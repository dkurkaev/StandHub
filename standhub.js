#!/usr/bin/env node
// StandHub — делает локальные стенды (dev-серверы) этого Mac доступными
// с твоих устройств (iPad, iPhone) через Tailscale и только для твоего аккаунта.
//
//   • находит запущенные стенды (lsof + HTTP-проба), определяет проект, ветку, фреймворк;
//   • зеркалирует каждый порт P на Tailscale-IP:P через обратный прокси
//     (Host/Origin переписываются на localhost:P — Vite/Django/Rails не блокируют запросы,
//     WebSocket/HMR/SSE работают), HTTP и HTTPS на одном порту;
//   • пускает только устройства твоего Tailscale-аккаунта (tailscale whois);
//   • показывает дашборд со всеми стендами на :7777.
//
// Без зависимостей, нужен только Node.js >= 18.
'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFile, spawn } = require('node:child_process');

const VERSION = '0.2.0';
const HOME = os.homedir();
const DATA_DIR = process.env.STANDHUB_HOME || path.join(HOME, '.config', 'standhub');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');
const TS_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

// ───────────────────────── utils ─────────────────────────

const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);

const childEnv = {
  ...process.env,
  PATH: [...new Set([...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
    .filter(Boolean).join(':'),
};

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 << 20, env: childEnv }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function isExec(p) { try { await fsp.access(p, fs.constants.X_OK); return true; } catch { return false; } }

async function which(name) {
  for (const dir of childEnv.PATH.split(':')) {
    const p = path.join(dir, name);
    if (await isExec(p)) return p;
  }
  return null;
}

const normIp = (a = '') => (a.startsWith('::ffff:') ? a.slice(7) : a);

function isTailnetIp(ip) {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(ip);
  return Boolean((m && +m[1] >= 64 && +m[1] <= 127) || /^fd7a:115c:a1e0:/i.test(ip));
}

function localAddrs() {
  const s = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) s.add(a.address);
  return s;
}

const tildify = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ───────────────────────── config ─────────────────────────

const DEFAULTS = {
  dashboardPort: 7777,
  bind: 'auto',            // 'auto' — Tailscale IPv4 этого Mac; или явный IP
  auth: 'same-user',       // 'same-user' — только устройства твоего Tailscale-аккаунта | 'tailnet' | 'none'
  allowUsers: [],          // дополнительные Tailscale-логины, которым можно
  https: 'auto',           // 'auto' — сертификат от `tailscale cert`, если в tailnet включён HTTPS; false — выкл
  rewriteHost: true,       // переписывать Host/Origin на localhost:PORT
  keepAwake: false,        // не давать Mac засыпать, пока есть стенды (caffeinate -i)
  scanIntervalMs: 2500,
  portRange: [1024, 49151],
  includePorts: [],        // всегда показывать эти порты
  excludePorts: [],        // никогда не показывать эти порты
  excludeProcesses: [],    // регулярки по имени/командной строке процесса
  hiddenPorts: [],         // скрытые из дашборда (и не проксируемые) порты
  names: {},               // { "5173": "Своё имя" }
  hosts: {},               // { "64926": "app.localhost" } — если стенд маршрутизирует по имени хоста
  kinds: {},               // { "9091": "app" } — ручная группа стенда: app (основные) или service (вспомогательные)
  rewriteBody: true,       // подменять http://localhost:PORT в HTML/JS/JSON на адрес для iPad
};

const cfg = {};
let cfgMtime = -1;

function applyConfig(user) {
  const next = { ...DEFAULTS, ...(user || {}) };
  const e = process.env;
  if (e.STANDHUB_BIND) next.bind = e.STANDHUB_BIND;
  if (e.STANDHUB_PORT) next.dashboardPort = +e.STANDHUB_PORT;
  if (e.STANDHUB_AUTH) next.auth = e.STANDHUB_AUTH;
  for (const k of Object.keys(cfg)) delete cfg[k];
  Object.assign(cfg, next);
}

function loadConfig() {
  let st = null;
  try { st = fs.statSync(CONFIG_PATH); } catch { /* no file */ }
  const mtime = st ? st.mtimeMs : 0;
  if (mtime === cfgMtime) return;
  cfgMtime = mtime;
  if (!st) return applyConfig({});
  const user = readJson(CONFIG_PATH);
  if (!user) { log('config: не удалось разобрать', CONFIG_PATH, '— использую значения по умолчанию'); return applyConfig({}); }
  applyConfig(user);
}

function ensureConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
}

function saveConfig(patch) {
  const user = readJson(CONFIG_PATH) || {};
  Object.assign(user, patch);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(user, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  cfgMtime = -1;
  loadConfig();
}

applyConfig({});

// ───────────────────────── Tailscale ─────────────────────────

const ts = { bin: null, state: 'NotInstalled', ip: null, dnsName: null, userId: null, login: null, certDomains: [] };

async function findTailscale() {
  return (await which('tailscale')) || ((await isExec(TS_APP_BIN)) ? TS_APP_BIN : null);
}

function tailnetIpFromInterfaces() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (!name.startsWith('utun')) continue;
    for (const a of list || []) if (a.family === 'IPv4' && isTailnetIp(a.address)) return a.address;
  }
  return null;
}

async function refreshTailscale() {
  ts.bin = await findTailscale();
  Object.assign(ts, { ip: null, dnsName: null, userId: null, login: null, certDomains: [] });
  if (!ts.bin) {
    const ip = tailnetIpFromInterfaces();
    ts.state = ip ? 'Running' : 'NotInstalled';
    ts.ip = ip;
    return;
  }
  const r = await run(ts.bin, ['status', '--json'], 8000);
  let s = null;
  try { s = JSON.parse(r.stdout); } catch { /* daemon not reachable */ }
  if (!s) { ts.state = 'NotRunning'; return; }
  const self = s.Self || {};
  ts.state = s.BackendState || 'Unknown';
  if (ts.state !== 'Running') return;
  ts.ip = (self.TailscaleIPs || s.TailscaleIPs || []).find((x) => x.includes('.')) || null;
  ts.dnsName = (self.DNSName || '').replace(/\.$/, '') || null;
  ts.userId = self.UserID ?? null;
  ts.login = (s.User && s.User[String(self.UserID)] && s.User[String(self.UserID)].LoginName) || null;
  ts.certDomains = s.CertDomains || [];
}

// Кто подключается: проверяем, что устройство принадлежит тому же Tailscale-аккаунту, что и этот Mac.
const whoisCache = new Map(); // ip -> { exp, promise }

async function whois(ip) {
  if (!ts.bin) return { ok: false, reason: 'Не найден Tailscale CLI — не могу проверить, чьё это устройство' };
  const r = await run(ts.bin, ['whois', '--json', ip], 6000);
  let w = null;
  try { w = JSON.parse(r.stdout); } catch { /* ignore */ }
  if (!w) return { ok: false, reason: `tailscale whois ${ip} не ответил` };
  const u = w.UserProfile || {};
  const node = w.Node || {};
  const device = node.ComputedName || (node.Hostinfo && node.Hostinfo.Hostname) || String(node.Name || ip).split('.')[0];
  const same = ts.userId != null && u.ID === ts.userId;
  const allowed = same || (cfg.allowUsers || []).includes(u.LoginName);
  return allowed
    ? { ok: true, who: `${device} · ${u.LoginName || u.DisplayName || 'tailnet'}`, device, login: u.LoginName }
    : { ok: false, reason: `Устройство «${device}» принадлежит ${u.LoginName || 'другому пользователю'}` };
}

