# AGENTS.md

Guidance for coding agents working in this repository. Read this before making changes.

## What this is

A single-page bus arrival board for Singapore. A commuter opens the page, allows
location once, and sees the 15 nearest stops with what is coming, when, and how
full it is. No sign-up, no settings, no onboarding.

The product goal is speed and low friction, not features. When a change trades
convenience for capability, the default answer is no. Concretely:

- First paint should be one network round trip. `/api/board` returns stops and
  arrivals together for exactly that reason — do not split it back apart.
- No login, no account, no server-side user state. Pins and the last coordinate
  live in `localStorage`; the server stores nothing about anyone.
- No new user-facing configuration. If a setting would need explaining, pick a
  sensible default instead.
- Mobile phone at a bus stop on cellular data is the target device. Wide screens
  are the override, not the base.

## Stack

- Node 22+, TypeScript 5.7, ESM (`"type": "module"`), strict mode
- Express 4 — the only runtime dependency
- Frontend: hand-written HTML/CSS/JS in [public/](public/). No framework, no
  bundler, no build step. Keep it that way unless the maintainer says otherwise.
- Upstream data: LTA DataMall (`BusStops`, `BusArrivalv2`)

## Commands

```sh
npm install
npm run build      # tsc -p tsconfig.json -> dist/
npm start          # node dist/index.js, http://localhost:8080
npm run dev        # build + node --watch

LTA_ACCOUNT_KEY=... npm start   # against the real DataMall API
```

There is no test suite, linter or formatter in this repo. Do not invent
`npm test` or `npm run lint` in docs, CI or commit messages. If you add one,
say so explicitly and wire it into `package.json`.

Known gap, recorded deliberately (10 Aug 2026): the DataMall activation work in
[docs/datamall-activation.md](docs/datamall-activation.md) adds negative
caching, per-key backoff, a circuit breaker, a global token bucket and a
deadline race to [src/cache.ts](src/cache.ts) and [src/lta.ts](src/lta.ts).
That is concurrency-sensitive code whose failure mode is silent — a broken
cache does not error, it just hammers upstream — and `curl` cannot really
verify it. A minimal `node:test` suite covering `cache.ts` and the rate limiter
is the intended follow-up; it was consciously deferred, not overlooked. Until
then, exercise those paths against a stub `LTA_BASE_URL` that returns empty
bodies and 429s rather than trusting a happy-path check.

## Verifying a change

Since there are no tests, verify by running it:

1. `npm run build` — must pass clean. `strict` and `noUncheckedIndexedAccess`
   are on; do not silence errors with `any` or `!`.
2. `npm start`, then `curl -s localhost:8080/healthz` — expect
   `{"ok":true,...,"mock":true}` once the stop list has loaded.
3. Exercise the endpoint you touched, e.g.
   `curl -s 'localhost:8080/api/board?lat=1.3521&lon=103.8198&limit=3'`.
4. For frontend changes, open `http://localhost:8080` and check the board in a
   narrow viewport. Geolocation needs a secure context — `localhost` counts, a
   bare LAN IP does not.

Mock mode (no `LTA_ACCOUNT_KEY`) serves 12 synthetic stops with synthetic
timings, so the board is shorter than 15 there. That is expected, not a bug.

## Architecture

```
public/app.js  ──GET /api/board?lat&lon&pinned──▶  index.ts
                 GET /api/arrivals?stops=…                │
                 GET /api/stops?q=…                       │
                                            ┌─────────────┴─────────────┐
                                       StopIndex                   arrivalsForMany
                                    (stops.ts, in RAM)          (arrivals.ts + cache.ts)
                                            └────────── lta.ts ─────────┘
                                                          │
                                                    DataMall / mock.ts
```

- [src/index.ts](src/index.ts) — Express routes, input validation, static files
- [src/stops.ts](src/stops.ts) — the whole stop list in memory; linear-scan
  search and nearest-neighbour, refreshed daily. A few thousand rows, so no
  index and no database. Keep it that way.
- [src/arrivals.ts](src/arrivals.ts) — per-stop arrivals, 5 at a time, one
  failed stop maps to `null` rather than failing the board
- [src/cache.ts](src/cache.ts) — TTL cache with in-flight de-duplication and
  stale-on-error. Both properties are load-bearing; read the comment before
  changing it.
- [src/lta.ts](src/lta.ts) — DataMall client and response mapping
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
- Stop codes are validated against `/^[A-Za-z0-9]{4,8}$/` and capped at 25 per
  request so one caller cannot fan out across the whole feed. Keep both.

## Deployment

Container is a three-stage build ([Dockerfile](Dockerfile)) running as `node`
with a read-only root filesystem. Kubernetes manifests are in
[k8s/bus-arrival.yaml](k8s/bus-arrival.yaml): readiness hits `/healthz`,
liveness is a deliberate TCP check so a DataMall outage does not restart-loop a
pod that is still serving cached timings.

Note a discrepancy to resolve with the maintainer before relying on it: the
manifest comments reference a CI workflow at `.github/workflows/bus-arrival.yml`
and a path `apps/bus-arrival`, neither of which exists in this repository. The
image `ghcr.io/kylenguyen/bus-arrival:latest` is presumably built elsewhere.

## Gotchas

- A handful of real stops carry `0,0` coordinates. `nearby()` filters them out;
  `search()` keeps them findable. Preserve that split.
- `Monitored: 0` means the timing is scheduled, not live-tracked. The UI marks
  it with `*`; do not present it as a live ETA.
- Arrival TTL (15 s) sits below DataMall's own ~20–30 s refresh, so caching
  costs no accuracy and protects the account quota. Do not lower it.
- Toggling a pin mid-load coalesces into `pendingLoad` rather than being
  dropped. Keep that behaviour if you touch `loadBoard()`.
- The stop list loads *after* the port binds, so the container passes its
  startup probe even when DataMall is slow. `/healthz` returns 503 until the
  list is in.
- Field names and endpoint paths follow the DataMall user guide. LTA has
  revised them before (`BusArrival` → `BusArrivalv2`); check the current guide
  against `lta.ts` when activating a real account.
