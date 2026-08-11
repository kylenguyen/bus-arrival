#!/usr/bin/env node
// Builds data/sg-places.json.gz — the postal-code index the finder searches.
//
// Run by hand, roughly never. It is deliberately not in package.json's scripts
// and never runs in CI: the artefact is committed, and a build step that pulled
// 57 MB from GitHub raw would put a third-party outage in the release path.
//
//   node tools/build-places.mjs
//   node tools/build-places.mjs --input buildings.json --out data/sg-places.json.gz
//
// The source is a scrape of OneMap's building/address records. Parsing the 57 MB
// document peaks around 600-800 MB of RSS; if V8 gives up, fetch it once with
// curl and re-run against the local copy with --input, or raise the ceiling with
// `node --max-old-space-size=2048 tools/build-places.mjs`. That is what --input
// is for — a re-run should not re-download.
//
// Output is byte-reproducible: the same input yields the same bytes, because the
// records are sorted by postal code before they are serialised. A regeneration
// diff is therefore data change and nothing else.
//
// No dependencies beyond `node:` builtins, on purpose: it has to run from a clean
// checkout without touching package.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const SOURCE_URL =
  'https://raw.githubusercontent.com/xkjyeah/singapore-postal-codes/master/buildings.json';
const LICENCE = 'Singapore Open Data Licence (OneMap, via xkjyeah/singapore-postal-codes)';
const ATTRIBUTION = 'Address data © OneMap / Singapore Land Authority, under the Singapore Open Data Licence.';
const DEFAULT_OUT = 'data/sg-places.json.gz';

// Singapore's bounding box, generous at the edges. Stronger than the 0,0 test the
// bus-stop feed needs: it also catches records where LONGITUDE and the misspelt
// LONGTITUDE disagree, which is the failure mode a coordinate swap produces.
const LAT_MIN = 1.15;
const LAT_MAX = 1.5;
const LON_MIN = 103.55;
const LON_MAX = 104.15;

const POSTAL = /^\d{6}$/;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};

/** "NIL" is how the source spells absent. Collapse whitespace so tokens are clean. */
const field = (value) => {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text === 'NIL' ? '' : text;
};

const loadSource = async () => {
  const input = arg('--input');
  if (input) {
    console.log(`reading ${input}`);
    return JSON.parse(readFileSync(input, 'utf8'));
  }
  console.log(`downloading ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`source returned ${res.status}`);
  return JSON.parse(await res.text());
};

const raw = await loadSource();
if (!Array.isArray(raw)) throw new Error('source is not an array');
console.log(`read ${raw.length} source records`);

const drops = { postal: 0, coord: 0, box: 0, unnamed: 0 };
const byPostal = new Map();
let collisions = 0;

for (const record of raw) {
  const postal = typeof record?.POSTAL === 'string' ? record.POSTAL.trim() : '';
  if (!POSTAL.test(postal)) {
    drops.postal += 1;
    continue;
  }

  const lat = Number(record.LATITUDE);
  const lon = Number(record.LONGITUDE);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    drops.coord += 1;
    continue;
  }
  if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) {
    drops.box += 1;
    continue;
  }

  const building = field(record.BUILDING);
  const block = field(record.BLK_NO);
  const road = field(record.ROAD_NAME);
  // Nothing to render and nothing to match on. A row that cannot be named cannot
  // be chosen, so it is weight in the index and in the image for no benefit.
  if (!building && !block && !road) {
    drops.unnamed += 1;
    continue;
  }

  const place = {
    postal,
    building,
    block,
    road,
    // The source carries ~14 significant digits. Past the sixth (~0.1 m) it is
    // noise, and dropping it is most of what gets the artefact under 2 MB.
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
  };

  const existing = byPostal.get(postal);
  if (existing) {
    collisions += 1;
    // A postal shared by a named building and a bare block should keep the name:
    // it is the better label and the only one that is searchable by name.
    if (existing.building || !building) continue;
  }
  byPostal.set(postal, place);
}

// Sorted, so the output is byte-reproducible and a regeneration diff shows only
// what actually changed in the data.
const places = [...byPostal.values()].sort((a, b) => a.postal.localeCompare(b.postal));

const generatedAt = new Date().toISOString().slice(0, 10);
const body = places.map((place) => JSON.stringify(place)).join(',\n');
// One record per line inside a normal JSON array: the line diffs of NDJSON at the
// parse speed of a single JSON.parse. The newlines cost ~120 KB raw and nothing
// once gzipped.
const text = `{"source":${JSON.stringify(SOURCE_URL)},"licence":${JSON.stringify(
  LICENCE,
)},"generatedAt":${JSON.stringify(generatedAt)},"count":${places.length},"places":[\n${body}\n]}\n`;

const gz = gzipSync(Buffer.from(text), { level: 9 });
const out = arg('--out') ?? DEFAULT_OUT;
writeFileSync(out, gz);

// --- summary ------------------------------------------------------------
// Everything a human needs to decide whether to commit the result, printed
// rather than assumed. The spot checks are the cheap guard against a transform
// that silently shifted fields by one.

const tokens = new Set();
for (const place of places) {
  for (const token of `${place.building} ${place.road}`.split(/[^A-Z0-9]+/)) {
    if (token.length >= 2) tokens.add(token);
  }
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

console.log('');
console.log(`source records      ${raw.length}`);
console.log(`  dropped, postal   ${drops.postal}  (not six digits, or "NIL")`);
console.log(`  dropped, coord    ${drops.coord}  (not a finite number)`);
console.log(`  dropped, box      ${drops.box}  (outside Singapore)`);
console.log(`  dropped, unnamed  ${drops.unnamed}  (no building, block or road)`);
console.log(`  postal collisions ${collisions}`);
console.log(`places written      ${places.length}`);
console.log(`distinct tokens     ${tokens.size}`);
console.log(`raw                 ${mb(text.length)}`);
console.log(`gzipped             ${mb(gz.length)}  -> ${out}`);
if (gz.length > 2 * 1048576) {
  console.log('');
  console.log('NOTE: above 2 MB gzipped. Switch the record form to positional arrays');
  console.log('      (["018956","MARINA BAY SANDS",...]) — ~30% smaller and faster to');
  console.log('      parse, at the cost of a loader that indexes by position.');
}

console.log('');
console.log('spot checks:');
for (const postal of ['018956', '310155', '738099']) {
  console.log(`  ${postal}  ${JSON.stringify(byPostal.get(postal) ?? null)}`);
}

console.log('');
console.log(`attribution required in README.md and the page footer:\n  ${ATTRIBUTION}`);
