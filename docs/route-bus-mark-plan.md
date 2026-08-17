# Implementation plan: route-page bus position mark

Status: **approved 17 Aug 2026, implemented 17 Aug 2026.** Read the
[task status](#task-status) and the divergences below before trusting the body
of this document.

## Feature

The route page's bus mark (today a 🚌 emoji absolutely positioned on the spine's
left edge) becomes:

1. **The closest bus to arrive at the highlighted stop** — the anchor stop's
   lead bus (`buses[0]` for the service), whether the anchor was chosen by tap
   or resolved from the user's location.
2. **Drawn with the board's existing vehicle silhouettes** — the `VEHICLE`
   DD/SD/BD SVGs already living in [public/app.js](../public/app.js) (~line
   590), including the `is-incoming` trail animation and reduced-motion
   handling in styles.css. No new artwork; zero UI discrepancy with the home
   board by construction.
3. **Inline on the right**, on the same line as the stop name — and when the
   bus sits beyond the fetched window, inline right on the upstream fold row
   ("8 stops — show").

### The placement ladder

Decided top-down by a new pure function `busMarkPlacement(leads, now)`;
`leads` is the window's lead buses in route order, furthest upstream first,
anchor last (the array `renderWindow` already builds).

| # | Condition | Result | Icon row |
|---|---|---|---|
| 1 | Arrivals stale / not fresh | (caller skips) | none |
| 2 | Anchor lead missing, unparseable, `monitored !== true`, or ETA staler than `JUMP_TOLERANCE_MS` | `null` | none |
| 3 | Anchor lead ETA ≤ 0 ("Arr") | `{kind:'anchor'}` | anchor row |
| 4 | `inferBusSegment` finds exactly one jump | `{kind:'segment', seg}` | the stop being approached (`from + seg + 1`) |
| 5 | Window all clean, zero jumps — bus upstream of window | `{kind:'beyond'}` | upstream fold row; if expanded, stop `from − 1` with approx treatment; origin-terminus row if `from === 0` |
| 6 | Window ambiguous (two jumps / unmonitored / stale inside) but anchor lead live | `{kind:'approx'}` | anchor row, degraded (`title="Approaching — exact position unknown"`) |

`passed` dimming of upstream stops applies **only** in kind 4. `inferBusSegment`
stays byte-identical; the new function wraps it.

### Agreed judgment calls

- **"Becker" = bendy** (DataMall `Type: 'BD'`).
- **Unknown `type`** — deliberate deviation from the board, where a blank draws
  nothing: the route mark is positional and cannot vanish, so unknown type
  renders the plain single-deck body with `{title:'Bus', label:'Bus'}`,
  claiming no deck count.
- **Trails** follow the board's rule: only when the anchor lead's ETA is
  ≤ 3 min (`isIncoming` in [public/origin.js](../public/origin.js)).
- **Expanded fold** under kind 5: the fold row no longer exists and the
  revealed stops carry no ETAs, so the mark attaches to the stop row
  immediately above the window (`from − 1`) with the approx treatment.

## Task graph

```
T1 (shared icon module)  ──┐
                           ├──► T3 (route render + styles) ──► T4 (E2E verification)
T2 (placement logic)     ──┘
```

T1 ∥ T2 run in parallel — file sets are disjoint, so no conflicts are
expected; whichever merges second rebases onto `main` and re-runs `npm test`
first. T3 branches from `main` only after both are in; T4 runs on `main`
after T3. **One commit per task**, merged only with `npm test` green. Each
task is executed by a separate agent using the context below.

---

## T1 — Extract the vehicle marks into a shared module

**Outcome:** `public/vehicle-marks.js` exists, exporting `VEHICLE`, `trail`,
`vehicleIcon`; the board page behaves pixel-identically.

**Context:**
- Move `VEHICLE`, `trail()`, `vehicleIcon()` from
  [public/app.js](../public/app.js) (~lines 535–664) into a new ESM
  `public/vehicle-marks.js`, preserving the long design-rationale comments —
  house style is that comments carry the why.
- `app.js` imports them; `renderTags` stays in app.js unchanged.
- [public/index.html](../public/index.html) (~line 305) has a hand-synced
  static sample whose comment says "Kept in step with VEHICLE.DD in app.js" —
  update the pointer to the new module.
