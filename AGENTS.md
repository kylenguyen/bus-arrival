# AGENTS.md

Guidance for coding agents working in this repository. Read this before making changes.

This file governs **behaviour**. [style-guide.md](style-guide.md) governs **how it
looks** — the Void Deck visual system: colour tokens, the two-face type rule, shape,
card anatomy, motion and the identity assets. Read it before any change that touches
colour, type, radius, card layout or the wordmark. Where the two disagree, this file
wins: every rule there is subordinate to the one below.

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
one of two doors — current location, or an address they already know — and sees
the 8 nearest stops to it with what is coming, when, and how full it is. An
address is a 6-digit postal code, a building or a road, searched against a
committed file of 121,360 of them; a 5-digit stop code still resolves as an
escape hatch, because that file is a ~2020 scrape. No sign-up and no settings.

The dialog on the first visit is the **entry choice**, not onboarding and not a
settings screen. It is there because the board cannot rank anything without a
coordinate, and the two ways of getting one are genuinely different journeys: the
alternative is a native permission prompt as the first thing a stranger sees,
with nothing on screen to explain it, and no way in at all for someone who will
not share a location. It shows before it asks: an accent band carrying the
heading, then one real board card captioned `Example`, then the question and the
two doors. The example is built from the board's own `.card` classes rather than a
mock of them, so it cannot promise a layout the board does not produce, and it is
there because a stranger is being asked for their location by a page that has
otherwise shown them nothing. The doors are equal tappable cards — glyph, label,
one line of detail — not a primary button and a ghost, because the second is not a
decline but the other journey. Still one question, never shown again once a
coordinate is in hand, and stored as which door was used rather than as a
preference. Do not grow it into a settings panel or a second slide, do not
simplify it away, and do not flatten the doors back to one primary and one ghost —
the second door is the whole reason the first one is allowed to be refused.

On a viewport under 620 px tall the example is dropped and the doors stay
([public/styles.css](public/styles.css)). Showing the answer is worth a great
deal, but not the choice itself: at 320×568 the whole card is 646 px against
536 px of dialog, and what fell off the bottom was the address door.

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
- No login, no account, no server-side user state. Six `localStorage` keys, and
  the server stores nothing about anyone:
  - `bus-board.pins.v1` — the pinned stops. Orthogonal to the rest: a pin is not
    a door, and changing door leaves them alone.
  - `bus-board.loc.v1` — the last GPS fix and its age, and the **sole** owner of
    both. The 12 h cached-paint window, the 5-minute focus re-locate and the
    200 m re-rank all read this key and only this key, which is why all three
    went through the two-door change and the finder change untouched.
  - `bus-board.origin.v1` — which door the board is ranked from: `{mode:'gps'}`,
    or `{mode:'place', postal, code, label, name, lat, lon, at}`. Written only
    when a coordinate is actually in hand — a fix, or an address chosen from
    search — so a denial or a dismissal leaves a first visit still a first visit.
    The place record **does** carry its own coordinate, on purpose and unlike the
    gps one: it is a fixed point the user named, not a fix, and it must not
    expire, move, or cost a geocode to read back. The gps record carries **no**
    coordinate for the mirror-image reason — it is one bit, and a second copy of
    the fix would be a second thing to keep in step with `loc.v1`. Read a
    coordinate with `originCoord(origin, lastLoc)`; never put a *fix* in here,
    and never read the fix from anywhere but `loc.v1`.

    The key is deliberately still `v1`. It used to hold `{mode:'stop', code,
    description, roadName, lat, lon}`, and `readOriginRecord` migrates that shape
    in place on read; bumping the key would have sent every returning user of
    that door back to the intro dialog, which is the exact failure the
    grandfathering in `decideBoot` exists to prevent.
  - `bus-board.recent.v1` — the last five addresses committed, most recent first,
    no timestamps. Not configuration, and not an exception to the rule below:
    there is nothing here to explain or to set. It is a cache of what the user
    already did, the same bargain `loc.v1` makes, and it is the specific
    mitigation for what the finder costs — a 5-digit stop code is printed on the
    pole in front of you, a 6-digit postal code is not. Worth stating rather than
    inheriting silently: it holds up to five labelled addresses, plausibly home
    and work, in cleartext on the device. Never transmitted, never seen by the
    server, cleared with the other four `bus-board.*` keys.
  - `bus-board.hint.v1` — how many times the board's navigation tip has been
    shown, `{"shown": n}`, capped at three (`HINT_MAX_SHOWINGS` in
    [public/origin.js](public/origin.js)). It exists because the board's two doors
    are deliberately quiet: the stop name carries a chevron, and the bus number
    carries nothing at all, so that one sentence is the **only** thing that ever
    teaches the number is tappable. Retiring itself is the point — chrome that
    outlives its lesson is just a smaller board — and "Got it" writes the retired
    record straight away, whichever showing it lands on, so the count is the
    backstop for a rider who never presses anything rather than a second thing a
    dismissal has to count up to. A board with no cards teaches nobody, so the gate
    and an empty board show nothing and spend nothing. Losing the key costs at most
    five showings of one sentence, which is why corrupt state reads as a first
    visit.
  - `bus-route.anchor.v1` — the route page's remembered boarding stop per
    service, `{"61": "43179", …}`, most recently used last and capped at 30
    services (`ANCHOR_LRU_MAX` in [public/route-logic.js](public/route-logic.js)).
    Written only when a stop is actually anchored — a tapped board card's
    `?stop=`, a picker choice, a nearest-stop inference, the guard's "use it
    anyway" — and **never** for the direction toggle's translated return stop,
    which is displayed and not persisted, so toggling back restores the stop
    the user actually chose. A remembered code the route no longer serves
    drops itself on the next visit, after its notice has been shown once.
    Orthogonal to the board's keys: it names stops per service, not a door,
    and changing the board's origin leaves it alone.
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

  The stylesheet is hand-written CSS with a token layer at the top, and
  [style-guide.md](style-guide.md) is its rationale — every colour, the type split and
  the 4px radius are decisions with an argument behind them, not defaults. One
  self-hosted webfont (`public/fonts/`, 11.9 KB) and no other asset dependency; adding a
  second is a payload decision, not a styling one.
