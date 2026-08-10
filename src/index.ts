import path from 'node:path';
import express from 'express';

import { arrivalsForMany } from './arrivals.js';
import { config, mockMode } from './config.js';
import { upstreamStats } from './lta.js';
import { StopIndex } from './stops.js';
import type { ArrivalsResponse, BoardResponse, BoardStop } from './types.js';

const STOP_CODE = /^[A-Za-z0-9]{4,8}$/;

/** Ceiling on stops per request, so one caller cannot fan out to the whole feed. */
const MAX_STOPS = 25;
const DEFAULT_NEARBY = 15;

const stops = new StopIndex();

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
 */
app.get('/healthz', (_req, res) => {
  const ready = stops.size > 0;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    stops: stops.size,
    stopsLoadedAt: stops.loadedAt?.toISOString() ?? null,
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

/** Fallback for visitors who will not or cannot share a location. */
app.get('/api/stops', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  if (query.trim().length < 2) {
    res.status(400).json({ error: 'query must be at least 2 characters' });
    return;
  }
  res.set('cache-control', 'public, max-age=300');
  res.json({ stops: stops.search(query) });
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

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down`);
  stops.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
