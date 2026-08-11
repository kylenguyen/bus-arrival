# AGENTS.md

Guidance for coding agents working in this repository. Read this before making changes.

## The one thing that matters

**A commuter must find out what bus is coming, and when, as quickly and with as
little effort as possible — on a phone, one-handed, at a bus stop, on cellular
data.** That is the whole product. Every feature, every layout, every interaction
is judged against it and nothing else.

Two rules follow, and they decide arguments:

1. **Speed and convenience beat capability.** A change that adds a capability but
   costs a tap, a round trip, a scroll, or a moment of reading is a regression,
   however useful the capability is. When in doubt, the answer is no. Ask "does
   this get someone to a departure time faster?" — if the honest answer is no,
   do not build it.
2. **Mobile is the product, not a viewport.** Design, build and verify at phone
   width first. Wide screens are the override, never the base. A layout that only
   reads well on a laptop is broken, not "desktop-optimised".

## What this is

A single-page bus arrival board for Singapore. A commuter opens the page, picks
one of two doors — current location, or a stop code they already know — and sees
the 8 nearest stops to it with what is coming, when, and how full it is. No
sign-up and no settings.

The dialog on the first visit is the **entry choice**, not onboarding and not a
settings screen. It is there because the board cannot rank anything without a
coordinate, and the two ways of getting one are genuinely different journeys: the
alternative is a native permission prompt as the first thing a stranger sees,
with nothing on screen to explain it, and no way in at all for someone who will
not share a location. It is one question, answered by tapping one of two buttons,
never shown again once a coordinate is in hand, and stored as which door was used
rather than as a preference. Do not grow it into a settings panel, and do not
simplify it away — the second door is the whole reason the first one is allowed to
be refused.

Dismissing it — Escape, or a tap on the backdrop, which on a phone is most of the
screen and so is usually an accident — lands on the **gate**, carrying one sentence
about why the board is empty and the same two doors as buttons (`dismissGate` in
[public/origin.js](public/origin.js) decides both, and drops the location door when
the variant has none). It used to open the search panel instead, which left a page
holding a search box, no board, no gate and three quarters of the viewport empty.
Nothing is persisted, so the dialog is still right to come back next reload.

The product goal is speed and low friction, not features. When a change trades
convenience for capability, the default answer is no. Concretely:

- First paint should be one network round trip. `/api/board` returns stops and
  arrivals together for exactly that reason — do not split it back apart.
- No login, no account, no server-side user state. Three `localStorage` keys, and
  the server stores nothing about anyone:
  - `bus-board.pins.v1` — the pinned stops. Orthogonal to the rest: a pin is not
    a door, and changing door leaves them alone.
  - `bus-board.loc.v1` — the last GPS fix and its age, and the **sole** owner of
    both. The 12 h cached-paint window, the 5-minute focus re-locate and the
    200 m re-rank all read this key and only this key, which is why all three
    went through the two-door change untouched.
  - `bus-board.origin.v1` — which door the board is ranked from: `{mode:'gps'}`,
    or `{mode:'stop', code, description, roadName, lat, lon}`. Written only when
    a coordinate is actually in hand — a fix, or a stop chosen from search — so a
    denial or a dismissal leaves a first visit still a first visit. The gps
    record carries **no coordinate, on purpose**: it is one bit, and a second
    copy of the fix would be a second thing to keep in step with `loc.v1`. Read
    a coordinate with `originCoord(origin, lastLoc)`; never store one here, and
    never read the fix from anywhere but `loc.v1`.
- No new user-facing configuration. If a setting would need explaining, pick a
  sensible default instead. The first-visit entry choice is not an exception to
  this: a setting is something the user maintains and can be wrong about later,
  whereas that is one question with no default that could be right for both
  answers, asked once and never again. Adding a way to change a preference is
  configuration; asking which of two journeys this is, is not.