- Upstream data: LTA DataMall (`BusStops`, `v3/BusArrival`). The addresses the
  finder searches are not upstream at all — they are a committed file in `data/`,
  read once at startup, with no third party in the request path.

## Commands

```sh
npm install
npm run build      # tsc -p tsconfig.json -> dist/
npm start          # node dist/index.js, http://localhost:8080
npm run dev        # build + node --watch
npm test           # build, then node --test over dist/**/*.test.js

LTA_ACCOUNT_KEY=... npm start   # against the real DataMall API

node tools/build-places.mjs     # rebuild data/sg-places.json.gz. By hand, roughly never
```

`tools/build-places.mjs` is deliberately **not** a `package.json` script and
never runs in CI: it pulls 57 MB from GitHub raw, which would put a third-party
outage in the release path for a file that is committed and changes about never.
Its output is byte-reproducible, so a regeneration diff is data change and
nothing else. Read its header before running it — parsing the source document
peaks around 600–800 MB of RSS.

There is a test suite, and its scope is deliberately narrow: the
concurrency-sensitive code in [src/cache.ts](src/cache.ts) and the state
machines in [src/limiter.ts](src/limiter.ts) — `Backoff` and `CircuitBreaker` —
whose failure mode is silent — a broken cache does not error, it just hammers
upstream — so `curl` cannot verify them. [src/places.ts](src/places.ts) is in
scope for the same reason and it is the newest one: a scoring ladder fails by
ranking the wrong row first, which is a perfectly healthy 200 and so is invisible
to `curl`. Its tests build their fixture in memory — a dozen hand-written
records, gzipped, through `loadBuffer` — and never open the 11 MB artefact, which
would cost ~200 ms and ~35 MB per test file and would fail for reasons belonging
to the data rather than the code. Tests live beside the source as
`src/*.test.ts`, compile
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

`npm test` covers the modules named above, and CI runs it on every push to `main`
before the image build. Everything else, verify by running it:

1. `npm run build` — must pass clean. `strict` and `noUncheckedIndexedAccess`
   are on; do not silence errors with `any` or `!`.
