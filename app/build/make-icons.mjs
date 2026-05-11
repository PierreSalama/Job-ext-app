// Pure-Node icon builder. Reads the source PNGs (16/32/48/128) and writes
// a multi-resolution Windows .ico and a macOS .icns file alongside them.
// No external deps — implements the ICO + ICNS binary formats directly.
//
// Run: node build/make-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(__dirname, '..', 'src', 'icons');

// ---------- ICO ----------
// Format: ICONDIR (6 bytes) + n × ICONDIRENTRY (16 bytes each) + n × image data.
// Image data is raw PNG bytes (Vista+ supports embedded PNG inside ICO).
function buildIco(pngFiles) {
  const images = pngFiles.map(({ size, file }) => {
    const data = fs.readFileSync(file);
    return { size, data };
  });
  const n = images.length;
  const headerSize = 6 + 16 * n;
  let offset = headerSize;
  const dir = Buffer.alloc(headerSize);
  // ICONDIR
  dir.writeUInt16LE(0, 0);   // reserved
  dir.writeUInt16LE(1, 2);   // type=1 (icon)
  dir.writeUInt16LE(n, 4);   // count
  // ICONDIRENTRYs
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const sz = images[i].size === 256 ? 0 : images[i].size; // 256 encoded as 0
    dir.writeUInt8(sz, e);              // width
    dir.writeUInt8(sz, e + 1);          // height
    dir.writeUInt8(0, e + 2);           // palette
    dir.writeUInt8(0, e + 3);           // reserved
    dir.writeUInt16LE(1, e + 4);        // planes
    dir.writeUInt16LE(32, e + 6);       // bits per pixel
    dir.writeUInt32LE(images[i].data.length, e + 8);  // bytes
    dir.writeUInt32LE(offset, e + 12);  // offset
    offset += images[i].data.length;
  }
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

// ---------- ICNS ----------
// Format: header "icns" + total length, then a series of typed chunks.
// We use the PNG-embedded chunk types which all modern macOS versions read:
//   ic07 = 128×128, ic08 = 256×256 (not used here), ic09 = 512×512 (not used),
//   ic11 = 32×32@2x (=64), ic12 = 16×16@2x (=32), ic13 = 128×128@2x (=256).
// For our 16/32/48/128 sources we just embed the matching closest sizes.
function buildIcns(pngFiles) {
  // Map size → ICNS chunk OSType (4 ASCII bytes)
  const SIZE_TO_TYPE = {
    16:  'icp4',  // 16x16
    32:  'icp5',  // 32x32
    64:  'icp6',  // 64x64 (not present in our sources)
    128: 'ic07',  // 128x128
    256: 'ic08',  // 256x256
    512: 'ic09'
  };
  const chunks = [];
  for (const { size, file } of pngFiles) {
    const type = SIZE_TO_TYPE[size];
    if (!type) continue;
    const data = fs.readFileSync(file);
    const chunk = Buffer.alloc(8 + data.length);
    chunk.write(type, 0, 'ascii');
    chunk.writeUInt32BE(8 + data.length, 4);
    data.copy(chunk, 8);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

// ---------- Main ----------
const sources = [16, 32, 48, 128]
  .map((size) => ({ size, file: path.join(ICONS_DIR, `icon${size}.png`) }))
  .filter((s) => fs.existsSync(s.file));

if (sources.length === 0) {
  console.error('No source PNGs found in', ICONS_DIR);
  process.exit(1);
}

const ico = buildIco(sources);
fs.writeFileSync(path.join(ICONS_DIR, 'icon.ico'), ico);
console.log(`Wrote icon.ico (${ico.length} bytes, ${sources.length} resolutions)`);

const icns = buildIcns(sources);
fs.writeFileSync(path.join(ICONS_DIR, 'icon.icns'), icns);
console.log(`Wrote icon.icns (${icns.length} bytes, ${sources.length} resolutions)`);

// Linux electron-builder wants either a single 512x512 PNG or a directory
// with multiple sizes. We already have the directory.
console.log('Linux: src/icons/ contains the multi-res PNGs.');
