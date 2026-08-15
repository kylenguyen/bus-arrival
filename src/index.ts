import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';

import { arrivalsForMany } from './arrivals.js';
import { config, mockMode } from './config.js';
import { upstreamStats } from './lta.js';
import { PlaceIndex } from './places.js';
import { RouteIndex } from './routes.js';
import { StopIndex } from './stops.js';
import type {
  ArrivalsResponse,
  BoardResponse,
  BoardStop,
  BusStop,
  Place,
  PlacesResponse,
  RouteDirectionPayload,
  RouteEndpoint,
  RouteResponse,
  StopResponse,
} from './types.js';

/** DataMall documents BusStopCode as a 5-digit identifier. Junk is rejected
 *  here rather than reaching the fan-out. */
const STOP_CODE = /^\d{5}$/;

/** Six digits is a Singapore postal code and nothing else. */
const POSTAL_CODE = /^\d{6}$/;

/** DataMall spells service numbers like `61` and `972M` — short alphanumerics. */
const SERVICE_NO = /^[A-Za-z0-9]{1,5}$/;

/** Longer than any Singapore address; the same ceiling `PlaceIndex` applies. */
const MAX_QUERY = 64;

/** Ceiling on stops per request, so one caller cannot fan out to the whole feed. */
const MAX_STOPS = 8;
const DEFAULT_NEARBY = 8;

/**
 * What every file in `public/` is served with — the two shells and the assets
 * alike, which is the point: they are one unit and must never be cached apart.
 *
 * `no-cache` is "keep the copy, revalidate before reusing it", not "do not store
 * it". `express.static` already sends `ETag` and `Last-Modified`, so the revalidation
 * costs a conditional request and comes back a ~200-byte `304` rather than the body.
 *
 * This used to be `maxAge: '1h'`, which bought that round trip at two prices. A
 * deploy stayed invisible to a returning visitor for an hour, which is
 * indistinguishable from a deploy that never happened and cost an afternoon of
 * looking in the wrong place. Worse, the hour was per file: a browser could hold a
 * 59-minute-old `app.js` against a fresh `index.html` and render the page
 * half-updated. Six small assets at this traffic level do not justify either.
 *
 * Fingerprinted filenames under `immutable` would buy the round trip back, at the
 * cost of a build step that rewrites references in both shells and an import map to
 * keep the module specifiers in `app.js`/`route.js` resolving. Worth it if the
 * conditional requests ever show up in the numbers; not before.
 */
const STATIC_CACHE_CONTROL = 'no-cache';

const stops = new StopIndex();
const places = new PlaceIndex();
const routes = new RouteIndex();

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
    // Observability only, deliberately outside `ready`: the route feed serves
    // the route page, and the board's readiness must never depend on it.
    routes: routes.size,
    routesLoadedAt: routes.loadedAt?.toISOString() ?? null,
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
 * rather than the old one reused: a page opened before a deploy goes on running
 * the `app.js` it already loaded until someone reloads it, and a 404 makes that
 * copy's existing `catch` say "Search is unavailable right now." — one degraded
 * panel over a working board — where a 200 with a different body shape would
 * render `undefined` rows.
 *
 * That window used to be an hour wide for fresh loads too, because `public/` was
 * served with `maxAge: '1h'`; it is now bounded by revalidation (see
 * `STATIC_CACHE_CONTROL`). The open-tab case remains, which is why the new path
 * stays.
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

/**
 * Joins a route stop code against the stop list for display. A code missing
 * from `StopIndex` — the two feeds can drift for a day — degrades instead of
 * dropping the stop: the code stands in as its own description, and the `0,0`
 * coordinate is the same "unknown" a handful of real stops already carry.
 */
const joinRouteStop = (code: string): RouteEndpoint => {
  const stop = stops.get(code);
  return stop
    ? { code: stop.code, description: stop.description, roadName: stop.roadName, lat: stop.lat, lon: stop.lon }
    : { code, description: code, roadName: '', lat: 0, lon: 0 };
};

/**
 * One service's full route, both directions, stops joined with names and
 * coordinates. Carries nothing about the caller — a service number is public
 * knowledge — so unlike `/api/places` a shared cache is welcome here, and
 * `max-age=300` sits well under the daily refresh of the feed behind it.
 */
app.get('/api/route/:service', (req, res) => {
  const raw = typeof req.params.service === 'string' ? req.params.service : '';
  if (!SERVICE_NO.test(raw)) {
    res.status(400).json({ error: 'service must be 1-5 letters or digits' });
    return;
  }

  const service = routes.get(raw);
  if (!service) {
    res.status(404).json({ error: 'no such service' });
    return;
  }

  const directions: RouteDirectionPayload[] = [];
  for (const direction of [1, 2] as const) {
    const found = service.directions.get(direction);
    const firstCode = found?.stops[0];
    const lastCode = found?.stops[found.stops.length - 1];
    if (!found || firstCode === undefined || lastCode === undefined) continue;
    directions.push({
      direction,
      origin: joinRouteStop(firstCode),
      destination: joinRouteStop(lastCode),
      firstBus: found.firstBus,
      lastBus: found.lastBus,
      // Re-numbered 1..n: `RouteDirection` holds codes in StopSequence order
      // but DataMall's raw sequence numbers can skip, and the page wants a
      // dense index, not the feed's bookkeeping.
      stops: found.stops.map((code, i) => ({ seq: i + 1, ...joinRouteStop(code) })),
    });
  }

  const body: RouteResponse = {
    serviceNo: service.serviceNo,
    operator: service.operator,
    loop: service.loop,
    loopDesc: service.loopDesc === '' ? null : service.loopDesc,
    directions,
    fetchedAt: new Date().toISOString(),
    mock: mockMode,
  };
  res.set('cache-control', 'public, max-age=300');
  res.json(body);
});

