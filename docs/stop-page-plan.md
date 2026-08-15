# Stop page (`/stop/:stop_number`) — implementation plan

Direction D ("Flagboard") from the approved design proposals
(https://claude.ai/code/artifact/161a5c48-4de0-4227-a5be-34361deec08d): the flag plate
(code / name / road / distance / pin / share / opposite flip) over the arrivals board
(numeric sort) and a flat "Today at this stop" schedule table with a Weekday/Sat/Sun
control. Share = system share sheet with clipboard fallback; Opposite = plain navigation
to the paired stop; unknown codes land on an in-page guard, never a bare 404.

Rules of the road for every task: **AGENTS.md wins on behaviour, style-guide.md wins on
looks.** Read both before touching anything. Pure modules (`public/*-logic.js`) take
`now` as a parameter and never touch DOM/fetch/storage; glue modules (`public/*.js`)
apply results in one-line assignments. Every interpolation goes through a local
`escape()`. User-facing copy is pinned verbatim by tests — reuse existing strings
exactly where a state is shared with another page.

Execution: tasks run sequentially (shared working tree and `dist/`), each by a separate
agent. T1/T2/T4 are logically independent of each other; T3 needs T1+T2; T5 needs
T3+T4; T6 needs T5; T7 needs everything.

---

## Shared contract (fixed — do not renegotiate mid-task)

### `GET /api/stop/:code`

- `:code` must match `/^\d{5}$/` → else `400 {"error":"bad_code"}`.
- Unknown code → `404 {"error":"unknown_stop"}`.
- `Cache-Control: public, max-age=300` (schedule data is static day-to-day; live
  arrivals stay on the existing `no-store` `/api/arrivals`).
- 200 body:

```json
{
  "stop": { "code": "54261", "description": "Blk 331", "roadName": "Ang Mo Kio Ave 1",
            "lat": 1.36, "lon": 103.84 },
  "opposite": { "code": "54269", "description": "Opp Blk 331" },
  "services": [
    { "serviceNo": "22", "operator": "SBST",
      "firstBus": { "wd": "0530", "sat": "0530", "sun": "0545" },
      "lastBus":  { "wd": "2330", "sat": "2330", "sun": "2315" },
      "freq": { "peak": "06-08", "offpeak": "10-15" } }
  ],
  "fetchedAt": "2026-08-16T06:32:00.000Z",
  "mock": false
}
```

- `opposite` is `null` when no confident pair exists.
- `services` sorted with `localeCompare(..., undefined, { numeric: true })` (same as
  arrivals in `src/lta.ts`).
- Times are DataMall HHMM strings; empty string means "no data" (DataMall `-`,
  already normalised by `toTimes` in `src/lta.ts`).
- A service calling at the stop in both directions appears **once**: per day-type,
  `firstBus` = earlier, `lastBus` = later, where a last-bus time before `0400` sorts as
  next-day (past-midnight buses).
- `freq.peak` / `freq.offpeak` are DataMall's `AM_Peak_Freq` / `AM_Offpeak_Freq` raw
  strings (`"06-08"`), `null` when absent. Client formats for display.

### Shell route

`GET /stop/:code` serves `public/stop.html` (lenient about the param, like
`/bus/:service` at `src/index.ts:346`), with per-stop `<title>`/OG meta injected by
string replacement when the code is known; generic meta otherwise.

### Client storage

- Pins: reuse `bus-board.pins.v1` exactly as `app.js` reads/writes it. Bookmark = pin.
- Location: read-only use of `bus-board.loc.v1` for the distance chip (12 h staleness
  ceiling, same as the board). No prompting from the stop page on load; no second
  first-run.

### Opposite-stop heuristic (server-side, `StopIndex`)

1. Candidates: different code, finite non-zero coords, haversine ≤ 120 m.
2. Must share `roadName` (exact match).
3. Description reciprocity wins: `norm(b) === 'opp ' + norm(a)` or vice versa
   (case-insensitive, trimmed). If several, nearest wins.
4. Otherwise drop same-kerb candidates — description pairs where one is
   `bef <base>`/`aft <base>` of the other's base — then take the nearest survivor.
5. Nothing left → `null` (the client omits the chip; never disabled).

---

## T1 — Backend: per-stop schedule reverse index + frequency ingestion

**Why:** DataMall BusRoutes per-stop `firstBus`/`lastBus` is already fetched and parsed
(`toRouteStop`, `src/lta.ts:342`) but discarded in `buildRoutes` (`src/routes.ts:74-78`,
only the seq-1 terminus times survive). There is no stop→services index. BusServices
frequency fields are not ingested at all.

**Scope (files):**
- `src/types.ts`: add `ServiceFreq { peak: string|null; offpeak: string|null }` and
  `StopService { serviceNo; operator; firstBus: RouteStopTimes; lastBus: RouteStopTimes;
  freq: ServiceFreq }`. Do **not** change `RouteDirection` — the route page's shape and
  the loop-duplicate reasoning at `src/routes.ts:8-13` stay untouched.
- `src/lta.ts`: extend `fetchAllServices`/`toService` to capture `AM_Peak_Freq` and
  `AM_Offpeak_Freq` (normalise `-`/missing to `null`) onto `ServiceInfo`.
- `src/routes.ts`: inside `buildRoutes`, before flattening, accumulate a
  `Map<stopCode, StopService[]>`: for each (service, direction, record), merge into the
  service's entry for that stop (min first / max last per day-type; last < "0400" sorts
  next-day; empty string never beats a real time). Dedupe loop services that visit a
  stop twice. Sort each list numerically. Expose `RouteIndex.servicesAt(code): StopService[]`
  (empty array for unknown stop) alongside the existing `get`.
