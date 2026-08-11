# Replace bus-stop search with postal-code / address search

> **This document is committed to the repo as `docs/postal-code-finder.md`**, alongside
> [docs/first-run-journey.md](docs/first-run-journey.md), which is the precedent: a design
> approved before implementation, left as approved, with a delta section appended afterwards
> recording where the shipped code diverged. Do the same here — do not edit the body to match
> the code; append to it.
>
> **The postal-code dump is committed to the repo as `data/sg-places.json.gz`** (see Task 1),
> and reaches the container via a `COPY data ./data` line in the Dockerfile (see Task 7).

## Context

The finder today searches bus stops (`GET /api/stops?q=`), and a tapped stop's coordinate becomes the board origin. Two problems: a stop code is not something people know unless they are standing at the pole, and the panel is inert until the second keystroke — no icon, no clear button, no recents, no visible loading or error states.

This change makes the finder search **Singapore postal codes, buildings and roads**. The chosen address's lat/lon becomes the origin and `/api/board?lat&lon` runs exactly as today, so the board itself needs no change. Alongside it, the cheap client-only UX polish agreed earlier: field chrome, a Recent list, six explicit visible states, and keyboard navigation.

Decisions already taken, not to be relitigated:

- **No third-party API at runtime.** A postal-code dump is committed to the repo, loaded into memory at startup, searched in memory.
- **The ★ pin feature stays exactly as it is.** `PINS_KEY`, `togglePin`, the star buttons, `boardParams`'s `pinned` param and the server's pinned handling are all untouched.
- **A 5-digit stop code still works** as an escape hatch, because the dump is a ~2020 scrape (see Risks).

## Measured facts this plan rests on

| Fact | Value |
|---|---|
| Source dump | `xkjyeah/singapore-postal-codes` `buildings.json` — 57 MB, 141,726 records, ALL CAPS, missing values are the literal `"NIL"` |
| After trim + validate + dedupe by postal | **121,360 records**, 11.1 MB JSON, **1.63 MB gzipped** |
| Heap, parsed | 25.3 MB; **+9.2 MB** for the inverted index → ~35 MB total |
| Index build | ~50 ms at startup; 6,900 distinct tokens |
| Query cost | linear scan **3–18 ms** (rejected); inverted index **0.01–0.45 ms** |
| Pod budget | `512Mi` request *and* limit (k8s/bus-arrival.yaml:67-73) — 35 MB is comfortable |

The linear scan is the one to avoid: Node is single-threaded, so 18 ms per keystroke on a 250m-CPU pod would stall arrival requests.

## Shared design reference

Tasks below refer back to these sections by name. Read the one your task names before starting.

### D1 — The artefact

Gzipped JSON, **one record per line inside the array**, with an envelope carrying `source`, `licence`, `generatedAt`, `count`. Line-per-record buys `git show | gunzip | diff` line diffs for ~120 KB pre-gzip and nothing post-gzip, at single-`JSON.parse` speed. Strings stay **ALL CAPS on disk** — the dump is uniformly uppercase, so the *query* can be uppercased instead of normalising 121k records, which avoids +3.2 MB of lowercase copies. Display casing happens client-side in `titleCase()`.

```json
{"source":"https://raw.githubusercontent.com/xkjyeah/singapore-postal-codes/master/buildings.json",
"licence":"Singapore Open Data Licence (OneMap, via xkjyeah/singapore-postal-codes)",
"generatedAt":"2026-08-11","count":121360,
"places":[
{"postal":"018956","building":"MARINA BAY SANDS","block":"10","road":"BAYFRONT AVENUE","lat":1.283761,"lon":103.860719},
{"postal":"310155","building":"","block":"155","road":"LORONG 1 TOA PAYOH","lat":1.33241,"lon":103.847}
]}
```

### D2 — Validation rules (applied twice, by the tool and by the loader)

- `postal` matches `/^\d{6}$/` — rejects `"NIL"` and OneMap's `"S123456"` shapes.
- `lat`/`lon` finite and inside the Singapore box `lat ∈ [1.15, 1.50]`, `lon ∈ [103.55, 104.15]`. Stronger than a `0,0` test, and it catches records where `LONGITUDE`/`LONGTITUDE` disagree.
- `building`/`block`/`road` are strings; the literal `"NIL"` becomes `''`; whitespace collapsed; trimmed.

Duplicating this in the loader is deliberate: the artefact is committed data a human could hand-edit, and "no result carries an unusable coordinate" is the invariant that lets the client commit a row as an origin without re-checking.

### D3 — The search ladder

Query uppercased, whitespace-collapsed, truncated to 64 chars; `[]` below 2 chars. Inverted index over `building` and `road` only, tokens `/[^A-Z0-9]+/` of length ≥ 2. **Block numbers are not indexed** — short, hugely repeated, no discriminating power; handled by a scoring bonus instead. Posting lists built leading-token-first in two passes so truncating a long list keeps the rows the ladder ranks top.

Pick the token with the shortest posting list as generator (prefix-matching the *last* token against the ~6,900 keys when it has no exact list), cap candidates at `MAX_CANDIDATES = 2000`, verify survivors against remaining tokens directly on stored strings with a boundary-aware word-prefix test.

| Score | Condition |
|---|---|
| 100 | `postal === q` |
| 90 | `building === q` |
| 80 | `building` starts with `q` |
| 70 | `road === q` or `"{block} {road}" === q` |
| 60 | `building` contains `q` |
| 50 | `road` or `"{block} {road}"` starts with `q` |
| 40 | `road` contains `q` |
| 20 | no single-field match, but every query token matched |

Plus **`+15` when any query token equals `block`** — this is what puts Blk 155 above Blk 159 for `"155 toa payoh"`, a query that skips the middle of the road name and so prefix-matches nothing. Tie-break on postal ascending, as `StopIndex` ties on code.

### D4 — The endpoint

**`GET /api/places?q=` replaces `GET /api/stops`.** One client call; the server decides what the query means:

| Query | Resolved by | Row |
|---|---|---|
| `/^\d{6}$/` | `PlaceIndex.get()` | the address |
| `/^\d{5}$/` | **`StopIndex.get()`** — exact `Map` lookup, the stop-code escape hatch | the stop |
| anything else, ≥ 2 chars | `PlaceIndex.search()` | ≤ 10 addresses |

```
200 { "places": [ { postal, code, building, block, road, lat, lon }, … ] }
400 { "error": "query must be at least 2 characters" }
cache-control: private, max-age=300
```

`postal` and `code` are mutually exclusive; either may be `null`. Rows carry raw-ish fields, not a pre-formatted label — display casing and length capping belong in the client's pure, tested layer.

Two deliberate departures from copying the old route:

- **`private`, not `public`, max-age.** `/api/stops` carried stop codes; `/api/places` carries whatever the user typed, routinely their own home postal code. `public` invites Traefik or a CDN to store a URL containing a stranger's address, which sits badly beside the repo's rule that `/api/board`'s coordinate is `no-store` and never logged. `private` keeps per-keystroke caching free in the user's own browser, which is the entire practical benefit at this traffic level.
- **A new path, not the old one reused.** `public/` is served with `maxAge: '1h'`, so a stale `app.js` runs for up to an hour after deploy. A 404 makes its existing `catch` say "Search is unavailable right now." — one degraded panel, board and pins intact — where a 200 with a different body shape would render `undefined` rows.

### D5 — The origin record

```js
/** @typedef {{mode:'place', postal: string|null, code: string|null, label: string,
 *             name: string, lat: number, lon: number, at?: number}} Place */
```

- `label` ≤ 18 chars — **chip and gate only**. `building || "Blk {block}" || road || "Stop {code}" || "S{postal}"`.
- `name` ≤ 40 chars — **tagline and aria-label only**. `[building, [block, road].join(' ')].filter(Boolean).join(', ')`.
- `postal` is a **string or null**, never a number: `Number('018956')` loses the leading zero.

State the rule once so no call site invents its own: `label` wherever something shares a line or a glance; `name` wherever there is room; compose `name` + `postal` at the render site.

**Do not bump `bus-board.origin.v1`. Migrate in place.** `readOriginRecord` becomes a *normalising* read: accepts `place` records, migrates legacy `{mode:'stop', code, description, roadName, lat, lon}` to `{mode:'place', code, label: "Stop {code}", name: "{description}, {roadName}"}`, and re-caps `label`/`name` on every read. The legacy record already carries a usable coordinate, so the migration is lossless in the only dimension that matters — dropping it would send every returning stop-mode user back to the intro dialog, the exact failure `decideBoot`'s grandfathering exists to prevent. The property the old tests pinned ("only ever a 5-digit string", which made the chip safe to interpolate) is replaced by "**never returns a label longer than 18 characters or containing a newline**".