async function authorize(rawIp) {
  const ip = normIp(rawIp);
  if (localAddrs().has(ip)) return { ok: true, who: 'этот Mac', local: true };
  if (cfg.auth === 'none') return { ok: true, who: ip };
  if (!isTailnetIp(ip)) return { ok: false, reason: `Адрес ${ip} не из твоей сети Tailscale` };
  if (cfg.auth === 'tailnet') return { ok: true, who: ip };
  const hit = whoisCache.get(ip);
  if (hit && hit.exp > Date.now()) return hit.promise;
  const promise = whois(ip);
  whoisCache.set(ip, { exp: Date.now() + 20000, promise });
  const res = await promise;
  whoisCache.set(ip, { exp: Date.now() + (res.ok ? 5 * 60000 : 20000), promise: Promise.resolve(res) });
  if (!res.ok) log(`доступ запрещён ${ip}: ${res.reason}`);
  return res;
}

// ───────────────────────── HTTPS (tailscale cert) ─────────────────────────

const tlsState = { opts: null, source: null, domain: null, checkedAt: 0, error: null };
const endpoints = new Set();

function setTls(opts, source) {
  tlsState.opts = opts;
  tlsState.source = source;
  for (const ep of endpoints) ep.updateTls();
}

async function refreshTls() {
  const e = process.env;
  if (e.STANDHUB_TLS_CERT && e.STANDHUB_TLS_KEY) {
    if (!tlsState.opts) setTls({ cert: fs.readFileSync(e.STANDHUB_TLS_CERT), key: fs.readFileSync(e.STANDHUB_TLS_KEY) }, 'env');
    return;
  }
  if (cfg.https === false) { tlsState.error = 'HTTPS выключен в config.json'; if (tlsState.opts) setTls(null); return; }
  if (!ts.bin || !ts.dnsName) { tlsState.error = null; if (tlsState.opts) setTls(null); return; }
  if (!ts.certDomains.includes(ts.dnsName)) {
    tlsState.error = 'В админке Tailscale не включены HTTPS Certificates';
    if (tlsState.opts) setTls(null);
    return;
  }
  if (tlsState.domain === ts.dnsName && tlsState.opts && Date.now() - tlsState.checkedAt < 12 * 3600e3) return;
  if (tlsState.error && Date.now() - tlsState.checkedAt < 10 * 60e3) return; // не долбим при ошибке
  tlsState.checkedAt = Date.now();
  if (!tlsState.opts) log(`получаю HTTPS-сертификат для ${ts.dnsName}…`);
  const dir = path.join(DATA_DIR, 'tls');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certFile = path.join(dir, `${ts.dnsName}.crt`);
  const keyFile = path.join(dir, `${ts.dnsName}.key`);
  const r = await run(ts.bin, ['cert', '--cert-file', certFile, '--key-file', keyFile, ts.dnsName], 120000);
  if (!r.ok) {
    tlsState.error = `tailscale cert: ${(r.stderr || r.stdout).trim().split('\n').pop() || 'ошибка'}`;
    log('HTTPS недоступен —', tlsState.error);
    return;
  }
  try {
    const cert = fs.readFileSync(certFile);
    const key = fs.readFileSync(keyFile);
    if (!tlsState.opts || !cert.equals(tlsState.opts.cert)) { setTls({ cert, key }, 'tailscale'); log('HTTPS-сертификат готов для', ts.dnsName); }
    tlsState.domain = ts.dnsName;
    tlsState.error = null;
  } catch (err) {
    tlsState.error = `не удалось прочитать сертификат: ${err.message}`;
  }
}

let tlsBusy = false;
function refreshTlsInBackground() {
  if (tlsBusy) return;
  tlsBusy = true;
  refreshTls()
    .catch((e) => { tlsState.error = e.message; log('HTTPS: ошибка —', e.message); })
    .finally(() => { tlsBusy = false; });
}

// ───────────────────────── listening endpoint (HTTP + HTTPS на одном порту) ─────────────────────────

class Endpoint {
  constructor({ host, port, onRequest, onUpgrade, allowTls = true }) {
    Object.assign(this, { host, port, onRequest, onUpgrade, allowTls });
    this.state = 'starting';
    this.error = null;
    this.failedAt = 0;
    this.sockets = new Set();
    this.http = this.#decorate(http.createServer((q, s) => onRequest(q, s, false)), false);
    this.https = null;
    this.server = net.createServer((sock) => this.#accept(sock));
    this.ready = new Promise((resolve) => {
      this.server.on('error', (e) => {
        this.state = e.code === 'EADDRINUSE' ? 'busy' : 'error';
        this.error = e.code || e.message;
        this.failedAt = Date.now();
        resolve(this.state);
      });
      this.server.listen({ host, port }, () => { this.state = 'ok'; resolve('ok'); });
    });
    endpoints.add(this);
    this.updateTls();
  }

  #decorate(srv, secure) {
    srv.keepAliveTimeout = 65000;
    srv.headersTimeout = 70000;
    srv.requestTimeout = 0; // долгие загрузки / стриминг
    if (this.onUpgrade) srv.on('upgrade', (q, s, h) => this.onUpgrade(q, s, h, secure));
    srv.on('clientError', (err, sock) => { if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
    return srv;
  }

  updateTls() {
    if (!this.allowTls) return;
    const o = tlsState.opts;
    if (!o) { this.https = null; return; }
    if (this.https) { this.https.setSecureContext(o); return; }
    this.https = this.#decorate(https.createServer({ ...o }, (q, s) => this.onRequest(q, s, true)), true);
  }

  #accept(sock) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    sock.setNoDelay(true);
    if (!this.https) { this.http.emit('connection', sock); return; }
    // Смотрим на первый байт: 0x16 — TLS ClientHello, иначе обычный HTTP.
    sock.once('data', (chunk) => {
      sock.pause();
      sock.unshift(chunk);
      const target = chunk[0] === 0x16 && this.https ? this.https : this.http;
      target.emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
  }

  close() {
    endpoints.delete(this);
    try { this.server.close(); } catch { /* ignore */ }
    for (const s of this.sockets) s.destroy();
    this.state = 'closed';
  }
}

// ───────────────────────── reverse proxy ─────────────────────────

const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 });
const REQ_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'expect']);
const RES_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'trailer', 'upgrade']);

function hostParts(hostHeader) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(hostHeader || ''));
  return m ? { hostname: m[1], port: m[2] || null } : null;
}

function extOf(req, secure) {
  const hp = hostParts(req.headers.host);
  return { proto: secure ? 'https' : 'http', hostname: hp ? hp.hostname : (currentBind || 'localhost') };
}

// Имя, под которым стенд ждёт запросы: обычно localhost, но, например, у compose-стека с edge-прокси —
// shop-wt-1234.localhost (маршрутизация по Host).
const vhostFor = (port) => (internal.get(+port) && internal.get(+port).vhost) || 'localhost';

// https://mac.tailnet.ts.net:5173/x → http://localhost:5173/x (только если хост — наш внешний)
function toLocalUrl(u, ext) {
  const m = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(String(u));
  if (!m) return u;
  const hp = hostParts(m[2]);
  if (!hp || hp.hostname.toLowerCase() !== ext.hostname.toLowerCase()) return u;
  const port = hp.port || (m[1].toLowerCase() === 'https' ? '443' : '80');
  return `http://${vhostFor(port)}:${port}${m[3]}`;
}

// http://localhost:5173/x, http://app.localhost:5173/x → https://mac.tailnet.ts.net:5173/x
const LOCAL_HOST_RX_SRC = '(?:(?:[a-z0-9-]+\\.)*localhost|127\\.0\\.0\\.1|\\[::1\\]|0\\.0\\.0\\.0)';
const LOCAL_URL_RX = new RegExp(`\\bhttps?:\\/\\/${LOCAL_HOST_RX_SRC}(?![\\w.-])(?::(\\d+))?`, 'gi');
function toExtUrls(s, ext) {
  return String(s).replace(LOCAL_URL_RX, (all, port) => {
    const p = port || (/^https/i.test(all) ? '443' : '80');
    return `${ext.proto}://${ext.hostname}:${p}`;
  });
}

