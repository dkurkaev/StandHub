// Смоук-тест StandHub без Tailscale: вместо адреса Tailscale используется LAN-IP этого Mac.
// Запуск: node test/smoke.js
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BIND = process.env.TEST_BIND || Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')).address;
const DASH = 47791, VITE = 45173, PY = 45180;
const EDGE = 58173, API = 58174, VHOST = 'demo-wt-abc123.localhost'; // порты выше 49152, как у Docker
const BACKEND = 45182; // JSON-API в обычном диапазоне — должен попасть во вспомогательные
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'standhub-test-'));
const procs = [];
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  → ${extra}` : ''}`); if (!cond) failed++; };

function req(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const r = mod.request(url, { rejectUnauthorized: false, agent: false, ...opts }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (opts.onData) opts.onData(d); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    r.end(opts.body);
  });
}

function wsHandshake(secure, port, origin) {
  return new Promise((resolve) => {
    const s = secure ? tls.connect({ host: BIND, port, rejectUnauthorized: false }) : net.connect(port, BIND);
    let buf = Buffer.alloc(0);
    s.on(secure ? 'secureConnect' : 'connect', () => s.write(
      `GET /?token=x HTTP/1.1\r\nHost: ${BIND}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${origin}\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`));
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    s.on('close', () => resolve(buf.toString('latin1')));
    s.on('error', () => resolve(buf.toString('latin1')));
    setTimeout(() => s.destroy(), 2000);
  });
}

