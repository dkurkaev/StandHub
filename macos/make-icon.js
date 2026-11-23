// Рисует иконку приложения в PNG (RGBA) нужного размера: node make-icon.js 1024 icon.png
// Скруглённый квадрат по сетке macOS (824/1024) с градиентом и тремя «стойками» стендов.
const fs = require('fs');
const zlib = require('zlib');

const S = +process.argv[2] || 1024;
const out = process.argv[3] || 'icon.png';
const k = S / 1024;
const body = { x0: 100, y0: 100, x1: 924, y1: 924, r: 185 };
const bars = [282, 452, 622].map((top) => ({ x0: 250, y0: top, x1: 774, y1: top + 120, r: 38 }));

function inRound(x, y, R) {
  if (x < R.x0 || x > R.x1 || y < R.y0 || y > R.y1) return false;
  const cx = Math.min(Math.max(x, R.x0 + R.r), R.x1 - R.r);
  const cy = Math.min(Math.max(y, R.y0 + R.r), R.y1 - R.r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R.r * R.r;
}

function sample(x, y) { // координаты в сетке 1024
  if (!inRound(x, y, body)) return null;
  for (const b of bars) {
    if (inRound(x, y, b)) {
      const cy = (b.y0 + b.y1) / 2;
      if ((x - 330) ** 2 + (y - cy) ** 2 <= 26 * 26) return [34, 197, 94];
      if (x > 400 && x < 700 && Math.abs(y - cy) < 9) return [199, 210, 254];
      return [255, 255, 255];
    }
  }
  const t = ((x - 100) + (y - 100)) / 1648;
  return [Math.round(99 + (124 - 99) * t), Math.round(102 + (58 - 102) * t), Math.round(241 + (237 - 241) * t)];
}

const N = 4; // суперсэмплинг 4×4 для сглаживания краёв
const row = S * 4 + 1;
const raw = Buffer.alloc(row * S);
for (let py = 0; py < S; py++) {
  raw[py * row] = 0;
  for (let px = 0; px < S; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < N; sy++) {
      for (let sx = 0; sx < N; sx++) {
        const c = sample((px + (sx + 0.5) / N) / k, (py + (sy + 0.5) / N) / k);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
    }
    const o = py * row + 1 + px * 4;
    if (a) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); }
    raw[o + 3] = Math.round((a / (N * N)) * 255);
  }
}

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(out, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