// Адреса стендов внутри HTML/JS/JSON/CSS (в т.ч. экранированные http:\/\/…) → внешний адрес.
// Меняем только порты известных стендов: остальные с iPad всё равно недоступны.
const BODY_URL_RX = new RegExp(`\\b(https?|wss?):(\\/\\/|\\\\\\/\\\\\\/)${LOCAL_HOST_RX_SRC}:(\\d{2,5})\\b`, 'gi');
const BODY_TYPES = /^\s*(text\/(html|css|javascript|plain|x-component)|application\/(javascript|x-javascript|json|manifest\+json|ld\+json))\b/i;
const BODY_LIMIT = 25 * 1024 * 1024;

function rewriteBodyText(text, ext) {
  return text.replace(BODY_URL_RX, (all, scheme, slashes, port) => {
    if (!internal.has(+port)) return all;
    const proto = /^ws/i.test(scheme) ? (ext.proto === 'https' ? 'wss' : 'ws') : ext.proto;
    return `${proto}:${slashes}${ext.hostname}:${port}`;
  });
}

function bodyRewritable(req, ur) {
  if (!cfg.rewriteBody || req.method === 'HEAD' || ur.statusCode < 200 || [204, 304].includes(ur.statusCode)) return false;
  if (!BODY_TYPES.test(String(ur.headers['content-type'] || ''))) return false;
  const enc = String(ur.headers['content-encoding'] || 'identity').toLowerCase();
  if (!['identity', 'gzip', 'br', 'deflate'].includes(enc)) return false;
  return !(+ur.headers['content-length'] > BODY_LIMIT);
}

function decodeBody(buf, enc) {
  return new Promise((resolve, reject) => {
    const cb = (e, out) => (e ? reject(e) : resolve(out));
    if (enc === 'gzip') zlib.gunzip(buf, cb);
    else if (enc === 'br') zlib.brotliDecompress(buf, cb);
    else if (enc === 'deflate') zlib.inflate(buf, (e, out) => (e ? zlib.inflateRaw(buf, cb) : resolve(out)));
    else resolve(buf);
  });
}

function encodeBody(buf, enc) {
  return new Promise((resolve, reject) => {
    const cb = (e, out) => (e ? reject(e) : resolve(out));
    if (enc === 'gzip') zlib.gzip(buf, { level: 5 }, cb);
    else if (enc === 'br') zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, cb);
    else if (enc === 'deflate') zlib.deflate(buf, cb);
    else resolve(buf);
  });
}

// Буферизуем текстовый ответ, подменяем адреса и отдаём; слишком большой — отдаём как есть.
function sendRewrittenBody(ur, res, headers, ext) {
  const chunks = [];
  let size = 0;
  const onData = (c) => {
    chunks.push(c);
    size += c.length;
    if (size > BODY_LIMIT) {
      ur.removeListener('data', onData);
      ur.removeListener('end', onEnd);
      res.writeHead(ur.statusCode, ur.statusMessage, headers);
      for (const x of chunks) res.write(x);
      ur.pipe(res);
    }
  };
  const onEnd = async () => {
    const raw = Buffer.concat(chunks);
    const enc = String(ur.headers['content-encoding'] || 'identity').toLowerCase();
    let body = raw;
    try {
      const text = (await decodeBody(raw, enc)).toString('utf8');
      if (/localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(text)) {
        const replaced = rewriteBodyText(text, ext);
        if (replaced !== text) {
          body = await encodeBody(Buffer.from(replaced, 'utf8'), enc);
          headers['content-length'] = String(body.length);
          if (typeof headers.etag === 'string' && !headers.etag.startsWith('W/')) headers.etag = `W/${headers.etag}`;
          delete headers['content-md5'];
        }
      }
    } catch { body = raw; }
    if (res.headersSent) return;
    res.writeHead(ur.statusCode, ur.statusMessage, headers);
    res.end(body);
  };
  ur.on('data', onData);
  ur.on('end', onEnd);
  ur.on('error', () => res.destroy());
}

function fixCookie(c, secure) {
  let s = c.replace(new RegExp(`;\\s*domain=\\.?${LOCAL_HOST_RX_SRC}(?=;|$)`, 'gi'), '');
  if (!secure && !/^__(?:Secure|Host)-/i.test(s) && /;\s*secure(?=;|$)/i.test(s)) {
    // по http браузер выбросит Secure-куку — убираем флаг (SameSite=None без Secure тоже запрещён)
    s = s.replace(/;\s*secure(?=;|$)/gi, '').replace(/;\s*samesite=none(?=;|$)/gi, '; SameSite=Lax');
  }
  return s;
}

function upstreamHeaders(req, port, ext, upgrade) {
  const out = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i].toLowerCase();
    const v = req.rawHeaders[i + 1];
    if (k === 'x-forwarded-for') continue;
    if (!upgrade && REQ_HOP.has(k)) continue;
    if (out[k] === undefined) out[k] = v;
    else out[k] = [].concat(out[k], v);
  }
  if (cfg.rewriteHost) {
    // Для стенда запрос выглядит так, будто его открыли в браузере на самом Mac.
    out.host = `${vhostFor(port)}:${port}`;
    if (typeof out.origin === 'string') out.origin = toLocalUrl(out.origin, ext);
    if (typeof out.referer === 'string') out.referer = toLocalUrl(out.referer, ext);
  }
  const ip = normIp(req.socket.remoteAddress);
  out['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${ip}` : ip;
  out[VIA_HEADER] = VIA_ID;
  return out;
}

function rewriteResponseHeaders(h, ext, secure) {
  const out = {};
  for (const [k, v] of Object.entries(h)) if (!RES_HOP.has(k)) out[k] = v;
  if (cfg.rewriteHost) {
    for (const k of ['location', 'content-location', 'access-control-allow-origin', 'refresh']) {
      if (typeof out[k] === 'string') out[k] = toExtUrls(out[k], ext);
    }
    if (Array.isArray(out['set-cookie'])) out['set-cookie'] = out['set-cookie'].map((c) => fixCookie(c, secure));
  }
  return out;
}

// Защита от петли: запрос, уже прошедший через StandHub, обратно не проксируем.
const VIA_HEADER = 'x-standhub-via';
const VIA_ID = `${os.hostname()}:${process.pid}`;

