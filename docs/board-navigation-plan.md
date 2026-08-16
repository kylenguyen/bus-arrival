# Board navigation affordances — implementation plan

Options **A ("Quiet marks")** and **D ("Teach once")** from the approved design proposal,
rendered on the real card in both schemes:
https://claude.ai/code/artifact/1dd9afbe-1269-4fc1-9f8b-d32a0287458b

The problem: the board's two doors to the deeper pages are already links —
`a.card-link` → `/stop/:code` ([public/app.js](../public/app.js) `renderShells`) and
`a.service-no` → `/bus/:no?stop=…` ([public/app.js](../public/app.js) `renderServices`) —
but [public/styles.css](../public/styles.css) strips both of colour and underline. The
reasoning at the time was sound and is quoted in the file: an accent, underlined `61` in
the first column would out-shout the minutes beside it. The result is that nothing on the
card says it goes anywhere.

A + D fixes that with ink rather than height. Options B (tiles) and C (named door strips)
were rejected — C because it buys discoverability with the screen space the board exists to
spend on arrivals; B is the documented fallback if A proves too quiet in use, and can
replace A without touching anything else.

Rules of the road for every task: **AGENTS.md wins on behaviour, style-guide.md wins on
looks.** Read both before touching anything. `public/origin.js` stays pure — no DOM,
storage, clock or `fetch` — and the module-contract test in
[src/origin.test.ts](../src/origin.test.ts) enforces it; `public/app.js` is the glue.
Every interpolation goes through the local `escape()`. User-facing copy is pinned verbatim
by tests.

Execution: tasks run **sequentially** in a shared working tree, one commit each. T3 is the
only genuinely parallel-safe task (it touches `public/origin.js` and
`src/origin.test.ts` and nothing else); T1, T2 and T4 all edit `public/styles.css`, and
T2/T4 both edit `public/index.html` and `public/app.js`. If T3 is run concurrently in a
worktree, rebase it onto `main` before T4 starts.

---

## Shared contract (fixed — do not renegotiate mid-task)

| Thing | Value |
| --- | --- |
| Storage key | `bus-board.hint.v1` — the **fifth** `bus-board.*` key |
| Tip copy | `Tap a stop for every bus that calls there. Tap a bus number for where it goes.` |
| Dismiss label | `Got it` |
| Showings before auto-retire | `3` |
| New classes | `.card-chev`, `.coach`, `.coach-x` |
| Underline scope | `a.service-no`, product-wide |
| Chevron scope | `a.card-link` on the board card, and the intro dialog's sample |

### Decisions taken (16 Aug 2026)

1. **The underline is product-wide, not board-only.** `public/stop.js` and
   `src/stop-page.ts` already emit `a.service-no`, so scoping the rule to the board would
   make one component teach two different things on two pages. The accepted cost is a
   visible change to the stop page, which was designed in a separate round. The route page
   and `/buses` are unaffected — both render `<span class="service-no">`, not a link, and
   must stay bare.
2. **The tip shows at most three times, and a dismissal ends it immediately.** Pressing
   "Got it" writes the retired record straight away, whether it is the first showing or the
   third. Auto-retire is the backstop for a rider who never presses anything; the dismissal
   is not a "seen once" counter increment.
3. **The dismiss control is 2.75rem, not the 1.6rem `×` in the specimen.** The mock
   under-drew it; style-guide.md floors anything tappable at 44px. The shipped control is a
   `Got it` button using `.pin`'s negative-margin trick so the row still lands near 44px
   overall.

---

## T1 — Underline the linked service number

**Scope:** `public/styles.css` only. No markup changes — every surface already emits
`a.service-no`.

Replace the `a.service-no` rule (in the route-page section, immediately under the
`--- route page (/bus/:service) ---` banner). Its comment currently argues *for* the absent
underline; rewrite it to record the new decision — a muted hairline, not an accent
underline, because the accent still belongs to the minutes — rather than deleting it.

```css
a.service-no {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--muted);
  text-decoration-thickness: 1px;
  text-underline-offset: <measured>;
}
```

### The geometry problem this task exists to solve