- Mobile phone at a bus stop on cellular data is the target device. Wide screens
  are the override, not the base. In practice:
  - The answer — stop name, service number, minutes — must be legible at arm's
    length in sunlight and reachable without pinch-zoom or horizontal scroll. In
    practice nothing on a card goes below ~11 px (`0.7rem`): the crowding labels,
    column headings and vehicle tags all used to sit at `0.6rem`, which is
    decoration rather than information at a bus stop in the sun. Buy the room by
    dropping content that has not earned it, never by shrinking type past that.
  - Crowding is shown for the **next** bus only. Three labels a service meant nine
    on a card at one weight, so the number being decided on competed with eight
    others; how full a bus will be in twenty minutes is a guess anyway. Columns two
    and three answer "is it worth waiting", which minutes do alone.
  - A wait shows the board's shape, not an empty page: `busy()` in
    [public/app.js](public/app.js) puts the gate's sentence over skeleton cards. A
    grey line alone in a viewport reads as a broken app, and the first-visit
    location wait can run 12 s.
  - Anything tappable is a thumb target, comfortably hit one-handed, with enough
    separation that a hurried tap cannot hit the wrong thing. Hover is not an
    interaction; there is no cursor.
  - The most-wanted information sits highest. Chrome, notes and secondary detail
    go below the fold or away entirely — the first screenful is the product.
  - Payload and round trips are a UX concern on cellular, not just an
    engineering one. Weigh every added asset and request against the delay it
    puts between opening the page and reading a time.
  - Verify at ~375 px wide before calling a frontend change done. A change that
    was only ever seen on a desktop browser has not been tested.

## Stack

- Node 22+, TypeScript 5.7, ESM (`"type": "module"`), strict mode
- Express 4 — the only runtime dependency
- Frontend: hand-written HTML/CSS/JS in [public/](public/). No framework, no
  bundler, no build step. Keep it that way unless the maintainer says otherwise.
  Two ES modules, and the split is load-bearing:
  [public/origin.js](public/origin.js) is pure decision logic (no DOM, no
  `fetch`, no `localStorage`, no clock) and [public/app.js](public/app.js) is the
  glue that imports it — elements, requests, storage, listeners, each apply site
  a one-line assignment. It is split that way because `app.js` cannot be imported
  by a test and `origin.js` can, which is the only unit coverage the journey
  rules have. Do not inline it back.
- Upstream data: LTA DataMall (`BusStops`, `v3/BusArrival`)

## Commands

```sh
npm install
npm run build      # tsc -p tsconfig.json -> dist/
npm start          # node dist/index.js, http://localhost:8080
npm run dev        # build + node --watch
npm test           # build, then node --test over dist/**/*.test.js

LTA_ACCOUNT_KEY=... npm start   # against the real DataMall API
```

There is a test suite, and its scope is deliberately narrow: the
concurrency-sensitive code in [src/cache.ts](src/cache.ts) and the state
machines in [src/limiter.ts](src/limiter.ts) — `Backoff` and `CircuitBreaker` —
whose failure mode is silent — a broken cache does not error, it just hammers
upstream — so `curl` cannot verify them. Tests live beside the source as `src/*.test.ts`, compile
with everything else, and use an injected clock; do not write a test that
sleeps. [src/origin.test.ts](src/origin.test.ts) is the exception to "tests
cover `src/`": it reaches into `public/origin.js` with a *computed* specifier,
`await import(new URL('../public/origin.js', import.meta.url).href)`, because a
literal path trips TS2307 (no declarations) and TS6059 (outside `rootDir`) —
computed, tsc leaves it alone, the module types as `any` and the build stays
clean. Keep it computed. The other half of that bargain is that `origin.js` must
never read the clock: anything time-dependent takes `now` as a parameter and
`app.js` supplies it, so no test there needs timers either. Everything else in
the repo is still verified by running it. There is
no linter or formatter — do not invent `npm run lint`.

A committed DataMall stub lives at
[tools/stub-datamall.mjs](tools/stub-datamall.mjs) (no dependencies, `node
tools/stub-datamall.mjs`, port 9099). Point the app at it to leave mock mode:

```sh
LTA_ACCOUNT_KEY=stub-key LTA_BASE_URL=http://localhost:9099 node dist/index.js
```

Modes are `ok`, `empty` (zero-length body — the 01:30 case), `429` (with
`Retry-After`), `500` (body carries a fake AccountKey, so you can grep the app
log and prove we never echo one) and `slow`. Switch at runtime with
`GET /_mode?set=429`, or for a single stop code with
`GET /_mode?set=500&code=10002` (`GET /_mode?clear=10002`, or `clear=all`, drops
it again) — that is how one board request can carry two different upstream
states at once. Read the request counter, per-path counts and per-request
timestamps at `GET /_stats`. Failure modes apply to `BusArrival` only —
`BusStops` always answers, so the pod still becomes ready. Add
`ARRIVAL_TTL_MS=1` when measuring upstream call rate rather than caching.