async function main() {
  console.log(`BIND=${BIND} tmp=${tmp}`);
  // 1. стенды
  procs.push(spawn(process.execPath, [path.join(__dirname, 'fake-vite.js'), String(VITE)], { stdio: 'ignore' }));
  const repo = path.join(tmp, 'demo-shop');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'demo-shop' }));
  fs.writeFileSync(path.join(repo, 'index.html'), '<title>Demo Shop</title>');
  execFileSync('git', ['init', '-q', '-b', 'feature/ipad'], { cwd: repo });
  procs.push(spawn('python3', ['-m', 'http.server', String(PY), '--bind', '0.0.0.0'], { cwd: repo, stdio: 'ignore' }));
  procs.push(spawn(process.execPath, [path.join(__dirname, 'fake-edge.js'), String(EDGE), VHOST], { stdio: 'ignore' }));
  procs.push(spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end('{"ok":true}')}).listen(${API},'127.0.0.1')`], { stdio: 'ignore' }));
  procs.push(spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>{s.statusCode=401;s.setHeader('content-type','application/json');s.end('{"detail":"Not authenticated"}')}).listen(${BACKEND},'127.0.0.1')`], { stdio: 'ignore' }));
  // 2. самоподписанный сертификат для проверки HTTPS на том же порту
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=standhub-test',
    '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
  // 3. StandHub
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hosts: { [EDGE]: VHOST } }));
  const hub = spawn(process.execPath, [path.join(ROOT, 'standhub.js')], {
    env: { ...process.env, STANDHUB_HOME: home, STANDHUB_BIND: BIND, STANDHUB_PORT: String(DASH),
      STANDHUB_TLS_CERT: path.join(tmp, 'c.pem'), STANDHUB_TLS_KEY: path.join(tmp, 'k.pem') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(hub);
  let hubLog = '';
  hub.stdout.on('data', (d) => { hubLog += d; });
  hub.stderr.on('data', (d) => { hubLog += d; });

  let st = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      st = JSON.parse((await req(`http://127.0.0.1:${DASH}/api/state`)).body);
      const ok = [VITE, PY, EDGE, BACKEND].every((p) => (st.stands.find((s) => s.port === p) || {}).exposure === 'mirror');
      if (ok) break;
    } catch { /* not yet */ }
  }
  const vite = st && st.stands.find((s) => s.port === VITE);
  const py = st && st.stands.find((s) => s.port === PY);
  check('дашборд видит оба стенда, оба зеркалированы', vite && py && vite.exposure === 'mirror' && py.exposure === 'mirror', JSON.stringify(st && st.stands));
  check('заголовок страницы из <title> (с &amp;)', vite && vite.title === 'Fake Vite & Co', vite && vite.title);
  check('python-стенд: имя репо, ветка, фреймворк', py && py.name === 'demo-shop' && py.branch === 'feature/ipad' && py.framework === 'http.server', py && JSON.stringify([py.name, py.branch, py.framework]));
  check('фоновые приложения не попали в список', st && st.stands.every((s) => !/^(Spotify|ControlCenter|Telegram|Code Helper|rapportd|postgres|Notion|Slack)/i.test(s.process)), st && st.stands.map((s) => `${s.port}:${s.process}`).join(' '));

  const base = `http://${BIND}:${VITE}`;
  const direct = await req(`${base}/`, { headers: { host: `${BIND}:${VITE}` } }).catch((e) => ({ status: e.code }));
  check('через зеркало Vite-подобный сервер не блокирует чужой Host', direct.status === 200 && direct.body.includes('Hello from fake Vite'), `${direct.status} ${direct.body}`);

  const echo = JSON.parse((await req(`${base}/echo`, { headers: { origin: base, referer: `${base}/page?x=1` } })).body);
  check('Host/Origin/Referer переписаны на localhost', echo.host === `localhost:${VITE}` && echo.origin === `http://localhost:${VITE}` && echo.referer === `http://localhost:${VITE}/page?x=1`, JSON.stringify(echo));
  check('X-Forwarded-For проставлен', Boolean(echo['x-forwarded-for']));
  const cors = await req(`${base}/echo`, { headers: { origin: base } });
  check('Access-Control-Allow-Origin переписан обратно на внешний адрес', cors.headers['access-control-allow-origin'] === base, cors.headers['access-control-allow-origin']);

  const redir = await req(`${base}/redirect`);
  check('Location: localhost → внешний адрес', redir.status === 302 && redir.headers.location === `${base}/landing`, redir.headers.location);

  const ck = await req(`${base}/cookie`);
  const sid = (ck.headers['set-cookie'] || []).find((c) => c.startsWith('sid='));
  check('cookie: убраны Domain=localhost и Secure (по http), SameSite=Lax', sid && !/domain=/i.test(sid) && !/secure/i.test(sid) && /samesite=lax/i.test(sid), sid);

  const t0 = Date.now();
  let firstAt = 0;
  const sse = await req(`${base}/sse`, { onData: () => { if (!firstAt) firstAt = Date.now() - t0; } });
  const total = Date.now() - t0;
  check('SSE стримится без буферизации', (sse.body.match(/tick/g) || []).length === 3 && firstAt < 600 && total >= 850, `first chunk ${firstAt} ms, total ${total} ms`);

  const big = Buffer.alloc(3 * 1024 * 1024, 120);
  const up = JSON.parse((await req(`${base}/upload`, { method: 'POST', body: big, headers: { 'content-type': 'application/octet-stream', 'content-length': big.length } })).body);
  check('загрузка 3 МБ проходит целиком', up.bytes === big.length, JSON.stringify(up));

  const ws = await wsHandshake(false, VITE, base);
  check('WebSocket (HMR) через прокси: 101 + сообщение, Origin переписан', ws.startsWith('HTTP/1.1 101') && ws.includes(`hello origin=http://localhost:${VITE}`), ws.slice(0, 120));

  const sbase = `https://${BIND}:${VITE}`;
  const sh = await req(`${sbase}/`).catch((e) => ({ status: e.code, body: '' }));
  check('HTTPS на том же порту', sh.status === 200 && sh.body.includes('Hello from fake Vite'), sh.status);
  const sredir = await req(`${sbase}/redirect`);
  check('Location под HTTPS → https://', sredir.headers.location === `${sbase}/landing`, sredir.headers.location);
  const sck = await req(`${sbase}/cookie`);
  check('cookie под HTTPS сохраняет Secure', ((sck.headers['set-cookie'] || []).find((c) => c.startsWith('sid=')) || '').includes('Secure'));
  const wss = await wsHandshake(true, VITE, sbase);
  check('WSS через прокси', wss.startsWith('HTTP/1.1 101') && wss.includes(`hello origin=http://localhost:${VITE}`), wss.slice(0, 120));

  const pyr = await req(`http://${BIND}:${PY}/`);
  check('сервер на 0.0.0.0 тоже зеркалируется и отвечает', pyr.status === 200 && pyr.body.includes('Demo Shop'), pyr.status);

  const icon = await req(`http://127.0.0.1:${DASH}/icon/${VITE}`);
  check('иконка стенда из <link rel=icon>', icon.status === 200 && /svg/.test(icon.headers['content-type']), `${icon.status} ${icon.headers['content-type']}`);
  const appIcon = await req(`http://127.0.0.1:${DASH}/apple-touch-icon.png`);
  check('иконка для экрана «Домой» (PNG)', appIcon.status === 200 && appIcon.headers['content-type'] === 'image/png');
  const page = await req(`http://${BIND}:${DASH}/`);
  check('дашборд доступен и на внешнем адресе', page.status === 200 && page.body.includes('<title>Стенды</title>'));
  const spage = await req(`https://${BIND}:${DASH}/api/state`);
  check('дашборд по HTTPS', spage.status === 200);

  const evil = await req(`http://127.0.0.1:${DASH}/api/hide`, { method: 'POST', body: JSON.stringify({ port: VITE, hidden: true }), headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
  check('POST с чужим Origin отклонён', evil.status === 403);

  const hid = JSON.parse((await req(`http://127.0.0.1:${DASH}/api/hide`, { method: 'POST', body: JSON.stringify({ port: VITE, hidden: true }), headers: { 'content-type': 'application/json' } })).body);
  const hv = hid.stands.find((s) => s.port === VITE);
  const afterHide = await req(`${base}/`).catch((e) => ({ status: e.code }));
  check('скрытый стенд перестаёт быть доступен извне', hv && hv.hidden && afterHide.status === 'ECONNREFUSED', `${hv && hv.exposure} ${afterHide.status}`);
  check('скрытие сохранено в config.json', JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).hiddenPorts.includes(VITE));
  await req(`http://127.0.0.1:${DASH}/api/hide`, { method: 'POST', body: JSON.stringify({ port: VITE, hidden: false }), headers: { 'content-type': 'application/json' } });
  const back = await req(`${base}/`).catch((e) => ({ status: e.code }));
  check('после «Показать» снова доступен', back.status === 200, back.status);

  // стенд за edge-прокси с маршрутизацией по имени хоста (как compose-стек с Envoy)
  const edge = st && st.stands.find((s) => s.port === EDGE);
  check('стенд на высоком порту с виртуальным хостом найден', edge && edge.title === 'Edge Login' && edge.vhost === VHOST && edge.localUrl === `http://${VHOST}:${EDGE}/`, JSON.stringify(edge));
  check('JSON-API на высоком порту не попал в список', st && !st.stands.some((s) => s.port === API));
  const ebase = `http://${BIND}:${EDGE}`;
  const eroot = await req(`${ebase}/`);
  check('edge: Host переписан на виртуальный, Location → внешний адрес', eroot.status === 307 && eroot.headers.location === `${ebase}/login`, `${eroot.status} ${eroot.headers.location}`);
  const elogin = await req(`${ebase}/login`);
  check('edge: адреса в теле страницы заменены (обычные, ws://, экранированные)',
    elogin.body.includes(`"publicOrigin":"${ebase}"`) && elogin.body.includes(`"ws":"ws://${BIND}:${EDGE}/ws"`) && elogin.body.includes(`"http:\\/\\/${BIND}:${EDGE}"`),
    elogin.body.slice(0, 400));
  check('edge: чужой порт localhost:1 в теле не тронут', elogin.body.includes('http://localhost:1/keep'));
  const ecookie = (elogin.headers['set-cookie'] || [])[0] || '';
  check('edge: Domain=<vhost> у куки убран', ecookie.startsWith('session=') && !/domain=/i.test(ecookie), ecookie);
  const eecho = JSON.parse((await req(`${ebase}/echo`, { headers: { origin: ebase } })).body);
  check('edge: Origin переписан на виртуальный хост', eecho.host === `${VHOST}:${EDGE}` && eecho.origin === `http://${VHOST}:${EDGE}`, JSON.stringify(eecho));
  const eslogin = await req(`https://${BIND}:${EDGE}/login`);
  check('edge по HTTPS: publicOrigin → https://, ws → wss://', eslogin.body.includes(`"publicOrigin":"https://${BIND}:${EDGE}"`) && eslogin.body.includes(`wss://${BIND}:${EDGE}/ws`), eslogin.body.slice(0, 300));

  // деление на основные (фронтенды) и вспомогательные (API и т.п.)
  const kindOf = (state, p) => (state.stands.find((s) => s.port === p) || {}).kind;
  check('фронтенды — в основных, JSON-API — во вспомогательных',
    kindOf(st, VITE) === 'app' && kindOf(st, EDGE) === 'app' && kindOf(st, BACKEND) === 'service',
    JSON.stringify([kindOf(st, VITE), kindOf(st, EDGE), kindOf(st, BACKEND)]));
  const kpost = (kind) => req(`http://127.0.0.1:${DASH}/api/kind`, { method: 'POST', body: JSON.stringify({ port: BACKEND, kind }), headers: { 'content-type': 'application/json' } });
  const moved = JSON.parse((await kpost('app')).body);
  const cfgAfter = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  check('стенд можно вручную перенести в основные, выбор сохраняется', kindOf(moved, BACKEND) === 'app' && cfgAfter.kinds[BACKEND] === 'app', JSON.stringify(cfgAfter.kinds));
  const back2 = JSON.parse((await kpost('service')).body);
  const cfgBack = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  check('возврат в автоматическую группу убирает ручную отметку', kindOf(back2, BACKEND) === 'service' && !(BACKEND in cfgBack.kinds), JSON.stringify(cfgBack.kinds));

  // «Пропущенные»: JSON-API на высоком порту виден там, «Показать» открывает доступ, обратное действие — убирает
  const skAPI = (st.skipped || []).find((s) => s.port === API);
  check('JSON-API на высоком порту — в «Пропущенных» с типом ответа', skAPI && skAPI.type === 'JSON' && skAPI.status === 200, JSON.stringify(st.skipped));
  const incPost = (include) => req(`http://127.0.0.1:${DASH}/api/include`, { method: 'POST', body: JSON.stringify({ port: API, include }), headers: { 'content-type': 'application/json' } });
  const inc = JSON.parse((await incPost(true)).body);
  const incStand = inc.stands.find((s) => s.port === API);
  await sleep(300);
  const viaMirror = await req(`http://${BIND}:${API}/`).catch((e) => ({ status: e.code, body: '' }));
  check('«Показать»: порт стал стендом и доступен через зеркало', incStand && incStand.included && !inc.skipped.some((s) => s.port === API) && viaMirror.status === 200 && viaMirror.body.includes('"ok":true'),
    `${JSON.stringify(incStand)} ${viaMirror.status}`);
  const exc = JSON.parse((await incPost(false)).body);
  await sleep(300);
  const afterExc = await req(`http://${BIND}:${API}/`).catch((e) => ({ status: e.code }));
  check('обратно в «Пропущенные»: доступ закрыт', !exc.stands.some((s) => s.port === API) && exc.skipped.some((s) => s.port === API) && afterExc.status === 'ECONNREFUSED', `${afterExc.status}`);

  procs[1].kill();
  await sleep(4000);
  const gone = JSON.parse((await req(`http://127.0.0.1:${DASH}/api/state`)).body);
  const pyGone = await req(`http://${BIND}:${PY}/`).catch((e) => ({ status: e.code }));
  check('остановленный стенд исчезает, зеркало закрывается', !gone.stands.some((s) => s.port === PY) && pyGone.status === 'ECONNREFUSED', pyGone.status);

  // авторизация (модуль без запуска сервера)
  const hubmod = require(path.join(ROOT, 'standhub.js'));
  const a1 = await hubmod.authorize('8.8.8.8');
  const a2 = await hubmod.authorize('100.101.102.103');
  const a3 = await hubmod.authorize('::ffff:127.0.0.1');
  check('чужой не-Tailscale адрес — отказ', !a1.ok, JSON.stringify(a1));
  check('Tailscale-адрес без подтверждения whois — отказ', !a2.ok, JSON.stringify(a2));
  check('локальный адрес — можно', a3.ok);

  console.log(failed ? `\n${failed} проверок не прошло\n--- лог StandHub ---\n${hubLog}` : '\nВсе проверки пройдены.\n--- лог StandHub ---\n' + hubLog);
}

main().catch((e) => { console.error(e); failed++; }).finally(() => {
  for (const p of procs) try { p.kill(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});