`.service-no` is `display: block`, `1.3rem`, `line-height: 1.1`; `.service-tags` sits
`margin-top: 0.2rem` below it carrying a `0.7rem` vehicle mark. The underline is drawn
below the baseline and may land inside that 3.2px gap, where it reads as part of the
drawing rather than as a link. Do not guess at the offset:

1. Measure in a real browser at 375px **with Archivo Narrow actually loaded**, not the
   fallback: clear air between the underline's bottom edge and the top of `.tag-svg`.
2. Target **≥3px clear** at a 1rem root, so the underline can never be taken for the
   mark's own ink.
3. Pick `text-underline-offset` in the `0.12em`–`0.2em` band. Only if that cannot buy the
   clearance, raise `.service-tags` `margin-top` to `0.3rem`.
4. **Prove the row height did not move.** Measure `.service`
   `getBoundingClientRect().height` before and after, on a row *with* a lead ETA and
   crowding pill **and** on a row *without* one (`.eta-empty`, or a service whose lead cell
   has no crowding label — `renderEta` emits an empty `.eta-load` there). The lead ETA
   column normally drives row height and leaves slack, but that is the assumption under
   test, not a given. If any row grows, the `.service-tags` margin cannot go up and the
   clearance must come from the offset alone.
5. **No bare `color-mix()`.** The file still carries iOS 15 fallbacks. If `var(--muted)` at
   1px reads too heavy, soften it inside
   `@supports (background: color-mix(in srgb, red 16%, white))` with plain `var(--muted)`
   as the fallback — the same pattern the crowding pills use.

### Verification

1. `npm run build && npm test` — green. No existing test should need changing.
2. `npm start`; browser at 375px in the device toolbar. Capture five surfaces in **both**
   colour schemes:
   - `/` board cards;
   - the intro dialog's sample card (clear all `bus-board.*` keys first — it renders
     `<a class="service-no">` with no href precisely so it cannot drift from the board);
   - `/stop/10001` live arrival rows;
   - `/stop/10001` first/last-bus table (the `<th>` links);
   - an ended service on the stop page, for the `.sp-off .service-no` muted state.
3. Negative check: `/bus/52` and `/buses` render `<span class="service-no">` — confirm
   neither gains an underline.
4. Zoom one service row to 400%: the underline does not touch the vehicle mark in either
   scheme.
5. Record the before/after row heights from step 4 of the geometry work in the task report.
6. 320px on `/` and `/stop/10001`:
   `document.documentElement.scrollWidth === window.innerWidth`.

**Commit:** `T1: underline the linked service number`

---

## T2 — Chevron after the stop name

**Scope:** `public/app.js`, `public/index.html`, `public/styles.css`.

In `renderShells`, append the mark **inside** `.card-name`, not as a sibling —
`.card-name` is `display: block`, so a sibling would land on its own line:

```js
<span class="card-name">${escape(stop.description)}<span class="card-chev" aria-hidden="true">›</span></span>
```

Markup with `aria-hidden`, **not** a CSS `::after`: generated content is announced by most
screen readers, and this mark carries nothing the link text does not.

**Do not put the chevron at the head's right edge.** `.pin` already owns that edge; two
controls there would be worse than none.

The intro dialog's sample card must not drift — its own comment says it is built from the
board's classes so it cannot promise a layout the board does not produce. Wrap its
code+name in `<a class="card-link">` with no href (the same precedent as the
`<a class="service-no">` with no href a few lines below) and add the chevron span. Extend
the comment to say why.

CSS, beside the existing `a.card-link` rule, updating that comment:

```css
.card-chev {
  margin-left: 0.3rem;
  color: var(--muted);
  font-weight: 400;
}
```

**Known wart:** `.card-name` carries `overflow-wrap: anywhere`, so a long description can
orphan the chevron onto its own line. Acceptable — it is a mark, not information — but
check it against the longest description in mock data at 320px and report what it does.

### Verification

1. `npm run build && npm test` — green.
2. Board at 375px, both schemes: the chevron trails the name in `--muted`, and none of
   `.meta-code`, `.card-name` or `.card-sub` shifts position.
3. `.card-head` `getBoundingClientRect().height` unchanged before/after.
4. First visit (clear all `bus-board.*` keys): the sample card shows the same chevron as
   the live board, and Tab from the intro's doors must not land in the sample's link.