/**
 * Everything the stop page needs that is not live arrivals: the stop, its
 * opposite-kerb pair when one can be inferred, and every service calling there
 * with first/last bus and headway. Like `/api/route/:service` — a stop code is
 * public knowledge, so a shared cache is welcome, and the schedule behind this
 * is static day-to-day. Live arrivals stay on `/api/arrivals` (`no-store`).
 *
 * The error bodies (`bad_code`, `unknown_stop`) are machine-readable tokens
 * pinned by the stop-page contract in docs/stop-page-plan.md — the client
 * branches on them to pick its guard screen.
 */
app.get('/api/stop/:code', (req, res) => {
  const raw = typeof req.params.code === 'string' ? req.params.code : '';
  if (!STOP_CODE.test(raw)) {
    res.status(400).json({ error: 'bad_code' });
    return;
  }

  const stop = stops.get(raw);
  if (!stop) {
    res.status(404).json({ error: 'unknown_stop' });
    return;
  }

  const opposite = stops.oppositeOf(raw);
  const body: StopResponse = {
    stop,
    opposite: opposite ? { code: opposite.code, description: opposite.description } : null,
    services: routes.servicesAt(raw),
    fetchedAt: new Date().toISOString(),
    mock: mockMode,
  };
  res.set('cache-control', 'public, max-age=300');
  res.json(body);
});

/**
 * The stop page shell, read once at startup — it ships with `dist/` and cannot
 * change under a running process, and a missing file should fail the boot, not
 * the ten-thousandth request.
 *
 * The three tag constants are the shell's own generic meta, verbatim: injection
 * works by exact-string replacement of a whole tag, so the file served
 * unreplaced (unknown code, or `express.static` fetching `/stop.html` directly)
 * is already valid generic HTML with no `__TOKEN__` text to leak into a tab
 * title. stop.html's head comment says the same thing from its side — edit a
 * tag there and its constant here in the same commit.
 */
const STOP_SHELL = readFileSync(path.join(import.meta.dirname, '..', 'public', 'stop.html'), 'utf8');
const STOP_TITLE_TAG = '<title>bus stop · ezbus</title>';
const STOP_OG_TITLE_TAG = '<meta property="og:title" content="bus stop · ezbus" />';
const STOP_OG_URL_TAG = '<meta property="og:url" content="https://ezbus.sg/stop" />';

/** Escapes text bound for the stop shell's meta tags — attribute values
 *  included, hence the quotes. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );

/**
 * The stop page shell. Lenient about `:code` for the same reason `/bus/:service`
 * is — the client renders its own guard, and a 404 here would swap that page for
 * the browser's. When the code is a known stop, the tab title and OG tags are
 * injected per-request so a shared link unfurls as the stop rather than as the
 * app; anything else gets the generic shell untouched.
 */
app.get('/stop/:code', (req, res) => {
  const raw = typeof req.params.code === 'string' ? req.params.code : '';
  const stop = STOP_CODE.test(raw) ? stops.get(raw) : undefined;

  let html = STOP_SHELL;
  if (stop) {
    const title = escapeHtml(`${stop.code} · ${stop.description}, ${stop.roadName}`);
    html = html
      .replace(STOP_TITLE_TAG, `<title>${title}</title>`)
      .replace(STOP_OG_TITLE_TAG, `<meta property="og:title" content="${title}" />`)
      .replace(
        STOP_OG_URL_TAG,
        `<meta property="og:url" content="https://ezbus.sg/stop/${stop.code}" />`,
      );
  }

  res.set('Cache-Control', STATIC_CACHE_CONTROL).type('html').send(html);
});

/**
 * The route page shell. Deliberately lenient about `:service` — the client
 * renders its own "no such service" state, and a 404 here would swap that page
 * for the browser's. Same revalidation as the rest of `public/`.
 *
 * `headers` rather than `maxAge`: `send` derives its own `Cache-Control` from
 * `maxAge`, so passing both would put two intentions in one response.
 */
app.get('/bus/:service', (_req, res) => {
  res.sendFile(path.join(import.meta.dirname, '..', 'public', 'route.html'), {
    headers: { 'Cache-Control': STATIC_CACHE_CONTROL },
  });
});

app.use(
  express.static(path.join(import.meta.dirname, '..', 'public'), {
    index: 'index.html',
    // Overrides the `public, max-age=0` that `send` derives from the default
    // `maxAge`. `serve-static` runs this after `send` has set its own header
    // and before the response goes out, so this is the one that lands.
    setHeaders: (res) => {
      res.setHeader('Cache-Control', STATIC_CACHE_CONTROL);
    },
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

// Routes ride the same pattern, with one difference: the ~26k-record walk can
// take a while, and nothing gates on it — /healthz reports its count without
// ever letting it hold readiness.
void routes.start();

// And the addresses, unconditionally — `mockMode` is about the DataMall key and
// this data is not LTA's. The consequence, documented rather than hidden: in
// mock mode the finder holds 121k real addresses over 12 synthetic stops, so a
// Jurong address shows demo stops 15 km away. Synchronous, ~200 ms of blocked
// loop, after `listen()` and behind the readiness probe's initial delay.
places.load();

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down`);
  stops.stop();
  routes.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
