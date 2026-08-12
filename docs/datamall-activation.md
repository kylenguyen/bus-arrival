# DataMall activation plan

Decided 10 Aug 2026. Turns the existing DataMall client on against a real
AccountKey, for a **publicly reachable** deployment, starting with a small set
of users.

Scope is Option A: keep the live pull-through architecture. No database, no
persistence, no new datasets. The stop list is re-pulled on every pod start
(~11 calls) exactly as it is today.

The critical path below is the smallest set of changes after which turning the
key on is safe. Everything else — latency, lazy-loading, stale cards, per-IP
limits — is in [Appendix A](#appendix-a--deferred-work) with a sharpened spec,
ready to pick up once real traffic tells us what actually needs fixing.

## Decisions taken

| # | Decision | Rationale |
|---|---|---|
| 1 | Live pull-through, no snapshot | 11 calls per pod start is cheap; persistence is the first stateful thing in the repo and not worth it yet |
| 2 | Stale cards degrade visibly | Extends the existing `monitored: false` precedent rather than inventing a new UI concept — deferred to Appendix A |
| 3 | Lazy-load arrivals, 8 stops on first paint | Cuts the most expensive operation by ~47% with no freshness loss — deferred to Appendix A |
| 4 | Bus Routes API deferred | Third dataset; the critical-path fixes already make 02:00 behave, just with a vaguer message |
| 5 | ~~No test suite yet~~ **Reversed 10 Aug 2026** | Backoff and the breaker have no observable failure signal and no deterministic manual check. A minimal `node:test` over `cache.ts` and the limiter is now task 0 |
| 6 | `replicas: 1` stays | Caches are per-pod; N pods multiply upstream rate by ~N |
| 7 | Launch to a small user set behind the same public URL | No auth layer exists and building one is out of scope. "Small" means we control who is told the URL, not who can reach it |
| 8 | **Added 10 Aug 2026** — the circuit breaker gates arrivals only, not the stop-list pull | Breaking `BusStops` too would let a run of arrivals failures block the pull that makes the pod ready, turning degraded timings into a cold-start 503 and an empty board. The stop list is one call a day, so it cannot be what burns the quota, and `stops.ts` already keeps the previous list on a refresh failure |

Decision 5 is the one that changed. The reasoning: three of the original tasks
(backoff, circuit breaker, token bucket) return byte-identical responses whether
they work or not. The only signal is upstream call volume over time, and
reproducing that by hand takes a scripted stub plus a stopwatch — comparable
effort to the test, with a weaker result you cannot re-run on every change.

## Why the sequence matters

**Do not put the real key in until the critical path lands.** The guide states
that during non-operating hours the API returns no response at all — not even
attribute tags. Today that throws in `res.json()`, and because `cache.ts` never
re-stamps `expiresAt` on failure, every request would go upstream at full rate
for the four-odd hours the buses aren't running. Nightly. Against an account
with no documented rate limit. That is how a key gets blocked rather than
throttled.

Two ordering rules follow, and they are why the task numbers below differ from
the original draft:

- **The instrument comes before the thing it measures.** The `/healthz` counter
  (task 2) is the only way to observe tasks 4 and 5 at all. It was task 6 in the
  first draft, after all three things that depend on it.
- **The fixture comes before everything.** Mock mode short-circuits at
  [arrivals.ts:10](../src/arrivals.ts#L10) and never enters `request()`, so
  "verified in mock mode" verifies none of the client behaviour. Task 0 exists
  because of this.

---

# Critical path

Eight tasks. Each carries its own verification with a numeric pass criterion —
if a task's check cannot fail, the task is not done.

Documentation is not a separate task. Where a change contradicts a line in
`README.md` or `AGENTS.md`, that line is edited in the same commit; the specific
lines are named per task.

## 0. Test harness — stub server and `node:test`

Nothing else on the critical path is observable without this, and six of the
seven remaining tasks need it.

**Stub server** (`tools/stub-datamall.mjs`, committed, not a throwaway). A
single-file Node HTTP server standing in for DataMall, driven by an env var or a
control endpoint:

| Mode | Behaviour |
|---|---|
| `ok` | 200 with a plausible `Services` body |
| `empty` | 200 with a zero-length body — the 01:30 case |
| `429` | 429 with `Retry-After: 5` |
| `500` | 500 with a body containing a fake AccountKey, to prove we never echo it |
| `slow` | 200 after a configurable delay |

It must count requests, record per-request arrival timestamps, and expose both
at `GET /_stats`. Everything downstream asserts against that counter.

Run the app against it with a dummy key — `LTA_ACCOUNT_KEY=stub-key
LTA_BASE_URL=http://localhost:9099` — which is what takes it out of mock mode.
When measuring rate rather than caching, add `ARRIVAL_TTL_MS=1`, otherwise the
15 s cache masks the behaviour under test.

**Test suite.** `node --test`, wired into `package.json` as `npm test`. Covers
`TtlCache` and the backoff/breaker state machine with an injected clock — no
`setTimeout`, no sleeping tests. Scope is deliberately those two modules; this
is not the start of a general test suite.

This changes [AGENTS.md:42-55](../AGENTS.md#L42-L55), which currently instructs
agents that no test suite exists and not to invent `npm test`. Rewrite that
section in the same commit: `npm test` exists, covers `cache.ts` and the
limiter, and everything else is still verified by running it.

**Verify.** `npm test` passes and fails for the right reason: revert the
`cache.ts` fix locally and confirm the backoff test goes red. A test suite that
has never failed has not been tested.

## 1. Endpoint path → v3

`src/lta.ts:123`: `BusArrivalv2` → `v3/BusArrival`.

The documented URL is now
`https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival` (User Guide
v6.9, 3 Aug 2026, §2.1). The old path may still resolve, but building on an
undocumented one is how this breaks silently later. Response shape is unchanged
— `RawService` / `RawBus` mappings need no edit.

`config.baseUrl` stays as-is; only the path argument changes.

Update [AGENTS.md:29](../AGENTS.md#L29), which names the dataset as
`BusArrivalv2`.

**Verify.** Drive `/api/arrivals?stops=10001` against the stub. The stub log
shows exactly one request and its path is
`/v3/BusArrival?BusStopCode=10001`. Fails if the path still contains `v2`.

## 2. Upstream call counter on `/healthz`

There is currently zero visibility into account spend, and tasks 4 and 5 cannot
be verified without it. This is why it moved to the front.

Add to the `/healthz` payload ([index.ts:39-47](../src/index.ts#L39-L47)):

- `upstreamCalls` — cumulative since boot
- `upstreamCallsPerMin` — trailing 60 s
- `breakerOpen` — boolean, from task 5

Counted inside `request()` in `lta.ts`, so it covers arrivals and the stop-list
pull alike, and so a cache hit is correctly not counted.

`/healthz` is publicly reachable and this exposes rough traffic volume. That is
acceptable — it reveals nothing about any user, and readiness already exposes
stop count. Do not add anything per-IP or per-stop to this payload.

**Verify.**

1. Mock mode: `upstreamCalls` is `0` and stays `0` after a board load.
2. Stub mode, fresh boot: load a 3-stop board. Counter rises by exactly 3 plus
   the stop-list pull. Repeat within 15 s — counter does **not** move, proving
   cache hits are excluded.
3. Readiness probes hitting `/healthz` do not increment it.

## 3. Distinguish "no buses" from "upstream broken"

Currently both collapse to `null`. The guide treats absent arrival data as a
legitimate state, so it must not be an error.

- `lta.ts`: tolerate an empty response body. Empty → `[]`, not a throw.
- `types.ts`: `services: []` now means "nothing running", `null` still means
  "the call failed".
- `public/app.js`: the two messages already exist at
  [app.js:187-191](../public/app.js#L187-L191) and already split on this
  distinction. Copy change only: `[]` renders "No buses at this hour".

Without this split, the negative cache in task 4 would treat every stop at 01:30
as a failure and back off from a perfectly healthy API. That is the actual
reason this sits ahead of task 4 rather than beside it.

Update [AGENTS.md](../AGENTS.md) architecture notes, which describe a failed
stop mapping to `null` without mentioning the empty case.

**Verify.** One board request covering two stops, stub set to `empty` for the
first and `500` for the second. Response body carries `services: []` for the
first and `services: null` for the second. In the browser, the two cards show
different messages. Fails if both are `null`.

## 4. Negative caching and backoff — `src/cache.ts`

The bug: the `.catch` at [cache.ts:32-35](../src/cache.ts#L32-L35) returns the
stale value but never writes it back, so the entry stays expired and the next
request immediately retries upstream. No backoff exists anywhere.

- On failure, re-stamp the entry with a short expiry so stale reads are served
  without a fresh upstream call.
- Per-key exponential backoff: **start 2 s, double, cap 60 s, reset to 2 s on
  the first success.**
- A key with no cached value at all still backs off — it returns the failure to
  the caller, but does not re-enter `loader()` until the window expires.
- Keep both existing properties intact: in-flight de-duplication and
  stale-on-error. `AGENTS.md` calls them load-bearing and they are.

**Verify.**

1. `npm test` — injected clock, assert the 2/4/8/16/32/60/60 progression and the
   reset-on-success.
2. End-to-end: stub in `500` mode, request `/api/arrivals?stops=10001` once a
   second for 60 s. `upstreamCalls` rises by **at most 6**, not 60. Every one of
   the 60 client responses is a 200 carrying the stale payload.
3. Nightly case: stub in `empty` mode for 60 s. `upstreamCalls` rises at the
   normal cache-miss rate and the breaker never trips — an empty body is not a
   failure. This is the regression that task 3 exists to prevent.

## 5. 429 / 5xx handling and circuit breaker — `src/lta.ts`

`DataMallError` already carries `status`
([lta.ts:15-23](../src/lta.ts#L15-L23)) and nothing reads it.

The original draft said "circuit-break after repeated 429s", which has no
threshold, no open duration and no recovery rule — nothing you could write a
failing test against. Fixing that:

| Parameter | Value | Note |
|---|---|---|
| Trip threshold | 5 consecutive 429 or 5xx across the arrivals path | Consecutive, so an isolated blip does not trip it. Arrivals only, per decision 8 — `fetchAllStops` calls upstream unguarded |
| Open duration | 60 s | Matches the backoff cap |
| Recovery | Half-open: one probe request. Success closes, failure re-opens for another 60 s | |
| `Retry-After` | Honoured when present, clamped to 120 s | An unbounded value from upstream must not wedge us |

While open, `request()` fails immediately without a socket. Callers already
degrade a failed stop to `null` ([arrivals.ts:30-35](../src/arrivals.ts#L30-L35)),
so the board still renders — fast, with "Timings unavailable" cards.

Keep the existing rule: never log or return the response body, it can echo the
AccountKey.

**Verify.**

1. `npm test` — trip, open, half-open, close, re-open, with an injected clock.
2. Stub in `429` mode with `Retry-After: 5`: after the **fifth consecutive**
   429, `upstreamCalls` does not move for 5 s. *Corrected 10 Aug 2026 — the
   first draft said "after the first 429", which describes breaker behaviour at
   a point where the breaker cannot yet have tripped. A single 429 is held only
   by the per-key backoff's 2 s window; measured at 2001 ms. See A9.*
3. Drive 6 failures, then hold. `/healthz` reports `breakerOpen: true` and
   `upstreamCalls` is flat for 60 s. `/api/board` still responds in **under
   500 ms** — an open breaker must be fast, not slow.
4. Stub in `500` mode with a fake AccountKey in the body: `grep` the full
   application log for that string. Zero hits.

## 6. Close the 50-call hole — `src/index.ts`

`pinned` is capped at 25 and `limit` is separately clamped to 25, but pinned
stops are pushed without counting against `limit`
([index.ts:70-91](../src/index.ts#L70-L91)). So `?limit=25&pinned=<25 codes>`
yields a 50-stop board and a 50-call fan-out — double the ceiling that
`README.md` and `AGENTS.md` both document as a quota guarantee.

Truncate `board` to `MAX_STOPS` before calling `arrivalsForMany`.

Pinned stops are pushed first, so truncation drops nearby suggestions before
pins. A user with 25 pins therefore sees 25 pinned stops and zero nearby ones.
That is the intended behaviour — they asked for those stops explicitly — and the
test asserts it rather than leaving it to chance.

**Verify.** `curl -s 'localhost:8080/api/board?lat=1.3521&lon=103.8198&limit=25&pinned=<25 valid codes>'`

- `stops` array length is exactly 25.
- All 25 have `pinned: true`.
- `upstreamCalls` rises by at most 25 for that request. Length alone is not
  enough — it passes even if the fan-out still fires 50 times before truncation.

## 7. Tighten the stop-code regex

[index.ts:9](../src/index.ts#L9): `/^[A-Za-z0-9]{4,8}$/` → `/^\d{5}$/`. The guide
documents `BusStopCode` as a 5-digit identifier. Rejects junk before it reaches
the fan-out.

Mock stop codes are all 5-digit ([mock.ts:10-21](../src/mock.ts#L10-L21)), so
mock mode is unaffected.

Update [AGENTS.md:127](../AGENTS.md#L127), which documents the old pattern as a
constraint to preserve.

**Verify.** `/api/arrivals?stops=ABC12` → 400. `/api/arrivals?stops=1000` → 400.
`/api/arrivals?stops=10001` → 200. Mock-mode board still returns 12 stops.

---

# Launch

## Gate

Do not proceed until all eight tasks are done and:

- `npm run build` is clean under `strict` and `noUncheckedIndexedAccess`.
- `npm test` passes.
- The full stub verification above has been run end to end, in one sitting, on
  the merge commit. Not task by task across a week.

**Gate run 10 Aug 2026, branch `datamall-activation`.** Passed. Build clean,
38 tests green, and the suite verified to fail for the right reason — removing
the `cache.ts` failure re-stamp turns exactly the two backoff tests red.
Measured against the stub: empty-body 60 s → 4 calls/min with `services: []`
and no trip; 500 for 60 s → 5 calls with all 60 client responses 200 on stale
timings; breaker open → `/api/board` median 4 ms, max 7 ms; 25 pins + limit=25
→ 25 stops and 25 calls; zero hits grepping every application log for the
stub's planted fake AccountKey. One check failed as written and was corrected
rather than the code changed — see task 5's verify item 2 and A9.

## Activation

```sh
kubectl create secret generic lta-datamall --from-literal=accountKey='...'
kubectl rollout restart deployment/bus-arrival
kubectl logs -l app=bus-arrival --tail=50        # expect the real stop count, no [MOCK MODE]
curl -s https://ezbus.sg/healthz                 # ok:true, mock:false, ~5000 stops
```

Then drop `optional: true` from the `secretKeyRef`
([k8s/bus-arrival.yaml:53](../k8s/bus-arrival.yaml#L53)) so a missing secret
fails loudly instead of quietly serving synthetic timings.

Verify that change before trusting it: roll out once with the secret name
deliberately wrong and confirm the pod fails to start rather than serving
synthetic timings to real users. Discovering this during an incident is the
failure mode it exists to prevent.

## What to watch, and for how long

The first 24 h is the test that matters, because the nightly storm is the
failure this whole critical path was built to prevent.

| When | Check | Bad sign |
|---|---|---|
| First hour | `upstreamCallsPerMin` under load | Anything above roughly 2× your user count per minute |
| 01:00–05:00 | `upstreamCallsPerMin` overnight | Sustained non-zero rate — the backoff is not holding |
| Any time | `breakerOpen` | `true` for more than ~2 min means upstream is genuinely unhappy. Not 60 s: the flag lags real recovery, because a closed breaker needs a request to reach it to serve as the probe, and every key may still be inside its own backoff window. Observed closing 17 s after upstream healed, and still `true` 20 s after in another run |
| Day 7 | Cumulative `upstreamCalls` | Feeds the token-bucket sizing in Appendix A |

Widening beyond the first users needs a week of that data, not a good first
hour.

## Rollback

Un-setting the secret returns the pod to mock mode and synthetic timings, which
is degraded but serving. Faster than a redeploy and it costs the account
nothing:

```sh
kubectl set env deployment/bus-arrival LTA_ACCOUNT_KEY-
```

This only works while `optional: true` is still on the `secretKeyRef`, so keep
that until the first 24 h cycle is clean, then drop it as above.

---

# Appendix A — deferred work

Not on the critical path. Each is specified to the point where it can be picked
up without re-deriving anything, including the numbers the first draft left
open. Roughly in the order real traffic is likely to justify them.

## A1. Global token bucket on the DataMall client

The guide documents **no rate limit at all** — the full v6.9 text was grepped
for rate limit, throttle, 429, quota, per-minute and per-day: zero hits. Absence
of documentation is not absence of enforcement, so we impose our own ceiling.

Deferred because with a handful of users the ceiling is far above anything the
app can generate, and the circuit breaker already bounds the damage from an
upstream that pushes back. Revisit at day 7 with real `upstreamCalls` data.

Sizing from what the app legitimately needs:

```
board load                     15 calls (8 after A3)
refresh, per active user      ~ 4 calls / 30 s
20 concurrent users           ~ 2.7 calls/s + board loads
```

Starting point **5 req/s sustained, burst 25** — a deliberate guess, to be
replaced by a measured figure.

**Open decision, must be settled before implementing:** when the bucket is
empty, does `request()` queue or reject? Queued calls eat the A2 deadline and
surface as `services: null` after 2.5 s; rejected calls surface as `null`
immediately. Both defensible, different tests, pick one explicitly.

Bucket wraps `request()` so it covers arrivals and the stop-list pull alike.
No-op in mock mode.

**Verify.** Unit test with an injected clock for the refill maths. End to end:
`ARRIVAL_TTL_MS=1`, request 40 distinct stop codes, read the stub's per-request
timestamps — first 25 near-instant, remainder arriving at ~5/s. Assert no window
of length *t* contains more than `25 + 5t` calls.

## A2. Deadline on the arrivals half of `/api/board`

[index.ts:94](../src/index.ts#L94) blocks the entire response on every arrival
call. With `CONCURRENCY = 5` and chunks running in series, worst case is 3 waves
× 8 s = **24 s** to first byte, on a phone, at a bus stop. Neither `loadBoard()`
nor `fetch()` sets a client timeout.

Race `arrivalsForMany` against a ~2.5 s budget. Stragglers go out as
`services: null`; they keep resolving into the 15 s cache in the background and
the refresh path picks them up at no extra upstream cost.

Trade-off accepted: on a slow-but-working upstream, some cards show
"unavailable" for ~30 s where they previously showed real timings after a long
wait. Correct call for the target device.

**Verify.** Stub in `slow` mode at 6 s.

1. `/api/board` returns in under 3 s wall clock, stragglers `services: null`.
2. Within the TTL, `/api/arrivals` for those same codes returns real services
   **and `upstreamCalls` does not move.** This is the half the first draft
   claimed but never checked — it is what proves the abandoned work landed in
   the cache instead of being thrown away.
3. No `unhandledRejection` in the log. An abandoned promise that rejects later
   is the obvious failure mode of a deadline race.

## A3. Lazy-load arrivals — 8 on first paint

`/api/board` fans out across all 15 stops while the IntersectionObserver already
knows most cards are below the fold
([app.js:215-224](../public/app.js#L215-L224)). Roughly 7 of 15 calls are for
cards that may never be scrolled to.

- Server: fetch arrivals for the first 8 board stops only; the rest ship with
  `services: null`.
- Client: fetch on scroll-into-view. `refreshArrivals()` returns early when
  `wanted` is empty and otherwise only runs on the 30 s timer
  ([app.js:336-345](../public/app.js#L336-L345)), so a newly visible card would
  sit blank for up to 30 s — the observer needs its own trigger at
  [app.js:220](../public/app.js#L220).

15 → 8 calls per board load, ~47% off the most expensive operation. Does not
split `/api/board`, so the one-request-per-paint rule in `AGENTS.md` holds for
everything visible.

**Edge case to decide:** pins are pushed first, so a user with more than 8 pins
has pinned cards outside the first-8 window painting blank. Either exempt pins
from the cap or accept it — state which.

**Verify.** Board with 15 nearby stops: at most 8 carry `services`, the rest are
`null`, and `upstreamCalls` rises by at most 8. In a narrow viewport, scrolling a
below-fold card into view produces an `/api/arrivals` request within ~1 s — not
on the next 30 s tick.

## A4. Stale-card contract

Grey card, `as of HH:MM`, countdown suppressed once the data is older than
~90 s. Consistent with how `monitored: false` is already surfaced with `*`, so
this is an extension of an existing idea rather than a new one. Gives the
negative cache in task 4 a defined user-visible meaning instead of silently
serving old data.

**This cannot be built from the current types.** `fetchedAt` is per-response
([index.ts:100](../src/index.ts#L100)) and `BoardStop` carries no timestamp
([types.ts:35-41](../src/types.ts#L35-L41)), so a card served from a stale cache
entry and one fetched fresh in the same response share one timestamp — the grey
state would either never trigger or trigger for the whole board at once. Missing
work, not in the original draft:

- `TtlCache` exposes each entry's stamp time.
- `BoardStop` and `ArrivalsResponse` gain a per-stop `servicesAsOf`.
- Both server paths populate it.

**Verify.** Stub frozen in `500` mode: one card greys out at ~90 s with its
countdown suppressed while a healthy card beside it keeps ticking.

## A5. Per-IP token bucket

`/api/arrivals` and `/api/board` are unauthenticated and reachable at
`ezbus.sg`. A four-line shell loop drains the quota. A1 bounds account
damage; this stops one caller starving everyone else.

Deferred on the reasoning that during the small-user phase the breaker is the
backstop and the URL is not advertised. That is obscurity, not a control —
promote this the moment the URL is shared anywhere public.

**Open decision:** no rate is specified. Pick a sustained req/min and a burst
before implementing.

Two implementation notes the first draft did not carry:

- `trust proxy` is on ([index.ts:23](../src/index.ts#L23)) and production sits
  behind Traefik behind cloudflared, so the key is `X-Forwarded-For`, not the
  socket address. A local `curl` loop exercises the socket path only — the test
  must set the header, and confirm what cloudflared actually forwards.
- In-memory ephemeral counters keyed by IP are **not** IP logging and do not
  breach [AGENTS.md:120-122](../AGENTS.md#L120-L122). Say so in the code comment;
  a reviewer will ask. The consequence is that when this misfires there are no
  logs to diagnose it with — accepted deliberately.

**Verify.** Loop from one `X-Forwarded-For` value until it 429s; a second value
still receives 200 throughout.

## A6. Check the rounding rule

Advisement Pt. 2 requires arrival durations rounded **down** to the minute, with
`0:59` displayed as "Arr".

Reads as already compliant: `minutesUntil` floors
([app.js:125-127](../public/app.js#L125-L127)) and `mins <= 0` renders "Arr"
([app.js:155-160](../public/app.js#L155-L160)), so 0:59 → `floor(0.98)` → 0 →
"Arr". Confirm against a fixed table rather than by inspection, using stub
`EstimatedArrival` values at known offsets:

| Offset | Expected |
|---|---|
| +0:59 | Arr |
| +1:00 | 1 min |
| +1:59 | 1 min |
| +2:00 | 2 min |
| −0:30 | Arr |

## A7. Bus Routes API for operating hours

Third dataset. Would let us say "Not In Operation" instead of "No buses at this
hour". Deferred per decision 4 — the critical path already makes 02:00 behave,
just with a vaguer message.

## A8. Remaining documentation corrections

The doc lines that contradict code changed on the critical path are edited in
those commits. What remains is a claim that is wrong today, independent of any
change:

- [README.md:92-96](../README.md#L92-L96): the 15 s TTL does not protect quota.
  It de-duplicates *concurrent viewers of the same stop*, but since the poll
  interval (30 s) exceeds the TTL, every poll is a guaranteed cache miss — it
  does nothing for steady-state rate.
- [AGENTS.md:150](../AGENTS.md#L150) repeats the same error in the Gotchas
  section: "keeps us well inside the account quota". Same correction. The first
  draft fixed only the README copy.
- Both files: note that no rate limit is documented by LTA, and that the
  breaker — later the bucket — is the control.

## A9. `Retry-After` reaches the breaker but not the backoff

Recorded 10 Aug 2026, found by the launch gate. Not a defect in anything that
was built — a gap between two mechanisms that were specified separately.

`Retry-After` is parsed in `lta.ts` and passed to `CircuitBreaker.recordFailure`,
which honours it. `Backoff.recordFailure` takes a key and nothing else, so a
single 429 against one stop is held by the backoff's own 2 s first window
regardless of what upstream asked for. Measured: upstream said 5 s, the key
retried at 2001 ms.

Bounded twice. It is per key, so it is one extra call rather than a storm, and
any run of five consecutive failures hands control to the breaker, which does
wait the full window — verified at 5.2 s with the header and flat for 60 s
without it. Worst realistic case is one intermittently-429ing stop among healthy
ones: roughly two extra calls per key per window, breaker never involved.

Deferred because closing it means threading a deadline through
`Backoff.recordFailure` and therefore through `TtlCache`, which would give the
generic cache knowledge of an HTTP header. That is the module the whole gate
rests on, and the saving is single-digit calls. Revisit at day 7 alongside A1 —
if the real `upstreamCalls` data shows DataMall sending `Retry-After` routinely
rather than exceptionally, the trade changes.

**Verify, if picked up.** Stub in `429` mode with `Retry-After: 5`, one fresh
stop code polled at 200 ms: the first retry lands at ~5 s, not ~2 s, and the
2/4/8 progression resumes only for failures upstream did not name a deadline
for.

---

# Appendix B — accepted risks

| Risk | Status |
|---|---|
| Cold start during a DataMall outage leaves the pod permanently un-ready and the site down, with `replicas: 1` and no fallback | Accepted — no snapshot, per decision 1 |
| Cannot distinguish "Not In Operation" from "No Est. Available" without Bus Routes operating hours | Accepted — deferred, per decision 4 and A7 |
| No rate ceiling of our own during the small-user phase; the circuit breaker is the only backstop | Accepted for the small-user phase only. A1 before widening |
| No per-IP limit on public unauthenticated endpoints | Accepted only while the URL is unadvertised. A5 the moment it is shared |
| Worst case 24 s to first byte on a slow upstream | Accepted for the small-user phase; A2 is the fix and users can be told directly |
| `v3/BusArrival` has only ever been exercised against `mock.ts` and the stub | First real call is the test; watch logs closely on activation |
| The stub is our model of DataMall's behaviour, and it is a guess about the empty-body case in particular | Unavoidable. The 01:00–05:00 watch is what confirms or refutes it |