5. Screen reader on the live board: the card link announces `43179 Opp Blk 123, link` —
   no "single right-pointing angle quotation mark".
6. Longest mock description at 320px: no sideways scroll; orphan behaviour reported.

**Commit:** `T2: chevron on the board card's stop link`

---

## T3 — Pure hint logic + tests

**Scope:** `public/origin.js`, `src/origin.test.ts`. No UI. The only parallel-safe task.

Exports — names and semantics fixed. These return a **plain object**, not a JSON string:
`write()` in app.js stringifies, and `readRaw()` hands back the raw string, so the pure
module works in raw-in / value-out terms exactly as `readOriginRecord` and
`rememberRecent` already do.

```js
export const HINT_COPY =
  'Tap a stop for every bus that calls there. Tap a bus number for where it goes.';
export const HINT_DISMISS_LABEL = 'Got it';
export const HINT_MAX_SHOWINGS = 3;

export function readHintRecord(raw);                  // → { shown: number }
export function hintDecision({ raw, boardHasCards }); // → { show: boolean, record: object | null }
export function dismissedHintRecord();                // → { shown: HINT_MAX_SHOWINGS }
```

Rules:

- `boardHasCards === false` → `{ show: false, record: null }`. A gate, an empty board or a
  refusal is not the moment to teach navigation.
- `shown >= HINT_MAX_SHOWINGS` → `{ show: false, record: null }`.
- Otherwise → `{ show: true, record: { shown: shown + 1 } }`.
- `readHintRecord` degrades to `{ shown: 0 }` for anything that is not a non-negative
  integer.
- `dismissedHintRecord()` is what a dismissal persists: it jumps straight to the retired
  state, so "Got it" on the first showing ends the tip for good (decision 2 above).

Nothing here needs a clock, so no `now` parameter — and the module-contract test will fail
if `Date.now`, `document`, `localStorage` or `fetch(` appear in the file.

### Verification

`npm test` green, with new tests covering:

1. `readHintRecord` on `null`, `''`, `'not json'`, `'{}'`, `'{"shown":"2"}'`,
   `'{"shown":-1}'`, `'{"shown":1.5}'`, `'[]'`, `'{"shown":2}'`, `'{"shown":99}'`.
2. `hintDecision` across the ladder 0 → 1 → 2 → 3, and with `boardHasCards: false` at each
   rung (never shows, never writes).
3. `dismissedHintRecord()` fed back through `hintDecision` yields `show: false` — one step
   retires it, from any starting count.
4. All three copy/threshold constants pinned verbatim, matching the way
   `ADDRESS_DOOR_LABEL` is already asserted.

**Commit:** `T3: pure hint decision logic`

---

## T4 — The coach mark

**Depends on T3**, and lands after T2 (both edit `index.html` and `app.js`).

**Scope:** `public/index.html`, `public/app.js`, `public/styles.css`, plus one line of
`AGENTS.md`.

Static markup in `index.html`, `hidden`, directly **before** `#board` inside `<main>` — so
a screen reader meets the tip before the cards, and nothing reflows when it appears:

```html
<p class="coach" id="coach" hidden>
  <span id="coach-text"></span>
  <button id="coach-dismiss" type="button" class="coach-x">Got it</button>
</p>
```

Text and button label are filled from `HINT_COPY` / `HINT_DISMISS_LABEL` by app.js, so the
copy has one source and T3's test is the only place it is pinned. **Not** a live region —
it is not news, and `#board` beside it is already `aria-live="polite"`.

app.js:

- `HINT_KEY = 'bus-board.hint.v1'`, added to the storage-key comment block at the top of
  the file. That block opens "Four localStorage keys" and must now say five.
- Decide **once per page load**, not per refresh: a module-level `hintDecided` flag,
  checked in `loadBoard`'s success branch right after `render()`, passing
  `boardHasCards: board.length > 0`. An origin switch calls `loadBoard` again and must not
  burn a second showing.
- The dismiss handler hides the tip and persists `dismissedHintRecord()` through the
  existing `write()`.

CSS — a raised surface, so the border is mandatory (in dark mode `--shadow` draws nothing
and the border is its only edge):