async function proxyRequest(mirror, req, res, secure) {
  if (req.headers[VIA_HEADER]) {
    return sendPage(res, 508, 'Петля прокси', `Порт ${mirror.port} указывает обратно на StandHub (${req.headers[VIA_HEADER]}). Похоже, запущено два экземпляра StandHub.`);
  }
  const auth = await authorize(req.socket.remoteAddress);
  if (!auth.ok) return sendDenied(res, auth);
  const ext = extOf(req, secure);
  const up = http.request({
    host: mirror.upstream,
    port: mirror.port,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, mirror.port, ext, false),
    agent: upstreamAgent,
  });
  up.on('response', (ur) => {
    const headers = rewriteResponseHeaders(ur.headers, ext, secure);
    if (bodyRewritable(req, ur)) { sendRewrittenBody(ur, res, headers, ext); return; }
    res.writeHead(ur.statusCode, ur.statusMessage, headers);
    ur.pipe(res);
    ur.on('error', () => res.destroy());
  });
  up.on('error', (err) => {
    if (!res.headersSent) sendPage(res, 502, 'Стенд не отвечает', `Порт ${mirror.port} на Mac не принял соединение (${err.code || err.message}). Возможно, dev-сервер перезапускается — обнови страницу через пару секунд.`);
    else res.destroy();
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

async function proxyUpgrade(mirror, req, sock, head, secure) {
  sock.on('error', () => {});
  if (req.headers[VIA_HEADER]) { sock.end('HTTP/1.1 508 Loop Detected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
  const auth = await authorize(req.socket.remoteAddress);
  if (!auth.ok) { sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
  const headers = upstreamHeaders(req, mirror.port, extOf(req, secure), true);
  const up = net.connect(mirror.port, mirror.upstream);
  up.setNoDelay(true);
  up.on('error', () => sock.destroy());
  up.on('close', () => sock.destroy());
  sock.on('close', () => up.destroy());
  up.on('connect', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) for (const vv of [].concat(v)) raw += `${k}: ${vv}\r\n`;
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
}

const mirrors = new Map(); // port -> { port, upstream, endpoint, pid }

function openMirror(port, upstream, host, pid) {
  const mirror = { port, upstream, pid };
  mirror.endpoint = new Endpoint({
    host,
    port,
    onRequest: (q, s, secure) => proxyRequest(mirror, q, s, secure),
    onUpgrade: (q, s, h, secure) => proxyUpgrade(mirror, q, s, h, secure),
  });
  return mirror;
}

// ───────────────────────── discovery ─────────────────────────

const procCache = new Map();  // pid -> { comm, args, startedAt, cwd }
const projCache = new Map();  // cwd -> { at, info }
const probeCache = new Map(); // `${pid}:${port}` -> { at, result }
const dockerCache = { at: 0, map: new Map() };

function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return 0;
  return (((+(m[1] || 0) * 24 + +(m[2] || 0)) * 60 + +m[3]) * 60 + +m[4]) * 1000;
}

async function fillProcInfo(pids) {
  const need = pids.filter((p) => !procCache.has(p));
  if (!need.length) return;
  const list = need.join(',');
  const [a, b, c] = await Promise.all([
    run('/bin/ps', ['-o', 'pid=,comm=', '-p', list]),
    run('/bin/ps', ['-o', 'pid=,etime=,args=', '-p', list]),
    run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', list]),
  ]);
  const info = new Map(need.map((p) => [p, { comm: '', args: '', startedAt: Date.now(), cwd: null }]));
  for (const line of a.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && info.has(+m[1])) info.get(+m[1]).comm = m[2].trim();
  }
  for (const line of b.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m && info.has(+m[1])) Object.assign(info.get(+m[1]), { startedAt: Date.now() - parseEtime(m[2]), args: m[3].trim() });
  }
  let cur = 0;
  for (const line of c.stdout.split('\n')) {
    if (line[0] === 'p') cur = +line.slice(1);
    else if (line[0] === 'n' && info.has(cur)) info.get(cur).cwd = line.slice(1);
  }
  for (const [pid, i] of info) if (i.comm) procCache.set(pid, i);
}

const DEV_RUNTIMES = /^(node|nodejs|bun|deno|python[\d.]*|ruby|php[\d.]*|java|dotnet|go|beam\.smp|erl|perl|caddy|nginx|httpd|hugo)$/i;
const DEV_TOOL_PROCESS = /^(claude|language_server[\w.-]*|copilot-language-server|codeium[\w.-]*|sourcekit-lsp|gopls|rust-analyzer)$/i;

function isExcludedProcess(p) {
  const base = path.basename(p.comm);
  for (const s of cfg.excludeProcesses || []) {
    try { const rx = new RegExp(s, 'i'); if (rx.test(base) || rx.test(p.args)) return true; } catch { /* bad regex */ }
  }
  // Другие экземпляры StandHub (например, ручной запуск рядом с агентом): их зеркала — не стенды,
  // иначе два экземпляра начнут проксировать порты друг другу по кругу.
  if (/standhub\.js/i.test(p.args)) return true;
  // Служебные порты инструментов разработки (Claude Code, языковые серверы редакторов) — не стенды.
  if (DEV_TOOL_PROCESS.test(base)) return true;
  if (/docker|vpnkit|orbstack|colima|rancher|podman|lima/i.test(p.comm)) return false;
  if (/^\/(System|usr\/libexec|usr\/sbin|sbin|Library\/Apple)\//.test(p.comm)) return true;
  // Приложения (Spotify, Telegram, редакторы…) — не стенды, если только это не рантайм (java из IDE, Python.app и т.п.)
  if (/\.app\/Contents\//.test(p.comm) && !DEV_RUNTIMES.test(base) && !/\/Contents\/Developer\//.test(p.comm)) return true;
  return false;
}

const isDocker = (p) => /docker|vpnkit|orbstack|colima|rancher|podman|lima/i.test(p.comm);

const FRAMEWORKS = [
  [/storybook/i, 'Storybook'], [/vitepress/i, 'VitePress'], [/\bastro\b/i, 'Astro'], [/\bnuxi?\b/i, 'Nuxt'],
  [/svelte-kit/i, 'SvelteKit'], [/\bremix\b/i, 'Remix'], [/\bvite(?:\.js)?\b/i, 'Vite'], [/\bnext\b/i, 'Next.js'],
  [/react-scripts/i, 'CRA'], [/@angular|\bng\s+serve/i, 'Angular'], [/\bexpo\b/i, 'Expo'], [/\bgatsby\b/i, 'Gatsby'],
  [/docusaurus/i, 'Docusaurus'], [/\bparcel\b/i, 'Parcel'], [/webpack/i, 'webpack'], [/\bnest\b/i, 'NestJS'],
  [/manage\.py\s+runserver/i, 'Django'], [/\buvicorn\b/i, 'Uvicorn'], [/\bgunicorn\b/i, 'Gunicorn'], [/\bflask\b/i, 'Flask'],
  [/streamlit/i, 'Streamlit'], [/jupyter/i, 'Jupyter'], [/http\.server/i, 'http.server'], [/\brails\b|\bpuma\b/i, 'Rails'],
  [/\bjekyll\b/i, 'Jekyll'], [/artisan\s+serve/i, 'Laravel'], [/\bphp\b.*\s-S\s/i, 'PHP'], [/\bhugo\b/i, 'Hugo'],
  [/spring-boot|springframework/i, 'Spring'],
];

function detectFramework(p) {
  if (isDocker(p)) return 'Docker';
  for (const [rx, name] of FRAMEWORKS) if (rx.test(p.args)) return name;
  const base = path.basename(p.comm).replace(/\d+(\.\d+)*$/, '');
  return base === 'Python' ? 'python' : base;
}

function readGitHead(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch { return null; }
}

const GENERIC_NAME = /^(front|frontend|back|backend|web|webapp|api|server|client|app|ui|admin|site|www|service|svc|core|main|src)$/i;
const CONTAINER_DIR = /^(projects|apps|packages|services|src|repos|code|modules|libs|workspace)$/i;

function contextName(dir) {
  let d = path.dirname(dir || '/');
  for (let i = 0; i < 4 && d !== '/' && d !== HOME; i++) {
    const b = path.basename(d);
    if (!CONTAINER_DIR.test(b)) return b;
    d = path.dirname(d);
  }
  return null;
}

function projectInfo(cwd) {
  const hit = projCache.get(cwd);
  if (hit && Date.now() - hit.at < 10000) return hit.info;
  const info = {};
  if (cwd && cwd !== '/' && cwd !== HOME) {
    let dir = cwd;
    for (let i = 0; i < 15; i++) {
      if (!info.pkg) {
        const pj = readJson(path.join(dir, 'package.json'));
        if (pj && pj.name) { info.pkg = pj.name; info.pkgDir = dir; }
      }
      const g = path.join(dir, '.git');
      let st = null;
      try { st = fs.statSync(g); } catch { /* no .git here */ }
      if (st) {
        let gitDir = g;
        let common = g;
        if (st.isFile()) {
          const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
          if (m) {
            gitDir = path.resolve(dir, m[1].trim());
            try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { common = gitDir; }
            info.worktree = path.basename(dir);
          }
        }
        info.root = dir;
        info.repo = path.basename(common) === '.git' ? path.basename(path.dirname(common)) : path.basename(dir);
        info.branch = readGitHead(gitDir);
        break;
      }
      const up = path.dirname(dir);
      if (up === dir || dir === HOME) break;
      dir = up;
    }
  }
  let name = info.repo || info.pkg || (cwd && cwd !== '/' && cwd !== HOME ? path.basename(cwd) : null);
  if (info.repo && info.pkg && info.pkgDir && info.pkgDir !== info.root) name = `${info.repo} › ${info.pkg.replace(/^@[^/]+\//, '')}`;
  // «frontend», «backend», «api»… ничего не говорят — добавляем проект-родителя: my-project › frontend
  const lead = name ? name.split(' › ')[0] : '';
  if (GENERIC_NAME.test(lead)) {
    const ctx = contextName(info.root || cwd);
    if (ctx) name = `${ctx} › ${name}`;
  }
  info.name = name;
  projCache.set(cwd, { at: Date.now(), info });
  return info;
}

// Опубликованные порты контейнеров: имя, образ, compose-проект/сервис и папка проекта.
async function dockerMap() {
  if (Date.now() - dockerCache.at > 8000) {
    dockerCache.at = Date.now();
    const map = new Map();
    const bin = (await which('docker')) || null;
    if (bin) {
      const fmt = ['{{.Names}}', '{{.Ports}}', '{{.Image}}', '{{.CreatedAt}}', '{{.Label "com.docker.compose.project"}}',
        '{{.Label "com.docker.compose.service"}}', '{{.Label "com.docker.compose.project.working_dir"}}'].join('\t');
      const r = await run(bin, ['ps', '--format', fmt], 5000);
      for (const line of r.stdout.split('\n')) {
        const [name, ports, image, created, project, service, workdir] = line.split('\t');
        if (!ports) continue;
        const cm = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/.exec(String(created));
        const createdAt = cm ? Date.parse(`${cm[1]}T${cm[2]}${cm[3]}:${cm[4]}`) || null : null;
        const info = { name, image, createdAt, project: project || null, service: service || null, workdir: workdir || null };
        // «0.0.0.0:8080->80/tcp» и диапазоны «0.0.0.0:9090-9091->9090-9091/tcp»
        for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
          const from = +m[1];
          const to = m[2] ? Math.min(+m[2], from + 1000) : from;
          for (let p = from; p <= to; p++) map.set(p, info);
        }
      }
    }
    dockerCache.map = map;
  }
  return dockerCache.map;
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : +k.slice(1));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k] || m;
  });
}