- `src/mock.ts`: put per-stop first/last on **every** mock route record (not just
  `i === 0`) and add freq to mock services, so mock mode exercises the same paths.
  Keep the `SERVICES_BY_STOP` ↔ `ROUTE_SHAPES` inverse invariant — `src/mock.test.ts`
  pins it.
- `tools/stub-datamall.mjs`: already emits per-record `WD_/SAT_/SUN_` times; add the two
  freq fields to its BusServices payload if missing.
- Tests: new cases (new file or extended `src/routes.test.ts`) — see verification.

**Do not:** change `RouteResponse`, the route page, or any existing pinned copy string.

**Verification (must all pass before the task is done):**
1. `npm test` fully green (this also proves no existing shape/test broke).
2. New unit tests cover, minimum:
   - `servicesAt` returns the right services for a stop appearing in two directions of
     one service, merged min-first/max-last per day-type.
   - Past-midnight merge: last buses `2330` vs `0010` → `0010` wins as latest.
   - Empty-string times never override real times.
   - A loop service visiting the same stop twice appears once.
   - Unknown stop → `[]`.
   - Freq fields survive from BusServices records to `StopService.freq`; missing → null.
3. Mock invariant test still green; mock `servicesAt('10001')` numerically sorted
   `['52','167','985']` order with times present.

## T2 — Backend: opposite-stop pairing in `StopIndex`

**Scope:** `src/stops.ts` only (plus tests). Add `oppositeOf(code): BusStop | null`
implementing the heuristic in the shared contract, reusing the existing haversine
(`distanceFrom`) and the `0,0`-coordinate exclusion already used by `nearby`
(`src/stops.ts:82`). Keep it O(n) per call over the in-memory list (n ≈ 5 000, called
per page load, fine) or precompute per refresh — implementer's choice; document which.

**Verification:**
1. `npm test` green.
2. Unit tests (mock stops are ready-made fixtures — `src/mock.ts:9-22`):
   - Reciprocal pair: `10001 "Blk 101"` ↔ `10009 "Opp Blk 101"` both ways.
   - Same-kerb rejected: `30031 "Example Hawker Ctr"` vs `30039 "Bef Example Hawker
     Ctr"` → not paired by rule 3; falls to rule 4 same-kerb drop → expected result
     documented in the test (these two are ~50 m apart, same road: assert `null`).
   - Different road never pairs even when within 120 m (synthetic fixture).
   - Distance ceiling: same road, reciprocal names, 300 m apart (synthetic) → `null`.
   - Unknown code → `null`; stop with `0,0` coords → `null`.

## T3 — Backend: `GET /api/stop/:code`

**Scope:** `src/index.ts`: new endpoint per the shared contract, registered near
`/api/route/:service` (`src/index.ts:293`), using `stops.get`, `stops.oppositeOf`
(T2) and `routes.servicesAt` (T1). Include `mock` flag like the other endpoints.
Keep the handler thin; if any assembly logic needs branching, extract a pure function
and unit-test it.

**Verification:**
1. `npm test` green.
2. Mock-mode smoke (no `DATAMALL_ACCOUNT_KEY` → mock data; check `src/config.ts` for
   the exact env semantics):
   - `npm run build && node dist/index.js` (note the port from `src/config.ts`).
   - `curl -s localhost:PORT/api/stop/10001` → `stop.description "Blk 101"`,
     `opposite.code "10009"`, services `52,167,985` each with `firstBus`, `lastBus`,
     `freq`; `mock: true`.
   - `curl -s localhost:PORT/api/stop/10011` → `opposite` null or per-heuristic result —
     assert it matches T2's tested expectation for the station-exit pair (same kerb).
   - `curl -s -o /dev/null -w '%{http_code}' /api/stop/99999` → 404;
     `/api/stop/abc` → 400; `/api/stop/123456` → 400.
   - `curl -sI /api/stop/10001 | grep -i cache-control` → `public, max-age=300`.