## Verifying a change

`npm test` covers the two modules above, and CI runs it on every push to `main`
before the image build. Everything else, verify by running it:

1. `npm run build` — must pass clean. `strict` and `noUncheckedIndexedAccess`
   are on; do not silence errors with `any` or `!`.
2. `npm start`, then `curl -s localhost:8080/healthz` — expect
   `{"ok":true,...,"mock":true}` once the stop list has loaded. The same payload
   carries `upstreamCalls` (cumulative since boot), `upstreamCallsPerMin`
   (trailing 60 s) and `breakerOpen`. All three come from `upstreamStats()` in
   [src/lta.ts](src/lta.ts) and are the only visibility into account spend, so
   any change to upstream call volume is checked here. In mock mode the counts
   stay `0` forever: mock mode never enters `request()`, which is where they
   are incremented.
3. Exercise the endpoint you touched, e.g.
   `curl -s 'localhost:8080/api/board?lat=1.3521&lon=103.8198&limit=3'`.
4. For frontend changes, open `http://localhost:8080` and check the board in a
   phone-width viewport first (device toolbar, ~375 px) — that is the shipping
   target, so a change checked only at desktop width is unverified. Confirm the
   first screenful still leads with arrivals, nothing scrolls sideways, and every
   control is a comfortable one-handed tap. Geolocation needs a secure context — `localhost` counts, a
   bare LAN IP does not. The first visit is a different journey from every later
   one, so clear the three keys (DevTools → Application → Local Storage) to get
   the intro dialog back, and exercise both doors — a returning visitor never
   sees it.

Mock mode (no `LTA_ACCOUNT_KEY`) serves 12 synthetic stops with synthetic
timings — enough to fill the 8-stop board, but search has almost nothing to
match. That is expected, not a bug.

## Architecture

```
public/app.js  ──GET /api/board?lat&lon&pinned──▶  index.ts
 └─ origin.js    GET /api/arrivals?stops=…                │
                 GET /api/stops?q=…                       │
                                            ┌─────────────┴─────────────┐
                                       StopIndex                   arrivalsForMany
                                    (stops.ts, in RAM)          (arrivals.ts + cache.ts)
                                            └────────── lta.ts ─────────┘
                                                          │
                                                    DataMall / mock.ts
```

- [public/app.js](public/app.js) — glue only: elements, `fetch`, `localStorage`,
  event wiring. Every rule it applies is decided in
  [public/origin.js](public/origin.js), which is pure and unit tested
- [src/index.ts](src/index.ts) — Express routes, input validation, static files
- [src/stops.ts](src/stops.ts) — the whole stop list in memory; linear-scan
  search and nearest-neighbour, refreshed daily. A few thousand rows, so no
  index and no database. Keep it that way.
- [src/arrivals.ts](src/arrivals.ts) — per-stop arrivals, 5 at a time, one
  failed stop maps to `null` rather than failing the board. `null` is failure
  only: a stop with nothing running — DataMall returns no body at all outside
  operating hours — maps to `[]`, and the two must stay distinguishable.
- [src/cache.ts](src/cache.ts) — TTL cache with in-flight de-duplication,
  stale-on-error and per-key backoff on failure (a `Backoff` from
  [src/limiter.ts](src/limiter.ts)). All three properties are load-bearing;
  read the comment before changing it. On failure the entry is re-stamped to
  expire exactly when the backoff window does, so serving stale and refusing to
  retry are one deadline rather than two.
- [src/limiter.ts](src/limiter.ts) — the rate-limiting state machines, kept
  apart from their callers because they are pure state plus an injected clock.
  `Backoff` (per key, used by `cache.ts`) and `CircuitBreaker` (global, used by
  `lta.ts`): five consecutive failures open it for 60 s, then a single probe
  closes it or buys another 60 s. It counts only what the caller passes it —
  which statuses mean "stop" is `lta.ts`'s decision, not the breaker's.