- Pure refactor: no behaviour, markup, or CSS change of any kind.

**Verification:**
1. `npm test` green (build + full suite).
2. `grep -rn "const VEHICLE" public/` returns exactly one hit (the new module).
3. `npm start` (mock mode, http://localhost:8080), enter via either door:
   board cards show the same tags as before — DD (divider across), BD
   (divider down, 3 wheels), SD (plain short body); trails animate only on
   rows with lead ETA ≤ 3 min; `prefers-reduced-motion` still stills them.
4. `git diff` shows no change inside the moved SVG path data (pure move).

**Commit:** `T1: extract vehicle marks into public/vehicle-marks.js`

---

## T2 — Placement ladder as pure logic

**Outcome:** `busMarkPlacement(leads, now)` in
[public/route-logic.js](../public/route-logic.js), fully unit-tested; no UI
change.

**Context:**
- `inferBusSegment` (route-logic.js ~line 613) is untouched; wrap it.
- `now` is injected, never a clock read (house rule — the module never reads
  a clock).
- Return contract: the ladder table above. The beyond/approx distinction:
  `beyond` requires every window lead to pass `inferBusSegment`'s validity
  gates with zero jumps; anything else that still has a live anchor lead is
  `approx`.
- Single-element input (anchor only — terminus case): `{kind:'anchor'}` when
  Arr, else `{kind:'beyond'}`; T3 maps that to the terminus row when
  `anchorIdx === 0`.
- Tests in [src/route-logic.test.ts](../src/route-logic.test.ts) — note its
  computed-import-specifier bargain (top of file) and injected `NOW`; follow
  the existing `inferBusSegment` describe block's `eta()` helper style.
- JSDoc in the module's established voice.

**Verification** (unit tests to write, then `npm test`):
1. Anchor ETA −30 s → `{kind:'anchor'}`; anchor ETA −120 s (past tolerance) → `null`.
2. Clean descending window, one jump at index k → `{kind:'segment', seg:k−1}`
   (mirror the existing `inferBusSegment` cases).
3. Clean window, monotonically decreasing toward anchor, no jump → `{kind:'beyond'}`.
4. Two jumps → `{kind:'approx'}` (anchor live).
5. An upstream lead `monitored:false` or missing, anchor live → `{kind:'approx'}`.
6. Anchor lead `monitored:false` → `null`, regardless of window.
7. Single-element array, live, not Arr → `{kind:'beyond'}`; Arr → `{kind:'anchor'}`.
8. Empty / `null` input → `null`.

**Commit:** `T2: busMarkPlacement — the mark's placement ladder as data`

---

## T3 — Route page rendering + styles

**Outcome:** the route page draws the shared vehicle silhouette inline-right
on the correct row per the ladder; old 🚌 emoji and absolute positioning
removed.

**Context:**
- Depends on T1 + T2 merged; start from updated `main`.
- [public/route.js](../public/route.js) `renderWindow` (~lines 495–565):
  replace `inferBusSegment`/`markIdx` usage with `busMarkPlacement`. The
  mark's vehicle type comes from the **anchor's** lead bus
  (`leads[leads.length − 1].type`); build the icon with
  `vehicleIcon(VEHICLE[type] ?? fallback, incoming)` from `vehicle-marks.js`.
  Fallback = SD art with `{title:'Bus', label:'Bus'}`. `incoming` = anchor
  lead ETA ≤ 3 min, matching the board's `isIncoming` rule (reuse from
  origin.js if importable, else replicate the threshold with a comment
  pointing at it).
