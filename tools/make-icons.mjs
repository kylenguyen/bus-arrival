// Renders the ezbus home-screen icons from the same geometry as the favicon in
// index.html — a mosaic-turquoise tile with the board's own double decker on it —
// and the 1200×630 Open Graph card (`public/og-card.png`): the same mark with the
// wordmark under it on the full-bleed turquoise.
//
// Written as a generator rather than checked-in binaries with no source, because
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

function png(raw, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The OG card: 1200×630 (the summary_large_image aspect), full-bleed turquoise,
// the bus mark centred above the wordmark. One static card for the whole site.
//
// The wordmark is set in one ink, `--on-accent` white, not the h1's two-tone —
// on the accent ground the accent half of the split would vanish, and white on
// the turquoise is exactly the favicon's treatment of the identity. The letters
// are stencilled from straight strokes with round caps (sdSegment already gives
// both), which is the set-square world style-guide.md asks for: block numerals,
// not a soft display face we would have to embed a rasteriser to render.

const OG_W = 1200;
const OG_H = 630;

// Mark placement: favicon design units → card pixels. Scale 11 puts the glyph
// (20 units wide) at 220 px, sitting over a 588 px wordmark like an icon above
// a name rather than competing with it.
const OG_MARK_SCALE = 11;
const OG_MARK_OX = OG_W / 2 - (BOX / 2) * OG_MARK_SCALE; // glyph centred on x
const OG_MARK_OY = 116 - BODY.y * OG_MARK_SCALE; // body's top edge at y=116

// Wordmark metrics, in card pixels. y runs 0..1 over the x-height in LETTERS.
const OG_XH = 110; // x-height
const OG_WORD_Y = 420; // top of the x-height; bottom lands at 530
const OG_LETTER_W = 84;
const OG_LETTER_GAP = 42;
const OG_WORD_STROKE = 20; // vs the mark's 2 × 11 = 22 — near-equal weights

// Each letter is polyline strokes in a unit box: x 0..1 across the letter,
// y 0..1 down the x-height (b's ascender goes negative, above it).
const LETTERS = {
  e: [
    [[0, 0], [1, 0]],
    [[0, 0.5], [1, 0.5]],
    [[0, 1], [1, 1]],
    [[0, 0], [0, 1]],
    [[1, 0], [1, 0.5]],
  ],
  z: [
    [[0, 0], [1, 0]],
    [[1, 0], [0, 1]],
    [[0, 1], [1, 1]],
  ],
  b: [
    [[0, -0.45], [0, 1]],
    [[0, 0], [1, 0]],
    [[1, 0], [1, 1]],
    [[0, 1], [1, 1]],
  ],
  u: [
    [[0, 0], [0, 1]],
    [[0, 1], [1, 1]],
    [[1, 0], [1, 1]],
  ],
  s: [
    [[0, 0], [1, 0]],
    [[0, 0], [0, 0.5]],
    [[0, 0.5], [1, 0.5]],
    [[1, 0.5], [1, 1]],
    [[0, 1], [1, 1]],
  ],
};

/** The wordmark's strokes as [ax, ay, bx, by] in card pixels, centred on x. */
function wordSegments(word) {
  const width = word.length * OG_LETTER_W + (word.length - 1) * OG_LETTER_GAP;
  let x0 = (OG_W - width) / 2;
  const segments = [];
  for (const ch of word) {
    for (const [[ax, ay], [bx, by]] of LETTERS[ch]) {
      segments.push([
        x0 + ax * OG_LETTER_W,
        OG_WORD_Y + ay * OG_XH,
        x0 + bx * OG_LETTER_W,
        OG_WORD_Y + by * OG_XH,
      ]);
    }
    x0 += OG_LETTER_W + OG_LETTER_GAP;
  }
  return segments;
}

function renderOgCard() {
  const [gr, gg, gb] = hex(GROUND);
  const [ir, ig, ib] = hex(INK);
  const segments = wordSegments('ezbus');
  const wordHalf = OG_WORD_STROKE / 2;
  // Mark distances come back in design units; scaling them into pixels keeps
  // the stroke width and the antialiasing ramp correct at card size.
  const markHalf = (STROKE / 2) * OG_MARK_SCALE;

  const raw = Buffer.alloc(OG_H * (OG_W * 4 + 1));
  for (let y = 0; y < OG_H; y++) {
    const rowStart = y * (OG_W * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < OG_W; x++) {
      const pxc = x + 0.5;
      const pyc = y + 0.5;

      const u = (pxc - OG_MARK_OX) / OG_MARK_SCALE;
      const v = (pyc - OG_MARK_OY) / OG_MARK_SCALE;
      const body =
        Math.abs(sdRoundBox(u, v, BODY.x + BODY.w / 2, BODY.y + BODY.h / 2, BODY.w / 2, BODY.h / 2, BODY.r)) *
          OG_MARK_SCALE -
        markHalf;
      const deck = sdSegment(u, v, BODY.x, DECK_Y, BODY.x + BODY.w, DECK_Y) * OG_MARK_SCALE - markHalf;
      let d = Math.min(body, deck);
      for (const w of WHEELS) d = Math.min(d, sdCircle(u, v, w.x, w.y, w.r) * OG_MARK_SCALE);
      for (const [ax, ay, bx, by] of segments) {
        d = Math.min(d, sdSegment(pxc, pyc, ax, ay, bx, by) - wordHalf);
      }

      const ink = cover(d, 1);
      const i = rowStart + 1 + x * 4;
      raw[i] = Math.round(gr + (ir - gr) * ink);
      raw[i + 1] = Math.round(gg + (ig - gg) * ink);
      raw[i + 2] = Math.round(gb + (ib - gb) * ink);
      raw[i + 3] = 255; // full-bleed card: no tile, no transparency
    }
  }
  return raw;
}

for (const size of [180, 192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, png(render(size), size, size));
  console.log(`public/icon-${size}.png`);
}

writeFileSync(new URL('../public/og-card.png', import.meta.url), png(renderOgCard(), OG_W, OG_H));
console.log('public/og-card.png');
