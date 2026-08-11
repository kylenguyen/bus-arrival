# First-run journey split: choose location or a stop code

> **Design record, not current documentation.** The plan below is kept as it was
> approved. Two sections at the end are the deltas, and the second one supersedes
> everything this document says about the internals of `#finder`: the
> `#use-location` button, `.finder-loc`, `.finder-or` and the `aria-pressed` ✓ no
> longer exist. Read *Superseded — `#use-location` and the two-door panel* before
> trusting any `#finder` markup, CSS or `openSearch`/`closeSearch` detail here. The
> two doors, `decideBoot`, the intro dialog and the transient-activation rule are
> all still current.

## Context

Today the page calls `void locate()` at module evaluation ([public/app.js:556](public/app.js#L556)). A first-time visitor gets the browser's native geolocation prompt with no explanation of what the site is or why it wants their position. If they refuse, they land on a gate plus an auto-opened search box whose only behaviour is to silently *pin* whatever they tap — there is no way to say "just show me stop 43179".

This change splits the home page into two journeys:

- **First visit** — a modal introduction explaining the site in two sentences, then two doors: use my current location, or enter a stop code. Nothing loads and no request fires until they choose.
- **Returning visit** — the board loads straight away from whichever door they last used, with zero taps.

Either door can be changed afterwards from a chip in the masthead.

**The design's load-bearing idea:** both doors reduce to a coordinate. `/api/board?lat&lon` does not care where the coordinate came from, and `/api/stops?q=` already returns each stop's `lat`/`lon`, so selecting a stop yields its coordinate with no extra round trip. Stop-code mode is therefore "rank stops around a fixed place" rather than a second rendering path.

**No server change is required.** Verified against [src/index.ts:66-124](src/index.ts#L66-L124), [src/stops.ts:74-116](src/stops.ts#L74-L116) and [src/types.ts](src/types.ts): `/api/stops` returns full `BusStop` records including coordinates, `/api/board` has no 400 path, `limit=8` is already the clamp ceiling, and `nearby()` returns `distanceM: 0` for the origin stop and sorts it first.

Approved decisions (do not relitigate): native `<dialog>` for the intro; grandfather existing users straight to GPS mode; stop mode shows the chosen stop plus its 7 nearest neighbours; a search-result tap sets the origin, replacing today's pin-on-tap. Stop entry stays code-or-name.

## State model

One new localStorage key beside the existing `PINS_KEY` / `LOC_KEY` ([public/app.js:10-11](public/app.js#L10-L11)):

```
bus-board.origin.v1
  { mode: 'gps',  at }
  { mode: 'stop', code: '43179', description, roadName, lat, lon, at }
```

- `LOC_KEY` stays the **sole** owner of the last GPS fix and its age, so `LOC_MAX_AGE_MS` (12 h), the 5-minute focus re-locate ([app.js:549](public/app.js#L549)) and the 200 m re-rank keep working untouched. The gps origin record carries no coordinate on purpose — it is one bit.
- `PINS_KEY` unchanged. Pins are orthogonal to mode.
- Read guard mirrors `readLoc()` ([app.js:56-64](public/app.js#L56-L64)): object; `mode ∈ {gps, stop}`; for `stop`, `code` matches `/^\d{5}$/` **and** `lat`/`lon` are finite **and** not `0,0`. Anything else is treated as absent.
- Staleness: gps keeps today's rules; **stop mode never expires and never touches geolocation**; the mode choice itself never expires.
- **Governing rule: write the origin only when a coordinate is actually in hand** — a successful fix, or a stop selected from search. Denials, dismissals, timeouts and typos persist nothing. So "returning" ≡ "we hold a usable origin", and every half-finished first run correctly degrades to a first visit with no extra flags.

The `0,0` guard is not optional: a handful of real stops carry `0,0` coordinates, `search()` deliberately keeps them findable while `nearby()` filters them out ([src/stops.ts:110-112](src/stops.ts#L110-L112), AGENTS.md:193-195). Without the guard, tapping one persists an origin in the Gulf of Guinea, ranks the whole of Singapore ~1,300 km away, and falsely trips the delisted-stop note.

## Testing architecture (read before writing any code)

The test story drives the file layout, so it comes first.

**The constraint.** `npm test` is `npm run build && node --test 'dist/**/*.test.js'`. `tsconfig.json` sets `rootDir: "src"` and `include: ["src/**/*.ts"]`, so `public/app.js` is never compiled and never lands in `dist/`. Worse, it cannot be imported by a test even if it did: it performs `document.getElementById` at module scope ([app.js:20-32](public/app.js#L20-L32)), installs two `setInterval`s and calls `locate()` on the last line. **Any unit coverage of this feature requires extracting the logic into a side-effect-free module.** That is the price of the tests, and it is worth paying — but it is not free, so it is item 2 and not a footnote.

**The decomposition.** Every new behaviour becomes a pure function that takes its inputs (including `now`) and returns either a value or *the state to apply*. `public/app.js` keeps only DOM reads/writes, `fetch`, `localStorage`, and event wiring — each apply site a one- or two-line mechanical assignment.

```
public/origin.js   new. pure, no DOM, no fetch, no localStorage, no Date.now().
                   ~16 exported functions. imported by app.js as a module.
public/app.js      shrinks. glue: elements, fetch, storage, listeners, applies.
src/origin.test.ts new. node:test over public/origin.js. ~60 cases.
src/stops.test.ts  new. pins the three server assumptions the design rests on.
```

`app.js` is already `type="module"` ([index.html:61](public/index.html#L61)), so `import { … } from './origin.js'` needs no bundler and no build step — consistent with AGENTS.md:27-28. Add `<link rel="modulepreload" href="/origin.js">` to `<head>` so the second module is fetched in parallel with `app.js` instead of after it; without that the extraction costs one serialized round trip on a cold cellular load, which is the one place this change touches the first-paint budget.

**Importing a `public/` file from a `src/` test.** Use a computed specifier so tsc never tries to resolve it:

```ts
const origin = await import(new URL('../public/origin.js', import.meta.url).href);
```

From `dist/origin.test.js` that URL resolves to `<repo>/public/origin.js`. The computed form is load-bearing — a literal `'../public/origin.js'` trips TS2307 (no declarations) and TS6059 (outside `rootDir`), whereas a computed one types as `any` and compiles clean under `strict`. Top-level `await import()` in a test file is already the house pattern ([src/lta.stops.test.ts:11](src/lta.stops.test.ts#L11)). Trade-off accepted: this puts a `public/` file on the test path, a precedent the repo has so far avoided, and the module is typed `any` inside the test so a signature change fails at runtime rather than at compile time.

**Time is injected, never read.** `public/origin.js` must not call `Date.now()`; every time-dependent function takes `now` as a parameter, and `app.js` supplies it. This follows AGENTS.md:48 ("no test may sleep") and the hand-rolled clock at [src/cache.test.ts:11-19](src/cache.test.ts#L11-L19) — no fake timers needed anywhere.

**Critical review of what this does and does not buy.**

| Layer | Covered by | Confidence |
|---|---|---|
| Origin guard, boot routing, grandfathering, coordinate mapping, board params, all copy selection, delisted rule, focus-relocate rule, Enter-commit decision, intro variant, distance labels | `src/origin.test.ts` — real unit tests, no stubs | High. These are where the design's rules live and where a future edit will break them silently |
| Rendered strings (the distance cell, escaping) | `src/origin.test.ts` asserting on returned strings | High. `distanceLabel` is a string function; XSS regressions on that cell are catchable without a DOM |
| Element ids, attribute names, which element each decision is applied to | manual matrix only | Low, and deliberately so — see below |
| `<dialog>` modality, focus trap, Escape, backdrop | manual matrix + real devices | Cannot be unit tested |
| iOS geolocation user-gesture chain | real iPhone only | Cannot be unit tested |
| 360 px layout, dark mode | manual matrix | Cannot be unit tested |

**Why no jsdom and no hand-rolled DOM stub.** A stub proves the code calls the API you stubbed. The three highest-risk failures in this change are `<dialog>` modality on iOS 15.x, the transient-activation rule that makes `getCurrentPosition` work from a click, and the permission-revoked path — and jsdom implements none of them faithfully. Adding it would buy green tests over exactly the areas that stay broken. The residual risk (a typo'd element id, a decision applied to the wrong node) is real but *loud*: it fails on first load, every time, and the manual matrix has a row per component. So the mitigation is structural, not a stub — keep every apply site to a single assignment so there is nothing left in it to get wrong:

```js
// the whole of the chip's "component": decision is tested, application is not worth testing
const chip = chipState(origin);
el.originChip.textContent = chip.label;
el.originChip.setAttribute('aria-label', chip.ariaLabel);
```

**If you want real browser coverage**, the honest option is Playwright driving `npm start` in mock mode, which would cover the dialog, the switcher and every failure branch for real. That is a separate decision with real cost (a heavy devDependency, CI runtime, and a new category of flake), and it should not be smuggled in under this feature. Note that CI does not run `npm test` at all today ([.github/workflows/bus-arrival.yml](.github/workflows/bus-arrival.yml) only builds and pushes the image) — fixing that is item 3 and is a precondition for these tests being worth writing.

## Work items

Each item leaves the app working and ships with its own tests. Pin-on-tap is never removed before its replacement exists.

| # | Item | Files | Tests added |
|---|---|---|---|
| 1 | Fix the stale "15 nearest stops" docs (code says 8) | README.md:4,13 · AGENTS.md:8,92 · optionally the `limit = 15` default at [src/stops.ts:108](src/stops.ts#L108) | — |
| 2 | **Extraction harness.** Create `public/origin.js` with `formatMetres` + `isUsableStopCoord` only, move `formatDistance` onto it, wire the import and `modulepreload`, and stand up `src/origin.test.ts` with the computed-import pattern | public/origin.js · public/app.js · public/index.html · src/origin.test.ts | 8 |
| 3 | **CI runs the tests.** Add `npm ci && npm test` as a gate before the image build | .github/workflows/bus-arrival.yml | — |
| 4 | Origin state + boot split: `readOriginRecord`, `decideBoot`, `originCoord`, `boardParams`; `ORIGIN_KEY`, `readOrigin`, `writeOrigin`, `boot()` replacing the boot line. New users still fall through to today's `locate()` (no dialog yet) | public/origin.js · public/app.js · src/origin.test.ts | 26 |
| 5 | Origin-aware coordinate plumbing — nothing assumes GPS any more, including the focus handler (`shouldRelocateOnFocus`) | public/origin.js · public/app.js · src/origin.test.ts | 6 |
| 6 | Stop origin can be committed: result tap sets the origin, Journey B stop path, `taglineFor`, `gateMessageFor`, `shouldShowDelistedNote`, `delistedNote`. Deletes `pinByCode` | public/origin.js · public/app.js · public/index.html · src/origin.test.ts | 11 |
| 7 | Mode-aware distance labels: `distanceLabel` | public/origin.js · public/app.js · src/origin.test.ts | 8 |
| 8 | Two-button gate: `gateState` + the three failure sentences via `refusalCopy` | public/origin.js · public/index.html · public/styles.css · public/app.js · src/origin.test.ts | 9 |
| 9 | The intro dialog + Journey A: `introVariant` | public/origin.js · public/index.html · public/styles.css · public/app.js · src/origin.test.ts | 4 |
| 10 | Origin chip + finder location row + Escape/focus: `chipState` | public/origin.js · public/index.html · public/styles.css · public/app.js · src/origin.test.ts | 5 |
| 11 | Enter-to-commit, validation copy, `enterkeyhint`: `commitDecision` | public/origin.js · public/index.html · public/app.js · src/origin.test.ts | 8 |
| 12 | Pin the server assumptions the client design depends on | src/stops.test.ts | 6 |
| 13 | Documentation for the new behaviour | README.md · AGENTS.md | — |

Docs rule (docs/datamall-activation.md:64-66) says a contradicted line is edited in the same commit — so fold item 13's paragraphs into items 6, 9 and 10 if committing per item. Item 1 stands alone; those lines are stale independently of this work.

## public/origin.js — the new pure module

Every function is exported (tests import all of them), takes plain data, and returns plain data. No `Date.now()`, no DOM, no `fetch`, no `localStorage`.

| Signature | Returns | Purpose |
|---|---|---|
| `isUsableStopCoord(lat, lon)` | boolean | finite **and** not `0,0`. The `0,0` trap guard, used by both the read guard and the commit path |
| `formatMetres(metres)` | string | metres under 1 km, one-decimal km above. Extracted from today's `formatDistance` |
| `formatDistance(metres)` | string | `formatMetres(m) + ' · N min walk'`. Behaviour unchanged from [app.js:95-100](public/app.js#L95-L100) |
| `readOriginRecord(raw)` | `Origin \| null` | Takes the **raw localStorage string** (or null) and parses it inside a try, mirroring `readLoc()`. Enforces the whole guard |
| `decideBoot({ originRaw, locRaw, pinCount, now })` | `{ journey: 'intro'\|'gps'\|'stop', origin, persist }` | The entire first-visit-vs-returning decision, including grandfathering. `persist: true` means the grandfather branch fired |
| `originCoord(origin, lastLoc)` | `{lat, lon} \| null` | The single mapping from origin state to a board coordinate |
| `boardParams({ origin, lastLoc, pins, limit })` | string | The `/api/board` query string. One place decides which coordinate is sent |
| `shouldRelocateOnFocus(origin, lastLoc, now)` | boolean | gps **and** the fix is older than 5 min. False for stop mode and for no origin |
| `taglineFor(origin)` | string | `Stops nearest you, live from LTA` / `Stops near 43179, live from LTA` |
| `gateMessageFor(origin)` | string | `Finding stops near you…` / `Finding stops near 43179…` |
| `chipState(origin)` | `{ label, ariaLabel }` | `Near you ▾` / `Stop 43179 ▾` (U+25BE), plus the long `aria-label` carrying the description |
| `distanceLabel(stop, origin)` | string | gps → `formatDistance`; stop mode origin card → `(This stop)`; stop mode otherwise → `formatMetres` (metres only); no distance → `''` |
| `shouldShowDelistedNote(origin, stops)` | boolean | See the rule below |
| `delistedNote(origin)` | string | `Stop 43179 is no longer in service. Showing stops near it.` |
| `refusalCopy(err)` | `{ message }` | Three-way split on `err.code` (1/2/3) |
| `gateState(message, primary, secondary)` | `{ message, primary: {label, hidden}, secondary: {…} }` | The two-button gate's show/hide logic, so `app.js` only assigns |
| `introVariant({ isSecureContext, hasGeolocation })` | `'full' \| 'insecure' \| 'unsupported'` | Which intro the dialog renders |
| `commitDecision(value, results)` | `{action:'choose', code} \| {action:'note', message} \| {action:'wait'}` | What pressing Enter in the finder does |

**Delisted-stop rule.** "Origin code absent from `data.stops`" is *not* sufficient. Pinned stops are pushed first and the board is truncated to 8 **before** the fan-out ([src/index.ts:103-111](src/index.ts#L103-L111)), so a user with 8 pins gets zero nearby slots and the origin stop is missing for an unrelated reason. The origin stop always sorts first in `nearby()` (distance 0), so the rule is: show the note only when the origin code is absent **and** the board holds at least one non-pinned stop.

**Why `distanceLabel` rather than a second parameter on `formatDistance`:** `(This stop)` is not a distance format, `renderShells` keeps exactly one call site, and `formatMetres`/`formatDistance` stay pure single-argument functions.

## src/origin.test.ts — the cases

`node:test` + `node:assert/strict`, `describe`/`it`, no clock helper needed (time is a parameter). Grouped by function; the item column ties each block to the commit that introduces it.

**`isUsableStopCoord` (4, item 2)** — accepts a normal SG coordinate · rejects `0,0` · accepts `lat: 0` with a non-zero lon (a real place, and the guard must not over-reject) · rejects `NaN`/`undefined`/strings.

**`formatMetres` / `formatDistance` (4, item 2)** — `420` → `420 m` · `1500` → `1.5 km` · `0` → `0 m` · non-number → `''`. Plus one that pins today's behaviour: `formatDistance(420)` ends in `· 5 min walk` (`Math.round(420 / 80)` is 5 — this line said 6 until item 2 measured it), and `formatDistance(0)` still says `1 min walk` (the floor at [app.js:97](public/app.js#L97)) — proving the extraction changed nothing before item 7 changes where it is called.

**`readOriginRecord` (12, item 4)** — accepts a valid gps record · accepts a valid stop record and returns it intact · returns null for `null` input · for `''` · for `'{'` (malformed, no throw escaping) · for `'null'` · for a JSON array · for `{mode:'walk'}` · for a stop record with no coords · with a 4-digit code · with a 6-digit code · with `lat: 0, lon: 0` (the §trap guard) · with a non-numeric lat. One property case: **every accepted stop record has a code matching `/^\d{5}$/`**, which is what makes `chipState` safe to write with `textContent`.

**`decideBoot` (10, item 4)** — valid gps record → `{journey:'gps', persist:false}` · valid stop record → `{journey:'stop'}` with the record returned · nothing at all → `{journey:'intro'}` · no origin but a parseable `locRaw` → `{journey:'gps', persist:true}` and the synthesised record carries `now` as `at` (grandfathering) · no origin, no loc, `pinCount: 1` → grandfathered to gps · no origin, no loc, `pinCount: 0` → `intro` (the misfire guard) · corrupt origin **with** a valid loc → grandfathered, not intro · corrupt origin with nothing else → intro · a stop record whose `code` is valid but whose coords are `0,0` → intro, not stop · `locRaw` present but malformed → intro.

**`originCoord` (4, item 4)** — stop mode returns the record's own lat/lon, ignoring `lastLoc` entirely · gps mode returns `lastLoc` · gps mode with `lastLoc: null` returns null · no origin returns null.

**`boardParams` (6, item 4)** — always sets `limit=8` · stop mode sends the record's coordinate · gps mode sends `lastLoc` · no coordinate omits `lat`/`lon` entirely (so the server's `located:false` path is reached, not `lat=NaN`) · pins are joined with commas · no pins omits `pinned`.

**`shouldRelocateOnFocus` (6, item 5)** — gps with a 10-minute-old fix → true · gps with a 1-minute-old fix → false · gps with no fix → true · **stop mode with no fix → false** · **stop mode with an ancient fix → false** · no origin → false. The two stop-mode cases are the regression net for risk 1 below; they are the most valuable tests in the file.

**`taglineFor` / `gateMessageFor` / `delistedNote` (5, item 6)** — gps and stop variants of each, and that the stop variants contain the code. One case asserting `taglineFor` never returns the mock warning string, so the `mockActive` guard stays in `app.js` where it belongs.

**`shouldShowDelistedNote` (6, item 6)** — origin present in the board → false · origin absent and the board has non-pinned stops → true · origin absent and the board is **all pinned** → false (the 8-pin false-positive guard) · empty board → false · gps mode → false regardless · origin absent and the board holds exactly one non-pinned stop → true (boundary).

**`distanceLabel` (8, item 7)** — gps mode → `420 m · 5 min walk` · stop mode, origin card → `(This stop)` · stop mode, other card → `60 m`, and asserts it contains no `walk` · stop mode with `distanceM: 0` on a card that is *not* the origin (possible for a co-located stop) → `0 m`, not `(This stop)` · `distanceM: null` → `''` · missing `distanceM` → `''` · no origin → `''` · a stop code containing `<script>` returns a string with no raw `<` (belt-and-braces on the one cell interpolated into `innerHTML`; `escape()` in `renderShells` is the braces).

**`refusalCopy` (5, item 8)** — `code 1` → the "blocked for this site" sentence · `code 2` → "Couldn't get your location." · `code 3` → "Still can't get a fix on your location." · an `Error` with no `code` → the code-2 wording (the `getPosition` `unsupported` reject path) · `undefined` → the same, no throw.

**`gateState` (4, item 8)** — message only → both buttons hidden · one action → primary shown with its label, secondary hidden · two actions → both shown with the right labels in the right slots · a falsy label is treated as absent, not rendered as an empty button.

**`introVariant` (4, item 9)** — secure + geolocation → `full` · insecure → `insecure` · secure but no geolocation → `unsupported` · insecure **and** no geolocation → `insecure` (one sentence wins, deterministically).

**`chipState` (5, item 10)** — gps label is `Near you ▾` · stop label is `Stop 43179 ▾` and contains the code · the stop `ariaLabel` contains the description while the label does not (the 360 px width decision, pinned as a test) · no origin → a neutral label, no `undefined` in the string · the label never contains a newline or the road name.

**`commitDecision` (8, item 11)** — 5 digits with an exact match in results → `{action:'choose'}` with that code · 5 digits with no match → `{action:'note'}` naming the code · 1 character → `{action:'note'}` with the 5-digit hint · empty → the same note · a name query with results → `{action:'wait'}` (leave the list to tap) · a name query with no results → `{action:'note'}` · 5 digits matching a `0,0` stop → `{action:'note'}`, not `choose` · whitespace around 5 digits is trimmed and still commits.

**Total: ~91 cases.** Every one is a pure input/output assertion — no timers, no network, no DOM, no `process.env`.

## src/stops.test.ts — pinning the server assumptions

Six cases against `StopIndex`, which has zero coverage today and which three client rules silently depend on. Mock mode is not needed: construct the index and seed it, or run in mock mode via `process.env` if `#stops` cannot be seeded directly — check before writing, and if the private field blocks it, drive it through mock mode with a dynamic import as [src/lta.stops.test.ts:8-11](src/lta.stops.test.ts#L8-L11) does.

- `nearby()` from a stop's own coordinate returns that stop **first** with `distanceM === 0` — the assumption `distanceLabel`'s `(This stop)` and the delisted rule both rest on.
- `nearby()` excludes a `0,0` stop.
- `search()` **includes** a `0,0` stop — pins the split AGENTS.md:193-195 requires preserving, and documents *why* the client guard exists.
- `search()` ranks an exact code above a prefix match (the Enter-to-commit path depends on the exact match being findable).
- `search()` returns `[]` below 2 characters (the guard that keeps `/api/stops` from 400ing).
- `distanceFrom()` returns 0 for a stop at the query coordinate.

**Not attempted: route tests for `/api/board`.** [src/index.ts](src/index.ts) calls `app.listen` at module scope, which is exactly why the repo has none and why `node --test dist/` hangs (AGENTS.md:206-208). Testing the 8-pin truncation at the route level would mean refactoring `index.ts` to export the app — a reasonable change, but out of scope here. The client-side consequence is fully covered by `shouldShowDelistedNote` instead, and the truncation itself is unchanged by this work.

## public/app.js

**Deleted:** `pinByCode()` ([app.js:512-520](public/app.js#L512-L520)). Its only caller is the `[data-add]` listener, which becomes `chooseStop`. No `PINS_KEY` migration needed — the junk records it wrote (`description: code, roadName: ''`) are harmless because cards render from server data and only `p.code` is ever sent.

**Moved out to `public/origin.js`:** `formatDistance` (:95-100) and all the new decision logic. What remains in `app.js` is glue.

**Modified:**

| Function | Lines | Change |
|---|---|---|
| header comment | 1-8 | "allow location once" is no longer the journey. Name the two doors, the three keys, and the `origin.js` split |
| imports / constants / `el` / state | 10-43 | `import` from `./origin.js`; `ORIGIN_KEY`; dialog + chip + `#gate-alt` + `#board-note` elements; `origin`, `searchResults`, `introSeen`, `mockActive` |
| `gate` / `hideGate` | 107-120 | Applies `gateState(message, primary, secondary)` where each action is `{label, onClick}` or omitted. Wires `#gate-action` (`.primary`) and the new `#gate-alt` (`.ghost`). All four existing call sites adapt; three pass one action or none |
| `renderShells` | 234-275 | Replace the `formatDistance(stop.distanceM)` cell (:253-257) with `distanceLabel(stop, origin)`. **Keep the `escape()` wrapper.** Signature and the `shellSignature` short-circuit untouched — note it does not encode the mode, which is why `switchOrigin` resets it explicitly |
| `loadBoard` | 295-333 | (a) `pendingLoad = loc ?? lastLoc` → `loc ?? originCoord(origin, lastLoc)`; (b) build the query with `boardParams(...)` instead of inline `URLSearchParams`; (c) the zero-stops retry (:317) must not call `locate(true)` in stop mode; (d) apply `shouldShowDelistedNote` after a successful parse; (e) return `true`/`false` so `switchOrigin` can restore. **Keep the `pendingLoad` coalescing verbatim** (AGENTS.md:200-201) — the early return still yields `undefined`, which `switchOrigin` reads as "not my load" |
| `flagMock` | 363-366 | Set `mockActive = true` first, so applying `taglineFor()` can never clobber the demo-data warning on a switch |
| `getPosition` | 380-392 | **Unchanged, deliberately.** Its `getCurrentPosition` call sits inside a synchronously-executed Promise executor, so calling it from a click handler preserves the user gesture. Add a comment saying exactly that |
| `onLocationRefused` | 394-405 | Keep the `board.length > 0` early return (:395) — it is what stops the nagging for a revoked-permission returning user. Message from `refusalCopy(err)`, and two actions: **Enter a stop code** (primary) / **Try location again** (ghost). Drop the automatic `openSearch()` at :404 so the gate buttons are the only affordance and focus is not stolen |
| `locate` | 407-438 | Becomes the *returning-gps* path only, with the `navigator.permissions.query` pre-check (:417-427) intact. Guard at the top: `if (origin?.mode !== 'gps') return;`. Persist `{mode:'gps'}` after the first successful `rememberLoc` |
| `openSearch` / `closeSearch` | 442-454 | Set `#use-location`'s `aria-pressed` from the mode; clear `searchResults`; return focus to the chip on close |
| `runSearch` | 458-495 | Store the parsed array in `searchResults` before rendering — keeps coordinates out of DOM attributes and gives `commitDecision` its input. The `<2` guard (:459-463) stays; it is what keeps `/api/stops` from 400ing. `data-add` → `data-code` |
| `togglePin` | 499-510 | `loadBoard(lastLoc)` → `loadBoard(originCoord(origin, lastLoc))` |
| toggle / results listeners | 524-539 | Chip opens the panel (same behaviour); add Escape-closes-`#finder`; `pinByCode(...)` → `chooseStop(...)` |
| visibility listener | 546-551 | **Highest-risk edit.** Today `if (!lastLoc \|\| age > 5min) void locate()`. A stop-mode user usually has no `lastLoc`, so this fires an unprompted permission request on every tab focus. Becomes a one-line delegation to `shouldRelocateOnFocus(origin, lastLoc, Date.now())`, else `refreshArrivals()` |
| boot | 556 | `void locate()` → `boot()` |

**New in `app.js`** (glue only — every decision they need is imported):

| Signature | Purpose |
|---|---|
| `readOrigin()` | `readOriginRecord(localStorage.getItem(ORIGIN_KEY))` |
| `writeOrigin(next)` | Sets `origin`, stamps `at` with `Date.now()`, writes via the existing `write()` ([app.js:66-73](public/app.js#L66-L73)), then applies `chipState` and `taglineFor`. The **only** writer — the governing rule is enforced by keeping call sites to three: `locate()` success, `chooseStop()`, `boot()`'s grandfather branch |
| `boot()` | Calls `decideBoot({originRaw, locRaw, pinCount, now})` and applies the result: `intro` → `showIntro()`; `gps` → `locate()`; `stop` → tagline + gate + `loadBoard`. Persists first when `persist` is set. Synchronous and offline in every branch |
| `showIntro()` | No-op if `introSeen`. Applies `introVariant(...)`: for `insecure`/`unsupported`, `remove()` the location button (not `hidden`) and show the matching sentence. Then `showModal()`, or set the `open` attribute when `showModal` is missing |
| `startWithLocation()` | `intro.close()` → gate → `getPosition()` **with no `await` before it** → then `rememberLoc`, `writeOrigin({mode:'gps'})`, `loadBoard`. `.catch(onLocationRefused)`. Also wired to `#use-location` |
| `startWithCode()` | `intro.close()`, `openSearch()`, focus the input. No gate, no fetch, no persistence |
| `chooseStop(code)` | Look up in `searchResults`, check `isUsableStopCoord`, build the record, hand to `switchOrigin` |
| `switchOrigin(next)` | Snapshot `{origin, shellSignature}` → `closeSearch()` → `writeOrigin` → `resetBoard()` → gate → `await loadBoard(...)`; on `false`, restore the snapshot (re-persisting the old record), `shellSignature = ''`, `render()`, gate the failure. **Do not clear the `board` array** — only the DOM and the signature, or there is nothing to restore |
| `resetBoard()` | `el.board.innerHTML = ''; shellSignature = '';` — these must move together or the next `renderShells` short-circuits and paints nothing |
| `boardNote(message)` | `#board-note` text + `hidden`, mirroring `note()` ([app.js:102-105](public/app.js#L102-L105)) |
| `renderChip()` | Two assignments from `chipState(origin)` |

`switchOrigin` is the one piece of new *stateful* logic that stays in `app.js` and therefore stays untested. That is a deliberate accepted risk (risk 10) — extracting it would mean injecting `loadBoard`, the DOM reset and the storage write, which is more indirection than the ~15 lines are worth. Its failure mode is covered by manual rows E1-E3.

## public/index.html

**Head** — `<link rel="modulepreload" href="/origin.js" />` above the stylesheet link.

**Masthead** ([:20-25](public/index.html#L20-L25)) — the Search button becomes the origin chip. Renaming `search-toggle` → `origin-chip` is safe (the id is referenced only there and at [app.js:21](public/app.js#L21); CSS styles it via `button.ghost`), and "search-toggle" would be actively misleading once it opens a mode switcher.

```html
<button id="origin-chip" type="button" class="ghost"
        aria-expanded="false" aria-controls="finder"
        aria-label="Change stops shown. Currently: stops near you">
  Near you ▾
</button>
```

**`#finder`** ([:30-42](public/index.html#L30-L42)) — one new row above the input, plus `enterkeyhint="search"` on the input and a truer section `aria-label` ("Change the stops shown"). Keep `type="search" inputmode="search"` and the `font-size: 1rem` rule at [styles.css:182](public/styles.css#L182) that stops iOS zoom-on-focus.

```html
<div class="finder-loc">
  <button id="use-location" type="button" class="ghost" aria-pressed="false">
    Use my current location
  </button>
  <p class="finder-or">or search for a stop</p>
</div>
```

This single control also serves Journey A's "other door" — `startWithCode` opens the panel, which already contains it. Simpler than a second button below the results, and visible before the user has typed anything.

**`#gate`** ([:45-48](public/index.html#L45-L48)) — wrap the button in `.gate-actions` and add `<button id="gate-alt" type="button" class="ghost" hidden></button>`.

**Board note** — `<p id="board-note" class="note" hidden></p>` between `#gate` and `#board`.

**The dialog** — static markup after `</footer>`, before the script tag:

```html
<dialog id="intro" aria-labelledby="intro-title">
  <h2 id="intro-title">Bus arrival times</h2>
  <p>
    A quick way to see when the next bus is coming, at any stop in Singapore. That’s all it
    does — no sign-up, nothing to set up.
  </p>
  <p class="intro-q">How would you like to start?</p>
  <div class="intro-actions">
    <button id="intro-gps" type="button" class="primary" autofocus
            aria-describedby="intro-gps-sub">Use my current location</button>
    <p class="intro-sub" id="intro-gps-sub">Stops nearest you</p>
    <!-- Replaces the location button when it cannot possibly work. -->
    <p class="intro-sub" id="intro-no-gps" hidden></p>
    <button id="intro-code" type="button" class="ghost"
            aria-describedby="intro-code-sub">Enter a stop code</button>
    <p class="intro-sub" id="intro-code-sub">A stop you already know</p>
  </div>
  <p class="intro-fine">
    Your location is only used to rank nearby stops. It is not logged or saved.
  </p>
</dialog>
```

The two adaptive sentences ("This page needs a secure (https) connection to use your location." / "Your browser can't share a location.") are set from `showIntro()` rather than sitting in the markup — only one can ever be true, and the wrong one must not be in the DOM.

## public/styles.css

Append an `/* --- intro dialog --- */` block after the gate block (:152-164) to keep the file's section order.

| Selector | What it does |
|---|---|
| `dialog#intro` | `border: 0; padding: 1.15rem; margin: auto; background: var(--surface); color: var(--text); border-radius: var(--radius); box-shadow: var(--shadow); max-width: min(26rem, calc(100vw - 2rem));` — resets the UA border/padding and UA max-width. No z-index, no animation |
| `dialog::backdrop` | `background: rgb(0 0 0 / 0.45);` |
| `#intro h2` | matches the `h1` treatment at :89-93 |
| `#intro p`, `.intro-q`, `.intro-sub`, `.intro-fine` | body copy, the bold question, `--muted` sub-labels, `--muted` fine print |
| `.intro-actions`, `.intro-actions button` | grid stack in reading order, full-width buttons (they already carry the 2.75 rem min-height from `.primary`/`.ghost`) |
| `.gate-actions` | `display: flex; flex-wrap: wrap; gap: .5rem; justify-content: center;` |
| `.finder-loc`, `.finder-or` | flex row that wraps; `--muted` caption |
| `#use-location[aria-pressed='true']` + `::before` | `border-color: var(--accent)` and `content: '✓\00a0'` — the ✓ comes from the pressed state, so JS only toggles `aria-pressed` |
| `#board-note` | margin only; reuses `.note` (:238-242) |
| `dialog#intro[open]:not(:modal)` | Fallback margin so the no-`showModal` in-flow rendering is not flush against the masthead. `:modal` ships with `showModal`, so this is inert on modern browsers |

Every colour is an existing token. The one raw value is `rgb(0 0 0 / 0.45)` on `::backdrop`, correct in both schemes.

**Dark mode ([:29-43](public/styles.css#L29-L43)) needs no changes**, but eyeball one thing: `--shadow: none` in dark means the dialog has no drop shadow, so the 45% backdrop alone separates it from `--surface #191c21`. If the edge reads as invisible, add `border: 1px solid var(--border)` — still token-only.

Neither media query (:514, :527) needs changing: the dialog's max-width is viewport-relative and both new flex rows wrap.

## Verification

**Automated.** `npm test` must be green: ~91 new cases in `src/origin.test.ts`, 6 in `src/stops.test.ts`, plus the existing 42. Item 3 makes CI run it. Everything is deterministic — no timers, no network, no sleeps.

**Fixtures for the manual pass.**

- **Mock mode** (no `LTA_ACCOUNT_KEY`): 12 synthetic stops ([src/mock.ts:9-22](src/mock.ts#L9-L22)). The stop journey works end to end (`20021` has a neighbour ~60 m away), but the other six cards are kilometres off, so it is a poor fixture for judging the metres-only copy.
- **The stub** (`LTA_ACCOUNT_KEY=stub-key LTA_BASE_URL=http://localhost:9099`, [tools/stub-datamall.mjs](tools/stub-datamall.mjs)): 250 stops on a ~111 m grid — the right fixture for stop mode. `GET /_mode?set=500&code=10101` puts "Timings unavailable" on the origin card, `?set=429` degrades the board, `?set=empty` gives "No buses at this hour.", `?set=slow` exercises a switch in flight, and `/_stats` proves a stop commit costs exactly one `/api/board`.

Everything below is offline; no real DataMall key is needed. Use `http://localhost:8080` — a LAN IP is not a secure context, which is itself row A9. Clear state via DevTools → Application → Local Storage. Force geolocation outcomes by overriding `navigator.geolocation.getCurrentPosition` in the console *then* triggering the path from the UI (all three entry points call it lazily); for a real denial that also exercises the permissions pre-check, block location in site settings and reload.

**The manual matrix is now scoped to what unit tests cannot reach** — wiring, real browser behaviour, and layout. Every row's *decision* is already covered above; these rows prove the decision is applied to the right element.

**Journey A.** A1 first visit → dialog, and the Network panel shows `origin.js` fetched in parallel with `app.js` and **no `/api/*` call**. A2 → GPS granted: gate, one `/api/board`, both keys written. A3/A4/A5 → `code` 1/2/3 give three distinct sentences with two buttons each and **nothing persisted**. A6 → "Enter a stop code": finder open and focused, no gate, no request, no prompt. A7/A8 → Escape and backdrop dismissal both open the finder, persist nothing, and the dialog returns next reload. A9 → insecure context (LAN IP from a phone): location button absent from the DOM, https sentence shown, code path works. A10 → the unsupported-geolocation sentence (source override, or accept code review plus the `introVariant` test). A11 → `delete HTMLDialogElement.prototype.showModal`: renders in flow, both buttons work.

**Journey B.** B1 fresh fix → cached paint then live fix, identical to today. B2 stale >12 h → no cached paint. B3 moved >200 m → one re-rank. B4 permission revoked with a cache → cached board, **no** denial gate. B5 revoked with no cache → denial gate, origin **not** cleared. B6 stop mode → gate names the code, tagline and chip updated, **no permission request at all** (check the browser's permission/sensors panel), one `/api/board`. B7 stop mode, tab away 10 min and return → arrivals refresh only, still no geolocation call — the wiring half of the `shouldRelocateOnFocus` tests. B8 delisted code → board loads plus the note. B9 same with 8 pins → note **suppressed**. B10/B11 grandfathering from `loc.v1` / from pins → no dialog. B12 `PINS_KEY = '[]'` and no `loc.v1` → dialog **does** appear.

**Corrupt state.** One row, not six: `readOriginRecord`'s twelve cases are unit tested, so the manual pass only needs to confirm a corrupt record reaches the guard at all — set `origin.v1` to `'{'` and check the dialog appears with no console error. Plus C6: Firefox with `dom.storage.enabled = false` → dialog every reload, but not twice within a session.

**Search.** D3 `20021` + Enter commits with no tap · D4 `2` + Enter shows the hint and fires **no request** (it would 400) · D7 offline → "Search is unavailable right now." · D9 no iOS zoom on focus. The other `commitDecision` branches are unit tested.

**Switching (E1-E7).** gps→stop and stop→gps both work and update the chip, tagline and record; a switch that fails offline leaves the origin **unchanged** and the previous board back on screen (the untested `switchOrigin`, so exercise this one properly); opening and closing the panel fires zero requests; Escape closes it and returns focus to the chip; ★ still pins and re-ranks around the *current* origin; a result tap leaves `PINS_KEY` untouched.

**Layout and devices.** 320/360/390 px in both modes: chip on one line, no horizontal scroll. Dark mode with the dialog open: edge visible, backdrop correct, ✓ accent visible. **A real iPhone for A2** — the gesture chain and `<dialog>` behaviour are the two things nothing in this plan can verify any other way.

## Documentation (same commit as the code)

| File:line | Why it must change | With item |
|---|---|---|
| README.md:4,13 · AGENTS.md:8,92 | Say "15 nearest stops"; code says 8 | 1 |
| AGENTS.md:27-28 ("no framework, no bundler, no build step") | Still true, but `public/` is now two modules and one is on the test path. State that `origin.js` is pure and `app.js` is glue, and that the split exists so the journey rules are unit-testable — otherwise a future agent will inline it back | 2 |
| AGENTS.md:44-50 (testing) | Add the computed-import pattern and why it is computed; add that `public/origin.js` must never read `Date.now()` | 2 |
| README.md:3 | "allow location once" is no longer the only door | 9 |
| README.md:7-9 | Add the third localStorage key and what it holds per mode | 4 |
| README.md:15-24 ("The journey") | Bullet 1 asserts an immediate location prompt; bullet 4 says searched stops are pinned. Both false after decisions 1 and 4 | 6, 9 |
| AGENTS.md:7-9 | "no onboarding" — frame the chooser as the entry choice, and say why it is not a settings screen, so a future agent does not simplify it away | 9 |
| AGENTS.md:16-17 | Three keys now; state that `LOC_KEY` remains the sole owner of the fix and its age, and that the gps origin record carries no coordinate on purpose. The line most likely to be violated later | 4 |
| AGENTS.md:18-19 | "No new user-facing configuration" stands — add one sentence distinguishing a one-time entry choice from configuration | 9 |
| AGENTS.md:193-195 | Add the frontend consequence: a `0,0` stop must never become an origin, and `isUsableStopCoord` is where that is enforced | 6 |
| AGENTS.md:200-201 | Extend the `pendingLoad` note: `loadBoard` now takes its coordinate from `originCoord()`, and a failed switch must restore both board and origin | 6 |

## Risks, ranked

1. **`visibilitychange` firing geolocation in stop mode** — certain if missed. [app.js:549](public/app.js#L549) reads `if (!lastLoc || …)`, and a stop-mode user usually has no `lastLoc`, so every tab focus would prompt for location. Mitigated three ways: the `origin?.mode !== 'gps'` guard inside `locate()`, the listener delegating to `shouldRelocateOnFocus`, and the two stop-mode unit cases that pin it. Manual row B7 proves the delegation is wired.
2. **iOS Safari user-gesture chain.** The reason for skipping the permissions pre-check on the first-run path is that `await`ing it spends the transient activation. Any future `await` inserted between the click and `getCurrentPosition` silently breaks first-run location on iOS while working fine in Chrome desktop — hence the why-comment. **No test in this plan can catch this**; it needs row A2 on a real iPhone. Secondary: `showModal` needs iOS 15.4+; below that the `open` fallback loses the trap and backdrop but stays usable.
3. **The extraction is a real cost, not just a test convenience.** `public/origin.js` adds a second module fetch. `modulepreload` makes it parallel rather than serialized, and `express.static` already serves `public/` with `maxAge: '1h'` ([src/index.ts:155-160](src/index.ts#L155-L160)), so the steady-state cost is zero and the cold-start cost is one parallel ~4 KB request. It also puts a `public/` file on the test path (typed `any` in the test, so signature drift fails at runtime rather than compile time) — a new precedent, documented in AGENTS.md by item 2. If the maintainer would rather not pay this, the fallback is manual-only verification, and the plan loses ~91 tests.
4. **Grandfathering misfiring.** Showing the dialog to an existing user is the loud failure; hiding it from a new one is the quiet one. `readPins()` returns `[]` for both "no key" and "empty array", so `pinCount > 0` is the correct test — pinned as a `decideBoot` case. A user who visited once and *denied* location has neither key and will see the dialog: correct under the governing rule, and the case most likely to be reported as a bug.
5. **Delisted note false-positiving** for anyone with 8 pins. Covered by the all-pinned `shouldShowDelistedNote` case and manual rows B8/B9.
6. **`0,0` origin stops** — low likelihood, total failure when it happens. Guarded by `isUsableStopCoord` in both the read guard and the commit path, with cases in `readOriginRecord`, `decideBoot` and `commitDecision`, and the `search()`-keeps-them case in `src/stops.test.ts` documenting why the guard exists. One copy gap remains: the message shown when someone taps such a result — recommend reusing "No stop with code X." rather than inventing new wording.
7. **`aria-live` verbosity.** [index.html:50](public/index.html#L50) makes `#board` a live region, so a mode switch announces eight stop names and every ETA as one utterance. Optional fix: move the live region to `#status` and have `stamp()` write "8 stops near you. Updated 18:42." Costs: arrival changes stop being announced, and `stamp()` currently emits `HH:MM:SS` via `toLocaleTimeString('en-SG', {hour12:false})`, so dropping seconds is a separate decision that must keep the en-SG 24-hour convention. **Recommend deferring** — and never leaving both regions live.
8. **360 px masthead.** Estimated from the stylesheet, not measured: ~150 px for the `h1` plus ~110 px for the chip plus a 12 px gap ≈ 270 px inside ~333 px of usable width. `.ghost` is `white-space: nowrap`, so under pressure the `h1` wraps rather than the page overflowing. The `chipState` test asserting the label excludes the description pins the *decision*; the layout itself needs eyes at 320/360/390.
9. **Removal of pin-on-tap** — low technical risk, real user-visible change for anyone using search-then-pin. Pins themselves are untouched; mitigation is the README line plus the ★ staying on card #1.
10. **`switchOrigin` is the one untested piece of new stateful logic.** Its ordering collides with two existing mechanisms: `loadBoard`'s catch only gates when `board.length === 0`, and `renderShells` short-circuits on a matching `shellSignature`. Clear the DOM and `shellSignature` but **not** the `board` array; on failure reset the signature before `render()`. If a load is already in flight, `loadBoard` returns `undefined` — treat that as "not my failure" and leave the committed origin alone. Row E3 is the only net; exercise it deliberately.
11. **Tagline clobbering mock mode** — cosmetic but certain without the `mockActive` flag: switching origin in mock mode would leave "Stops near 20021, live from LTA" in the warning colour, a false claim about live data in exactly the environment used for manual testing. Pinned by the `taglineFor` case asserting it never returns the mock string.

## Implementation notes — where the shipped code diverges from the plan above

Recorded 11 Aug 2026, after implementation. The plan text above is left as it was
approved; this section is the delta, because a future reader trusting the plan
over the code would reintroduce three of these.

1. **`formatDistance(420)` is `420 m · 5 min walk`, not 6.** `Math.round(420 / 80)`
   is 5. Corrected inline above in both places it appeared.
2. **`dialog#intro[open]:not(:modal)` is unusable** for the no-`showModal`
   fallback. `:modal` and `showModal` both shipped in Safari 15.4, so on iOS
   15.0–15.3 — the only browsers that take the fallback path — the selector is
   unrecognised, the whole rule is dropped, and the fallback gets no margin. The
   code uses `dialog#intro.intro-inflow`, the class added by `showIntro()`.
3. **`readOrigin()` cannot be `readOriginRecord(localStorage.getItem(…))`.** With
   Firefox's `dom.storage.enabled = false` the *access* throws, before
   `readOriginRecord`'s try can catch anything — at module scope, killing the page.
   Both reads go through a `readRaw()` guard. This is the plan's own row C6.
4. **`writeOrigin` has four call sites, not three:** `startWithLocation()`,
   `switchOrigin()`, `boot()`'s grandfather branch, and `switchOrigin()`'s
   rollback. The governing rule is unaffected — the fourth restores a record that
   was already earned.
5. **`switchOrigin` snapshots the origin only, not `shellSignature`.** The
   captured signature is unusable: the restore must force a repaint, so it goes
   back as `''`. Snapshotting it would make `renderShells` swallow the restore.
6. **Two functions the table did not list.** `noStopsMessage(origin)` — the
   empty-board gate needed origin-aware copy, and leaving it as a ternary in
   `app.js` would have put untested copy selection in the glue. `parseLastFix` —
   module-private, the `readLoc()`-equivalent guard `decideBoot` needs.
7. **Enter-to-commit must flush the pending search debounce.** Enter lands inside
   the 250 ms window routinely, so `commitDecision` would decide against stale
   results and answer "No stop with code X." for a stop that exists. `commitSearch`
   awaits the flush first, and holds a `searchUnavailable` flag so an offline
   commit does not blame the stop for the network.
8. **`startWithLocation()` closes the finder**, because `#use-location` lives
   inside the panel it would otherwise leave open above the gate.
9. **Found in review, not in any item.** Two paths the plan created but never
   crossed: `#use-location` refused while a board is on screen hit
   `onLocationRefused`'s `board.length > 0` early return and gave a tap no answer
   at all (it now takes an `explicit` flag — automatic re-locates stay silent, taps
   never do); and leaving stop mode through `startWithLocation()` never reset the
   shells, so a user standing at the stop they had named would get the same eight
   cards back, signature unchanged, still labelled `(This stop)` and bare metres
   where walking times belong.

## Superseded — `#use-location` and the two-door panel

Recorded 12 Aug 2026. **Everything above about `#finder`'s internals is now
history.** The plan's own row 11 is the tell: it treated "tagline clobbering mock
mode" as cosmetic and solved it with the `mockActive` latch, which is exactly what
made the demo notice permanently destroy the sentence saying where the board was
ranked from.

What changed, and why a reader of the sections above must not reintroduce it:

- **`#use-location`, `.finder-loc` and `.finder-or` are gone.** The single control
  that "also serves Journey A's other door" (line 257) made state and action the
  same object: `#use-location[aria-pressed='true']::before` drew a ✓ on a button
  that still fired geolocation, so the state the user is in 95% of the time read as
  "already done, nothing to do". `aria-pressed` on a button that cannot be
  un-pressed is toggle semantics for a non-toggle.
- **`#finder` is a destinations card.** `#origins-head` ("Show stops near"), then
  `#origins` — a `<ul>` of `<li><button class="origin-row">` rows for the location
  door and each recent address — then a rule, then the search field and
  `#finder-hint`. The row the board is using carries `aria-current="true"`; the one
  affordance that re-runs a fix is `.origin-update` inside that row. See D6a in
  docs/postal-code-finder.md for the row model.
- **The card has a surface of its own** (`--surface`, token border, `--radius`,
  `--shadow`) and `#results` gave up its border and shadow to avoid a card inside a
  card. The chip's `▾` now opens a list, which is what a caret has always promised.
- **`openSearch` takes a focus target.** From the chip it focuses the list, because
  raising the phone keyboard over the rows hides the thing the redesign exists to
  show; from the address door (this document's Journey A) it still focuses the
  input.
- **The `mockActive` latch is deleted.** `taglineFor(origin, mock)` composes both
  clauses, so row 11's contradiction cannot be constructed rather than being
  guarded against.
- **`startWithLocation()` still closes the card**, and item 8 above still holds —
  the location door is still inside the panel, it is a row now.

The transient-activation rule is unchanged and still governs: the delegated
`#origins` click handler reaches `startWithLocation()` with nothing awaited above
it.
