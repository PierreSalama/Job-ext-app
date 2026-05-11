// Generate simple but recognizable PNG icons for the extension at 16/32/48/128.
// No external deps — uses Node's zlib + Buffer to write minimal valid PNGs.
// Design: rounded purple gradient square with a white "J" mark and a small green checkmark badge.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(size, pixelFn) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function inRoundRect(x, y, size, radius) {
  const r = radius;
  if (x >= r && x < size - r) return y >= 0 && y < size;
  if (y >= r && y < size - r) return x >= 0 && x < size;
  // corners
  const corners = [[r, r], [size - r - 1, r], [r, size - r - 1], [size - r - 1, size - r - 1]];
  for (const [cx, cy] of corners) {
    const dx = x - cx, dy = y - cy;
    if ((x < r || x >= size - r) && (y < r || y >= size - r)) {
      return dx * dx + dy * dy <= r * r;
    }
  }
  return false;
}

function pixelFor(x, y, size) {
  const radius = Math.max(2, Math.round(size * 0.18));
  if (!inRoundRect(x, y, size, radius)) return [0, 0, 0, 0];
  // Gradient indigo→violet
  const t = (x + y) / (size * 2);
  const r = lerp(99, 139, t);
  const g = lerp(102, 92, t);
  const b = lerp(241, 246, t);
  // Letter "J" — a vertical bar with a hook on the bottom
  const cx = size / 2, cy = size / 2;
  const barW = Math.max(1, Math.round(size * 0.10));
  const barH = Math.round(size * 0.50);
  const barX = cx - barW / 2 + Math.round(size * 0.04);
  const barY0 = cy - barH / 2 - Math.round(size * 0.05);
  const barY1 = cy + barH / 2 - Math.round(size * 0.05);
  const isJBar = (x >= barX && x <= barX + barW && y >= barY0 && y <= barY1);
  // Hook: arc at bottom
  const hookR = Math.round(size * 0.18);
  const hookCx = barX - hookR + barW / 2;
  const hookCy = barY1;
  const dh = Math.hypot(x - hookCx, y - hookCy);
  const isHook = dh <= hookR && dh >= hookR - barW && y >= barY1 - 1;
  // Top crossbar of J
  const topY = barY0;
  const isTop = y >= topY && y <= topY + barW && x >= barX - Math.round(size * 0.10) && x <= barX + barW + Math.round(size * 0.04);
  if (isJBar || isHook || isTop) return [255, 255, 255, 255];
  // Green check badge bottom-right
  if (size >= 32) {
    const bcx = size - Math.round(size * 0.22);
    const bcy = size - Math.round(size * 0.22);
    const br = Math.round(size * 0.16);
    const dd = Math.hypot(x - bcx, y - bcy);
    if (dd <= br) {
      // White ring
      if (dd > br - Math.max(1, Math.round(size * 0.025))) return [255, 255, 255, 255];
      // Checkmark inside
      const lx = x - bcx, ly = y - bcy;
      // diagonal: from (-br/2, 0) to (-br/6, br/3) to (br/2, -br/3)
      const onCheck =
        (lx >= -br * 0.45 && lx <= -br * 0.1 && Math.abs((ly - br * 0.1) - (lx + br * 0.45) * 0.9) <= 1.4) ||
        (lx >= -br * 0.1 && lx <= br * 0.5 && Math.abs((ly - br * 0.4) + (lx + br * 0.1) * 1.1) <= 1.4);
      if (onCheck) return [255, 255, 255, 255];
      return [16, 185, 129, 255];
    }
  }
  return [r, g, b, 255];
}

for (const size of [16, 32, 48, 128]) {
  const buf = makePng(size, pixelFor);
  writeFileSync(new URL(`./icon${size}.png`, import.meta.url), buf);
  console.log(`wrote icon${size}.png (${buf.length}b)`);
}