function parseHtml(html) {
  const out = { markup: /<(?:html|head|body|title|div|main|script)\b/i.test(html) };
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) out.title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim().slice(0, 140);
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag);
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag) || /\bhref\s*=\s*([^\s>]+)/i.exec(tag);
    if (rel && href && /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(rel[1])) { out.icon = decodeEntities(href[1]); break; }
  }
  return out;
}

// GET / на стенде: отвечает ли по HTTP, заголовок страницы, иконка.
function probe(host, port, pathname = '/', depth = 0, vhost = 'localhost') {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (r) => { if (done) return; done = true; resolve(r); try { req.destroy(); } catch { /* ignore */ } };
    req = http.request({
      host, port, path: pathname, method: 'GET', agent: false, timeout: 2500,
      headers: { host: `${vhost}:${port}`, 'user-agent': 'StandHub-probe', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    }, (res) => {
      const base = { http: true, status: res.statusCode, contentType: String(res.headers['content-type'] || '') };
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && depth < 3) {
        const local = /^\//.test(loc) ? loc : (new RegExp(`^https?://${LOCAL_HOST_RX_SRC}:${port}(/.*)?$`, 'i').exec(loc) || [])[1] || (new RegExp(`^https?://${LOCAL_HOST_RX_SRC}:${port}$`, 'i').test(loc) ? '/' : null);
        if (local) { done = true; req.destroy(); probe(host, port, local, depth + 1, vhost).then((r) => resolve(r.http ? r : base)); return; }
      }
      if (!/html/i.test(base.contentType)) { res.resume(); finish(base); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; if (buf.length > 65536 || /<\/head>/i.test(buf)) finish({ ...base, ...parseHtml(buf), page: pathname }); });
      res.on('end', () => finish({ ...base, ...parseHtml(buf), page: pathname }));
      res.on('error', () => finish(base));
    });
    req.on('timeout', () => finish({ http: null, slow: true }));
    req.on('error', (e) => finish({ http: e.code === 'ECONNREFUSED' ? undefined : false, error: e.code || e.message }));
    req.end();
  });
}

