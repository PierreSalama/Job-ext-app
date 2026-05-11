// Build proper multi-resolution icon.ico, icon.icns, and per-size PNGs from
// the source SVG. Requires `sharp` (auto-installed at build time via the
// devDependency; ships prebuilt binaries for every OS so no compile needed).
//
// Run: node build/make-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(__dirname, '..', 'src', 'icons');
const SVG_PATH = path.join(ICONS_DIR, 'icon.svg');

// All sizes a Windows ICO + macOS ICNS together need.
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

async function main() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    console.error('sharp not installed. Run `npm install sharp --no-save` first.');
    console.error('Falling back to bundling only the existing PNGs (build may fail if 256x256 is required).');
    sharp = null;
  }

  const pngs = {};

  if (sharp) {
    if (!fs.existsSync(SVG_PATH)) {
      console.error('Source SVG missing at', SVG_PATH);
      process.exit(1);
    }
    const svg = fs.readFileSync(SVG_PATH);
    for (const size of SIZES) {
      const out = path.join(ICONS_DIR, `icon${size}.png`);
      await sharp(svg, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toFile(out);
      pngs[size] = fs.readFileSync(out);
      console.log(`  ${size}x${size} -> ${out} (${pngs[size].length} bytes)`);
    }
  } else {
    // Fallback: use only what's already on disk.
    for (const size of SIZES) {
      const p = path.join(ICONS_DIR, `icon${size}.png`);
      if (fs.existsSync(p)) pngs[size] = fs.readFileSync(p);
    }
  }

  // ---- ICO ----
  const icoSizes = [16, 32, 48, 64, 128, 256].filter((s) => pngs[s]);
  const ico = buildIco(icoSizes.map((s) => ({ size: s, data: pngs[s] })));
  fs.writeFileSync(path.join(ICONS_DIR, 'icon.ico'), ico);
  console.log(`Wrote icon.ico (${ico.length} bytes, sizes: ${icoSizes.join(',')})`);

  // ---- ICNS ----
  const icns = buildIcns(pngs);
  fs.writeFileSync(path.join(ICONS_DIR, 'icon.icns'), icns);
  console.log(`Wrote icon.icns (${icns.length} bytes)`);
}

// ICO format: ICONDIR + n × ICONDIRENTRY + image bytes (raw PNG works on Vista+).
function buildIco(images) {
  const n = images.length;
  const headerSize = 6 + 16 * n;
  let offset = headerSize;
  const dir = Buffer.alloc(headerSize);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(n, 4);
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const sz = images[i].size >= 256 ? 0 : images[i].size; // 256+ encoded as 0
    dir.writeUInt8(sz, e);
    dir.writeUInt8(sz, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].data.length;
  }
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

// ICNS — embed PNG chunks for the standard Retina sizes.
function buildIcns(pngs) {
  const TYPE_BY_SIZE = {
    16:   'icp4',
    32:   'icp5',
    64:   'icp6',
    128:  'ic07',
    256:  'ic08',
    512:  'ic09',
    1024: 'ic10'
  };
  const chunks = [];
  for (const sz of Object.keys(TYPE_BY_SIZE).map(Number).sort((a, b) => a - b)) {
    const data = pngs[sz];
    if (!data) continue;
    const chunk = Buffer.alloc(8 + data.length);
    chunk.write(TYPE_BY_SIZE[sz], 0, 'ascii');
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

main().catch((e) => { console.error(e); process.exit(1); });
