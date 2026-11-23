// Фейковый edge-прокси compose-стека: отвечает только на свой виртуальный хост (как Envoy/Traefik),
// встраивает свой адрес в страницу (как runtime-config с publicOrigin) и ставит куку на свой домен.
const http = require('http');

const PORT = +process.argv[2] || 58173;
const VHOST = process.argv[3] || 'demo-wt-abc123.localhost';
const ORIGIN = `http://${VHOST}:${PORT}`;

http.createServer((req, res) => {
  if (req.headers.host !== `${VHOST}:${PORT}`) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"error":"no route for host"}');
  }
  if (req.url === '/') {
    res.writeHead(307, { location: `${ORIGIN}/login` });
    return res.end();
  }
  if (req.url === '/login') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `session=xyz; Domain=${VHOST}; Path=/; HttpOnly`,
    });
    const config = JSON.stringify({ publicOrigin: ORIGIN, ws: `ws://${VHOST}:${PORT}/ws`, other: 'http://localhost:1/keep' });
    return res.end(`<!doctype html><html><head><title>Edge Login</title>
<script>window.__CONFIG__=${config};window.__ESCAPED__="${ORIGIN.replace(/\//g, '\\/')}";</script></head><body>login</body></html>`);
  }
  if (req.url === '/echo') {
    res.writeHead(200, { 'content-type': 'application/x-echo' /* не переписывается прокси */ });
    return res.end(JSON.stringify(req.headers));
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`fake edge on ${PORT} for ${VHOST}`));
