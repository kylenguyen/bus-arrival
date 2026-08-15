#!/usr/bin/env node
/**
 * Stand-in for LTA DataMall, for exercising the client paths that mock mode
 * short-circuits past. Mock mode never enters `lta.ts:request()`, so "verified
 * in mock mode" verifies none of the retry, backoff or breaker behaviour —
 * this is what those checks are driven against.
 *
 * No dependencies beyond `node:` builtins, on purpose: it has to run from a
 * clean checkout without touching `package.json`.
 *
 *   node tools/stub-datamall.mjs
 *   LTA_ACCOUNT_KEY=stub-key LTA_BASE_URL=http://localhost:9099 node dist/index.js
 *
 * Env:
 *   STUB_PORT      listen port, default 9099
 *   STUB_MODE      initial mode, default 'ok'
 *   STUB_DELAY_MS  delay used by 'slow' mode, default 6000
 *
 * Modes (arrivals only — see below):
 *
 *   ok      200 with a plausible `Services` body
 *   empty   200 with a zero-length body — the 01:30 "buses aren't running" case
 *   429     429 with `Retry-After: 5`
 *   500     500 whose body contains a fake AccountKey, so a later `grep` of the
 *           application log can prove we never echo an upstream body
 *   slow    the `ok` body after STUB_DELAY_MS
 *
 * The failure modes apply to `BusArrival` paths only. `BusStops`, `BusRoutes`
 * and `BusServices` are always served normally, so the stub can sit in `500`
 * mode without the pod going un-ready and taking the whole test with it. The
 * stop feed returns one short page (fewer than the client's PAGE_SIZE of 500)
 * so `$skip` pagination terminates after a single call; the route feed is 611
 * records over the same grid — services '10', '2', '857' plus loop '359' — so
 * its `$skip` walk genuinely turns a second page. An `ok` arrivals body lists
 * only the services whose route segment (SEGMENTS below) covers the stop, so
 * the two feeds always agree about who stops where.
 *
 * Control endpoints, all GET so they are one curl each. Any path starting with
 * `/_` is a control path and is deliberately NOT counted in the stats:
 *
 *   GET /_mode                    -> {"mode":"ok","overrides":{}}
 *   GET /_mode?set=429            -> switches the global mode at runtime
 *   GET /_mode?set=500&code=10002 -> mode for one stop code only
 *   GET /_mode?clear=10002        -> drops that override ('all' drops the lot)
 *   GET /_stats                   -> {"total":N,"byPath":{...},"timestamps":[...]}
 *   GET /_stats?reset=1           -> clears the counters, then reports the empty set
 *
 * Per-code overrides exist because the interesting checks are about telling two
 * upstream states apart *inside one board request* — an empty stop next to a
 * failing one — and a single global mode can only produce one of them at a time.
 * A code with no override follows the global mode.
 *
 * `byPath` is keyed by pathname without the query string, so driving 25 stop
 * codes does not produce 25 keys. Every request is also logged to stdout with
 * its full query string, which is what the "exactly one request, and its path
 * is /v3/BusArrival?BusStopCode=10001" check reads.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 9099);
const DELAY_MS = Number(process.env.STUB_DELAY_MS ?? 6000);
const MODES = ['ok', 'empty', '429', '500', 'slow'];

/** Fake key material. Never a real one; the point is to grep for it. */
const FAKE_KEY = 'FAKEKEY-DO-NOT-ECHO-0123456789';

let mode = MODES.includes(process.env.STUB_MODE ?? '') ? process.env.STUB_MODE : 'ok';

/** Per-stop-code mode, consulted ahead of the global one. @type {Map<string, string>} */
const overrides = new Map();

let total = 0;
/** @type {Map<string, number>} */
const byPath = new Map();
/** @type {number[]} */
const timestamps = [];

/**
 * 250 stops: fewer than PAGE_SIZE so the client stops after page 0, but enough
 * that `nearby()` has something to rank. Codes are 5 digits because task 7
 * tightens the validator to /^\d{5}$/; 10001 and 10002 exist by name because
 * later verifications name them.
 */