2. `npm start`, then `curl -s localhost:8080/healthz` — expect
   `{"ok":true,...,"mock":true}` once **both** lists have loaded: readiness is
   `stops.size > 0 && places.size > 0`, and the address file also logs
   `loaded 121360 places (generated 2026-08-11) in 178 ms` on the way in. A zero
   `places` count with a `place index load failed:` line above it means the
   artefact is missing or corrupt, and the pod will never become ready. The same payload
   carries `upstreamCalls` (cumulative since boot), `upstreamCallsPerMin`
   (trailing 60 s) and `breakerOpen`. All three come from `upstreamStats()` in
   [src/lta.ts](src/lta.ts) and are the only visibility into account spend, so
   any change to upstream call volume is checked here. In mock mode the counts
   stay `0` forever: mock mode never enters `request()`, which is where they
   are incremented.
3. Exercise the endpoint you touched, e.g.
   `curl -s 'localhost:8080/api/board?lat=1.3521&lon=103.8198&limit=3'`. For the
   finder, all four branches of one route:

   ```sh
   curl -s 'localhost:8080/api/places?q=310155'    # one address row, code null
   curl -s 'localhost:8080/api/places?q=43179'     # one stop row, postal null
   curl -s 'localhost:8080/api/places?q=toa+payoh' # ≤10 address rows, best first
   curl -si 'localhost:8080/api/places?q=t'        # 400 — the client never sends this one
   curl -si 'localhost:8080/api/places?q=310155' | grep -i cache  # private, max-age=300
   ```

   The rows are the part `curl` cannot judge. A ladder change is verified by
   typing real addresses into the box and reading the order, not by a 200.
4. For frontend changes, open `http://localhost:8080` and check the board in a
   phone-width viewport first (device toolbar, ~375 px) — that is the shipping
   target, so a change checked only at desktop width is unverified. A change to
   colour, type, radius or card layout is also checked against the "Changing this"
   list at the end of [style-guide.md](style-guide.md). Confirm the
   first screenful still leads with arrivals, nothing scrolls sideways, and every
   control is a comfortable one-handed tap. Geolocation needs a secure context — `localhost` counts, a
   bare LAN IP does not. The first visit is a different journey from every later
   one, so clear all five `bus-board.*` keys (DevTools → Application → Local
   Storage) to get the intro dialog back, and exercise both doors — a returning
   visitor never sees it. The fifth is `bus-board.hint.v1`, and leaving it behind
   is the easy mistake: the intro comes back without it, but the navigation tip
   above the board stays retired, so a first visit is only partly reproduced.
   Clearing only `origin.v1` leaves a Recent list behind, which is a
   fifth journey rather than a first one — and now a visible one, since recents are
   rows in the destinations card rather than contents of the search box.

   The card itself is worth opening in both colour schemes: in dark mode
   `--shadow` draws nothing, so its token border is the only edge it has. Check that
   opening it from the chip leaves the first board card on screen, that focus lands
   on the list rather than in the box (a keyboard over the rows defeats the point),
   and that nothing in it draws a ✓.

Mock mode (no `LTA_ACCOUNT_KEY`) serves 12 synthetic stops with synthetic
timings — enough to fill the 8-stop board. The finder is **not** in mock mode
with it: the address file is committed data, not LTA's, so `places.load()` runs
unconditionally and the search returns all 121,360 real addresses over those 12
stops. A Jurong postal code therefore resolves perfectly and then ranks demo
stops 15 km away. That is expected, not a bug — but it makes mock mode a poor
fixture for judging distance copy, and the stub (250 stops on a ~111 m grid) the
better one.

## Architecture

```
public/app.js  ──GET /api/board?lat&lon&pinned──▶  index.ts
 └─ origin.js    GET /api/arrivals?stops=…                │
                 GET /api/places?q=…                      │
                        ┌─────────────────────────────────┼───────────────────────┐
                   PlaceIndex                         StopIndex           arrivalsForMany
             (places.ts, from data/)             (stops.ts, in RAM)   (arrivals.ts + cache.ts)
                                                          └──────── lta.ts ───────┘
                                                                      │
                                                             DataMall / mock.ts
```

