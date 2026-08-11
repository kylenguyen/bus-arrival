import path from 'node:path';
import express from 'express';

import { arrivalsForMany } from './arrivals.js';
import { config, mockMode } from './config.js';
import { upstreamStats } from './lta.js';
import { PlaceIndex } from './places.js';
import { StopIndex } from './stops.js';
import type {
  ArrivalsResponse,
  BoardResponse,
  BoardStop,
  BusStop,
  Place,
  PlacesResponse,
} from './types.js';

/** DataMall documents BusStopCode as a 5-digit identifier. Junk is rejected
 *  here rather than reaching the fan-out. */
const STOP_CODE = /^\d{5}$/;

/** Six digits is a Singapore postal code and nothing else. */
const POSTAL_CODE = /^\d{6}$/;

/** Longer than any Singapore address; the same ceiling `PlaceIndex` applies. */
const MAX_QUERY = 64;

/** Ceiling on stops per request, so one caller cannot fan out to the whole feed. */
const MAX_STOPS = 8;
const DEFAULT_NEARBY = 8;

const stops = new StopIndex();
const places = new PlaceIndex();

const app = express();
app.disable('x-powered-by');

// Behind Traefik behind cloudflared. We do not log request IPs at all (see
// README), so this is only here to keep Express from guessing wrong if
// anything downstream ever needs the protocol.
app.set('trust proxy', true);

/** Comma-separated stop codes, validated, de-duplicated and capped. */
const parseCodes = (raw: unknown): string[] => {
  if (typeof raw !== 'string' || raw === '') return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const code = part.trim();
    if (STOP_CODE.test(code)) seen.add(code);
    if (seen.size >= MAX_STOPS) break;
  }
  return [...seen];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Readiness, plus the only visibility we have into what the account is being
 * charged for. Publicly reachable, so this stays at the level of "how much
 * traffic" — nothing per-IP or per-stop belongs here.
 *
 * Both indexes gate readiness. Gating on the address artefact is right *because
 * its failure is deterministic at image-build time*: the file is baked into the
 * image, so a bad one fails identically on every pod, and with `replicas: 1` and
 * the default RollingUpdate a pod that never becomes ready blocks the rollout
 * while the old one keeps serving. **If `data/sg-places.json.gz` ever moves to a
 * mounted volume or a network fetch, this gate must come off in the same
 * change** — the failure would then be environmental and per-pod, and gating on
 * it would take the whole board down for what is only a finder outage.
 *
 * `placesGeneratedAt` is the data's vintage, not the boot time: the dump is a
 * ~2020 scrape and how stale it is, is the number an operator actually wants.
 */
app.get('/healthz', (_req, res) => {
  const ready = stops.size > 0 && places.size > 0;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    stops: stops.size,
    stopsLoadedAt: stops.loadedAt?.toISOString() ?? null,
    places: places.size,
    placesGeneratedAt: places.generatedAt,
    mock: mockMode,
    ...upstreamStats(),
  });
});

/**
 * The whole page in one request: nearest stops (plus any pinned ones) with
 * their arrivals already attached. The client used to make one call to rank
 * stops and then one per stop; this collapses first paint to a single
 * round trip, which matters on mobile data.
 *
 * Carries a location, so: never cached, never logged.
 */
app.get('/api/board', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const located =
    Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

  const limit = clamp(Math.trunc(Number(req.query.limit)) || DEFAULT_NEARBY, 1, MAX_STOPS);
  const pinned = parseCodes(req.query.pinned);

  const board: BoardStop[] = [];
  const taken = new Set<string>();

  // Pinned first, in the order the client holds them.
  for (const code of pinned) {
    const stop = stops.get(code);
    if (!stop) continue;
    taken.add(stop.code);
    board.push({
      ...stop,
      distanceM: located ? stops.distanceFrom(stop, lat, lon) : null,
      pinned: true,
      services: null,
    });
  }

  if (located) {
    // Over-fetch by the pinned count so pinned stops that are also nearby do
    // not eat into the requested number of fresh suggestions.
    let added = 0;
    for (const stop of stops.nearby(lat, lon, limit + taken.size)) {
      if (taken.has(stop.code)) continue;
      taken.add(stop.code);
      board.push({ ...stop, pinned: false, services: null });
      if (++added >= limit) break;
    }
  }

  // `pinned` and `limit` are each capped at MAX_STOPS, but pinned stops are
  // pushed without counting against `limit` — so ?limit=8&pinned=<8 codes>
  // built a 16-stop board and a 16-call fan-out, double the ceiling README and
  // AGENTS.md both document as a guarantee. Cut before the fan-out, not after:
  // truncating the response would leave the calls already made. Pins are
  // pushed first, so this drops nearby suggestions before pinned stops. A user
  // with 8 pins gets 8 pinned cards and no suggestions, which is the stops they
  // explicitly asked for.
  board.length = Math.min(board.length, MAX_STOPS);

  const arrivals = await arrivalsForMany(board.map((stop) => stop.code));
  for (const stop of board) stop.services = arrivals.get(stop.code) ?? null;

  const body: BoardResponse = {
    stops: board,
    located,
    fetchedAt: new Date().toISOString(),
    mock: mockMode,
  };
  res.set('cache-control', 'no-store');
  res.json(body);
});