- Row targeting:
  - `segment` → row `from + seg + 1` (same arithmetic as today's `markIdx`);
    `passed` dimming applies only here.
  - `anchor` / `approx` → the anchor row (the `here` li); `approx` adds
    `title="Approaching — exact position unknown"` and a `bus-mark-approx`
    class.
  - `beyond` → the fold row immediately upstream of the window
    (`row.kind === 'fold'` with `startIndex + count === from`), inside the
    `<li>` but **outside** the `<button>` so tapping still expands. Fold
    expanded → stop row `from − 1` with the approx treatment. `from === 0` →
    origin-terminus row.
  - `null` → nothing (also when `!arrivalsFresh`, unchanged).
- Right-side layout: the icon is the rightmost element of the row line, after
  the existing inline ETA / stop-code; restructure `rowFor`'s markup so name
  + right-group form a flex line. Mobile-first at 390 px (AGENTS.md rule 2);
  long stop names truncate, never wrap under the icon.
- [public/styles.css](../public/styles.css): delete the absolute
  `.spine .bus-mark` block (~lines 1920–1930); new inline rules reuse
  `.tag-icon`/`.tag-svg` classes for the drawing itself (sizes, trails,
  reduced-motion come free) with a thin `.bus-mark` wrapper for row
  alignment. Follow style-guide.md tokens; no new colours.
- Update `BUS_POSITION_LABEL` (route-logic.js ~line 52) to also cover
  approximate placement, e.g. "…it can jump, and may be approximate."
- Delete the now-stale comment about the emoji not having "earned motion".

**Verification** (mock mode, `npm start`):
1. `npm test` green; `grep -rn "🚌" public/` empty.
2. Open a route page, anchored view: mark inline, right of the ETA, same line
   as the stop name; silhouette matches the board's for the same type (open
   the board in a second tab, compare).
3. Force each ladder kind and confirm the row (mock ETAs are deterministic;
   where a kind can't be reached with stock mock data, temporarily tweak
   `src/mock.ts` locally — throwaway, not committed — and note the tweak in
   the task report):
   - `segment`: mark on approaching stop, upstream window stops dimmed.
   - `anchor` (Arr): mark on the highlighted stop's row.
   - `beyond`: mark inline right on the "N stops — show" fold row; tapping
     still expands; after expansion the mark moves to the last revealed stop
     with the approx title.
   - `approx`: mark on anchor row, approx title present.
4. Trails animate only when anchor ETA ≤ 3 min; still under
   `prefers-reduced-motion`.
5. 390 px viewport: no horizontal overflow, long names truncate; dark and
   light themes both legible.
6. Direction toggle and "Change" (re-anchor) recompute the mark correctly.
7. Footer honesty line shows the updated wording.

**Commit:** `T3: route bus mark — shared silhouettes, inline right, placement ladder`

---

## T4 — End-to-end verification pass

**Outcome:** documented pass/fail record of the whole feature on a clean
checkout of `main`; fixes (if any) land as their own commits referencing the
failing step.

**Process:**
1. Fresh `git pull && npm ci && npm test` — full suite green.
2. **Matrix in mock mode:** each placement kind × each vehicle type
   (SD/DD/BD/unknown — mock cycles types in `src/mock.ts` `TYPES`; unknown
   via one throwaway local edit). For every cell record: row targeted, icon
   shape, title/aria-label text, trails on/off.
3. **Cross-page consistency:** board card tag vs route mark for the same
   service side-by-side — identical geometry, colour, animation behaviour.
4. **Regression sweep:** board page, stop page, and intro dialog unaffected
   (T1 moved shared code); fold expand/collapse, direction toggle, re-anchor,
   first-visit tip all behave as on current `main`.
5. **Responsive / a11y:** 320 px and 390 px widths, dark/light,
   `prefers-reduced-motion`, accessibility tree shows the mark's label
   ("Double deck bus" etc., "Bus" for unknown).
6. **Live smoke (optional, if `LTA_ACCOUNT_KEY` is set):** one busy corridor
   (e.g. service 187) watched across two refresh cycles — mark moves
   plausibly, never renders two marks, disappears cleanly when data goes
   stale.
7. Defects → fix commits, re-run the failing step plus `npm test`.

---

## Task status

- [x] T1 extract vehicle marks into `public/vehicle-marks.js` — `1574dd1`
      (merged `346d89b`)
- [x] T2 `busMarkPlacement` — the placement ladder as data — `8c6738e`
      (merged `85c5f22`)
- [x] T3 route bus mark — shared silhouettes, inline right — `743ca17`
- [x] T4 end-to-end verification — every checklist item passes; two fixes,
      `5db4a16` (the mark's trails crowding the ETA) and `82d65c1` (a
      pre-existing unguarded `VEHICLE` lookup in `renderTags`)

T4 ran the placement ladder × vehicle-type matrix in headless Chrome against
mock mode, with `/api/arrivals` intercepted so each rung could be forced; the
board-versus-route comparison, the responsive and reduced-motion checks and the
accessibility tree were read the same way. `LTA_ACCOUNT_KEY` was unset, so the
live smoke was run against `tools/stub-datamall.mjs` instead.

