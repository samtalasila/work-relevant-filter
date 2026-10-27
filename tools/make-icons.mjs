// Draws the extension icons into icons/. Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 48, 128];
const SUPERSAMPLE = 4;
const BLUE = [0x3b, 0x6f, 0xd8];
const WHITE = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coordinates are in a unit square. Funnel: a wide top, tapering to a stem.
const FUNNEL = [[0.24, 0.26], [0.76, 0.26], [0.55, 0.52], [0.55, 0.76], [0.45, 0.76], [0.45, 0.52]];
const CORNER = 0.22;

function inRoundedSquare(x, y) {
  const dx = Math.max(CORNER - x, x - (1 - CORNER), 0);
  const dy = Math.max(CORNER - y, y - (1 - CORNER), 0);
  return dx * dx + dy * dy <= CORNER * CORNER;
}

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let coverage = 0;
      let white = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!inRoundedSquare(x, y)) continue;
          coverage++;
          if (inPolygon(x, y, FUNNEL)) white++;
        }
      }
      const i = (py * size + px) * 4;
      if (coverage === 0) continue;
      const mix = white / coverage;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(BLUE[c] * (1 - mix) + WHITE[c] * mix);
      rgba[i + 3] = Math.round((255 * coverage) / samples);
    }
  }
  return rgba;
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) writeFileSync(join(outDir, `icon${size}.png`), encodePng(size, render(size)));