- [src/lta.ts](src/lta.ts) — DataMall client and response mapping, the upstream
  call counters, and the circuit breaker's policy: 429 and 5xx count as upstream
  refusing, a network error or timeout counts too, any other 4xx does not and
  neither does a 200 whose body will not parse. `Retry-After` is read off the
  response (both the delta-seconds and HTTP-date forms) and replaces the 60 s
  default, clamped to 120 s. **The breaker gates arrivals only.** `fetchAllStops`
  calls `request()` directly and is deliberately unguarded — the plan text says
  "across the whole client", and this is a considered divergence, not an
  oversight: breaking the `BusStops` pull would let an arrivals outage keep a
  cold pod un-ready and turn degraded timings into total downtime. Do not
  "fix" it back. The call counter still counts every upstream call, the stop
  list included.
- [src/mock.ts](src/mock.ts) — synthetic stops and timings for mock mode
- [src/config.ts](src/config.ts) — all env reading happens here, nowhere else

## Conventions

- Relative imports carry the `.js` extension (`./stops.js`), as NodeNext ESM
  requires, even though the source is `.ts`.
- Shared shapes live in [src/types.ts](src/types.ts). DataMall's raw shapes
  (`RawStop`, `RawService`) stay private to `lta.ts` — map at the boundary and
  never leak upstream field names past it.
- Read `process.env` only in `config.ts`.
- Comments explain why, not what, and are used sparingly on decisions that look
  arbitrary otherwise (cache TTLs, concurrency of 5, TCP liveness probe). Match
  that density; do not annotate obvious code.
- Frontend renders through `escape()` before interpolating into `innerHTML`.
  Every new interpolation of server or user data must go through it.
- Singapore conventions in user-facing output: `en-SG`, 24-hour time, metres.

## Data handling and privacy

These are constraints, not preferences:

- `/api/board` carries a coordinate. It is `no-store` and must never be logged,
  cached or forwarded. Do not add request logging that includes query strings
  or client IPs.
- Never log or return a DataMall error body — it can echo the AccountKey back.
  `lta.ts` deliberately reports status codes only.
- `LTA_ACCOUNT_KEY` belongs in a Kubernetes Secret. Never commit it, never
  write it into a manifest, never paste it into a chat or issue.
- Stop codes are validated against `/^\d{5}$/` — the guide documents
  `BusStopCode` as a 5-digit identifier — and the board is truncated to 8 stops
  *before* the fan-out, so one caller cannot fan out across the whole feed.
  Keep both. Pinned stops used to escape the cap; they no longer do.

## Deployment

Container is a three-stage build ([Dockerfile](Dockerfile)) running as `node`
with a read-only root filesystem. Kubernetes manifests are in
[k8s/bus-arrival.yaml](k8s/bus-arrival.yaml): readiness hits `/healthz`,
liveness is a deliberate TCP check so a DataMall outage does not restart-loop a
pod that is still serving cached timings. `/healthz` is also the account-spend
gauge (`upstreamCalls`, `upstreamCallsPerMin`, `breakerOpen`) and is publicly
reachable: exposing rough traffic volume is accepted, anything per-IP or
per-stop is not. Probing it costs nothing upstream — only `request()` in
`lta.ts` increments, so readiness polling never inflates the numbers.

The CI workflow the manifest comments reference,
[.github/workflows/bus-arrival.yml](.github/workflows/bus-arrival.yml), is in
this repository: on every push to `main` it runs `npm ci && npm test` and only
builds and pushes `ghcr.io/kylenguyen/bus-arrival` (`:latest` plus the commit
SHA) if that passes. A red suite therefore blocks the tag the cluster pulls.
Nothing in the repository references a path `apps/bus-arrival`.

## Gotchas

- A handful of real stops carry `0,0` coordinates. `nearby()` filters them out;
  `search()` keeps them findable. Preserve that split. The frontend consequence:
  such a stop is tappable in the search results but must never become the board's
  origin — ranking from `0,0` puts the whole of Singapore ~1,300 km away and
  falsely trips the delisted-stop note. `isUsableStopCoord` in
  [public/origin.js](public/origin.js) is the single place that is enforced, on
  both the stored record and the commit path; the tap is refused with the ordinary
  "no such stop" wording rather than a sentence about coordinates.