### D6 — The six finder states

`finderState({value, results, status})` → `{state, query, shouldSearch, rows, heading, note, busy, expanded, showClear}`.

| Value | Status | State | Rows | Note |
|---|---|---|---|---|
| empty | any | `idle` | — | — |
| 1 char | any | `short` | — | `Keep typing — 2 letters, or a 6-digit postal code.` |
| ≥ 2 | searching | `searching` | **previous rows, kept** | — (`busy: true`) |
| ≥ 2 | ok, hits | `results` | results | — |
| ≥ 2 | ok, none | `empty` | — | `No address matched.` |
| ≥ 2 | offline | `offline` | — | `Search is unavailable right now.` |

Rows arrive pre-converted (each carries a ready `Place`), so `app.js` commits with `choosePlace(searchRows[i].place)` — no branch, no second lookup, and unrankable rows are filtered out before render rather than refused on tap. Keeping previous rows during `searching` stops the list emptying and refilling on every keystroke.

**`recents` is no longer an input, and three states no longer borrow rows from it.** The Recent list used to fill `idle`, `short` and `offline`, which is why `#results` announced itself as "Search results" over it — open issue 4, now closed by construction. Recents live in `originsState` (D6a), above the box and on screen in *every* state, which is strictly better than the property this table used to boast about: the addresses you use most are one tap away with the network down *and* with it up.

### D6a — The destinations list

`originsState({origin, recents, geolocationSupported})` → `{heading, rows}`, each row `{kind, place, primary, detail, status, current, showUpdate}`.

| Row | When | `current` | `detail` | `status` | `showUpdate` |
|---|---|---|---|---|---|
| `gps` | `geolocationSupported === true` | origin is gps | `Uses your device location`, or `''` when current | `Showing now` when current | only when current |
| `place` | one per recent, capped at `RECENT_MAX` | it is the origin | `Singapore {postal}` → `Stop {code}` → `''` | `Showing now` when current | never |

This is what replaced the two `.ghost` buttons in which state and action were the same control — a ✓ generated from `aria-pressed` on a button that still fired geolocation, so the common case read as "already done, nothing to do". `current` marks; `showUpdate` acts; there is no ✓ anywhere.

Rules worth naming: the gps row is **omitted** when geolocation cannot work rather than disabled (the rule `app.js` used to apply by removing a DOM node), and only a literal `true` counts, so a caller that forgets the flag loses the primary door loudly instead of shipping a dead one quietly. The current place origin is hoisted to the front of the place rows whether or not `recents` holds it, and deduplicated against them by `recentKey` — the *same* identity function `rememberRecent` uses, so the two lists cannot disagree about what counts as the same address. Rows mirror `renderRows`' two lines, so the destinations and the search results read as one list split by a rule.

### D7 — Copy table

| Site | New |
|---|---|
| `taglineFor(origin, mock)` | `Stops near {name}, live from LTA` / `Stops near {name} · demo timings, not live` |
| `gateMessageFor` / `noStopsMessage` | `Finding stops near {label}…` / `No bus stops found near {label}.` — short label; these sit centred over skeleton cards |
| `chipState.label` / `.ariaLabel` | `{label} ▾` / `Change stops shown. Currently: stops near {name}, Singapore {postal}` |
| `dismissGate`, `busy()` hatch, `onLocationRefused`, `#intro-code` | `Enter an address` (one shared constant) |
| `#intro-code-sub` | `A postal code, building or road` |
| `#origins-head` | `Show stops near` |
| gps row / its `detail` | `Near you` / `Uses your device location` |
| `CURRENT_STATUS` / `.origin-update` | `Showing now` / `↻ Update my location` |
| `#search` placeholder / `<label>` | `Search postal code or place` / `Search for an address or postal code` |
| `#finder-hint` | `Postal code, building or road name` |
| `COMMIT_HINT` | `Enter a 6-digit postal code, or at least two letters.` |
| unfound postal / unfound stop | `No address at 310155.` / `No stop with code 43179.` |

The tagline is one sentence with two clauses, composed in the pure function. It used to be two competing sentences with a guard in `app.js` picking between them, and the demo notice both won and latched — so `Demo data — no LTA API key configured yet` replaced the only line saying where the board was ranked from, permanently, and said it in the vocabulary of whoever deploys the thing rather than whoever is waiting at the stop.

What the box accepts now lives in `#finder-hint` rather than in the placeholder alone: a placeholder is gone by the first keystroke, which is exactly when a rider typing an abbreviated road name needs to know what the box understands.

### D8 — Invariants that must survive every task

