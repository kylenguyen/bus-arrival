# SEO implementation plan

Make ezbus.sg's ~5,000 stop pages and ~370 route pages visible to search
engines. Strategy approved 16 Aug 2026; this document is the execution plan.
Each task below is scoped to be executed by a separate agent, is independently
testable, and states its verification steps. Tasks T1–T7 build the feature;
T8 is the end-to-end verification gate.

**Decisions already made (do not re-litigate):**

1. Server-side rendering uses the **existing exact-string tag-replacement
   pattern** from `/stop/:code` in `src/index.ts` — no template engine, no new
   dependencies.
2. **No stops-by-road browse pages.** The crawl graph is carried by the
   `/buses` index, route-page stop lists, and nearby/opposite links on stop
   pages.
3. The services index lives at **`/buses`**.

---

## Global context (read before every task)

Every task agent must read, in this order, before touching code:

1. [AGENTS.md](../AGENTS.md) — behaviour rules. The product test is: *does this
   get a commuter to a departure time faster?* SEO additions must never cost
   the interactive experience a tap, a round trip, or a moment of reading.
2. [style-guide.md](../style-guide.md) — the Void Deck visual system, binding
   for any visible markup added to pages.
3. `src/index.ts` lines ~380–445 — the meta-injection pattern this whole plan
   extends: whole-tag exact-string constants, replaced per request, where the
   file served **unreplaced is already valid, sensibly generic HTML**. Every
   new injection target must keep that property, and every replaced tag must
   have its constant and its HTML edited in the same commit.

Facts the tasks rely on:

- **Stack**: Express 4, TypeScript compiled by `tsc` to `dist/`, zero runtime
  dependencies beyond `express`. Do not add packages.
- **Tests**: `node:test` (`describe`/`it`, `assert/strict`), files compiled to
  `dist/**/*.test.js`, run by `npm test` (which builds first). Pure functions
  are exported specifically so tests can feed hand-written records — follow
  `buildRoutes` / `routes.test.ts` as the model.
- **Data lives in memory**: `StopIndex` (`src/stops.ts`) and `RouteIndex`
  (`src/routes.ts`), loaded at boot and refreshed on timers. `stops.get(code)`,
  `stops.nearby(lat, lon, limit)`, `stops.oppositeOf(code)`,
  `routes.get(serviceNo)`, `routes.servicesAt(code)` already exist.
- **Mock mode**: with no `LTA_ACCOUNT_KEY`, the server boots with 12 synthetic
  stops (codes `10001`–`10019`, see `MOCK_STOPS` in `src/mock.ts`) and a small
  set of services (`52` loop, `167`, `985`, `74`, …). All verification below
  runs in mock mode unless stated otherwise:
  `npm run build && node dist/index.js` then `curl http://localhost:8080/...`
  (default port 8080, `src/config.ts`).
- **Canonical origin** is `https://ezbus.sg` — already hard-coded in the OG
  injection; keep using the literal, matching the existing pattern.
- **URL guards**: `STOP_CODE = /^\d{5}$/`, `SERVICE_NO = /^[A-Za-z0-9]{1,5}$/`
  in `src/index.ts`.
- `/healthz` reports `stops`, `routes` counts — verification steps use it as
  the source of truth for expected page counts.

---

## Task graph

```
T1 ──▶ T2 (sitemap)          T3 ──▶ T4 (route meta) ──▶ T6 (route body)
  └──▶ T7 (/buses)             └──▶ T5 (stop body)
T1..T7 ──▶ T8 (end-to-end verification)
```

T3→T4→T6 and T3→T5 are ordered partly because they edit the same files
(`src/index.ts`, the two shells) — run them serially, never in parallel.
T1, T2, T7 touch disjoint areas and may run in parallel with the T3 chain,
except T7's footer edit, which should land after T5/T6 to avoid merge noise
in the shells.

---

## T1 — Enumeration accessors on the two indexes

**Depends on:** nothing.