- `border: 1px solid var(--border)`, `border-left: 3px solid var(--accent)`,
  `border-radius: 3px`, `background: var(--surface)`. The 3px accent bar is the marker
  `.card.pinned` and `.origin-row[aria-current]` already use — reuse it, do not invent a
  fourth.
- `.coach-x` at `min-height: 2.75rem`, with `.pin`-style negative margins so the row still
  lands near 44px overall.
- Nothing below `0.78rem`. No animation on appearance.

### Verification

1. `npm run build && npm test` — green.
2. Clear all five keys → reload → intro → choose a door → board loads → tip sits above the
   first card, text exactly `HINT_COPY`.
3. Reload twice: still shown (2nd, 3rd). Fourth reload: gone.
   `localStorage['bus-board.hint.v1']` reads `{"shown":3}`.
4. Clear again → press "Got it" on the **first** showing → gone immediately; reload →
   still gone; the key reads `{"shown":3}`.
5. Deny geolocation so the gate shows → no tip. Choose an address with no stops nearby
   (empty board) → no tip.
6. Dismiss button ≥44px in the DevTools box model; a comfortable one-handed hit at 375px.
7. First screenful still leads with arrivals — report the card count visible with and
   without the tip at 375px.
8. 320px: no sideways scroll; the copy wraps without pushing the button off the row.
9. Both colour schemes; the accent bar is visible in dark.
10. Tab order: masthead → origin chip → tip button → first card link. Screen reader reads
    the tip once, not as an alert.
11. Storage blocked (Firefox `dom.storage.enabled = false`): the board still renders and
    the tip does not break the load.
12. `AGENTS.md` "Verifying a change" §4 says "clear all four keys" — update it to five and
    name the new key. That is a load-bearing contributor instruction, not documentation.

**Commit:** `T4: first-visit navigation tip`

---

## T5 — End-to-end verification

Full sweep after T1–T4, by a fresh agent that assumes nothing. No commit unless a fix is
needed; a fix commits as `T5: <fix>`.

1. **Clean build + tests:** `npm run build && npm test` — all green, zero skips.
2. **Server health:** `npm start`, then `curl -s localhost:8080/healthz` →
   `{"ok":true,…,"mock":true}` with `upstreamCalls: 0` (mock mode never enters
   `request()`).
3. **The journey**, at 375px, both schemes, storage cleared: `/` intro → door → board
   (tip + chevrons + underlines) → tap a stop name → `/stop/:code` → tap a service number
   → `/bus/:no?stop=…` anchored to the right stop → back. Every hop lands where it should.
4. **Surface matrix.** Underline present on: `/`, `/stop/:code` live rows, `/stop/:code`
   schedule table, intro sample. Absent on: `/bus/:no`, `/buses`. Chevron present on:
   board cards, intro sample. Absent everywhere else.
5. **Tip lifecycle:** three showings then retired; "Got it" retires in one, from any count.
6. **320px** on `/`, `/stop/10001`, `/bus/52`, `/buses`:
   `document.documentElement.scrollWidth === window.innerWidth` on each.
7. **Reduced motion** (`prefers-reduced-motion: reduce`): nothing new animates, and the
   vehicle-mark trails still hold still at full ink.
8. **style-guide.md "Changing this"** checklist, run item by item.
9. **Real-shape upstream:** `node tools/stub-datamall.mjs`, then
   `LTA_ACCOUNT_KEY=stub-key LTA_BASE_URL=http://localhost:9099 node dist/index.js`.
   `GET /_mode?set=empty` → "No buses at this hour."; `GET /_mode?set=500` → "Timings
   unavailable — will retry." — with the card head, chevron and underlines intact in both
   states.
10. **Crawl regression:** `node tools/crawl-check.mjs` against the running server. Nothing
    in this feature adds or removes an href, so this is a pure guard on the SEO link graph.
11. **Screen reader pass** on `/`: card link, service link and tip each announced once,
    with no stray punctuation.
12. Produce a pass/fail report per item; any fail loops back to the owning task.

---

## Task status

- [ ] T1 underline the linked service number
- [ ] T2 chevron on the board card's stop link
- [ ] T3 pure hint decision logic
- [ ] T4 first-visit navigation tip
- [ ] T5 end-to-end verification