// Под какими именами хоста пробовать стенд: localhost, имя из config.hosts,
// для compose-стека — <project>.localhost и <service>.<project>.localhost.
function vhostCandidates(c) {
  const forced = cfg.hosts && cfg.hosts[c.port];
  if (forced) return [String(forced).replace(/^\w+:\/\//, '').replace(/[:/].*$/, '').toLowerCase()];
  const list = ['localhost'];
  const d = c.dock;
  if (d && d.project) list.push(`${d.project}.localhost`);
  if (d && d.project && d.service) list.push(`${d.service}.${d.project}.localhost`);
  return [...new Set(list.map((h) => h.toLowerCase().replace(/[^a-z0-9.-]/g, '-')))];
}

async function probeStand(c) {
  let fallback = null;
  for (const vhost of vhostCandidates(c)) {
    const r = { ...(await probe(c.upstream, c.port, '/', 0, vhost)), vhost };
    if (r.http !== true || r.status < 400) return r;
    if (!fallback) fallback = r;
  }
  return fallback;
}

async function cachedProbe(c) {
  const key = `${c.pid}:${c.port}`;
  const prev = probeCache.get(key);
  const ttl = !prev ? 0 : prev.result.http === true ? 15000 : prev.result.slow ? 4000 : 30000;
  if (prev && Date.now() - prev.at < ttl) return prev.result;
  let result = await probeStand(c);
  if (result.slow && prev && prev.result.http === true) result = { ...prev.result, slow: true };
  probeCache.set(key, { at: Date.now(), result });
  return result;
}

function pickUpstream(addrs) {
  if (addrs.has('*') || addrs.has('127.0.0.1')) return '127.0.0.1';
  if (addrs.has('::1')) return '::1';
  return [...addrs][0];
}

function bindKind(addrs) {
  if (addrs.has('*')) return 'all';
  if ([...addrs].every((a) => a === '127.0.0.1' || a === '::1')) return 'local';
  return [...addrs].join(', ');
}

const internal = new Map(); // port -> { upstream, icon } — то, что не уходит в API
let skippedList = [];       // отвечают по HTTP, но отфильтрованы как служебные (API на высоком порту и т.п.)

function responseType(pr) {
  const ct = String(pr.contentType || '').split(';')[0].trim().toLowerCase();
  if (!ct) return 'без типа';
  if (/json/.test(ct)) return 'JSON';
  if (/html/.test(ct)) return pr.markup ? 'HTML' : 'не страница';
  if (/^text\/plain/.test(ct)) return 'текст';
  if (/xml/.test(ct)) return 'XML';
  return ct;
}

// Основной стенд (фронтенд) — тот, что на / отдаёт HTML-страницу. Остальное (API, метрики) — вспомогательное,
// как и типовые админки/консоли инфраструктуры, даже если у них есть веб-интерфейс.
const isWebPage = (pr) => pr.http === true && Boolean(pr.markup) && pr.status < 400 && /html/i.test(pr.contentType || '');
const TOOL_UI = /minio|pgadmin|adminer|phpmyadmin|mailhog|mailpit|maildev|rabbitmq|kafka[\s-]?ui|kafdrop|akhq|redpanda|grafana|prometheus|alertmanager|jaeger|zipkin|kibana|opensearch|elasticvue|cerebro|swagger|redoc|portainer|traefik|keycloak|temporal|flower|redis[\s-]?(insight|commander)|mongo[\s-]express|clickhouse|sentry|metabase|localstack|wiremock|mockserver/i;

async function discover() {
  const r = await run('/usr/sbin/lsof', ['-nP', '-a', '-u', String(process.getuid()), '-iTCP', '-sTCP:LISTEN', '-Fpcn'], 8000);
  // Один порт могут слушать несколько процессов (стенд на localhost:P и чужое зеркало на другом IP:P),
  // поэтому собираем всех и выбираем владельца уже после фильтрации.
  const byPort = new Map(); // port -> Map(pid -> Set(addr))
  const allPids = new Set();
  let pid = 0;
  for (const line of r.stdout.split('\n')) {
    const t = line[0];
    const v = line.slice(1);
    if (t === 'p') pid = +v;
    else if (t === 'n' && pid !== process.pid) {
      const m = /^(.*):(\d+)$/.exec(v);
      if (!m) continue;
      const port = +m[2];
      const addr = m[1].replace(/^\[|\]$/g, '');
      if (!byPort.has(port)) byPort.set(port, new Map());
      const pm = byPort.get(port);
      if (!pm.has(pid)) pm.set(pid, new Set());
      pm.get(pid).add(addr);
      allPids.add(pid);
    }
  }
  const [lo, hi] = cfg.portRange;
  const include = new Set(cfg.includePorts);
  const ports = [...byPort.keys()].filter((port) =>
    include.has(port) || (port >= 1024 && port !== cfg.dashboardPort && !cfg.excludePorts.includes(port)));
  await fillProcInfo([...new Set(ports.flatMap((port) => [...byPort.get(port).keys()]))]);
  const cands = [];
  for (const port of ports) {
    for (const [owner, addrs] of byPort.get(port)) {
      const proc = procCache.get(owner);
      if (proc && (include.has(port) || !isExcludedProcess(proc))) { cands.push({ port, pid: owner, addrs, proc }); break; }
    }
  }
  if (cands.some((c) => isDocker(c.proc))) {
    const dm = await dockerMap();
    for (const c of cands) if (isDocker(c.proc)) c.dock = dm.get(c.port) || null;
  }
  for (const c of cands) {
    // Порты выше portRange (Docker раздаёт как раз такие) и порты контейнеров показываем,
    // только если там настоящая HTML-страница — иначе это API, БД и служебные сервисы.
    c.strict = !include.has(c.port) && (c.port < lo || c.port > hi || isDocker(c.proc));
    c.upstream = pickUpstream(c.addrs);
  }
  await Promise.all(cands.map(async (c) => { c.probe = await cachedProbe(c); }));

  const seen = new Set();
  const stands = [];
  const skipped = [];
  internal.clear();
  for (const c of cands) {
    seen.add(`${c.pid}:${c.port}`);
    const pr = c.probe;
    if (pr.http === undefined) continue;                                 // уже закрылся
    const p = c.proc;
    const dock = c.dock || null;
    const proj = projectInfo(dock ? dock.workdir : (isDocker(p) ? null : p.cwd));
    const autoName = proj.name || (dock && (dock.project || dock.name)) || path.basename(p.comm);
    if (!include.has(c.port)) {
      if (pr.http === false) continue;                                   // не HTTP (БД, Redis…)
      if (c.strict && !(pr.http === true && pr.markup && pr.status < 400)) {
        // Отвечает по HTTP, но не страница на высоком порту / в Docker — показываем в «Пропущенных».
        if (pr.http === true) {
          skipped.push({
            port: c.port,
            name: dock && dock.service ? `${autoName} · ${dock.service}` : autoName,
            framework: detectFramework(p),
            status: pr.status,
            type: responseType(pr),
            cwd: dock ? (tildify(dock.workdir) || dock.image || null) : tildify(p.cwd),
            args: dock ? `${dock.name} · ${dock.image}` : tildify(p.args).slice(0, 300),
          });
        }
        continue;
      }
    }
    const vhost = pr.vhost || 'localhost';
    internal.set(c.port, { upstream: c.upstream, icon: pr.icon || null, page: pr.page || '/', addrs: c.addrs, pid: c.pid, vhost });
    stands.push({
      port: c.port,
      pid: c.pid,
      name: cfg.names[c.port] || autoName,
      autoName,
      title: pr.title || '',
      status: pr.status || null,
      health: pr.http === true ? (pr.slow ? 'slow' : 'ok') : 'unknown',
      framework: detectFramework(p),
      process: path.basename(p.comm),
      args: dock ? `${dock.name} · ${dock.image}` : tildify(p.args).slice(0, 300),
      cwd: dock ? (tildify(dock.workdir) || dock.image || null) : tildify(p.cwd),
      repo: proj.repo || (dock && dock.project) || null,
      pkg: proj.pkg || null,
      branch: proj.branch || null,
      worktree: proj.worktree || null,
      compose: dock ? dock.project : null,
      service: dock ? (dock.service || dock.name) : null,
      vhost,
      localUrl: `http://${vhost}:${c.port}/`,
      startedAt: (dock && dock.createdAt) || p.startedAt,
      bind: bindKind(c.addrs),
      hidden: cfg.hiddenPorts.includes(c.port),
      included: include.has(c.port),
      exposure: 'pending',
      kind: isWebPage(pr) && !TOOL_UI.test([pr.title, dock && dock.image, dock && dock.service].filter(Boolean).join(' ')) ? 'app' : 'service',
    });
  }
  // Контейнеры compose-стека: главный (со своим именем хоста) — без пометки, остальные — «проект · сервис»
  // и во вспомогательных (это MinIO, админки и т.п. рядом с приложением).
  const byCompose = new Map();
  for (const s of stands) if (s.compose) byCompose.set(s.compose, [...(byCompose.get(s.compose) || []), s]);
  for (const group of byCompose.values()) {
    const primary = group.filter((s) => s.vhost !== 'localhost');
    for (const s of group) {
      if (primary.length === 1 && s === primary[0]) continue;
      if (s.service && !s.autoName.endsWith(` · ${s.service}`)) s.autoName = `${s.autoName} · ${s.service}`;
      if (!cfg.names[s.port]) s.name = s.autoName;
      if (primary.length) s.kind = 'service';
    }
  }
  for (const s of stands) {
    s.autoKind = s.kind;
    const forced = cfg.kinds && cfg.kinds[s.port];
    if (forced === 'app' || forced === 'service') s.kind = forced;
  }
  for (const k of probeCache.keys()) if (!seen.has(k)) probeCache.delete(k);
  for (const k of procCache.keys()) if (!allPids.has(k)) procCache.delete(k);
  skippedList = skipped.sort((a, b) => a.name.localeCompare(b.name) || a.port - b.port);
  return stands.sort((a, b) => b.startedAt - a.startedAt || a.port - b.port);
}

// ───────────────────────── dashboard ─────────────────────────

let computerName = os.hostname();
let state = { stands: [], at: 0, ms: 0 };
let currentBind = null;
let localDash = null;
let tailDash = null;

function dashUrls() {
  const port = cfg.dashboardPort;
  const urls = [];
  if (tlsState.opts && ts.dnsName) urls.push(`https://${ts.dnsName}:${port}`);
  if (ts.dnsName) urls.push(`http://${ts.dnsName}:${port}`);
  if (currentBind) urls.push(`http://${currentBind.includes(':') ? `[${currentBind}]` : currentBind}:${port}`);
  return [...new Set(urls)];
}

function apiState(auth) {
  return {
    version: VERSION,
    now: Date.now(),
    mac: { name: computerName, host: os.hostname() },
    viewer: { who: auth.who, local: Boolean(auth.local) },
    tailscale: {
      installed: Boolean(ts.bin) || ts.state === 'Running',
      state: ts.state, ip: ts.ip, dnsName: ts.dnsName, login: ts.login,
      https: Boolean(tlsState.opts), httpsError: tlsState.error,
    },
    bind: currentBind,
    auth: cfg.auth,
    dashboard: { port: cfg.dashboardPort, urls: dashUrls() },
    keepAwake: Boolean(cfg.keepAwake),
    awake: Boolean(caffeinate),
    stands: state.stands,
    skipped: skippedList,
    scannedAt: state.at,
    scanMs: state.ms,
  };
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(body);
}
const sendJson = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sendPage(res, status, title, text) {
  send(res, status, `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><style>:root{color-scheme:light dark}body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px}
h1{font-size:22px;margin:0 0 8px}p{color:GrayText}</style></head><body><h1>${escHtml(title)}</h1><p>${escHtml(text)}</p></body></html>`, 'text/html; charset=utf-8');
}

function sendDenied(res, auth) {
  sendPage(res, 403, 'Нет доступа', `${auth.reason}. StandHub пускает только устройства, вошедшие в Tailscale под тем же аккаунтом, что и этот Mac.`);
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function fetchLocal(host, port, pathname, vhost = 'localhost', limit = 512 * 1024) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: pathname, agent: false, timeout: 2500, headers: { host: `${vhost}:${port}`, 'user-agent': 'StandHub' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); resolve(null); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks) }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

const iconCache = new Map(); // `${port}:${pid}` -> { at, icon|null }

async function findIcon(port) {
  const s = internal.get(port);
  if (!s) return null;
  const key = `${port}:${s.pid}`;
  const hit = iconCache.get(key);
  if (hit && Date.now() - hit.at < (hit.icon ? 300000 : 30000)) return hit.icon;
  let icon = null;
  for (const href of [s.icon, '/favicon.ico'].filter(Boolean)) {
    const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(href);
    if (data) { icon = { type: data[1], body: data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3])) }; break; }
    let p = null;
    try {
      const u = new URL(href, `http://${s.vhost}:${port}${s.page || '/'}`);
      if (new RegExp(`^${LOCAL_HOST_RX_SRC}$`, 'i').test(u.hostname) && (u.port || '80') === String(port)) p = u.pathname + u.search;
    } catch { /* ignore */ }
    if (!p) continue;
    const r = await fetchLocal(s.upstream, port, p, s.vhost);
    if (r && r.status === 200 && r.body.length && (/^image\//.test(r.type) || /\.(ico|png|svg|jpe?g|gif|webp)$/i.test(p))) {
      icon = { type: r.type || 'image/x-icon', body: r.body };
      break;
    }
  }
  iconCache.set(key, { at: Date.now(), icon });
  return icon;
}