/** Refresh path: arrivals only, for the cards the client can actually see. */
app.get('/api/arrivals', async (req, res) => {
  const codes = parseCodes(req.query.stops);
  if (codes.length === 0) {
    res.status(400).json({ error: 'stops must be a comma-separated list of stop codes' });
    return;
  }

  const arrivals = await arrivalsForMany(codes);
  const body: ArrivalsResponse = {
    arrivals: codes.map((code) => ({ code, services: arrivals.get(code) ?? null })),
    fetchedAt: new Date().toISOString(),
    mock: mockMode,
  };
  res.set('cache-control', 'no-store');
  res.json(body);
});

/**
 * A stop as a finder row. The escape hatch shares one shape with the addresses
 * so the client keeps a single row → origin mapping and no branch.
 */
const stopRow = (stop: BusStop): Place => ({
  postal: null,
  code: stop.code,
  building: stop.description,
  block: '',
  road: stop.roadName,
  lat: stop.lat,
  lon: stop.lon,
});

/** What the query means, decided here so the client makes one call and no
 *  guesses of its own. */
const resolveQuery = (query: string): Place[] => {
  if (POSTAL_CODE.test(query)) {
    const place = places.get(query);
    return place ? [place] : [];
  }
  // Five digits are the stop-code escape hatch, and an exact `Map` lookup. It
  // stays because the address dump is a ~2020 scrape: in a new estate the code
  // on the pole may be the only way into the app at all.
  if (STOP_CODE.test(query)) {
    const stop = stops.get(query);
    return stop ? [stopRow(stop)] : [];
  }
  return places.search(query);
};

/**
 * The address finder, and the only door for a visitor who will not or cannot
 * share a location. It replaces the stop-name search route, at a **new path**
 * rather than the old one reused: `public/` is served with `maxAge: '1h'`, so a
 * stale `app.js` runs for up to an hour after a deploy, and a 404 makes its
 * existing `catch` say "Search is unavailable right now." — one degraded panel
 * over a working board — where a 200 with a different body shape would render
 * `undefined` rows.
 *
 * `private`, not `public`, max-age. The old route carried stop codes; this URL
 * carries whatever the user typed, routinely their own home postal code, and a
 * shared cache holding a stranger's address sits badly beside `/api/board`'s
 * coordinate being `no-store` and never logged. `private` keeps per-keystroke
 * caching in the user's own browser, which is the whole practical benefit at
 * this traffic level. **The query is never logged.**
 */
app.get('/api/places', (req, res) => {
  const raw = typeof req.query.q === 'string' ? req.query.q : '';
  // Truncated before it reaches the index: a longer query is a paste or an
  // attack, never an address.
  const query = raw.trim().slice(0, MAX_QUERY);
  if (query.length < 2) {
    res.status(400).json({ error: 'query must be at least 2 characters' });
    return;
  }

  res.set('cache-control', 'private, max-age=300');
  const body: PlacesResponse = { places: resolveQuery(query) };
  res.json(body);
});

app.use(
  express.static(path.join(import.meta.dirname, '..', 'public'), {
    maxAge: '1h',
    index: 'index.html',
  }),
);

const server = app.listen(config.port, () => {
  console.log(`bus board listening on :${config.port}${mockMode ? ' [MOCK MODE]' : ''}`);
  if (mockMode) {
    console.warn('LTA_ACCOUNT_KEY is not set — serving synthetic stops and timings.');
  }
});

// Load the stop list after binding the port so the container passes its
// startup probe even if DataMall is slow.
void stops.start();

// And the addresses, unconditionally — `mockMode` is about the DataMall key and
// this data is not LTA's. The consequence, documented rather than hidden: in
// mock mode the finder holds 121k real addresses over 12 synthetic stops, so a
// Jurong address shows demo stops 15 km away. Synchronous, ~200 ms of blocked
// loop, after `listen()` and behind the readiness probe's initial delay.
places.load();

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down`);
  stops.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