- iOS Safari spends a click's transient activation on the first `await`, and
  `getCurrentPosition` called after that point never prompts — silently, and only
  on iPhone. That is why `getPosition()`'s call sits inside a synchronously
  executed `Promise` executor, why `startWithLocation()` closes the dialog, shuts
  the finder and raises the gate with synchronous DOM calls only, and why both
  location buttons and the gate's retry route through it rather than through
  `locate()`, which awaits `navigator.permissions.query` first. Nothing may be
  `await`ed anywhere between a click and that call — the rule belongs to the whole
  chain, not to one function. Desktop Chrome stays green either way and no test
  here can catch it, so a real iPhone is the only check.
- The gate and the skeletons are one state machine, and the ordering is
  load-bearing. `gate()` cancels the pending escape hatch **and** clears the
  skeletons, because a refusal or a failure is the end of a wait and cards still
  pulsing under it promise a board that is not coming; `busy()` therefore calls
  `gate()` first and `showSkeleton()` after, never the other way round. The hatch —
  the "Enter a stop code" button that appears after 3 s — is armed only for waits on
  a *position*: a wait on `/api/board` fails on its own and raises its own retry,
  whereas an unanswered permission prompt never calls back at all, so the only way
  out of that one has to arrive on a timer. `showSkeleton()` tests the board's
  *markup*, not the `board` array — a real board on screen outranks placeholders,
  while `switchOrigin` and `startWithLocation` deliberately clear the markup and
  keep the array.
- Reading `localStorage` throws as well as writing it — Firefox with
  `dom.storage.enabled = false` throws on the access itself — so every read sits
  inside a `try` (`readRaw`, `readPins`, `readLoc`) and every write goes through
  `write()`. A session with storage blocked works and simply is not remembered,
  which for a first-time visitor means the intro returns on every reload.
- `Monitored: 0` means the timing is scheduled, not live-tracked. The UI marks
  it with `*`; do not present it as a live ETA.
- Arrival TTL (15 s) sits below the 20 s update frequency the guide documents
  for Bus Arrival (§2.1), so caching costs no accuracy and protects the account
  quota. Do not lower it.
- Toggling a pin mid-load coalesces into `pendingLoad` rather than being
  dropped. Keep that behaviour if you touch `loadBoard()`. Two things now depend
  on the rest of its shape: the coordinate comes from `originCoord()`, not from
  the argument, so no caller can rank the board by the wrong door; and the
  coalesced early return resolves `undefined`, which is how `switchOrigin` tells
  "a load was already in flight" from "my load failed". Only `false` rolls a
  switch back, and rolling back means restoring the origin record *and* the board
  — the `board` array is deliberately left intact so there is something to
  restore, so clear `el.board` and `shellSignature` but never the array.
- The stop list loads *after* the port binds, so the container passes its
  startup probe even when DataMall is slow. `/healthz` returns 503 until the
  list is in.
- `node --test dist/` hangs: given a directory, Node 24 executes *every* `.js`
  under it, including `dist/index.js`, which binds :8080 and never exits. That
  is why `npm test` passes the explicit `dist/**/*.test.js` pattern instead.
- `breakerOpen` on `/healthz` stays `true` through half-open — from the trip
  until a probe actually succeeds — because until then recovery is unproven.
- Recovery from a breaker trip takes longer than the breaker's own window, and
  that is correct. The breaker is global; `cache.ts` also backs off per key, and
  while the breaker is open every key's loader rejects fast, so every key
  accrues its own window too. The breaker closes on one probe, most stops return
  immediately, and a stop that happened to open a 60 s window just before the
  probe waits out the rest of it (measured: 13 of 15 stops back within 2 s of
  the breaker closing, the last two at 68 s). Nothing hammers upstream in the
  meantime and stops with a cached value serve it stale throughout. Both windows
  cap at 60 s, so the tail is bounded by the longer of the two, not by their sum.
- Field names and endpoint paths were checked field-by-field against API User
  Guide v6.9 (3 Aug 2026), §2.1 and §2.4, on 10 Aug 2026 — `docs/` holds the
  PDF. LTA has revised the path twice (`BusArrival` → `BusArrivalv2` →
  `v3/BusArrival`) and the field set once (v6.0 added `Monitored`), so re-check
  only if the guide has moved past 6.9.
- The stop-list walk advances `$skip` by the records a page actually returned
  and stops on an empty page. It does **not** treat a short page as the last
  one: the guide says the 500-record cap "may be adjusted from time to time",
  and a lowered cap would then truncate ~5,000 stops to one page silently.
  `src/lta.stops.test.ts` pins this. Costs one extra request a day.