// Иконка для «экрана Домой» на iPad: PNG 180×180, нарисованный кодом.
function makeAppIcon() {
  const W = 180;
  const raw = Buffer.alloc((W * 3 + 1) * W);
  const bg1 = [79, 70, 229];
  const bg2 = [124, 58, 237];
  const inBar = (x, y, top) => {
    const x0 = 40, x1 = 140, y0 = top, y1 = top + 26, r = 9;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < W; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const t = (x + y) / (2 * W);
      let c = bg1.map((v, i) => Math.round(v + (bg2[i] - v) * t));
      for (const top of [46, 77, 108]) {
        if (inBar(x, y, top)) {
          c = [255, 255, 255];
          if ((x - 60) ** 2 + (y - (top + 13)) ** 2 <= 25) c = [34, 197, 94];
        }
      }
      raw.set(c, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let appIcon = null;

function sameOriginPost(req) {
  if (!/application\/json/i.test(req.headers['content-type'] || '')) return false;
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

async function dashboardRequest(req, res) {
  const auth = await authorize(req.socket.remoteAddress);
  if (!auth.ok) return sendDenied(res, auth);
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, await fsp.readFile(DASHBOARD_HTML), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/api/state') return sendJson(res, apiState(auth));
    if (req.method === 'GET' && p.startsWith('/icon/')) {
      const icon = await findIcon(+p.slice(6));
      if (!icon) return send(res, 404, '', 'text/plain', { 'cache-control': 'max-age=30' });
      return send(res, 200, icon.body, icon.type, { 'cache-control': 'max-age=300' });
    }
    if (req.method === 'GET' && (p === '/apple-touch-icon.png' || p === '/app-icon.png' || p === '/favicon.ico')) {
      appIcon = appIcon || makeAppIcon();
      return send(res, 200, appIcon, 'image/png', { 'cache-control': 'max-age=86400' });
    }
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      return send(res, 200, JSON.stringify({
        name: 'Стенды', short_name: 'Стенды', start_url: '/', display: 'standalone',
        background_color: '#f5f5f7', theme_color: '#4f46e5', icons: [{ src: '/app-icon.png', sizes: '180x180', type: 'image/png' }],
      }), 'application/manifest+json');
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      if (!sameOriginPost(req)) return sendJson(res, { error: 'bad origin' }, 403);
      const body = await readBody(req);
      const port = Math.trunc(+body.port);
      if (p === '/api/hide') {
        const hidden = new Set(cfg.hiddenPorts);
        if (body.hidden) hidden.add(port); else hidden.delete(port);
        saveConfig({ hiddenPorts: [...hidden].sort((a, b) => a - b) });
      } else if (p === '/api/rename') {
        const names = { ...cfg.names };
        const name = String(body.name || '').trim().slice(0, 80);
        if (name) names[port] = name; else delete names[port];
        saveConfig({ names });
      } else if (p === '/api/include') {
        // «Показать» пропущенный порт: всегда считать его стендом (или вернуть автоматику)
        const included = new Set(cfg.includePorts);
        if (body.include) included.add(port); else included.delete(port);
        const patch = { includePorts: [...included].sort((a, b) => a - b) };
        if (body.include && cfg.hiddenPorts.includes(port)) patch.hiddenPorts = cfg.hiddenPorts.filter((x) => x !== port);
        saveConfig(patch);
      } else if (p === '/api/kind') {
        const kinds = { ...(cfg.kinds || {}) };
        const auto = (state.stands.find((s) => s.port === port) || {}).autoKind;
        if (body.kind === 'app' || body.kind === 'service') kinds[port] = body.kind; else delete kinds[port];
        if (kinds[port] && kinds[port] === auto) delete kinds[port]; // совпало с автоматикой — не храним
        saveConfig({ kinds });
      } else if (p === '/api/keep-awake') {
        saveConfig({ keepAwake: Boolean(body.on) });
      } else if (p !== '/api/rescan') {
        return sendJson(res, { error: 'not found' }, 404);
      }
      await kick();
      return sendJson(res, apiState(auth));
    }
    return send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    log('dashboard error:', e.message);
    return sendJson(res, { error: e.message }, 500);
  }
}

// ───────────────────────── keep awake ─────────────────────────

let caffeinate = null;
function updateKeepAwake(active) {
  const want = Boolean(cfg.keepAwake && active);
  if (want && !caffeinate) {
    caffeinate = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinate.on('exit', () => { caffeinate = null; });
    log('keep-awake: Mac не уснёт, пока есть стенды');
  } else if (!want && caffeinate) {
    caffeinate.kill();
    caffeinate = null;
    log('keep-awake: выключен');
  }
}

// ───────────────────────── main loop ─────────────────────────

let lastTsCheck = 0;
const mirrorLog = new Map(); // port -> last logged state

function desiredBind() {
  if (cfg.bind && cfg.bind !== 'auto') return cfg.bind;
  return ts.ip;
}

function exposureOf(s, a) {
  if (s.hidden) return 'hidden';
  if (!currentBind) return 'offline';
  if (a && a.addrs.has(currentBind)) return 'direct';
  const m = mirrors.get(s.port);
  if (m && m.endpoint.state === 'ok') return 'mirror';
  if (m && m.endpoint.state === 'busy') return 'busy';
  if (m && m.endpoint.state === 'starting') return 'starting';
  return 'error';
}

async function tick() {
  const t0 = Date.now();
  loadConfig();
  if (t0 - lastTsCheck > 15000) {
    const before = `${ts.state}|${ts.ip}|${ts.dnsName}`;
    await refreshTailscale();
    refreshTlsInBackground(); // `tailscale cert` может идти минуту — не блокируем сканирование
    lastTsCheck = Date.now();
    if (`${ts.state}|${ts.ip}|${ts.dnsName}` !== before) {
      log(`Tailscale: ${ts.state}${ts.ip ? ` · ${ts.ip}` : ''}${ts.dnsName ? ` · ${ts.dnsName}` : ''}${ts.login ? ` · ${ts.login}` : ''}`);
    }
  }

  const bind = desiredBind();
  if (bind !== currentBind) {
    for (const m of mirrors.values()) m.endpoint.close();
    mirrors.clear();
    if (tailDash) tailDash.close();
    tailDash = null;
    currentBind = bind;
    if (bind) log(`слушаю ${bind}; дашборд: ${dashUrls().join('  ')}`);
    else log('нет адреса Tailscale — стенды доступны только на этом Mac');
  }
  if (currentBind && (!tailDash || (['busy', 'error'].includes(tailDash.state) && Date.now() - tailDash.failedAt > 10000))) {
    if (tailDash) tailDash.close();
    tailDash = new Endpoint({ host: currentBind, port: cfg.dashboardPort, onRequest: dashboardRequest });
    tailDash.ready.then((st) => { if (st !== 'ok') log(`дашборд на ${currentBind}:${cfg.dashboardPort} не поднялся: ${tailDash && tailDash.error}`); });
  }

  const stands = await discover();

  const want = new Map();
  for (const s of stands) {
    const a = internal.get(s.port);
    if (currentBind && !s.hidden && !a.addrs.has(currentBind)) want.set(s.port, { s, a });
  }
  for (const [port, m] of mirrors) {
    const w = want.get(port);
    const failed = ['busy', 'error'].includes(m.endpoint.state) && Date.now() - m.endpoint.failedAt > 30000;
    if (!w || failed || w.a.pid !== m.pid) {
      m.endpoint.close();
      mirrors.delete(port);
      if (!w) { log(`− :${port}`); mirrorLog.delete(port); }
    } else {
      m.upstream = w.a.upstream;
    }
  }
  const opened = [];
  for (const [port, { s, a }] of want) {
    if (mirrors.has(port)) continue;
    const m = openMirror(port, a.upstream, currentBind, a.pid);
    mirrors.set(port, m);
    opened.push(m.endpoint.ready.then((st) => {
      const msg = st === 'ok' ? `+ :${port} → ${s.name} (${a.upstream})` : `! :${port} не удалось занять ${currentBind}:${port}: ${m.endpoint.error}`;
      if (mirrorLog.get(port) !== msg) { log(msg); mirrorLog.set(port, msg); }
    }));
  }
  await Promise.race([Promise.all(opened), new Promise((r) => setTimeout(r, 500))]);

  for (const s of stands) s.exposure = exposureOf(s, internal.get(s.port));
  state = { stands, at: Date.now(), ms: Date.now() - t0 };
  updateKeepAwake(stands.some((s) => !s.hidden));
}

let timer = null;
let running = false;
let again = false;
let waiters = [];

async function runTick() {
  if (running) { again = true; return; }
  running = true;
  clearTimeout(timer);
  const mine = waiters;
  waiters = [];
  try { await tick(); } catch (e) { log('ошибка сканирования:', e.stack || e); }
  running = false;
  mine.forEach((f) => f());
  if (again) { again = false; runTick(); return; }
  timer = setTimeout(runTick, cfg.scanIntervalMs);
}

function kick() {
  return new Promise((resolve) => { waiters.push(resolve); runTick(); });
}

function shutdown() {
  log('остановка');
  for (const ep of [...endpoints]) ep.close();
  if (caffeinate) caffeinate.kill();
  process.exit(0);
}

async function cliList(asJson) {
  await refreshTailscale();
  const stands = await discover();
  if (asJson) { console.log(JSON.stringify({ tailscale: ts, stands, skipped: skippedList }, null, 2)); return; }
  console.log(`Tailscale: ${ts.state}${ts.ip ? ` · ${ts.ip}` : ''}${ts.dnsName ? ` · ${ts.dnsName}` : ''}${ts.login ? ` · ${ts.login}` : ''}`);
  if (!stands.length) console.log('Стендов не найдено.');
  for (const s of stands) {
    console.log(`:${String(s.port).padEnd(6)} ${s.name.padEnd(28)} ${String(s.framework).padEnd(12)} ${s.branch ? `⎇ ${s.branch}  ` : ''}${s.title || ''}${s.vhost !== 'localhost' ? `  (${s.vhost})` : ''}${s.hidden ? '  [скрыт]' : ''}`);
  }
  if (skippedList.length) {
    console.log(`\nПропущенные (${skippedList.length}) — добавить: "includePorts" в ${CONFIG_PATH}`);
    for (const s of skippedList) console.log(`:${String(s.port).padEnd(6)} ${s.name.padEnd(28)} ${String(s.framework).padEnd(12)} ${s.type} · HTTP ${s.status}`);
  }
}

async function cliUrls() {
  await refreshTailscale();
  currentBind = desiredBind();
  if (!currentBind) {
    console.log(ts.state === 'NotInstalled'
      ? 'Tailscale не установлен. Установи его на Mac и iPad и войди одним аккаунтом (Sign in with Apple).'
      : `Tailscale: ${ts.state}. Войди в Tailscale на Mac (значок в строке меню).`);
    console.log(`Пока дашборд доступен только на этом Mac: http://localhost:${cfg.dashboardPort}`);
    return;
  }
  if (ts.dnsName && ts.certDomains.includes(ts.dnsName)) console.log(`На iPad:  https://${ts.dnsName}:${cfg.dashboardPort}`);
  for (const u of dashUrls()) console.log(`На iPad:  ${u}`);
  console.log(`На Mac:   http://localhost:${cfg.dashboardPort}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'serve';
  if (cmd === '--version' || cmd === 'version') { console.log(VERSION); return; }
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    console.log(`StandHub ${VERSION}\n\n  standhub.js            запустить (обычно это делает launchd)\n  standhub.js list       показать найденные стенды\n  standhub.js list --json\n  standhub.js urls       адреса дашборда\n\nКонфиг: ${CONFIG_PATH}`);
    return;
  }
  ensureConfigFile();
  loadConfig();
  if (cmd === 'list') { await cliList(argv.includes('--json')); return; }
  if (cmd === 'urls') { await cliUrls(); return; }

  const cn = await run('/usr/sbin/scutil', ['--get', 'ComputerName'], 3000);
  computerName = cn.stdout.trim() || os.hostname();
  log(`StandHub ${VERSION} (pid ${process.pid}, node ${process.version}), конфиг: ${CONFIG_PATH}`);

  localDash = new Endpoint({ host: '127.0.0.1', port: cfg.dashboardPort, onRequest: dashboardRequest, allowTls: false });
  const st = await localDash.ready;
  if (st !== 'ok') {
    log(`порт ${cfg.dashboardPort} занят (${localDash.error}) — StandHub уже запущен? Выхожу.`);
    process.exit(1);
  }
  log(`дашборд на Mac: http://localhost:${cfg.dashboardPort}`);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  if (process.env.STANDHUB_EXIT_WITH_STDIN) {
    // Запущены из StandHub.app: когда приложение закрывается (даже аварийно), stdin закрывается — выходим.
    process.stdin.on('end', shutdown);
    process.stdin.on('error', shutdown);
    process.stdin.resume();
  }
  runTick();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
} else {
  module.exports = { authorize, toLocalUrl, toExtUrls, fixCookie, isExcludedProcess, detectFramework, projectInfo, parseHtml, ts, cfg, applyConfig };
}
