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
 * The failure modes apply to `BusArrival` paths only. `BusStops` is always
 * served normally, so the stub can sit in `500` mode without the pod going
 * un-ready and taking the whole test with it. The stop feed returns one short
 * page (fewer than the client's PAGE_SIZE of 500) so `$skip` pagination
 * terminates after a single call.
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
  Services: [
    {
      ServiceNo: '10',
      Operator: 'SBST',
      NextBus: bus(120, 'SEA', 'WAB', 'SD', 1),
      NextBus2: bus(480, 'SDA', 'WAB', 'DD', 1),
      NextBus3: bus(900, 'LSD', '', 'BD', 0),
    },
    {
      ServiceNo: '2',
      Operator: 'GAS',
      NextBus: bus(45, 'SEA', 'WAB', 'SD', 1),
      NextBus2: bus(660, 'SEA', '', 'SD', 1),
      // Empty object is how DataMall spells "no third bus".
      NextBus3: {},
    },
    {
      ServiceNo: '857',
      Operator: 'SMRT',
      NextBus: bus(-30, 'SDA', 'WAB', 'DD', 1),
      NextBus2: {},
      NextBus3: {},
    },
  ],
});

const stopsBody = (skip) => ({
  'odata.metadata': 'http://localhost/stub/$metadata#BusStops',
  value: skip === 0 ? STOPS : [],
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