One route, three answers: `/api/places` decides what a query means rather than
making the client guess. Six digits are a postal code (`PlaceIndex.get`), five
are a stop code (`StopIndex.get`, the escape hatch), anything else is an address
search (`PlaceIndex.search`, ≤10 rows). `GET /api/stops` is **gone** — it 404s,
which is deliberate: a page opened before a deploy goes on running the `app.js`
it already loaded until someone reloads it, and a 404 makes that copy's existing
`catch` say "Search is unavailable right now." over a working board, where a 200
with a different body shape would render `undefined` rows. `public/` was served
with `maxAge: '1h'` when that call was made, which widened the window to an hour
for fresh loads as well; it is `no-cache` now (`STATIC_CACHE_CONTROL` in
[src/index.ts](src/index.ts)), and the open-tab case is what keeps the decision.

- [public/app.js](public/app.js) — glue only: elements, `fetch`, `localStorage`,
  event wiring. Every rule it applies is decided in
  [public/origin.js](public/origin.js), which is pure and unit tested
- [public/stop.html](public/stop.html) — the stop page shell (`/stop/:code`),
  served by the route in `index.ts` with title/OG placeholders swapped
  server-side; valid generic HTML if ever served unreplaced
- [public/stop.js](public/stop.js) — glue only, the same bargain as `app.js`:
  elements, `fetch`, storage, wiring; no storage key of its own — it reads and
  writes the board's `pins.v1` and reads `loc.v1`, never prompting for location
- [public/stop-logic.js](public/stop-logic.js) — the stop page's pure decision
  logic: no DOM, `fetch`, storage or clock, `now` is a parameter; unit tested
  from `src/stop-logic.test.ts` via the same computed specifier as `origin.js`
- [src/index.ts](src/index.ts) — Express routes, input validation, static files
- [src/stops.ts](src/stops.ts) — the whole stop list in memory; linear-scan
  nearest-neighbour, refreshed daily. A few thousand rows, so no index and no
  database. Keep it that way. It has **no `search()` any more** — the finder
  searches addresses, and all that is left here for a 5-digit code is `get()`,
  an exact `Map` lookup. Adding a scan back would put a second, worse finder
  beside the indexed one.
- [src/places.ts](src/places.ts) — 121,360 addresses read from
  `data/sg-places.json.gz` into an inverted index over building and road names.
  Loaded synchronously *after* `listen()`, ~180 ms, ~38 MB retained. No refresh
  timer and no `stop()`, unlike `StopIndex`: the file is baked into the image
  behind a `readOnlyRootFilesystem` and cannot change under a running pod. The
  scoring ladder, the block-number bonus and `MAX_CANDIDATES` are judgement calls
  tuned against no user data — the tests pin the behaviour, not its rightness.
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

Two directories are not code and are easy to miss:

- `data/` — `sg-places.json.gz`, the address artefact, ~1.6 MB, **committed on
  purpose** and generated by hand with `node tools/build-places.mjs`. It reaches
  the image through `COPY data ./data` in the Dockerfile and is resolved from
  `import.meta.dirname`, the same relative trick `express.static` uses for
  `public/`. It must stay out of `public/` — `express.static` would otherwise
  hand 1.6 MB to anyone who guessed the path.
- `docs/` — the two design records, each left as approved with a dated divergence
  section appended: [docs/first-run-journey.md](docs/first-run-journey.md) (the
  two-door first visit) and [docs/postal-code-finder.md](docs/postal-code-finder.md)
  (the address finder; the code comments cite its D1–D8 sections by name). Read a
  record's divergence section before trusting its body. The rule from
  `docs/datamall-activation.md` still holds: a line contradicted by a change is
  edited in the same commit.

## Conventions

- Relative imports carry the `.js` extension (`./stops.js`), as NodeNext ESM
  requires, even though the source is `.ts`.
- Shared shapes live in [src/types.ts](src/types.ts). DataMall's raw shapes
  (`RawStop`, `RawService`) stay private to `lta.ts` — map at the boundary and
  never leak upstream field names past it. Same rule one file over: the artefact's
  on-disk shape `PlaceRecord` stays private to `places.ts`, and `Place` is what
  leaves it.
- Read `process.env` only in `config.ts`.
- Comments explain why, not what, and are used sparingly on decisions that look
  arbitrary otherwise (cache TTLs, concurrency of 5, TCP liveness probe). Match
  that density; do not annotate obvious code.