const STOPS = Array.from({ length: 250 }, (_, i) => {
  const code = String(10001 + i);
  return {
    BusStopCode: code,
    RoadName: `Stub Road ${(i % 20) + 1}`,
    Description: `Stub Stop ${code}`,
    // Spread around the city centre so nearest-neighbour ordering is not a tie.
    Latitude: 1.3521 + (i % 25) * 0.001,
    Longitude: 103.8198 + Math.floor(i / 25) * 0.001,
  };
});

/** Minute-of-day to DataMall's HHMM strings; wraps so a late leg crosses midnight. */
const hhmm = (minuteOfDay) => {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
};

/** [start, end) over STOPS indexes; codes are 10001 + index. */
const range = (start, end) => Array.from({ length: end - start }, (_, i) => start + i);

/** STOPS index → stub stop code. */
const codeAt = (index) => String(10001 + index);

/**
 * Each service's segment of the 250-stop grid, [start, end) over STOPS
 * indexes. The single source of truth for who stops where: ROUTES and
 * SERVICES are generated from it, and `arrivalsBody` consults it, so the
 * arrivals feed can never name a service at a stop its route does not serve.
 * That agreement is load-bearing for the route page — a service link tapped
 * on a stub board card must land its `?stop=` on-route, not in the
 * stale-query fallthrough.
 */
const SEGMENTS = {
  10: { operator: 'SBST', start: 0, end: 125 },
  2: { operator: 'GAS', start: 50, end: 150 },
  857: { operator: 'SMRT', start: 100, end: 160 },
  // The loop; its route below calls the origin again as the final stop.
  359: { operator: 'TTS', start: 200, end: 240 },
};

/** Whether `serviceNo`'s segment covers this stop code. */
const serves = (serviceNo, stopCode) => {
  const seg = SEGMENTS[serviceNo];
  const index = Number(stopCode) - 10001;
  return seg !== undefined && index >= seg.start && index < seg.end;
};

const routeLeg = (serviceNo, operator, direction, indexes) =>
  indexes.map((stopIndex, i) => ({
    ServiceNo: serviceNo,
    Operator: operator,
    Direction: direction,
    StopSequence: i + 1,
    BusStopCode: String(10001 + stopIndex),
    // 0.4 km per hop, one decimal, cumulative from the origin like the real feed.
    Distance: Math.round(i * 4) / 10,
    WD_FirstBus: hhmm(330 + i),
    WD_LastBus: hhmm(1410 + i),
    SAT_FirstBus: hhmm(335 + i),
    SAT_LastBus: hhmm(1405 + i),
    SUN_FirstBus: hhmm(345 + i),
    SUN_LastBus: hhmm(1400 + i),
  }));

/** One route leg from a service's SEGMENTS entry, so no range lives twice. */
const leg = (serviceNo, direction, indexes) =>
  routeLeg(serviceNo, SEGMENTS[serviceNo].operator, direction, indexes);
const span = (serviceNo) => range(SEGMENTS[serviceNo].start, SEGMENTS[serviceNo].end);

/**
 * Routes for the SEGMENTS services — trunks '10', '2', '857' plus the loop
 * '359' — laid over the same 250-stop grid so every route stop resolves to a
 * stub stop. 611 records — deliberately more than one 500-record page, so the
 * client's `$skip` walk turns a second page instead of terminating on page 0
 * the way BusStops does.
 */
const ROUTES = [
  ...leg('10', 1, span('10')),
  ...leg('10', 2, span('10').reverse()),
  ...leg('2', 1, span('2')),
  ...leg('2', 2, span('2').reverse()),
  ...leg('857', 1, span('857')),
  ...leg('857', 2, span('857').reverse()),
  // The loop: one direction only, origin called again as the final stop.
  ...leg('359', 1, [...span('359'), SEGMENTS['359'].start]),
];

const serviceEntry = (ServiceNo, Operator, Direction, Category, OriginCode, DestinationCode, LoopDesc = '') => ({
  ServiceNo,
  Operator,
  Direction,
  Category,
  OriginCode,
  DestinationCode,
  AM_Peak_Freq: '08-12',
  AM_Offpeak_Freq: '10-15',
  PM_Peak_Freq: '08-12',
  PM_Offpeak_Freq: '12-18',
  LoopDesc,
});