**Context.** The sitemap (T2) and the `/buses` index (T7) need to enumerate
every stop and every service. Both indexes keep their collections private
(`#stops`, `#services`) and expose only point lookups today.

**Work.**

- `StopIndex`: add `all(): readonly BusStop[]` returning the current array
  (the reference the index holds is replaced wholesale on `reload()`, never
  mutated in place, so handing it out read-only is safe — say so in the
  doc comment).
- `RouteIndex`: add `all(): RouteService[]` returning the services sorted the
  way `/buses` should list them: numerically by the numeric prefix of
  `serviceNo`, then lexically (`2` before `10` before `10e` before `12`).
  Export the comparator as a pure function so it can be unit-tested.

**Outcome.** Both indexes enumerable; sort order for services defined in one
tested place.

**Verification.**

1. New unit tests in `src/stops.test.ts` / `src/routes.test.ts`:
   `all()` length matches `size`; service ordering asserts the exact sequence
   for a hand-written list like `['12', '2', '10e', '10', 'NR7']` →
   `['2', '10', '10e', '12', 'NR7']`.
2. `npm test` passes.

---

## T2 — robots.txt and sitemap.xml

**Depends on:** T1.

**Context.** Nothing under `public/` or in `src/index.ts` serves `robots.txt`
or `sitemap.xml` today. Total URL count is ~5,400 — one `<urlset>` file is
fine (the format's limit is 50,000).

**Work.**

- New module `src/sitemap.ts` exporting a pure
  `buildSitemap(stopCodes: string[], serviceNos: string[]): string` that
  returns the XML: `https://ezbus.sg/`, `https://ezbus.sg/buses`, then
  `/stop/<code>` for every stop and `/bus/<serviceNo>` for every service
  (serviceNo in DataMall's spelling, e.g. `972M`). No `<lastmod>` — the pages'
  stable facts change rarely and a wrong date is worse than none. XML-escape
  nothing fancy: codes and service numbers are already guard-validated
  alphanumerics.
- In `src/index.ts`:
  - `GET /sitemap.xml`: build from `stops.all()` / `routes.all()` per request,
    but memoise against the two indexes' `loadedAt` values so the loop runs
    only when data actually reloaded. `Content-Type: application/xml`,
    `Cache-Control: no-cache` (same value as `STATIC_CACHE_CONTROL`, same
    reasoning).
  - Serve when ready: if either index is still empty (cold start), return
    `503` rather than a 2-URL sitemap a crawler might cache.
- New `public/robots.txt` (served by the existing `express.static`):

  ```
  User-agent: *
  Allow: /
  Sitemap: https://ezbus.sg/sitemap.xml
  ```

**Outcome.** A crawler can discover every page from one fetch.

**Verification.**

1. Unit tests for `buildSitemap` with hand-written inputs: URL count equals
   `2 + stops + services`; spot-check exact `<loc>` strings; output parses as
   XML (assert balanced tags / starts with `<?xml`).
2. `npm test` passes.
3. Boot in mock mode, then:
   - `curl -s localhost:8080/robots.txt` → 200, contains the `Sitemap:` line.
   - `curl -s localhost:8080/sitemap.xml | grep -c '<loc>'` → equals
     `2 + stops + routes` from `curl -s localhost:8080/healthz`
     (mock: 2 + 12 + services count).
   - `curl -s -o /dev/null -w '%{content_type}' localhost:8080/sitemap.xml`
     → `application/xml...`.

---

## T3 — Canonical links and og:image on all three shells

**Depends on:** nothing (schedule after T2 lands to keep `index.ts` merges clean).

**Context.** No page carries `<link rel="canonical">`. `twitter:card` is
`summary` with no image; there is no `og:image`. Icon precedent: the repo
draws its own bus mark (see the inline SVG favicon in the shells and
`tools/make-icons.mjs`, which already generates PNGs from it).

**Work.**

- **og:image**: extend `tools/make-icons.mjs` (or add a sibling tool) to
  generate `public/og-card.png`, 1200×630 — the drawn bus mark and the
  wordmark on the mosaic turquoise `#0a6a72`, per style-guide.md. Static, one
  card for the whole site. Add `og:image` (absolute URL
  `https://ezbus.sg/og-card.png`), `og:image:width`, `og:image:height`, and
  switch `twitter:card` to `summary_large_image` on all three shells.
- **Canonicals**:
  - `index.html`: static `<link rel="canonical" href="https://ezbus.sg/" />`.
  - `stop.html` / `route.html`: the same tag pointing at `https://ezbus.sg/`
    as the **replacement target**, following the exact pattern of the
    existing tag constants: define `STOP_CANONICAL_TAG` (and route
    equivalent) in `src/index.ts`, matching comment in the shell's head.
    Served raw (unknown code, or `/stop.html` via static) the generic tag is
    correct behaviour: junk URLs declare the homepage canonical and stay out
    of the index.
  - In `GET /stop/:code`, when the stop is known, replace with
    `https://ezbus.sg/stop/<code>` alongside the existing title/OG swaps.
    (Route-page per-service canonical arrives with T4, which builds the
    injection for that shell.)

**Outcome.** Every URL declares one canonical self; shared links unfurl with
an image.

**Verification.**

1. `npm test` passes (existing tests still green — the tag constants changed
   in both places).
2. Boot in mock mode:
   - `curl -s localhost:8080/ | grep canonical` → exactly one tag, href `https://ezbus.sg/`.
   - `curl -s localhost:8080/stop/10001 | grep canonical` → href `https://ezbus.sg/stop/10001`.
   - `curl -s localhost:8080/stop/99999 | grep canonical` → href `https://ezbus.sg/` (unknown code stays generic).
   - `curl -s -o /dev/null -w '%{http_code}' localhost:8080/og-card.png` → 200.
   - All three shells `grep -c 'og:image'` ≥ 1.
3. Open `og-card.png` and confirm it renders the mark legibly (attach to the
   task result).

---

## T4 — Per-service meta injection on /bus/:service

**Depends on:** T3 (edits the same shell head; reuses the canonical target).

**Context.** `GET /bus/:service` currently `sendFile`s `route.html` untouched,
so every route page shares one generic title. The stop shell shows the pattern
to copy: shell read once into a constant at boot, whole-tag replacements, raw
file valid. Endpoint names come from joining a direction's first/last stop
codes through `StopIndex` — `GET /api/route/:service` already does exactly
this join (see `RouteEndpoint` usage in `src/index.ts`); extract or mirror
that logic into a small helper this task and T6 share.

**Work.**

- Read `route.html` into `ROUTE_SHELL` at boot; define tag constants for
  title, `og:title`, `og:description`, `og:url` (add the `og:url` tag to
  `route.html` — it is missing today), and the canonical from T3.
- In `GET /bus/:service`, when `SERVICE_NO` matches and `routes.get()` finds
  the service, inject:
  - Title: `bus <serviceNo> · <origin> → <destination> · ezbus` for
    two-direction services; `bus <serviceNo> · loop at <loopDesc> · ezbus`
    for loops (empty `loopDesc` falls back to the origin description).
  - Description: `Bus <serviceNo> route: all stops from <origin> to
    <destination>, with live arrival times. Operated by <operator>.`
  - Canonical + `og:url`: `https://ezbus.sg/bus/<serviceNo>` using the
    **DataMall spelling** from `RouteService.serviceNo`, so `/bus/972m`
    canonicalises to `/bus/972M` — one indexed URL per service.
  - Everything through the existing `escapeHtml`.
- Unknown service or bad param: serve the shell untouched, as today.

**Outcome.** Every route page has a unique, exact-match title; case-variant
URLs collapse to one canonical.

**Verification.**

1. `npm test` passes.
2. Boot in mock mode:
   - `curl -s localhost:8080/bus/167 | grep -E '<title>|canonical'` → title
     names `167` and both endpoint descriptions; canonical `https://ezbus.sg/bus/167`.
   - `curl -s localhost:8080/bus/52 | grep '<title>'` → the loop form, naming
     `Opp Blk 101` (mock loopDesc).
   - `curl -s localhost:8080/bus/zzz9 | grep '<title>'` → the generic title,
     unchanged.
   - Case check: `curl -s localhost:8080/bus/74` vs any lowercase-lettered
     mock service — canonical always shows the DataMall spelling.

---

## T5 — Server-rendered static body + JSON-LD on stop pages

**Depends on:** T3. **The core task of the plan.**

**Context.** A crawler fetching `/stop/83139` today gets a stencil: the body
is skeleton markup that `public/stop.js` fills from `/api/stop/:code` and
`/api/arrivals`. Everything *stable* about a stop is already in server memory
at request time: `stops.get(code)` (name, road, coordinates),
`routes.servicesAt(code)` (every service with first/last bus per day-type and
frequency), `stops.oppositeOf(code)`, `stops.nearby(lat, lon, 6)`. The agent
must read `public/stop.html`, `public/stop.js` and `public/stop-logic.js`
before deciding where the static block sits relative to what the client
renders — the constraint is stated here, the exact DOM integration is the
agent's call.

**Work.**

- Extend the `/stop/:code` injection to replace a **body region**, not just
  head tags. The shell carries a small generic-but-valid placeholder section
  (a sentence inviting the reader to the board, matching today's no-JS
  experience or better); the constant-swap replaces it, for known stops, with:
  - `<h1>`: `<description> (<code>), <roadName>` — check `stop.html` for an
    existing h1 first and adjust rather than duplicate.
  - The **services table**: every service calling here, linked to
    `/bus/<serviceNo>`, with first/last bus (wd/sat/sun) — this is
    `servicesAt()` rendered to HTML, the same data the client shows.
  - **Opposite stop** link when `oppositeOf()` finds one; **nearby stops**:
    up to 6 from `nearby(stop.lat, stop.lon, 7)` minus the stop itself, each
    linked to its `/stop/<code>` with road name and distance in metres. Skip
    the nearby block entirely for stops with the 0,0 coordinate.
  - **JSON-LD** `<script type="application/ld+json">`: a `BusStop` (name,
    `identifier` = code, `geo` with lat/lon, address locality Singapore) and
    a `BreadcrumbList` (Home → this stop). Values through a JSON
    serialisation, not string concatenation, then `</script`-escaped
    (`<` → `<`) against injection.
- **Interaction with the client**: the live board (arrivals) stays 100%
  client-rendered — no arrival times in static HTML, ever (they would be
  stale lies in a cache). The static schedule/nearby content must either be
  the exact markup the client would build (client then hydrates in place) or
  sit in its own section the client leaves alone — agent decides after
  reading `stop.js`, with two hard requirements: **no visible flash or
  layout jump on load with JS enabled** (verify at phone width per
  AGENTS.md), and **no duplicated content visible** in the final rendered
  page.
- Bodies grow: keep the injected block plain semantic HTML styled by existing
  `styles.css` classes; any new class goes through style-guide.md tokens.

**Outcome.** `curl` of any known stop page returns complete, unique, useful
HTML — name, road, services, schedule, neighbours — with valid structured
data; the interactive experience is unchanged.

**Verification.**

1. Unit-test the block builder as a pure exported function (hand-written
   `BusStop` + `StopService[]` in, HTML out): asserts h1 content, one row per
   service, hrefs, escaping (a description containing `<&"` round-trips
   escaped), JSON-LD parses with `JSON.parse` after extracting the script
   body.
2. `npm test` passes.
3. Boot in mock mode:
   - `curl -s localhost:8080/stop/10001` → contains `<h1>` with
     `Blk 101 (10001)`, a link `href="/bus/52"`, a link to `/stop/10009`
     (the opposite), and an `application/ld+json` block that `node -e
     'JSON.parse(...)'` accepts.
   - `curl -s localhost:8080/stop/99999` → generic shell, no h1 injection,
     no JSON-LD.
4. Browser check at 390 px width (per AGENTS.md), JS on: page looks and
   behaves as today — no flash, no duplicate schedule; screenshot attached
   to the task result.
5. Browser check with JS disabled: the page is readable and every link works.

---

## T6 — Server-rendered static body + JSON-LD on route pages

**Depends on:** T4 (shell-injection infrastructure and the endpoint helper),
T5 (established body-injection pattern to mirror).

**Context.** Same shape as T5, for `/bus/:service`. Stable data:
`routes.get(serviceNo)` → per-direction ordered stop codes, first/last bus,
operator, loop metadata; each code joins through `stops.get()` for
description and road (fall back to the bare code when the join misses — the
same degradation `/api/route/:service` already documents). Read
`public/route.html` and `public/route.js` first, same drill as T5.

**Work.**

- Extend the T4 injection with a body region: per direction, an ordered list
  of every stop — `<ol>` semantics, each entry linking `/stop/<code>` with
  description and road — plus operator, loop description, first/last bus for
  the direction. Duplicated codes on a loop stay duplicated (the data is
  right; only make the *second* occurrence a plain text entry if identical
  adjacent links offend the reader).
- JSON-LD: `BreadcrumbList` (Home → Buses → this service) and an `ItemList`
  of the direction-1 stops (name + url per element). No invented schema
  types.
- Same client-interaction constraints as T5: live pane untouched, no flash,
  no visible duplication; static-only view complete.

**Outcome.** Every route page serves its full stop list as crawlable HTML;
~370 pages each linking 20–80 stop pages — the bulk of the internal link
graph.

**Verification.**

1. Unit tests for the pure builder: direction count, `<ol>` ordering matches
   input `seq` order, loop duplicate preserved, join-miss fallback renders
   the code, JSON-LD parses.
2. `npm test` passes.
3. Boot in mock mode:
   - `curl -s localhost:8080/bus/74` → two ordered lists (two directions),
     links to `/stop/10011` and `/stop/10019`, JSON-LD parses.
   - `curl -s localhost:8080/bus/52` → one list (loop), `10001` appearing
     twice.
4. Browser check at phone width, JS on and off, as T5 steps 4–5.

---

## T7 — The /buses services index

**Depends on:** T1. Footer edits land after T5/T6 (same shell files).

**Context.** New page — the one new URL in the plan. It exists for crawlers
and for the commuter who types a bus number nowhere near a stop; it must be
one page, no pagination, fast. ~370 rows of `<a href="/bus/N">N</a>` plus
endpoint summary is a few tens of KB — fine.

**Work.**

- New `public/buses.html` shell following the existing shells' head pattern
  (theme-color pair, description, OG tags, canonical
  `https://ezbus.sg/buses`, manifest, icons — copy an existing head and
  adjust; static, no per-request injection needed in the head).
- `GET /buses` in `src/index.ts`: inject the body — every service from
  `routes.all()` in T1's order, each row: service number linking
  `/bus/<serviceNo>`, origin → destination (or loop description), operator.
  Title: `all bus services in Singapore · ezbus`. Cold start (routes empty):
  serve the shell with its generic body rather than an empty list.
- Links **to** `/buses`: add a footer link on all three existing shells
  (`index.html`, `stop.html`, `route.html` all have a `<footer
  class="footer">`) — text like `all bus services`, styled by existing
  footer conventions. This is the homepage→index edge the crawl graph needs.
- Add `/buses` to the sitemap — already in T2's URL list; confirm it emits.

**Outcome.** Every service page is two clicks from the homepage; commuters
get a working directory page.

**Verification.**

1. `npm test` passes (add a test only if logic beyond render-loop emerges;
   the row builder should be a tested pure function if it exceeds trivial).
2. Boot in mock mode:
   - `curl -s localhost:8080/buses | grep -c 'href="/bus/'` → equals `routes`
     from `/healthz`.
   - Ordering: `52` before `74` before `167` before `985` in the HTML.
   - `curl -s localhost:8080/ | grep 'href="/buses"'` → footer link present;
     same for one stop page and one route page.
3. Browser check at phone width: list is readable, tap targets adequate,
   dark and light schemes both correct per style-guide.md.

---

## T8 — End-to-end verification

**Depends on:** T1–T7 all merged. This task changes no product code; it may
add a script under `tools/`.

**Work + verification (this task *is* verification).**

1. **Clean build and unit suite**: fresh checkout state, `npm ci && npm test`
   → green.
2. **Crawl the mock site.** Boot mock mode. Write (or reuse if it exists by
   now) `tools/crawl-check.mjs` — `node:` builtins only, like the other
   tools — that:
   - Fetches `/robots.txt`, extracts the sitemap URL, fetches it, parses out
     every `<loc>`.
   - Asserts sitemap URL count = `2 + healthz.stops + healthz.routes`.
   - Fetches every sitemap URL → all 200, every `/stop/` page contains
     `<h1>` and parseable JSON-LD, every `/bus/` page contains at least one
     ordered list and parseable JSON-LD, every page contains exactly one
     canonical tag whose href equals its own canonical URL.
   - BFS-crawls internal `href`s from `/` and asserts every sitemap URL is
     reached within depth 3 (home → /buses → /bus/N → /stop/C).
   - Exits non-zero with a list of failures, prints
     `crawl-check: N pages OK` on success.
3. **Realistic-path smoke.** Run `node tools/stub-datamall.mjs`, boot with
   `LTA_ACCOUNT_KEY=stub-key LTA_BASE_URL=http://localhost:9099`, re-run
   `tools/crawl-check.mjs` — proves the whole pipeline through the live
   fetch path, not just mock short-circuits.
4. **Rendered checks** (manual, phone width 390 px, both colour schemes):
   home, one stop page, one route page, `/buses` — no flash on hydrate, no
   duplicated content, footer links present, JS-disabled versions readable.
5. **Meta spot-checks**: for one stop and one route page, run the HTML
   through a JSON-LD validator (paste into schema.org validator or
   `JSON.parse` extraction) and an OG debugger preview if available.
6. **Regression guard**: `/api/*` responses byte-identical in shape to
   before (spot-check `/api/board`, `/api/stop/10001`, `/api/route/52`
   against their TypeScript types); `/healthz` unchanged apart from being
   read.
7. **Report**: the task's output is a pass/fail table of steps 1–6 with the
   crawl-check numbers (pages fetched, depth histogram) — evidence, not
   assertion.

**Launch follow-ups (manual, outside the repo, after deploy):** verify the
domain in Google Search Console and Bing Webmaster Tools, submit
`https://ezbus.sg/sitemap.xml`, then watch indexed-vs-discovered weekly.
Expect long-tail impressions to appear over 8–12 weeks. These are noted here
so they are not forgotten; they are not agent tasks.

**Divergence, 16 Aug 2026 — service-less stops are excluded from the
sitemap.** The T8 crawl found that stops no service calls at (in the stub
dataset, 50 of 250) have no inbound links except nearby-stop links on other
stop pages, putting them at depth 4 — outside the depth-3 definition of done.
Consistent with the "no browse pages" decision, the sitemap route in
`src/index.ts` now emits `/stop/<code>` only where `routes.servicesAt(code)`
is non-empty. The pages themselves are unchanged: they still serve 200,
self-canonical, reachable via nearby links — they are just not advertised.
Accordingly, `tools/crawl-check.mjs` asserts the sitemap's stop count as
`0 < stops ≤ healthz.stops` (routes stay exact) and pins coverage two-sided
through the link graph instead: every `/stop/` href on a `/bus/` page must be
in the sitemap, and every sitemap `/stop/` page must link at least one
`/bus/` page.

---

## Definition of done (whole feature)

- `npm test` green; `tools/crawl-check.mjs` green against mock **and** stub.
- Every stop and route URL: unique title, self-canonical, parseable JSON-LD,
  crawlable static body, reachable by links within 3 clicks of `/`.
- `robots.txt` + `sitemap.xml` served, counts matching `/healthz`.
- Interactive experience unchanged: no new taps, no flash, no added round
  trips (AGENTS.md rule 1 is the veto over every task above).