### Divergences from the plan as written (17 Aug 2026)

1. **A second pure function, `markTarget`, joined `busMarkPlacement`.** The plan
   put row targeting in T3's renderer. It is in `route-logic.js` because the
   ladder answers what the timings support and this answers which row the fold
   plan can carry it on, and the second depends on what the *user* has spliced
   open — a different kind of fact, and one worth unit-testing without a DOM.
2. **`from === 0` gets no approx treatment.** The plan's table says `beyond`
   lands on the "origin-terminus row if `from === 0`" and leaves the degrading
   open. It takes neither the `title` nor the class: there is no row above the
   origin because there is no route above it, so "at or before stop 0" is a
   precise reading — the bus has not left the terminus — not a fallback.
3. **A gap too small to fold is treated exactly like an expanded fold.** The
   plan named only the expanded case. Under `FOLD_MIN` the upstream stops render
   individually and there is no fold row to carry the mark, which is the same
   situation arrived at differently, so it takes the same stop `from − 1` with
   the approx treatment.
4. **`approx`'s `title` sits on the `.bus-mark` wrapper, not on the icon.** The
   icon's own `title` (`Double deck`) comes from the shared `vehicleIcon` and
   could not be replaced without either forking the module or dropping the
   vehicle name. **Consequence, measured:** a pointer over the mark resolves the
   *inner* title, so the approx sentence is unreachable by hover. On the
   shipping target that costs nothing — there is no cursor on a phone and
   `title` never shows — and the visible signal for approx is the 0.78 opacity.
   Revisit only alongside a decision about what the mark should say out loud.
5. **The mark dropped the emoji's `aria-hidden` and carries the board's
   `aria-label`.** Verified in the accessibility tree over CDP: the marked row
   exposes `Double deck bus` / `Bendy bus` / `Single deck bus`, and `Bus` for a
   type we were never sent.
6. **`Arr` is drawn at two different boundaries and it does not show.**
   `busMarkPlacement` takes the anchor rung at `ts − now <= 0`; `etaInline`
   floors to whole minutes, so a row reads `arr` from 59 s out. The window
   between them is a stop whose inline ETA says `arr` while the placement is
   still `segment` — which is correct on both counts, since that row is an
   upstream stop and not the anchor. Traced by T3, and T4 found no reachable
   case where the two disagree about the *same* row.
7. **One layout rule of the board's did not come free after all**, contrary to
   "sizes, trails, reduced-motion come free". `.tag-svg`'s `margin-left:
   -0.25rem` aligns a mark that sits at the *left* of its column; inline right
   of an ETA it eats 4px of the 5.6px gap and puts the trails against the "min".
   Cancelled for `.spine .bus-mark` only — `5db4a16`.

### Notes for whoever picks this up next

- **Stock mock routes are 1–3 stops long**, so no rung below `anchor` can be
  reached with them. T3 and T4 both added a throwaway 12-stop service `999` to
  `SERVICES_BY_STOP` and `ROUTE_SHAPES` in `src/mock.ts` (keeping
  `src/mock.test.ts`'s inverse-map invariant) and reverted it before committing.
  Forcing a *rung* additionally needs the timings under control: T4 intercepted
  `/api/arrivals` in the browser and left everything else genuinely served.
- **The DataMall stub is a poor fixture for the ladder.** Its per-stop timings
  come out equal across a window, which is `beyond` and only ever `beyond`. It
  is the right fixture for "one mark, never two" and for the disappearance.
- **Restoring `_mode=ok` does not bring the mark back in the same tab.**
  `cache.ts` is stale-on-error with per-key backoff, so an `empty` or `500` spell
  outlives the mode switch by up to a minute; a fresh load recovers immediately.
  Documented behaviour, not a defect — the same trap is recorded in
  `docs/board-navigation-plan.md`.
- **Never verified here:** a real iPhone (nothing on this page touches
  transient activation, but `AGENTS.md`'s rule stands that no test here can
  catch iOS Safari), a real screen reader, and the mark's 0.78 approx opacity in
  actual sunlight — it measures 3.4:1 against `--bg` in light, over the 3:1
  floor for a graphic and the weakest ink on the page.