- Visual changes go through the tokens in `public/styles.css`, never a literal colour
  in a component rule. The system and the reasoning are in
  [style-guide.md](style-guide.md); the two rules most often broken by a well-meaning
  tidy-up are that `--accent` and the crowding family must not share a hue, and that
  dark mode's `--shadow` is a transparent shadow rather than `none`.
- Frontend renders through `escape()` before interpolating into `innerHTML`.
  Every new interpolation of server or user data must go through it.
- Singapore conventions in user-facing output: `en-SG`, 24-hour time, metres.

## Data handling and privacy

These are constraints, not preferences:

- `/api/board` carries a coordinate. It is `no-store` and must never be logged,
  cached or forwarded. Do not add request logging that includes query strings
  or client IPs.
- `/api/places` carries whatever the user typed, routinely their own home postal
  code. It is `private, max-age=300` — never `public`, which would invite Traefik
  or a CDN to store a URL containing a stranger's address — and the query is
  never logged, on the route or anywhere inside `PlaceIndex`. `private` keeps the
  per-keystroke caching in the user's own browser, which is the whole practical
  benefit at this traffic level.
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

The manifest also sets `NODE_OPTIONS=--max-old-space-size=384`. V8 sizes its old
space from the host's RAM rather than the cgroup limit, so on a large node it
plans for far more than the 512Mi limit and gets OOM-killed instead of
collecting. That was harmless while the heap was tiny; the address index makes it
~38 MB long-lived plus a transient spike at load. It is a runtime flag, not
application config, so it does not breach the "read `process.env` only in
`config.ts`" rule.

The CI workflow the manifest comments reference,
[.github/workflows/bus-arrival.yml](.github/workflows/bus-arrival.yml), is in
this repository: on every push to `main` it runs `npm ci && npm test` and only
builds and pushes `ghcr.io/kylenguyen/bus-arrival` (`:latest` plus the commit
SHA) if that passes. A red suite therefore blocks the tag the cluster pulls.
Nothing in the repository references a path `apps/bus-arrival`. Note that the
image build now needs `data/sg-places.json.gz` in the checkout: `COPY data
./data` fails without it, and a `data/` left untracked locally is a green suite
followed by a red build.

## Gotchas

- A handful of real stops carry `0,0` coordinates, and a scraped address dump
  contains worse. There is no split to preserve here any more: `StopIndex` has
  only `nearby()`, which drops them, and `PlaceIndex` rejects an unusable
  coordinate at **load** — against Singapore's bounding box, which subsumes the
  `0,0` test and also catches a row whose latitude and longitude were written the
  wrong way round. The consequence is the useful part: **no finder row can ever
  be uncommittable**, so there is no "you may not tap that one" copy anywhere and
  none should be invented. `isUsableCoord` in
  [public/origin.js](public/origin.js) — renamed from `isUsableStopCoord` when the
  origin stopped being a stop — still earns its keep, but as a guard on *stored*
  state rather than on results: a hand-edited `origin.v1` or a stale Recent entry
  would otherwise rank the board from the Gulf of Guinea, ~1,300 km from every
  stop in Singapore. `placeFromRow`, `readOriginRecord` and `readRecents` all
  funnel through it, which is what lets `finderState` drop an unrankable row
  before it is rendered instead of refusing the tap afterwards.
- **The address data is a ~2020 scrape and it shows.** New estates — Tengah,
  Bidadari, most 2021+ BTO blocks — are missing or wrong, and regenerating
  changes nothing until upstream updates, which it may never do. That is the
  whole reason the 5-digit stop-code path survives: in a new estate the code on
  the pole can be the only way into the app. Separately and more annoyingly,
  roads are stored in full (`ANG MO KIO AVENUE 3`) while everyone, LTA's own stop
  descriptions included, writes `Ave` — so `woodlands ave 5` returns **zero**
  rows today. Fixing it means a synonym table (`AVE→AVENUE`, `RD`, `ST`, `LOR`,
  `JLN`, `CTRL`) with OR-matching per token in candidate generation, not a tweak
  to the ladder. See the open issues in
  [docs/postal-code-finder.md](docs/postal-code-finder.md) before starting.