3. Kill the server afterwards.

## T4 — Frontend: pure module `public/stop-logic.js` + tests

**Scope:** new `public/stop-logic.js`, following `public/route-logic.js` conventions
(JSDoc, `now` as parameter, no DOM/fetch/storage). Check how `src/route-logic.test.ts`
imports a `public/` module and mirror it exactly in new `src/stop-logic.test.ts`.

Exports (names indicative):
- `parseStopPath(pathname)` → 5-digit code or `null`; regex `^\/stop\/([^/]+)\/?$`,
  decode, then validate `/^\d{5}$/` (lenient shell, strict client — same split as
  `parseServicePath`, `public/route-logic.js:118`).
- `dayTypeFor(date)` → `'wd' | 'sat' | 'sun'` (en-SG week; note in a comment that SG
  public holidays run Sunday schedules and are out of scope).
- `fmtHHMM('0530')` → `'05:30'`; empty/invalid → `null`.
- `fmtFreq('06-08')` → `'6–8 min'`; `null` → `null`.
- `serviceStatus({ now, firstBus, lastBus, dayType })` →
  `{ state: 'running' | 'ended' | 'before-first' }` with past-midnight handling: a
  `lastBus` before `0400` belongs to the previous day-type's span (a 00:30 check
  against Friday's `0010` last bus must say `ended` only after 00:10). Keep the rule
  simple and documented in tests; edge cases beyond the 04:00 convention are accepted
  imprecision.
- `distanceMeters(lat1, lon1, lat2, lon2)` — only if no client-side haversine already
  exists in a pure module (check `public/origin.js` and `route-logic.js` first; reuse
  if present).
- `sharePayload(stop, origin)` → `{ title: '54261 · Blk 331, Ang Mo Kio Ave 1',
  url: origin + '/stop/54261' }`.

**Verification:**
1. `npm test` green; new tests cover every export: path parsing (valid, `/stop/abc`,
   `/stop/123456`, trailing slash, URL-encoded), day types across a week, HHMM
   formatting incl. empty, freq formatting, status transitions around first bus, last
   bus, and the past-midnight window, share payload escaping/shape.
2. No DOM/fetch/storage/`Date.now()` inside the module (tests pass `now` explicitly).

## T5 — Frontend: `stop.html` + `stop.js` + CSS + shell route with meta injection

**Scope:**
- `public/stop.html`: third shell, modelled line-by-line on `public/route.html` (same
  head block: theme-color pair, `color-scheme`, font preload with `crossorigin`,
  modulepreload of pure modules, manifest, favicon). Ships a skeleton plate + skeleton
  arrivals rows inline (no spinner, ever). Contains literal placeholder tokens
  (e.g. `__STOP_TITLE__`, `__STOP_OG__`) that the server replaces; the static-file
  fallback must still be valid generic HTML if served unreplaced, so place placeholders
  inside comments the server swaps, or default-generic text the server rewrites —
  implementer picks the cleaner mechanism and documents it in a comment.
- `src/index.ts`: `app.get('/stop/:code', ...)` **above** `express.static`, lenient
  param, `Cache-Control: no-cache`; reads `stop.html` once at startup, per-request
  replaces title/OG placeholders with HTML-escaped `"{code} · {description}, {roadName}"`
  when `stops.get(code)` hits, generic otherwise. OG tags: `og:title`, `og:description`
  (`"Next buses now · first & last bus today"`), `og:url`.
- `public/stop.js`: glue, modelled on `route.js`. State machine
  `loading | ready | missing | badcode | failed`. Flow: `parseStopPath` → invalid →
  `badcode` guard (5-digit entry + "Back to board"); fetch `/api/stop/:code` → 404 →
  `missing` guard ("No stop with code NNNNN." + code re-entry + back); throw → `failed`
  ("Try again" verb, reuse route page copy where identical). Ready: render plate
  (code in `.meta-code`-style stencil, name, road, distance chip only when
  `bus-board.loc.v1` is fresh ≤ 12 h — compute with the pure haversine; omit otherwise),
  pin star (read/toggle `bus-board.pins.v1`, aria-pressed, confirmation title "Pinned
  to your board"), Share (`navigator.share({title, url})` when
  `window.isSecureContext && navigator.share`; else clipboard `writeText` and swap the
  verb label to "Copied ✓" for 2 s — **no await between the click and
  `navigator.share`**, same transient-activation rule as geolocation, AGENTS.md:540),
  opposite chip as a plain `<a href="/stop/XXXXX">` only when `opposite` non-null.
  Arrivals card: one `/api/arrivals?stops=CODE` fetch, `REFRESH_MS = 30_000` +
  `TICK_MS = 10_000` + `visibilitychange`, identical idiom to `route.js:981-988`;
  `services === null` → "Timings unavailable — will retry."; `[]` → "No buses at this
  hour."; per-service `ended`/`before-first` (via T4 `serviceStatus`) render the
  "Ended · first bus HH:MM" row treatment from frame A3/D1. Schedule table: day-type
  segmented control defaulting to `dayTypeFor(new Date())`, rows from `services`
  (first/last via `fmtHHMM`, freq via `fmtFreq`, en-dash for nulls). Service numbers
  link to `/bus/:svc?stop=:code`. Local `escape()` on every interpolation.
