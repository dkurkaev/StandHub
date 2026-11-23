// Фейковый dev-сервер со строгой проверкой Host, как у Vite ("Blocked request. This host is not allowed").
const http = require('http');
const crypto = require('crypto');
const PORT = +process.argv[2] || 45173;
const OK_HOST = `localhost:${PORT}`;

const srv = http.createServer((req, res) => {
  if (req.headers.host !== OK_HOST) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end(`Blocked request. This host (${req.headers.host}) is not allowed.`);
  }
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="/vite.svg"><title>Fake Vite &amp; Co</title></head><body><h1>Hello from fake Vite</h1></body></html>');
  }
  if (req.url === '/vite.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#646cff"/></svg>');
  }
  if (req.url === '/echo') {
    res.writeHead(200, { 'content-type': 'application/x-echo' /* не переписывается прокси */, 'access-control-allow-origin': req.headers.origin || '*' });
    return res.end(JSON.stringify(req.headers));
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: `http://localhost:${PORT}/landing` });
    return res.end();
  }
  if (req.url === '/cookie') {
    res.writeHead(200, { 'set-cookie': ['sid=abc; Domain=localhost; Path=/; Secure; HttpOnly; SameSite=None', 'theme=dark; Path=/'] });
    return res.end('ok');
  }
  if (req.url === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let n = 0;
    const t = setInterval(() => {
      res.write(`data: tick ${++n} ${Date.now()}\n\n`);
      if (n === 3) { clearInterval(t); res.end(); }
    }, 300);
    return;
  }
  if (req.method === 'POST' && req.url === '/upload') {
    let bytes = 0;
    req.on('data', (c) => { bytes += c.length; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ bytes })); });
    return;
  }
  res.writeHead(404); res.end();
});

srv.on('upgrade', (req, sock) => {
  if (req.headers.host !== OK_HOST) return sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const msg = Buffer.from(`hello origin=${req.headers.origin}`);
  sock.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
  sock.on('error', () => {});
  setTimeout(() => sock.end(), 300);
});

srv.listen(PORT, 'localhost', () => console.log(`fake vite on ${JSON.stringify(srv.address())}`));