- The address file loads **synchronously, after the port binds**, and `/healthz`
  gates readiness on it (`stops.size > 0 && places.size > 0`), so the pod is 503
  for the ~180 ms it takes. Gating is right *because the failure is deterministic
  at image-build time*: a bad artefact fails identically on every pod, and with
  `replicas: 1` a pod that never becomes ready blocks its own rollout while the
  old one keeps serving. If that file ever moves to a mounted volume or a network
  fetch, the gate must come off in the same change — the failure would then be
  environmental and per-pod, and gating on it would take the whole board down for
  what is only a finder outage. The comment above `/healthz` says so too.
- **The finder commits by index, not by code**, because an address has no unique
  key the client knows. What makes that safe is that `applyFinder()` writes
  `searchRows` and the `#results` markup in the **same synchronous block** — an
  index read off the DOM therefore always addresses the array that produced that
  DOM. Split those two statements across an `await` and a fast typist commits the
  wrong address. Rows carry `data-index`; the `data-code` attribute in board-card
  markup is the pin path and is unrelated.
- **The same rule governs the destinations list.** `renderOrigins()` writes
  `originRows` and the `#origins` markup in one synchronous block, and is called
  from `openSearch()` and nowhere else — one render site is what keeps the pair
  impossible to desync. `closeSearch()` clears `originRows` with the markup.
- **`originsState` owns whether the location row exists at all.** When geolocation
  cannot work the row is *omitted*, not disabled — a control that cannot keep its
  promise is worse than no control, and this is where that decision lives now
  rather than in a DOM removal in `app.js`. Only a literal `true` for
  `geolocationSupported` counts, so a caller that forgets the flag loses the door
  visibly instead of shipping a dead one. The flag is
  `window.isSecureContext && !!navigator.geolocation`: plain http has the property
  and cannot use it, and a browser exposing it as null passes an
  `'geolocation' in navigator` test and then refuses the call.
- **State and action must stay separate objects in that list.** The row the board is
  ranked from carries `aria-current`; the control that re-runs a location fix is
  `.origin-update`. Do not merge them back — `aria-pressed` with a ✓ on a button
  that also fires geolocation is what this replaced, and it made the commonest state
  read as "already done, nothing to do".
- `titleCase` in `origin.js` keeps the words in its bounded `ACRONYMS` allowlist
  capitalised (`HDB HUB` → `HDB Hub`). **Do not replace the list with a
  heuristic.** The tempting one, "short and no vowels", was tried: `ST`, `BLK`,
  `JLN`, `RD`, `DR`, `PL`, `CL`, `TG` and `KG` all qualify and all are read as
  words, so it renders `ST. GEORGE'S ROAD` as `ST. George's Road`. Adding a word to
  the list is fine; both failure modes are asserted in `src/origin.test.ts`.
- **Query abbreviations expand as variants, never as rewrites** (`EXPANSIONS` in
  `src/places.ts`). `AVE` matches `AVENUE` *or* `AVE`, which is what keeps
  `st george` finding `ST. GEORGE'S ROAD` while `woodlands ave 5` finds
  `WOODLANDS AVENUE 5`. Candidate generation unions a token's forms
  (`#postingsFor`) — without that the short literal `AVE` posting list wins the
  most-selective-token contest and excludes every `AVENUE` row, so fixing
  `matchesAll` alone still returns nothing.
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
  the "Enter an address" button that appears after 3 s — is armed only for waits on
  a *position*: a wait on `/api/board` fails on its own and raises its own retry,
  whereas an unanswered permission prompt never calls back at all, so the only way
  out of that one has to arrive on a timer. `showSkeleton()` tests the board's
  *markup*, not the `board` array — a real board on screen outranks placeholders,
  while `switchOrigin` and `startWithLocation` deliberately clear the markup and
  keep the array.
- Reading `localStorage` throws as well as writing it — Firefox with
  `dom.storage.enabled = false` throws on the access itself — so every read sits
  inside a `try` (`readRaw`, `readPins`, `readLoc`, `storedOriginMode`) and every
  write goes through `write()`. A session with storage blocked works and simply
  is not remembered, which for a first-time visitor means the intro returns on
  every reload.
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