/** Both directions of a trunk, termini read off its SEGMENTS entry. */
const trunkEntries = (serviceNo) => {
  const seg = SEGMENTS[serviceNo];
  return [
    serviceEntry(serviceNo, seg.operator, 1, 'TRUNK', codeAt(seg.start), codeAt(seg.end - 1)),
    serviceEntry(serviceNo, seg.operator, 2, 'TRUNK', codeAt(seg.end - 1), codeAt(seg.start)),
  ];
};

/** One record per direction, origins/destinations matching ROUTES' first and last stops. */
const SERVICES = [
  ...trunkEntries('10'),
  ...trunkEntries('2'),
  ...trunkEntries('857'),
  // Loop services carry one direction, origin == destination, LoopDesc naming
  // the turnaround — here the road of stop index 239, the far end of the leg.
  serviceEntry('359', SEGMENTS['359'].operator, 1, 'FEEDER', codeAt(200), codeAt(200), 'Stub Road 20'),
];

const bus = (offsetSeconds, load, feature, type, monitored) => ({
  OriginCode: '75009',
  DestinationCode: '77009',
  EstimatedArrival: new Date(Date.now() + offsetSeconds * 1000).toISOString(),
  Latitude: '1.3521',
  Longitude: '103.8198',
  VisitNumber: '1',
  Load: load,
  Feature: feature,
  Type: type,
  Monitored: monitored,
});

const arrivalsBody = (stopCode) => ({
  'odata.metadata': 'http://localhost/stub/$metadata#BusArrivalv2/@Element',
  BusStopCode: stopCode,
  // Only the services whose SEGMENTS range covers this stop, so the arrivals
  // feed agrees with BusRoutes by construction. The loop '359' is deliberately
  // absent — it has never appeared in the arrivals body, and its route-page
  // states are driven from the route feed alone. A stop no segment covers
  // (indexes 160–199 and 240–249) reports an empty Services list, which is a
  // healthy answer, not a failure.
  Services: [
    {
      ServiceNo: '10',
      Operator: SEGMENTS['10'].operator,
      NextBus: bus(120, 'SEA', 'WAB', 'SD', 1),
      NextBus2: bus(480, 'SDA', 'WAB', 'DD', 1),
      NextBus3: bus(900, 'LSD', '', 'BD', 0),
    },
    {
      ServiceNo: '2',
      Operator: SEGMENTS['2'].operator,
      NextBus: bus(45, 'SEA', 'WAB', 'SD', 1),
      NextBus2: bus(660, 'SEA', '', 'SD', 1),
      // Empty object is how DataMall spells "no third bus".
      NextBus3: {},
    },
    {
      ServiceNo: '857',
      Operator: SEGMENTS['857'].operator,
      NextBus: bus(-30, 'SDA', 'WAB', 'DD', 1),
      NextBus2: {},
      NextBus3: {},
    },
  ].filter((svc) => serves(svc.ServiceNo, stopCode)),
});

const stopsBody = (skip) => ({
  'odata.metadata': 'http://localhost/stub/$metadata#BusStops',
  value: skip === 0 ? STOPS : [],
});

const routesBody = (skip) => ({
  'odata.metadata': 'http://localhost/stub/$metadata#BusRoutes',
  value: ROUTES.slice(skip, skip + 500),
});

const servicesBody = (skip) => ({
  'odata.metadata': 'http://localhost/stub/$metadata#BusServices',
  value: skip === 0 ? SERVICES : [],
});