- **iOS transient activation.** No `await` may be introduced above `getPosition()` on any click path. Every route to it runs `intro.close()` → `closeSearch()` → `busy()` → `getPosition()` synchronously. See [public/app.js:675-689](public/app.js#L675-L689) and [:1076-1086](public/app.js#L1076-L1086).
- **`origin.js` purity.** No DOM, no `fetch`, no `localStorage`, no clock. Enforced by the tripwire at [src/origin.test.ts:31-45](src/origin.test.ts#L31-L45). Anything time-dependent takes `now` as a parameter.
- **Nothing moves from `origin.js` into `app.js`.** The pure layer only grows; moving logic into glue silently deletes its test coverage.
- **`escape()` before `innerHTML`** for every interpolation of server data. Address strings come from a scraped dump — untrusted.
- **Rows and the array they index are written in one synchronous block.** True of `searchRows`/`#results` in `applyFinder`, and of `originRows`/`#origins` in `renderOrigins`. Rows commit by `data-index`, so an index read off the DOM must always address the array that produced that DOM; split the two statements across an `await` and a fast typist commits the wrong address. `renderOrigins` is called from `openSearch` and nowhere else, which is what keeps that pair impossible to desync.
- **`localStorage`** reads go through `readRaw`, writes through `write()`.
- **`shellSignature` does not encode origin mode**; all three explicit resets stay ([app.js:990](public/app.js#L990), [:1109](public/app.js#L1109), [:355](public/app.js#L355)).
- `npm run build` passes clean under `strict` + `noUncheckedIndexedAccess`; no `any`, no `!`.
- No new npm dependencies. `node:` builtins only.

---

# Tasks

Nine tasks. Task 0 is the paper trail; after it, **1 → 2 → 6** and **3 → 4 → 5 → 6** are the two chains, and they only meet at task 6. Every task ends with the repo building, `npm test` green, and the app working at 375 px.

---

## Task 0 — Commit this plan to the repo

**Depends on:** nothing. Do this first, so every later task has a versioned reference to cite.

### Deliverables

- `docs/postal-code-finder.md` — this document, verbatim

### Spec

Copy this plan to `docs/postal-code-finder.md` unchanged. It is the design record for the whole change, and every task above cites its sections (D1–D8) by name.

Follow the convention [docs/first-run-journey.md](docs/first-run-journey.md) establishes:

- The body is the design **as approved**. Later tasks must not rewrite it to match what they built.
- When implementation diverges — and on a change this size it will — append a final section, `## Implementation notes — where the shipped code diverges from the plan above`, dated, with one numbered entry per divergence and the reason. That file's own version of this section is the model: it records five real corrections, including two the plan got factually wrong, precisely so a future reader trusting the plan over the code does not reintroduce them.
- Relative links (`public/app.js`, `src/places.ts`) work from `docs/` in the GitHub UI; keep them relative, not absolute.

Do **not** add it to `README.md`'s or `AGENTS.md`'s file lists in this task — that is Task 8's job, and doing it here would mean touching those files twice.

### Verify

```bash
ls -l docs/postal-code-finder.md
grep -c "^## " docs/postal-code-finder.md    # the section headings survived the copy
```

**Done when:** the file exists in `docs/`, its content matches the approved plan, and its links resolve when viewed from the `docs/` directory.

---

## Task 1 — Build and commit the postal-code artefact

**Depends on:** nothing. **Read first:** D1, D2, [tools/stub-datamall.mjs](tools/stub-datamall.mjs) for house style.

### Deliverables

- `tools/build-places.mjs` — new
- `data/sg-places.json.gz` — new, committed (~1.5 MB)
- `README.md` — attribution paragraph only

### Spec

A hand-run tool. `#!/usr/bin/env node`, `node:` builtins only, a long header comment stating what it is for and how to run it. **Never added to `package.json` scripts** and never run in CI — a build step that downloads 57 MB from GitHub raw would put a third-party outage in the release path.

```
node tools/build-places.mjs
node tools/build-places.mjs --input buildings.json --out data/sg-places.json.gz
```

Pipeline:

1. `fetch(SOURCE_URL)` → `res.text()` → `JSON.parse`. Peak RSS is ~600–800 MB on a 57 MB document; say so in the header comment, and note the fallback (`curl` it down, re-run with `--input`, or `node --max-old-space-size=2048`). `--input` exists so a re-run does not re-download.
2. Apply D2 per record, **counting each rejection reason separately**.
3. Round `lat`/`lon` to 6 decimals (~0.1 m). The source carries ~14 significant digits, which is noise, and the rounding is most of what gets the artefact under 1.63 MB.
4. Drop `ADDRESS`, `SEARCHVAL`, `X`, `Y`, `LONGTITUDE`.
5. Dedupe by `postal`, **preferring the record that has a `BUILDING`** over one that does not; count collisions.
6. **Sort by `postal` ascending.** This is what makes the output byte-reproducible — the same input yields the same bytes, so a regeneration diff is data change only.
7. Serialise per D1, `gzipSync(…, { level: 9 })`, write.
8. Print a summary to stdout: input count, per-reason drops, dedupe count, final count, raw bytes, gz bytes, distinct token count, and **three spot-check records looked up by postal** (`018956`, `310155`, `738099`) so a human can eyeball that fields did not get scrambled. Print the attribution line that must appear in README.

**If the artefact lands above 2.0 MB gzipped**, switch the record form to positional arrays (`["018956","MARINA BAY SANDS","10","BAYFRONT AVENUE",1.283761,103.860719]`) — ~30% smaller and faster to parse, at the cost of a loader that indexes by position. The tool prints both sizes so this is decided on a number, not a guess.

### Verify

```bash
node tools/build-places.mjs
ls -l data/sg-places.json.gz                     # expect ~1.4–1.7 MB
node -e "
const {gunzipSync}=require('node:zlib'), fs=require('node:fs');
const f=JSON.parse(gunzipSync(fs.readFileSync('data/sg-places.json.gz')).toString());
console.log(f.count, f.places.length, f.generatedAt, f.licence);
const bad=f.places.filter(p=>!/^\d{6}\$/.test(p.postal)||!(p.lat>1.15&&p.lat<1.5&&p.lon>103.55&&p.lon<104.15));
console.log('invalid:',bad.length);
const seen=new Set(f.places.map(p=>p.postal)); console.log('unique:',seen.size);
const sorted=f.places.every((p,i,a)=>i===0||a[i-1].postal<=p.postal); console.log('sorted:',sorted);
console.log(f.places.find(p=>p.postal==='018956'));
"
```

**Done when:** count is ~121,360; `invalid: 0`; `unique` equals `count`; `sorted: true`; postal `018956` resolves to a plausible Marina Bay building with a Singapore coordinate; the tool's summary shows the per-reason drop counts; re-running the tool produces a **byte-identical** file (`md5` it twice); README carries the OneMap / Singapore Open Data Licence attribution.

---

## Task 2 — `PlaceIndex` and its tests

**Depends on:** Task 1. **Read first:** D1, D2, D3, and [src/stops.ts](src/stops.ts) for the class shape and comment density this must mirror.

### Deliverables

- `src/places.ts` — new
- `src/types.ts` — add `Place`, `PlacesResponse`
- `src/places.test.ts` — new

Purely additive. No route is wired; nothing calls this yet.

### Spec

```ts
export const PLACES_PATH = path.join(import.meta.dirname, '..', 'data', 'sg-places.json.gz');

export class PlaceIndex {
  #records: PlaceRecord[] = [];
  #byPostal = new Map<string, number>();
  #tokens = new Map<string, number[]>();
  #generatedAt: string | null = null;

  get size(): number;
  get generatedAt(): string | null;
  load(filePath?: string): void;          // catches + logs, mirroring StopIndex.reload()
  loadBuffer(gzipped: Uint8Array): void;  // throws on a malformed artefact; the test seam
  get(postal: string): Place | null;
  search(query: string, limit?: number): Place[];
}
```

- **No refresh timer and no `stop()`.** `StopIndex` has one because DataMall's list changes; this file is baked into an image with `readOnlyRootFilesystem: true` and cannot change under a running pod. Say why in a comment, or someone will add one back.
- **`generatedAt` replaces `loadedAt`** — it says how stale the *data* is, which is what an operator wants; `loadedAt` would always mean "boot".
- **Synchronous load.** One code path, no half-loaded state, no promise anyone can forget to await. ~200 ms of blocked event loop, called after `listen()`, unobservable behind the readiness probe's `initialDelaySeconds: 3`.
- `load()` swallows and logs, leaving `size` at 0 — the same contract as `StopIndex.reload()`, so `index.ts` needs no `try`. Success logs `loaded 121360 places (generated 2026-08-11) in 214 ms`. **Nothing on this path ever logs a query string.**
- `loadBuffer` re-applies D2, rejecting per-record and countably, and logs once if anything was rejected.
- `search` implements D3. `limit` defaults to **10**, not `StopIndex`'s 20: ten rows already scroll at 375 px and the payload is on cellular.
- `PlaceRecord` (the on-disk shape) stays **private to `places.ts`**; `Place` (the wire shape) lives in `src/types.ts`. Same boundary discipline as `RawStop` in `lta.ts` — map at the boundary, never leak the artefact's field names past it.

### Tests

**Fixture strategy: build it in memory.** ~12 hand-written records → `JSON.stringify` the envelope → `gzipSync` → `index.loadBuffer(buf)`. No fixture file is committed, no file is written, and the gunzip → parse → validate → index path is exercised for real. **The 11 MB artefact is never opened by a test** — `node --test` gives each file its own process, so it would cost ~200 ms and ~35 MB per file and would fail for reasons belonging to the data rather than the code. Say this in the file header, because the neighbouring `stops.test.ts` does the opposite.

Static imports are fine here — unlike `stops.test.ts`, `places.ts` reads no `process.env` and never calls `fetch`, so none of that file's dynamic-import ceremony is needed. Note that in the header too.

Fixture contents: Marina Bay Sands (building + block + road); two blocks on `LORONG 1 TOA PAYOH` (155 and 159, no building); `TOA PAYOH HDB HUB`; a bare `TOA PAYOH`; `ST. GEORGE'S ROAD` (punctuation); a road-only record; and five deliberately invalid records.

Added with the abbreviation and ranking work: `WOODLANDS AVENUE 5`, `ANG MO KIO AVENUE 3` and `JALAN BESAR` (the roads a rider types the short form of); `OCBC ANG MO KIO AVE 1 - 7 ELEVEN` with block `339` (the decoy whose block prefix-matched a trailing `3`); `CITIBANK TOA PAYOH HUB` at the Hub's own coordinates (the tenant-over-landmark pair); and `NTUC FAIRPRICE TOA PAYOH` (a brand that must still be findable by name, so the `UNNAMED_LEAD` penalty cannot misfire unnoticed).

| Block | Cases |
|---|---|
| `loadBuffer` | seeds `size` and `generatedAt` from the envelope · rejects countably: non-6-digit postal, non-finite coordinate, `0,0`, outside the SG box, duplicate postal — assert final `size` and `get()` → `null` for each · throws on valid gzip whose `places` is not an array, leaving `size` at 0 |
| `search` | 6-digit query returns exactly that one record · 6-digit with no match returns `[]` and does **not** fall through to token search · exact building outranks prefix outranks contains · building outranks road for the same query · `'  toa   payoh  '` ≡ `'TOA PAYOH'` · order-independent AND: `'hub payoh'` hits, `'hub sengkang'` does not · prefix applies to the **last** token only (`'toa pay'` matches, `'pay toa'` does not) · `'george'` finds `ST. GEORGE'S ROAD` (the boundary case a plain `includes(' '+t)` misses) · block bonus: `'155 toa payoh'` and `'155 lorong 1 toa payoh'` both put Blk 155 above Blk 159 · **`'155'` alone returns `[]`** — pins the documented consequence of not indexing block numbers, so nobody "fixes" it · `[]` below 2 chars and for `''` · `limit` caps the count · two identical queries return deeply equal arrays · a building-less record is found by road · no result ever carries `0,0` |
| `get` | trims its input · `null` for an unknown postal |

Several of these pin asymmetries that look like bugs (`'155'` → `[]`, `'pay toa'` → no match). Give each a one-line WHY comment, matching the house style.

### Verify

```bash
npm run build && npm test          # all existing + ~18 new cases green
node -e "
const {PlaceIndex}=await import('./dist/places.js');
const i=new PlaceIndex(); const t=Date.now(); i.load();
console.log('size',i.size,'generated',i.generatedAt,'load ms',Date.now()-t);
for(const q of ['310155','toa payoh','marina bay sands','george','155','ion'])
  console.log(q,'→',JSON.stringify(i.search(q).slice(0,2)));
console.log('heap MB',(process.memoryUsage().heapUsed/1048576).toFixed(1));
" --input-type=module
```

**Done when:** `npm test` green and `npm run build` clean with no `any`/`!`; the real file loads in under ~400 ms; `size` is ~121,360; heap after load is under 50 MB; each sample query returns plausible top hits; `'155'` returns `[]`.

---

## Task 3 — Pure client additions, nothing wired

**Depends on:** nothing (parallel with 1–2). **Read first:** D5, D6, D8, and [public/origin.js](public/origin.js) in full.

### Deliverables

- `public/origin.js` — add functions, one rename
- `public/app.js` — the single call site of the rename
- `src/origin.test.ts` — five new blocks, appended

**No behaviour change.** Every new export is unused at the end of this task. This is the harness the next three tasks build on.

### Spec

Rename `isUsableStopCoord` → `isUsableCoord` (body unchanged — a scraped dump absolutely contains `0,0`, so the guard stays load-bearing). Update the one `app.js` call site, the import list, and the test block name.

Add:

| Function | Signature → returns | Notes |
|---|---|---|
| `titleCase(s)` | `(string) → string` | ALL CAPS → display case, word by word. Lives here, pure and tested, which is why the server ships caps. Words in the bounded `ACRONYMS` allowlist keep their capitals (`HDB HUB` → `HDB Hub`); there is deliberately no vowel-based heuristic behind it — see open issue 3 |
| `placeFromRow(row)` | `(ServerRow) → Place \| null` | The **single** server-row → origin mapping. `null` for `!isUsableCoord` or a row with nothing to name it. Collapses whitespace, title-cases, caps `label` at 18 and `name` at 40 per D5 |
| `readRecents(raw)` | `(string\|null) → Place[]` | `JSON.parse` in a `try`; array only; every entry through the same normaliser as `readOriginRecord`; sliced to 5. Corrupt ⇒ `[]` |
| `rememberRecent(list, place)` | `(Place[], Place\|null) → Place[]` | New array, `place` first, deduped by `postal` when present else by `lat,lon`, capped at 5. Pure, no clock — order is positional, so no `at` and no `now` parameter |
| `moveActive(index, delta, count)` | `(number, number, number) → number` | Wraps both ends; `-1` when `count === 0`; `-1 + (-1)` → `count-1`; clamps an out-of-range start |
| `finderState(input)` | see D6 | The whole six-state panel decision |
| `SEARCH_DEBOUNCE_MS` | exported const `250` | Moved out of `app.js` to sit with the rules it belongs to. Exporting a *duration* is not reading a clock — the tripwire stays green |

Internal, not exported (pinned by behaviour tests instead): `LABEL_MAX = 18`, `NAME_MAX = 40`, `RECENT_MAX = 5`, `collapseSpace(v)`, `cap(s, n)`.

### Tests

Append five blocks at the end, in the order above — [src/origin.test.ts:43-44](src/origin.test.ts#L43-L44) says append rather than reorder so several agents can add to the file.

| Block | Cases |
|---|---|
| `placeFromRow` | builds label/name/postal from a block+road row · prefers a building name for the label · falls back to `Stop {code}` then `S{postal}` · `null` for `0,0`, for a missing coordinate, and for a row with nothing nameable · caps the label at 18 with an ellipsis · caps the name at 40 · collapses `\n`, `\t`, runs of spaces · keeps a leading-zero postal **as a string** (`018956`) · nulls a 5-digit or non-string postal without dropping the row |
| `readRecents` | `[]` for `null`, `''`, `'{'`, `'null'`, a JSON object, an array of junk · keeps well-formed entries in order · drops unrankable entries rather than the whole list · caps at 5 · re-caps an over-long stored label |
| `rememberRecent` | puts the place first · dedupes by postal, **moving** the existing entry to the front rather than adding a second · dedupes by `lat,lon` when both postals are null · caps at 5, dropping the oldest · a `null` place returns the list unchanged · **never mutates the input array** |
| `moveActive` | `-1 → 0` on down · wraps last → 0 · `-1` up → last · `-1` for count 0 · clamps out-of-range |
| `finderState` | all six D6 states asserting `state`, `rows.length`, `heading`, `note`, `busy`, `expanded` · `shouldSearch` false below 2 chars, true at 2 · `query` normalised (`S310155` → `310155`) · rows are recents in `idle`/`short`/`offline`, results in `results` · previous rows survive `searching` · unrankable results filtered out of `rows` · `showClear` follows a non-empty value · **`note` in the `empty` state is byte-identical to `commitDecision`'s no-match message** |

### Verify

```bash
npm run build && npm test
grep -n "isUsableStopCoord" public/ src/          # expect no hits
node --test dist/origin.test.js                   # tripwire block must be green
npm start                                          # app unchanged: search, pin, board all work as before
```

**Done when:** all new blocks green; the purity tripwire green; `isUsableStopCoord` appears nowhere; the running app behaves **exactly** as before this task.

---

## Task 4 — The origin record becomes a place

**Depends on:** Task 3. **Read first:** D5, D7, D8.

### Deliverables

- `public/origin.js` — changed and deleted functions
- `public/app.js` — glue
- `public/index.html` — delete `#board-note`, intro copy
- `public/styles.css` — delete `#board-note`, add the chip ellipsis rule
- `src/origin.test.ts` — edits in place, two blocks deleted

**The search is still bus-stop search and still works.** This task only changes what an origin *is*. That is what keeps it independently shippable.

### Spec

**Delete** `shouldShowDelistedNote` and `delistedNote`. A postal origin is never a bus stop, so it can never be "no longer in service"; a migrated stop origin is a fixed point, and if LTA delists the stop the board correctly shows the 8 nearest to that coordinate. These two are the only consumers of the all-pinned `board.some(s => !s.pinned)` reasoning, so it goes with them. In `app.js` also delete `boardNote()`, `applyBoardNote()`, `el.boardNote`, both call sites, and `boardNote('')` in `switchOrigin`; in the markup delete `<p id="board-note">` and its CSS rule.

**Change:**

| Function | Change |
|---|---|
| `readOriginRecord` | normalising read + legacy `{mode:'stop'}` migration, per D5 |
| `decideBoot` | `journey: 'intro' \| 'gps' \| 'place'`; grandfathering logic untouched |
| `originCoord`, `boot()`'s branch | `'place'` instead of `'stop'` |
| `distanceLabel` | **collapses to four lines.** `(This stop)` deleted — no meaning, and no code to match on. Place mode now uses `formatDistance`, i.e. metres **plus a walking time**: stop mode refused it because the board could be ranked from a stop the user was nowhere near, but a typed address is somewhere they are at or going to, so the walk is real and is the most decision-relevant number on the card. `Here` stays **gps-only** — `AT_STOP_M` is a statement about GPS fix noise, and a geocoded building has none |
| `taglineFor`, `gateMessageFor`, `noStopsMessage`, `chipState`, `dismissGate` | copy per D7 |

**Unchanged, and confirm so:** `formatMetres`, `formatDistance`, `boardParams` (keeps `pinned` exactly as is), `shouldRelocateOnFocus` (its `origin?.mode !== 'gps'` guard needs no edit — a place origin never re-locates, same as a stop origin), `refusalCopy`, `gateState`, `introVariant`.

In `app.js`, `chooseStop` maps its stop search result through `placeFromRow({postal: null, code, building: description, block: '', road: roadName, lat, lon})` — the stop path now produces a `Place` like everything else. `boot()`'s `'stop'` branch becomes `'place'`.

**The chip layout problem, solved explicitly.** Budget at 360 px: ~333 px usable − ~110 px `h1` − 12 px gap − ~31 px chip padding ≈ **180 px ≈ 24 characters**. Three defences: `label` capped at 18 in `placeFromRow` and re-capped on read; `label` prefers a short token by construction; and a CSS backstop:

```css
#origin-chip { min-width: 0; max-width: 58%; overflow: hidden; text-overflow: ellipsis; }
```

That last rule is worth adding on its own merits — `.ghost` is `white-space: nowrap` with no `min-width: 0` today, so a long label would overflow the viewport horizontally rather than shrink, which AGENTS.md explicitly forbids.

### Tests

Edit blocks **in place** (they are keyed by function name); delete the `shouldShowDelistedNote` (6 cases) and `delistedNote` (1 case) blocks entirely. Replace the `STOP_RECORD` fixture with `PLACE_RECORD` + `LEGACY_STOP_RECORD`.

| Block | Delete | Add |
|---|---|---|
| `readOriginRecord` | "returns null for a 6-digit code"; "only ever accepts a 5-digit string" | migrates a legacy stop record keeping lat/lon · still rejects a legacy stop at `0,0` and a 4-digit code · rejects a `place` with no coordinate, at `0,0`, or with an empty label · **nulls** a non-6-digit `postal` rather than rejecting the record · **property test:** never returns a label over 18 chars or containing a newline, fed a 200-char label and an embedded `\n` |
| `decideBoot` | — | `'stop'` → `'place'` in two cases · **a legacy stop record boots to `'place'` with `persist: false`** — the regression net for returning users |
| `taglineFor` | — | `Stops near {name}, live from LTA`; keep the `/live from LTA$/` invariant across `[GPS_RECORD, PLACE_RECORD, null]` |
| `gateMessageFor` | — | uses the **short** label: `assert.equal(msg.includes('Lorong'), false)` |
| `chipState` | the newline/road-name case (rewrite) | label is `{label} ▾` · aria-label carries the full name **and** `Singapore {postal}` · label never exceeds 18 chars + caret for any record `readOriginRecord` can return · label never contains `\n` |
| `distanceLabel` | the three stop-mode cases | place mode shows metres **and** a walking time · place mode never says `Here`, even at 0 m · place mode never says `(This stop)` · gps `Here` cases unchanged · keep the "never puts a raw `<` in the label" case |
| `originCoord`, `boardParams`, `shouldRelocateOnFocus`, `noStopsMessage`, `dismissGate` | — | fixture rename and copy only; assertions otherwise unchanged |

### Verify

```bash
npm run build && npm test
grep -rn "board-note\|delistedNote\|shouldShowDelistedNote\|This stop" public/ src/   # expect no hits
npm start
```

Then in the browser, with DevTools → Application → Local Storage:

1. **The migration — the highest-value check.** Set `bus-board.origin.v1` to `{"mode":"stop","code":"43179","description":"Blk 155","roadName":"Lor 1 Toa Payoh","lat":1.3325,"lon":103.8475,"at":1}`, reload. Expect: **no intro dialog**, the board loads, the chip reads `Stop 43179 ▾`, and the stored record has been rewritten to `mode:"place"`.
2. Clear all keys, reload → intro dialog. Choose a stop → chip, tagline and board all name it; cards show metres **and** a walking time; no card says `(This stop)`.
3. GPS mode: the nearest card still says `Here` under 30 m.
4. Pin two stops, switch origin → pins still first, ★ still toggles, `?pinned=` still on the request.
5. At 360 px, set a long label by hand in storage → the chip ellipsises and the page does **not** scroll horizontally.

**Done when:** all of the above pass, `npm test` is green, and the grep returns nothing.

---

## Task 5 — Field chrome

**Depends on:** Task 4. **Read first:** D8; [public/styles.css:317-380](public/styles.css#L317-L380).

### Deliverables

- `public/index.html` — `.finder-field` wrapper, icon, clear button, combobox scaffolding
- `public/styles.css` — new selectors
- `public/app.js` — the clear-button listener

Rows stay exactly as they are; the state model arrives in Task 6.

### Spec

```html
<div class="finder-field">
  <svg class="finder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false">
    <circle cx="11" cy="11" r="7"></circle><path d="M16.5 16.5 21 21"></path>
  </svg>
  <input id="search" type="search" role="combobox" aria-expanded="false"
         aria-controls="results" aria-autocomplete="list" aria-activedescendant=""
         inputmode="search" enterkeyhint="search" autocomplete="off" spellcheck="false"
         placeholder="e.g. 310155 or Toa Payoh Hub" />
  <button id="finder-clear" type="button" class="finder-clear"
          aria-label="Clear the search box" hidden>×</button>
</div>
<p id="results-head" class="results-head" hidden></p>
<ul id="results" class="results" role="listbox" aria-label="Search results" hidden></ul>
```

Inline SVG, not an asset: no request, and `currentColor` gets dark mode for free. `#results-head` sits **outside** the listbox — a heading is not an option.

Styles to add: `.finder-field { position: relative }`; input padding `2.5rem` left / `2.9rem` right; `.finder-icon` absolutely positioned, `1.05rem`, `var(--muted)`, `pointer-events: none`; `.finder-clear` a 2.6rem tap target at the right edge; `input[type='search']::-webkit-search-cancel-button { appearance: none }` so the native × does not double up; `.results-head` uppercase `0.75rem` `var(--muted)`; `.results[aria-busy='true'] { opacity: .6 }`.

The clear listener must be **synchronous throughout**: `el.search.value = ''; searchResults = []; activeIndex = -1; el.results.hidden = true; el.finderClear.hidden = true; el.search.focus();`. Show/hide `#finder-clear` from the existing `input` listener.

**The search icon is decoration and I would drop it.** It costs ~2.5rem of a 360 px field whose placeholder is already tight, inside a panel that already says "or search for an address", on an `input type="search"` with `enterkeyhint="search"`. The **× is functional** — clearing a 6-digit typo on a phone otherwise means long-press → select all → delete. Both are specced because you asked for both; if the field feels cramped at 360 px, the icon is the first thing to cut.

### Verify

```bash
npm run build && npm test && npm start
```

- The field renders with icon and no native ×; typing shows the clear button; tapping it empties the field, keeps focus, and the keyboard stays up on a phone.
- **On iOS or a 375 px emulation, focusing the input must not zoom the page** — the `font-size: 1rem` rule at [styles.css:317](public/styles.css#L317) is what prevents it and the new padding must not disturb it.
- Dark mode: icon and × both legible.
- 320/360/390 px: no horizontal scroll, placeholder not clipped mid-word.
- Tab order: input → clear → results. `#search` reports `role=combobox` in the accessibility tree.
- **D8 check:** the intro's "Use my current location" still triggers the permission prompt on a real iPhone — no `await` was introduced above `getPosition()`.

**Done when:** all of the above, and the finder still searches stops and commits an origin exactly as after Task 4.

---

## Task 6 — The swap

**Depends on:** Tasks 2 and 5. **Read first:** D3, D4, D6, D7, D8.

Server and client land **together**. Item 3's stale-client reasoning means a split ships a broken finder for up to an hour.

### Deliverables

- `src/index.ts` — `/api/places`, delete `/api/stops`, wire `places.load()`, extend `/healthz`
- `src/stops.ts` — delete `search()` and the now-unused `normalise`
- `src/stops.test.ts` — delete the three search cases, rewrite the header
- `public/app.js` — `fetchPlaces`, `applyFinder`, `renderRows`, `setActive`, rewritten `runSearch`/`commitSearch`, recents, arrow keys
- `public/origin.js` — `commitDecision` rewritten
- `public/index.html`, `public/styles.css` — row markup and styles
- `src/origin.test.ts` — `commitDecision` block rewritten

### Server spec

Implement D4. Validation mirrors the old route: `typeof req.query.q === 'string'` else `''`; `< 2` chars after trim → 400 with the same wording; truncate `q` to 64 chars before it reaches `search()`.

`/healthz` gains `places` and `placesGeneratedAt`, and readiness becomes `stops.size > 0 && places.size > 0`. Gating is right because the failure is deterministic at image-build time: with `replicas: 1` and the default RollingUpdate, a bad artefact blocks the rollout and the old pod keeps serving. **Add a comment saying that if this file ever moves to a mounted volume or a network fetch, the gate must come off in the same change.**

`places.load()` is called unconditionally after `listen()` — `mockMode` is about the DataMall key and this data is not LTA's. Consequence to document rather than hide: in mock mode the finder returns 121k real addresses over 12 synthetic stops, so a Jurong address shows demo stops 15 km away.

`GET /api/board` is untouched — no signature change, no new parameter, no new field.

### Client spec

`commitDecision({value, rows, status, activeIndex})`, in order:

1. `status === 'offline'` → `wait`. **This absorbs `app.js`'s untested `if (searchUnavailable) return;`** — a net coverage gain.
2. A highlighted row → `{action:'choose', index: activeIndex}`, outranking everything: a user who typed digits *and* arrowed down means the row.
3. `/^s?\s*(\d{6})$/i` matching a row's `postal` → choose; else `No address at 310155.`
4. `/^\d{5}$/` matching a row's `code` → choose; else `No stop with code 43179.`
5. Under 2 chars → `COMMIT_HINT`.
6. `rows.length > 0` → `wait` — committing the top row would guess between places the user can see and has not chosen.
7. → `No address matched.`, the same constant `finderState` already put under the box.

**Commit by index, not by code.** Addresses have no client-known unique key. The invariant that makes it safe: `searchRows` and the `#results` markup are written in the **same synchronous block**, so an index read off the DOM always addresses the array that produced it. Rows carry `data-index`, not `data-code`. Normalisation (the `S` prefix strip) happens **before the request**, not only at commit, or the server never sees the digits — `finderState` returns the normalised `query` for `app.js` to send.

New glue in `app.js`:

- `fetchPlaces(query)` — **the only place that knows the endpoint.** Owns the URL, the response key and the row mapping. If the endpoint ever changes, one function changes.
- `applyFinder()` — ~12 one-line assignments from `finderState(...)`: assign `searchRows`, clamp `activeIndex` to `-1` when `activeIndex >= rows.length`, `renderRows`, `el.results.hidden`, `aria-busy`, `#results-head`, `note`, `aria-expanded`, `showClear`, `setActive`.
- `renderRows(rows)` — the **one** `innerHTML` site; `escape()` on both display fields; `id="opt-N"`, `data-index="N"`.
- `setActive(i)` — `aria-activedescendant`, `aria-selected`, `scrollIntoView({block:'nearest'})`.
- `rememberPlace(place)` — `recents = rememberRecent(recents, place); write(RECENT_KEY, recents)`, called from `switchOrigin` **on the success path only**; a place whose board would not load is not worth offering again.
- `RECENT_KEY = 'bus-board.recent.v1'`, read via `readRaw` → `readRecents`.

`runSearch` is rewritten around `finderState` and a `searchStatus` of `'idle' | 'searching' | 'ok' | 'offline'`; `searchUnavailable` is deleted. `searchSeq` and the `setTimeout` stay glue — they are mutable request ordering and cannot be pure. `openSearch()` gains `applyFinder()` before `focus()`, which is what puts Recent on screen in the empty panel; it stays **synchronous**, so `startWithCode`'s click path is untouched.

Rows become `<li id="opt-N" role="option" data-index="N" aria-selected="false">` with **no inner `<button>`** — an `option` must not contain interactive content, and DOM focus has to stay in the input or the phone keyboard closes mid-typing. Activation stays delegated click, plus Enter. `ArrowDown`/`ArrowUp` call `moveActive` and `preventDefault()`. `Escape` keeps today's behaviour (closes the whole panel) rather than APG's two-stage dismiss — the panel is the listbox's only container, and a device with no Escape key gains nothing from two stages. Delete `.result-btn`/`.result-code`/`.result-name`/`.result-road`; add `.result-row`, `.result-row[aria-selected='true']`, `.result-primary`, `.result-secondary`. `cursor: pointer` on `.result-row` is not decoration — without it iOS Safari does not apply `:active` to a non-button and the tap loses its feedback.

**The Recent key.** `bus-board.recent.v1`, `Place[]`, most-recent-first, cap 5, no timestamps. AGENTS.md documents three keys and forbids new user-facing configuration; this is not configuration — its own test is "if a setting would need explaining, pick a sensible default", and there is nothing here to explain or set. `loc.v1` is the precedent: a cache of what the user already did, kept to remove a round trip. It is also the specific mitigation for what this swap costs — a 5-digit stop code is printed on the pole in front of you, a 6-digit postal code is not, and forgetting it is otherwise a dead end. Worth stating rather than inheriting silently: it stores up to five labelled addresses, plausibly home and work, in cleartext on the device. Never transmitted, the server never sees it, cleared with the other keys.

### Tests

Rewrite the `commitDecision` block (all 9 cases — the input shape changed): commits 6 digits matching a row's postal, by index · normalises `S310155` and `s 310155` · names the postal it could not find · **commits a 5-digit stop code against a row's `code`** · a highlighted row outranks a 6-digit query · a highlighted row commits on a text query · `activeIndex` beyond the row count does not commit · `status:'offline'` returns `wait` and never a note (the net for the flag that used to live in `app.js`) · one character returns the hint mentioning "6-digit" · a text query with rows → `wait` · with no rows → `No address matched.`, byte-identical to `finderState`'s note.

In `src/stops.test.ts`, delete the three `search()` cases (keep `nearby` and `distanceFrom`) and **rewrite the header comment** — it currently opens "Six invariants of `StopIndex`" and explains that the fixture exists because two of those six cases are about a `0,0` record that `MOCK_STOPS` lacks. After this change only one case needs it.

### Verify

```bash
npm run build && npm test
curl -s 'localhost:8080/api/places?q=310155' | head -c 300     # one address row
curl -s 'localhost:8080/api/places?q=43179'  | head -c 300     # one stop row, code set, postal null
curl -s 'localhost:8080/api/places?q=toa+payoh' | head -c 600  # ≤10 address rows
curl -si 'localhost:8080/api/places?q=t' | head -3             # 400
curl -si 'localhost:8080/api/places?q=310155' | grep -i cache  # private, max-age=300
curl -s localhost:8080/api/stops?q=toa | head -3               # 404
curl -s localhost:8080/healthz                                 # places count + placesGeneratedAt, ok:true
grep -rn "api/stops\|searchUnavailable\|data-code" src/ public/ # expect no hits
```

Browser matrix:

- **The six states**, driven by DevTools throttling and offline mode: empty box shows Recent · one character shows the hint and fires **no request** · two characters search · a hit list · `No address matched.` · offline shows the note *and* Recent.
- Arrow keys move the highlight and wrap at both ends; Enter commits the highlighted row; Enter on a bare 6-digit code commits without a tap; Enter on a bare 5-digit code commits the stop.
- Recents: commit three addresses, reopen the panel → three rows, most-recent first; commit one again → it moves to the front rather than duplicating; a failed switch does **not** add one.
- **Type 20 real Singapore addresses** — a block number, a mall, a road with a saint's name, a bare postal code, a 5-digit stop code, a new-estate postal code. The ladder, the `+15` block bonus and the 2,000-candidate cap are judgement calls tuned against no user data; the tests pin the behaviour, not its rightness.
- Pins untouched: ★ toggles, pinned stops stay first, `?pinned=` still on the board request.
- A real VoiceOver pass — iOS support for `aria-activedescendant` is historically weak, and no test here can catch it.
- **D8:** the location button still prompts on a real iPhone.

**Done when:** every curl returns as above, the grep is empty, `npm test` is green, and the browser matrix passes.

---

## Task 7 — Ship the data in the image

**Depends on:** Task 1 (needs the artefact). Independent of everything else.

### Deliverables

- `Dockerfile` — one `COPY` line

### Spec

```dockerfile
COPY --from=deps /app/node_modules ./node_modules
# Address index; regenerate with tools/build-places.mjs. Copied before dist so
# this rarely-changing 1.6 MB layer stays cached across ordinary commits.
COPY data ./data
COPY --from=build /app/dist ./dist
```

**The comment must be on its own line.** Dockerfile has no inline comment syntax — `#`
only starts a comment at the beginning of a line. Written as `COPY data ./data  # …`
the instruction parses as a `COPY` with five sources into a non-directory destination
and the build fails. (Corrected here after Task 7 hit it; recorded in the divergence
section.)

Placed **between** the `node_modules` and `dist` copies so the rarely-changing 1.6 MB layer stays cached across ordinary commits. `.dockerignore` needs no change — `data` is not in it. `import.meta.dirname` from `dist/index.js` resolves `../data/` to `/app/data/` in the image and `<repo>/data/` locally, the same relative trick `express.static` already uses for `public`.

Also consider `NODE_OPTIONS=--max-old-space-size=384` in `k8s/bus-arrival.yaml`. Node does not size its old space from the cgroup limit, so on a large host V8 may plan for far more than 512Mi and be OOM-killed rather than collecting. It has not bitten because usage was tiny; it is now ~35 MB of long-lived heap plus a ~40 MB transient. It is a runtime flag, not application config, so it does not violate the "read `process.env` only in `config.ts`" rule.

### Verify

```bash
docker build -t bus-arrival:test .
docker run --rm -p 8080:8080 bus-arrival:test &
sleep 5
curl -s localhost:8080/healthz                              # ok:true, places ~121360
curl -s 'localhost:8080/api/places?q=310155' | head -c 200
docker run --rm bus-arrival:test ls -l /app/data            # the artefact is present
docker image inspect bus-arrival:test --format '{{.Size}}'  # ~1.6 MB larger than before
```

**Done when:** the container reports `ok: true` with a non-zero `places` count, `/api/places` answers, and the image grew by roughly the artefact's size and no more.

---

## Task 8 — Documentation

**Depends on:** Tasks 0 and 6. **Read first:** `docs/datamall-activation.md:64-66` — a contradicted line is edited in the same commit; this task exists because tasks 6 and 7 contradict many.

### Deliverables

- `README.md`, `AGENTS.md`
- `docs/postal-code-finder.md` — append the implementation-notes section (per Task 0)

### Spec

`README.md`: the opening ("a stop code you already know"); the mock-mode sentence, which is now **backwards** — the finder holds the full address list while the board behind it stays synthetic; "The journey" items 5 and 6, both of which describe stop codes; the endpoints table (`/api/stops` → `/api/places`, `private, max-age=300`, the 10-row cap); "Design notes → No database", which currently says the whole dataset is a few thousand rows scanned linearly and must now also describe a 121k-row file with an inverted index at ~35 MB resident; the localStorage list (now four keys); **new: attribution and licence** for the OneMap-derived data plus the staleness warning; and "Before sharing the link", which needs the address data's provenance beside the existing DataMall caveat. The configuration table is unchanged — say so, because this feature deliberately adds no environment variable.

`AGENTS.md`: the two-door paragraph; the architecture diagram (`GET /api/stops?q=` → `GET /api/places?q=`, plus a `PlaceIndex (places.ts, from data/)` box) and bullets; the `src/stops.ts` bullet, whose "linear-scan search and nearest-neighbour" is now half true; commands (`node tools/build-places.mjs`, and that it is run by hand roughly never); the test-scope paragraph, adding `places.ts` with the same justification the others carry — a scoring ladder fails by ranking the wrong row first, which `curl` does not catch; "Verifying a change" (the new curls and the startup log line); the localStorage key list, now four, stating that `loc.v1` remains the sole owner of the fix and that the place record carries its own coordinate on purpose.

**The `0,0` gotcha must be rewritten, not amended.** It currently reads "`nearby()` filters them out; `search()` keeps them findable. Preserve that split." After task 6 `StopIndex` has no `search()` and the split does not exist; `PlaceIndex` rejects unusable coordinates at load instead, so no finder row can ever be uncommittable, and `isUsableCoord`'s reason for existing changes with it.

New gotchas: the artefact is a ~2020 scrape and stale for new estates; the load is synchronous and `/healthz` 503s until it is in; `data/sg-places.json.gz` must stay out of `public/` (`express.static` would otherwise serve 1.6 MB to anyone who guesses the path).

Both files should also name the two new paths in their layout sections: `data/` (what it holds, that it is generated by `tools/build-places.mjs`, and that it is committed on purpose) and `docs/postal-code-finder.md` (the design record), the same way `docs/first-run-journey.md` is referenced today.

Finally, append the divergence section to `docs/postal-code-finder.md` per Task 0 — every place tasks 1–7 departed from the design, dated, with the reason.

### Verify

```bash
grep -rn "api/stops\|stop code\|15 nearest\|three localStorage" README.md AGENTS.md
grep -rn "0,0" AGENTS.md                        # the gotcha must read as rewritten, not amended
grep -rn "data/\|postal-code-finder" README.md AGENTS.md   # both new paths are documented
```

**Done when:** no grep hit describes behaviour that no longer exists; both new paths are named in README and AGENTS.md; `docs/postal-code-finder.md` carries its divergence section; a reader who knows nothing about this change can follow README to run the app and AGENTS.md to modify it; and the attribution required by the Singapore Open Data Licence is present in both README and the page footer.

---

# Risks

1. **The dump is a ~2020 scrape.** Tengah, Bidadari and most 2021+ BTO blocks are missing or wrong, and re-running the tool changes nothing until upstream updates — which it may never do. This is why the 5-digit stop-code path stays: without it, a first-time visitor in a new estate who declines location has no way into the app at all. `placesGeneratedAt` on `/healthz` makes the vintage a number someone can read.
2. **Ranking quality is the part most likely to be wrong**, and no test can tell you it is right. The 20-address check in Task 6 is the real verification.
3. **Repo size:** ~1.5 MB added to every clone, and again in full on each regeneration (git cannot delta two independently-gzipped blobs) against a 2.8 MB `.git` today. Mitigation is discipline: regenerate rarely, and never commit a regeneration the tool's summary does not justify.
4. **Candidate truncation can hide a result** for a query whose only indexed token is very common (`road`, `jalan`, `avenue`). Leading-token-first posting lists keep the rows the ladder would rank top, but it is still truncation. If a common-word query behaves oddly, the number to look at is `MAX_CANDIDATES`, not the ladder.
5. **Deleting the delisted note removes the only signal a user with 8 pins ever gets** that the board has no nearby slots. It was only ever *suppressed* before, never explained, so this is not a regression — and `distanceLabel` now shows distances that visibly change even when the card set does not. No new copy is being added for it.
6. **Title-casing mangles acronyms** (`NTUC FAIRPRICE` → `Ntuc Fairprice`). The alternatives are an unbounded exception list or shipping ALL CAPS, which is honest and matches how OneMap itself displays these but reads as shouting on a card. Decide with eyes on a real phone in Task 5; it is a one-line change either way.
7. **Node does not size its old space from the cgroup limit** — see Task 7.
8. **Licence:** the data is OneMap-derived under the Singapore Open Data Licence, which requires attribution. The footer already carries `Data © LTA, via DataMall`; it needs a OneMap line beside it.

---

## Implementation notes — where the shipped code diverges from the plan above

Recorded 11 Aug 2026, after tasks 1–7. The plan text above is left as it was
approved, per Task 0; this section is the delta. A future reader trusting the
body over the code would reintroduce several of these — items 2, 3 and 7 in
particular, each of which was a bug before it was a decision.

1. **The Dockerfile comment.** The `COPY data ./data` line in Task 7 was first
   written with the comment on the same line. Dockerfile has no inline comment
   syntax — `#` only opens a comment at the start of a line — so the instruction
   parsed as a `COPY` with five sources into a non-directory destination and the
   build failed. Corrected in the body above, on its own line, and recorded here
   because the corrected text now looks like it was always right.

2. **Single-character query tokens survive verification.** D3 says tokens are
   "`/[^A-Z0-9]+/` of length ≥ 2". That rule belongs to the *index*, where a
   one-character token would match a third of the file and discriminate nothing.
   Applied to the *query* as written, it silently dropped the `3` from
   `ang mo kio ave 3`, which then matched avenues 1 through 10 equally.
   `queryTokens` in [places.ts](../src/places.ts) therefore keeps every token and
   `matchesAll` verifies all of them against the stored strings; only candidate
   *generation* still requires `MIN_TOKEN`.

3. **The candidate generator prefers an exact posting list to a truncated prefix
   union.** D3 says to prefix-match the last token "when it has no exact list",
   which is what the code does — but it then also refuses the prefix union when
   it has hit `MAX_CANDIDATES`, unless nothing else can generate candidates at
   all. A union that hit the ceiling is an arbitrary slice of Singapore; for
   `ang mo kio ave` the right generator is `KIO`, not every road whose name
   begins `AVE`. Without this the query returned rows that shared only the
   half-typed word.

4. **`STOP_WORDS = {BLK, BLOCK}`, filtered out of the query.** A deliberate
   departure from D3, argued at length in a comment in `places.ts`. Singaporeans
   write "Blk 155", LTA's stop descriptions say "Blk 869A", and this app's own
   chip and Recent list render `Blk {block}` — but no stored field spells it, the
   block is `"155"`. Under a strict AND every query carrying the word could only
   ever match nothing, i.e. a dead end reached by typing back what the app just
   showed. Dropped from the query rather than relaxing the conjunction (which
   would let any one wrong word through) or changing the index (124 building
   names carry `(BLK 6 …)` as a parenthetical and stay reachable by their other
   words). The list is confined to words the data structurally cannot contain.

5. **Rows display `place.name`, not `label`.** D5 reserves `name` for "tagline
   and aria-label only". A result row has a whole line to itself and the postal
   code beneath it, so showing the 18-character chip label there would throw away
   the block and road the user is choosing between — `Blk 155` alone does not
   distinguish Toa Payoh from Ang Mo Kio. D5's rule is restated as: `label`
   wherever something shares a line or a glance, `name` wherever there is room.
   The row has room.

6. **`ADDRESS_DOOR_LABEL` is exported from `origin.js`.** D7 lists one shared
   constant across four sites; three of them are in `app.js`, so the constant had
   to cross the module boundary. The fourth is in `index.html`, which nothing can
   import from, and is kept in step by hand — said so in the comment beside it.

7. **`storedOriginMode()` in `app.js`, which the plan has no room for.** D5 says
   migrate the legacy `{mode:'stop'}` record in place, and Task 4 pins
   `decideBoot` returning `persist: false` for it — correctly, because a
   returning user is not being grandfathered. But then nothing ever rewrites the
   record, and it is re-migrated on every visit for the rest of that user's life.
   The plan cannot have both as written. `boot()` compares the mode as *stored*
   against the mode `readOriginRecord` handed back and writes once when they
   differ. The read stays in `app.js`: "what is literally in the key" is a
   storage fact, not a rule, so it does not belong in the pure module.

8. **`commitSearch` awaits an in-flight request, not only a pending debounce.**
   The first-run journey's own divergence note (item 7 there) established the
   debounce flush. It is not sufficient: when the timer has already fired and the
   answer is still in the air, `commitDecision` decides against the *previous*
   query's rows and answers "No address at 310155." for an address the server is
   at that moment returning. `app.js` holds the promise in `inFlight` and Enter
   waits on whichever of the two is outstanding.

9. **The search icon was dropped.** Task 5 specced it and said it would be the
   first thing to cut if the field felt cramped; it was measured rather than
   felt. At 320 px the icon left the field 202.8 px of text for a placeholder
   needing 215.6 px, so `e.g. 310155 or Toa Payoh Hub` clipped to
   `…Toa Payoh H` — a truncated example is worse than no icon, on a control whose
   panel already says "or search for an address" and whose keyboard already shows
   a search key. Without it the placeholder fits down to 320 px with 13.6 px to
   spare. The × stays: it is functional. The reasoning is in a comment in
   `index.html` so it is not re-added on taste.

10. **Task 6's `grep -rn "…\|data-code" src/ public/` can never be empty.**
    Board cards carry `data-code` for the pin path, which this change never
    touched. The check that matters is that no *finder* row carries one — rows
    are `data-index` — and that is what was verified instead.

11. **The plan says both new paths should be documented "the same way
    `docs/first-run-journey.md` is referenced today".** It is not referenced
    today: neither README nor AGENTS.md mentioned it before this task. Both now
    name both design records, and say to read a record's divergence section
    before trusting its body.

12. **Attribution is in README, not yet in the page footer.** Task 8's
    done-condition asks for both. The footer still reads `Data © LTA, via
    DataMall` alone; adding the OneMap line is a `public/index.html` change that
    this documentation task did not make. It is listed as a release precondition
    under "Before sharing the link" in README and repeated in the open issues
    below, because the Singapore Open Data Licence requires it and the link
    should not be shared without it.

### Open issues

Written down rather than fixed. Items 1–5 are follow-ups, each reachable from
Task 6 and deliberately left out of it. Items 6 and 7 are **release
preconditions** — they do not block review, but the change must not ship with
either outstanding.

1. **Road-name abbreviations — CLOSED.** Roads are stored in full
   (`ANG MO KIO AVENUE 3`) and only the last query token may prefix-match, so
   `woodlands ave 5` returned **zero** rows and `ang mo kio ave 3` returned one
   wrong row (`OCBC ANG MO KIO AVE 1 - 7 ELEVEN`, whose block `339` is what the
   trailing `3` prefix-matched). This was never academic — **LTA's own stop
   descriptions write "Ave"**, so a card reading `Woodlands Ave 5` named something
   the finder could not find.

   Fixed with `EXPANSIONS` in `src/places.ts`: a query-side synonym table,
   OR-matched per token and never a rewrite, so `st george` still finds
   `ST. GEORGE'S ROAD`. Three touch points, all of them necessary — `matchesAll`
   accepts any form of a token; `#postingsFor` unions a token's forms during
   candidate generation, without which the short literal `AVE` posting list was
   chosen as the most selective token and excluded every `AVENUE` row (fixing
   `matchesAll` alone still returned nothing); and `scoreOf` ladders both spellings
   and takes the higher, without which an expanded match sits on the 20 floor.

   Verified against the running server:
   `curl 'localhost:8080/api/places?q=woodlands%20ave%205'` now answers with
   `WOODLANDS AVENUE 5` first.

2. **Bank branches outrank the landmark they sit in — STILL OPEN.** `toa payoh hub`
   puts `CITIBANK TOA PAYOH HUB` first: it scores 60 for *containing* the query,
   while `HDB HUB` — the building everyone means — reaches only the 20 floor
   because it matches no single field. The coordinates of both are the same
   building, so the board is right and only the label is odd.

   One fix was built and measured against the real 121k index: the `IN_ORDER` rung
   plus the `UNNAMED_LEAD` penalty now in `scoreOf`. **Those two rules were kept,
   but they do not fix this issue** — they were kept because they fix a different
   and more common thing, which is item 1's ranking (see below). This query is
   unchanged by them, because the real record is `HDB HUB` with `TOA PAYOH` only in
   its *road*, so no building-based rule can see the words the query is made of.
   `jurong point` has the same shape: `DBS JURONG POINT BRANCH` leads because no
   record is named `JURONG POINT`. A fix has to reason across building and road
   together. `src/places.test.ts` pins the current behaviour so the next attempt
   knows what it is changing.

   What those two rules *did* fix, measured before and after: without them
   `woodlands ave 5` answers with `HDB-WOODLANDS` and `ang mo kio ave 3` with
   `KEBUN BARU HEIGHTS`, because a building sitting on the road scores exactly what
   the road scores and then wins the postal-code tiebreak. A name led by a word the
   user did not type now ranks below the road they did type.

3. **`titleCase` mangles acronyms — CLOSED.** `HDB HUB` → `Hdb Hub`,
   `NTUC FAIRPRICE` → `Ntuc Fairprice`. Risk 6 above called for a decision with
   eyes on a real phone; the decision is the bounded `ACRONYMS` allowlist in
   `public/origin.js`, applied per word.

   The tempting heuristic — "short and no vowels" — was built and rejected on the
   data: `ST`, `BLK`, `JLN`, `RD`, `DR`, `PL`, `CL`, `TG` and `KG` all qualify for
   it and all are read as words, so it renders `ST. GEORGE'S ROAD` as
   `ST. George's Road`. The list is bounded, which was its stated cost; the
   heuristic is unbounded in the damage it does. Both cases are now assertions.

4. **`#results` keeps `aria-label="Search results"` while it is showing Recent —
   CLOSED.** Recent left the listbox entirely: it is a row in `#origins` now
   (D6a), so `#results` holds search results in every state and the label is true
   without being changed. `finderState` no longer takes `recents` at all, and a
   regression test asserts that passing it makes no difference.

5. **Two verifications still not run, for want of hardware — STILL OPEN.** The
   VoiceOver pass over `aria-activedescendant` (iOS support for it is historically
   weak, and no test here can catch it) and the real-iPhone check that the location
   door still prompts — D8's transient-activation invariant.

   The destinations-card work re-exercised both and could not close either. What it
   did add is evidence one step short of hardware: real Chrome, driven over CDP at
   375 px, with `getCurrentPosition` stubbed to count its calls. The intro's
   location door, the `gps` row and `.origin-update` each reach it exactly once per
   tap, with nothing awaited above the call. That proves the code path, not the
   iPhone behaviour — the failure mode is Safari-only and silent, so it stays open.

   VoiceOver is unchanged in the listbox and *new* in the destinations list, where
   `aria-current` now carries the state a ✓ and `aria-pressed` used to. Worth
   listening to specifically.

6. **`data/sg-places.json.gz` — CLOSED.** It is tracked, so `COPY data ./data` and
   the `/healthz` place-count gate both hold in CI.

7. **The OneMap footer line**, per item 12 above.