- `public/styles.css`: a `/* --- stop page --- */` block reusing tokens and existing
  patterns (plate = enlarged card-head idiom, arrivals grid classes reused as-is where
  possible; new classes prefixed `.stop-` or `.sp-`). No new colour family, nothing
  below 0.7rem, squared radii, dark mode via the existing token swap only.

**Verification:**
1. `npm test` green (T4 tests still pass; any copy reused from other pages matches
   verbatim).
2. Mock server up:
   - `curl -s localhost:PORT/stop/10001 | grep -o '<title>[^<]*'` → `10001 · Blk 101,
     Demo Ave 1` (plus og:title/og:url present); `curl -s localhost:PORT/stop/99999 |
     grep '<title>'` → generic title; both HTTP 200 with `no-cache`.
   - `/stop/10001/` (trailing slash) and `/stop/abc` also return the shell (lenient).
3. Browser walkthrough (document results; screenshots if the environment allows):
   plate renders; arrivals tick; schedule table matches `/api/stop` payload; seg
   control switches columns; pin toggles and survives reload; opposite chip navigates
   10001 ↔ 10009 and back-button returns; share button on an insecure/desktop context
   swaps to "Copied ✓"; `/stop/54262`-style unknown code shows the guard with re-entry.
4. Keyboard: pin, share, seg control, code re-entry reachable and operable; focus
   visible.

## T6 — Integration: entry links + docs

**Scope:**
- `public/app.js`: the board card's stop code / title area links to `/stop/{code}`
  (match the existing `.service-no` link pattern at `app.js:662`; keep the pin button's
  hit target unaffected).
- `public/route.js`: the anchored stop name in `.here-panel` links to `/stop/{code}`.
- `AGENTS.md`: add `stop.html` / `stop.js` / `stop-logic.js` to the module inventory
  with the same one-line discipline notes as the route page files.
- `docs/stop-page-plan.md` (this file): tick the task list at the bottom.

**Verification:**
1. `npm test` green.
2. Mock server: board card code click → stop page; route page anchor name click →
   stop page; no layout shift on the board card head (visual check).

## T7 — End-to-end verification

Full sweep after T1–T6, by a fresh agent that assumes nothing:

1. **Clean build + tests:** `npm run build && npm test` — all green, zero skips.
2. **Mock-mode server matrix** (no account key):
   - API: `/api/stop/10001` (full payload incl. opposite 10009, three services, freq),
     `/api/stop/10009` (opposite back to 10001), 400/404 matrix, cache headers,
     `/api/arrivals?stops=10001` still fine.
   - Shells: `/stop/10001` meta injected; `/stop/99999` generic meta + client guard;
     `/bus/52` and `/` unaffected (regression).
   - `/healthz` still reports ok.
3. **Real-shape upstream:** run `node tools/stub-datamall.mjs`, point the server at it
   (read the stub's header comment / `src/config.ts` for how), verify `/api/stop` for a
   stub stop returns per-stop times (not terminus times) and freq strings.
4. **Browser walkthrough** (the T5 checklist, re-run end-to-end, plus):
   - First-visit simulation: clear site data → open `/stop/10001` directly → full
     content, no prompts, no intro.
   - Pin on stop page → appears pinned on the board (`/`) — the bookmark=pin loop.
   - Light + dark (OS toggle) — plate, pills, seg control legible in both.
   - 320 px viewport — no horizontal scroll, third ETA column behaviour matches board.
   - Reduced motion — skeletons static, nothing conveys state by motion alone.
5. **Honesty checks:** with the stub returning an empty arrivals body for a stop →
   "No buses at this hour."; with the stub down (kill it) → stale timings kept +
   "Timings unavailable — will retry."
6. Produce a pass/fail report per item; any fail loops back to the owning task.

---

## Task status

- [x] T1 schedule reverse index + freq
- [x] T2 opposite pairing
- [x] T3 /api/stop/:code
- [x] T4 stop-logic.js
- [x] T5 stop page UI + shell
- [x] T6 integration links
- [x] T7 end-to-end verification