const json = (res, status, payload, headers = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
  return status;
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Control plane. Never counted, so a polling test harness cannot pollute the
  // very numbers it is reading.
  if (pathname.startsWith('/_')) {
    if (pathname === '/_mode') {
      const clear = url.searchParams.get('clear');
      if (clear !== null) {
        if (clear === 'all') overrides.clear();
        else overrides.delete(clear);
        console.log(`[stub] override cleared -> ${clear}`);
      }

      const set = url.searchParams.get('set');
      if (set !== null) {
        if (!MODES.includes(set)) {
          json(res, 400, { error: `unknown mode ${set}`, modes: MODES });
          return;
        }
        const code = url.searchParams.get('code');
        if (code === null) {
          mode = set;
          console.log(`[stub] mode -> ${mode}`);
        } else {
          overrides.set(code, set);
          console.log(`[stub] mode for ${code} -> ${set}`);
        }
      }
      json(res, 200, { mode, overrides: Object.fromEntries(overrides), modes: MODES });
      return;
    }
    if (pathname === '/_stats') {
      if (url.searchParams.get('reset') !== null) {
        total = 0;
        byPath.clear();
        timestamps.length = 0;
        console.log('[stub] stats reset');
      }
      json(res, 200, { total, byPath: Object.fromEntries(byPath), timestamps });
      return;
    }
    json(res, 404, { error: `unknown control path ${pathname}` });
    return;
  }

  total += 1;
  byPath.set(pathname, (byPath.get(pathname) ?? 0) + 1);
  timestamps.push(Date.now());

  const done = (status, note) => {
    console.log(`[stub] ${req.method} ${req.url} -> ${status} (${note})`);
  };

  // Route metadata: always healthy for the same reason as BusStops below —
  // these are daily bulk pulls, not the arrivals hot path the failure modes
  // exist for, and breaking them would stop the RouteIndex ever loading.
  if (pathname.includes('BusRoutes')) {
    const skip = Number(url.searchParams.get('$skip') ?? '0');
    const at = Number.isFinite(skip) && skip >= 0 ? skip : 0;
    const body = routesBody(at);
    json(res, 200, body);
    done(200, `routes skip=${at} n=${body.value.length}`);
    return;
  }

  if (pathname.includes('BusServices')) {
    const skip = Number(url.searchParams.get('$skip') ?? '0');
    const at = Number.isFinite(skip) && skip >= 0 ? skip : 0;
    json(res, 200, servicesBody(at));
    done(200, `services skip=${at}`);
    return;
  }

  // Stop list: always healthy, whatever the mode. An arrivals-driven failure
  // injection must not stop the pod becoming ready.
  if (pathname.includes('BusStops')) {
    const skip = Number(url.searchParams.get('$skip') ?? '0');
    json(res, 200, stopsBody(Number.isFinite(skip) ? skip : 0));
    done(200, `stops skip=${skip}`);
    return;
  }

  // Matches BusArrivalv2 and v3/BusArrival alike, so the stub survives task 1.
  if (pathname.includes('BusArrival')) {
    const stopCode = url.searchParams.get('BusStopCode') ?? '00000';
    switch (overrides.get(stopCode) ?? mode) {
      case 'empty':
        // Zero-length body with a JSON content type: what the guide describes
        // outside operating hours, and what makes res.json() throw today.
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '0' });
        res.end();
        done(200, 'empty');
        return;
      case '429':
        json(res, 429, { message: 'Too many requests' }, { 'retry-after': '5' });
        done(429, 'throttled');
        return;
      case '500':
        json(res, 500, {
          fault: {
            faultstring: `Internal error processing request for AccountKey ${FAKE_KEY}`,
            detail: { errorcode: 'stub.InternalError' },
          },
        });
        done(500, 'fake key in body');
        return;
      case 'slow':
        setTimeout(() => {
          if (res.writableEnded) return;
          json(res, 200, arrivalsBody(stopCode));
          done(200, `slow ${DELAY_MS}ms`);
        }, DELAY_MS);
        return;
      default:
        json(res, 200, arrivalsBody(stopCode));
        done(200, 'ok');
        return;
    }
  }

  json(res, 404, { error: `stub has no handler for ${pathname}` });
  done(404, 'unhandled path');
});

server.listen(PORT, () => {
  console.log(`[stub] DataMall stub on http://localhost:${PORT} mode=${mode} delay=${DELAY_MS}ms`);
  console.log(
    `[stub] control: /_mode /_mode?set=<${MODES.join('|')}>[&code=<stop>] /_mode?clear=<stop|all> /_stats /_stats?reset=1`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
