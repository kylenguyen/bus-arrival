// Renders the ezbus home-screen icons from the same geometry as the favicon in
// index.html: a mosaic-turquoise tile with the board's own double decker on it.
//
// Written as a generator rather than three checked-in binaries with no source, because
// the mark will change again and a PNG cannot be diffed. Run it after touching the
// geometry below, or after `--accent` moves in styles.css:
//
//   node tools/make-icons.mjs
//
// No dependencies and no rasteriser on the box, so the shapes are signed distance
// fields sampled once per pixel. An SDF gives exact coverage at the edge, which is
// better antialiasing than supersampling and a great deal less code — every shape here
// is a rounded box, a segment or a circle, and all three have closed-form distances.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

// The 32-unit design space the favicon is drawn in. Everything below is in those units
// and scales to whatever pixel size is asked for.
const BOX = 32;
const GROUND = '#0a6a72'; // --accent, light scheme
const INK = '#ffffff'; // --on-accent, light scheme

// Body 6–26 across and 6–20 down, wheels to 25.4: the mark spans 62% of the tile and so
// sits inside the 80% safe zone Android crops a `maskable` icon to.
const BODY = { x: 6, y: 6, w: 20, h: 14, r: 3 };
const DECK_Y = 13;
const STROKE = 2;
const WHEELS = [
  { x: 11, y: 23, r: 2.4 },
  { x: 21, y: 23, r: 2.4 },
];
const TILE_RADIUS = 4;

const sdRoundBox = (px, py, cx, cy, hw, hh, r) => {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
};

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

const sdSegment = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
};

/** Distance → coverage, over one pixel of the output grid. */
const cover = (d, px) => Math.min(1, Math.max(0, 0.5 - d / px));

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

function render(size) {
  const px = BOX / size; // one output pixel, in design units
  const [gr, gg, gb] = hex(GROUND);
  const [ir, ig, ib] = hex(INK);
  const half = STROKE / 2;

  // RGBA, one byte each, with a filter byte at the head of every row (PNG filter 0).
  const raw = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      // Pixel centre, in design units.
      const u = (x + 0.5) * px;
      const v = (y + 0.5) * px;

      const tile = cover(sdRoundBox(u, v, BOX / 2, BOX / 2, BOX / 2, BOX / 2, TILE_RADIUS), px);

      // The body outline: the rounded box's distance folded about zero is the stroke.
      const body = Math.abs(sdRoundBox(u, v, BODY.x + BODY.w / 2, BODY.y + BODY.h / 2, BODY.w / 2, BODY.h / 2, BODY.r)) - half;
      const deck = sdSegment(u, v, BODY.x, DECK_Y, BODY.x + BODY.w, DECK_Y) - half;
      let mark = Math.min(body, deck);
      for (const w of WHEELS) mark = Math.min(mark, sdCircle(u, v, w.x, w.y, w.r));

      const ink = cover(mark, px);
      const i = rowStart + 1 + x * 4;
      // Ink over ground. The colour is *not* premultiplied by the tile's coverage —
      // PNG alpha is straight, and scaling the channels here as well would darken the
      // rounded corners into a hairline outline.
      raw[i] = Math.round(gr + (ir - gr) * ink);
      raw[i + 1] = Math.round(gg + (ig - gg) * ink);
      raw[i + 2] = Math.round(gb + (ib - gb) * ink);
      raw[i + 3] = Math.round(255 * tile);
    }
  }
  return raw;
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, png(size));
  console.log(`public/icon-${size}.png`);
}
