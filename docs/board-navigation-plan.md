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

**Scope of this round (16 Aug 2026):** a chevron on the stop-name link, and a first-visit
tip that names both doors. The service-number underline that option A also carried was
tried and **rejected** — a hairline under `61`, sitting a few pixels above the vehicle
mark, drew the eye away from the minutes that are the reason the row exists. So the
stop-name door gets a permanent mark and the bus-number door does not.

The cost of that, stated plainly: after the tip retires, **nothing on the board indicates
that the bus number is tappable.** The tip is the only teacher for that door, and it shows
at most three times. That is an accepted trade — the bus-number door is the secondary one,
and the stop page it leads through carries its own service links — but if usage says the
route page is undiscoverable, the fix is a new round on that one affordance, not a quiet
reinstatement of the underline here.

Options B (tiles) and C (named door strips) were rejected — C because it buys
discoverability with the screen space the board exists to spend on arrivals; B is the
documented fallback if the chevron proves too quiet in use, and can replace it without
touching anything else.

Rules of the road for every task: **AGENTS.md wins on behaviour, style-guide.md wins on
looks.** Read both before touching anything. `public/origin.js` stays pure — no DOM,
storage, clock or `fetch` — and the module-contract test in
[src/origin.test.ts](../src/origin.test.ts) enforces it; `public/app.js` is the glue.
Every interpolation goes through the local `escape()`. User-facing copy is pinned verbatim
by tests.

Execution: tasks run **sequentially** in a shared working tree, one commit each. T2 is the
only genuinely parallel-safe task (it touches `public/origin.js` and `src/origin.test.ts`
and nothing else); T1 and T3 both edit `public/index.html`, `public/app.js` and
`public/styles.css`. If T2 is run concurrently in a worktree, rebase it onto `main` before
T3 starts.

**Do not touch `a.service-no` in `public/styles.css`.** Its existing comment argues for the
absent underline; that argument still stands and the rule stays as it is.

---

## Shared contract (fixed — do not renegotiate mid-task)

| Thing | Value |
| --- | --- |
| Storage key | `bus-board.hint.v1` — the **fifth** `bus-board.*` key |
| Tip copy | `Tap a stop for every bus that calls there. Tap a bus number for where it goes.` |
| Dismiss label | `Got it` |
| Showings before auto-retire | `3` |
| New classes | `.card-chev`, `.coach`, `.coach-x` |
| Chevron scope | `a.card-link` on the board card, and the intro dialog's sample |

### Decisions taken (16 Aug 2026)

1. **No service-number underline, on any surface.** Tried and rejected as too distracting
   next to the minutes. `a.service-no` keeps `text-decoration: none` product-wide — board,
   stop page live rows, and the stop page's first/last-bus table. `/bus/:n` and `/buses`
   render `<span class="service-no">` and were never in scope.
2. **The tip copy still names both doors.** It reads "Tap a bus number for where it goes."
   even though that door now has no permanent mark — that is precisely why the sentence
   stays. Teaching it once is the whole remaining mechanism.
3. **The tip shows at most three times, and a dismissal ends it immediately.** Pressing
   "Got it" writes the retired record straight away, whether it is the first showing or the
   third. Auto-retire is the backstop for a rider who never presses anything; the dismissal
   is not a "seen once" counter increment.
4. **The dismiss control is 2.75rem, not the 1.6rem `×` in the specimen.** The mock
   under-drew it; style-guide.md floors anything tappable at 44px. The shipped control is a
   `Got it` button using `.pin`'s negative-margin trick so the row still lands near 44px
   overall.

---

## T1 — Chevron after the stop name

**Scope:** `public/app.js`, `public/index.html`, `public/styles.css`. No dependencies.

In `renderShells` ([public/app.js](../public/app.js) around line 718), append the mark
**inside** `.card-name`, not as a sibling — `.card-name` is `display: block`, so a sibling
would land on its own line:

```js
<span class="card-name">${escape(stop.description)}<span class="card-chev" aria-hidden="true">›</span></span>
```

Markup with `aria-hidden`, **not** a CSS `::after`: generated content is announced by most
screen readers, and this mark carries nothing the link text does not.

**Do not put the chevron at the head's right edge.** `.pin` already owns that edge; two
controls there would be worse than none.

The intro dialog's sample card ([public/index.html](../public/index.html) around line 260)
must not drift — its own comment says it is built from the board's classes so it cannot
promise a layout the board does not produce. Add the same chevron span inside its
`.card-name` and extend the comment to say why. It needs **no** `<a class="card-link">`
wrapper: `a.card-link` contributes no visible styling (`color: inherit`,
`text-decoration: none`), so the plain `<span class="card-name">` already renders
identically, and adding a link element to a decorative sample buys nothing.

CSS, beside the existing `a.card-link` rule, updating that comment to record that the card
link now carries a mark:

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

1. `npm run build && npm test` — green. No existing test should need changing.
2. `npm start`; browser at 375px in the device toolbar. Board in **both** colour schemes:
   the chevron trails the name in `--muted`, and none of `.meta-code`, `.card-name` or
   `.card-sub` shifts position.
3. `.card-head` `getBoundingClientRect().height` measured before and after — unchanged.
   Record both numbers in the task report.
4. First visit (clear all `bus-board.*` keys): the intro dialog's sample card shows the
   same chevron as the live board, at the same offset and colour.
5. Screen reader on the live board: the card link announces `43179 Opp Blk 123, link` —
   no "single right-pointing angle quotation mark".
6. Longest mock description at 320px: `document.documentElement.scrollWidth ===
   window.innerWidth`, and report what the orphan does.
7. Negative check: `/stop/10001`, `/bus/52` and `/buses` gain no chevron anywhere.
8. Confirm `git diff` touches no `a.service-no` rule.

**Commit:** `T1: chevron on the board card's stop link`

---

## T2 — Pure hint logic + tests

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
  state, so "Got it" on the first showing ends the tip for good (decision 3 above).

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
5. The existing module-contract purity test still passes unmodified.

**Commit:** `T2: pure hint decision logic`

---

## T3 — The coach mark

**Depends on T2**, and lands after T1 (both edit `index.html`, `app.js` and `styles.css`).

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
copy has one source and T2's test is the only place it is pinned. **Not** a live region —
it is not news, and `#board` beside it is already `aria-live="polite"`.

app.js:

- `HINT_KEY = 'bus-board.hint.v1'`, added to the storage-key comment block at
  [public/app.js:12](../public/app.js#L12). That block opens "Four localStorage keys" and
  must now say five.
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
- **No bare `color-mix()`** — the file still carries iOS 15 fallbacks. If a softer tint is
  wanted, wrap it in `@supports (background: color-mix(in srgb, red 16%, white))` with a
  plain custom-property fallback, the same pattern the crowding pills use.

### Verification

1. `npm run build && npm test` — green.
2. Clear all five keys → reload → intro → choose a door → board loads → tip sits above the
   first card, text exactly `HINT_COPY`.
3. Reload twice: still shown (2nd, 3rd). Fourth reload: gone.
   `localStorage['bus-board.hint.v1']` reads `{"shown":3}`.
4. Clear again → press "Got it" on the **first** showing → gone immediately; reload →
   still gone; the key reads `{"shown":3}`.
5. Switch origin (GPS → address) with the tip on screen: `loadBoard` runs again, the
   counter does **not** advance a second time in the same page load.
6. Deny geolocation so the gate shows → no tip. Choose an address with no stops nearby
   (empty board) → no tip.
7. Dismiss button ≥44px in the DevTools box model; a comfortable one-handed hit at 375px.
8. First screenful still leads with arrivals — report the card count visible with and
   without the tip at 375px.
9. 320px: no sideways scroll; the copy wraps without pushing the button off the row.
10. Both colour schemes; the accent bar is visible in dark.
11. Tab order: masthead → origin chip → tip button → first card link. Screen reader reads
    the tip once, not as an alert.
12. Storage blocked (Firefox `dom.storage.enabled = false`): the board still renders and
    the tip does not break the load.
13. `AGENTS.md` "Verifying a change" §4 ([AGENTS.md:280](../AGENTS.md#L280)) says "clear all
    four keys" — update it to five and name the new key. That is a load-bearing contributor
    instruction, not documentation.

**Commit:** `T3: first-visit navigation tip`

---

## T4 — End-to-end verification

Full sweep after T1–T3, by a fresh agent that assumes nothing. No commit unless a fix is
needed; a fix commits as `T4: <fix>`.

1. **Clean build + tests:** `npm run build && npm test` — all green, zero skips.
2. **Server health:** `npm start`, then `curl -s localhost:8080/healthz` →
   `{"ok":true,…,"mock":true}` with `upstreamCalls: 0` (mock mode never enters
   `request()`).
3. **The journey**, at 375px, both schemes, storage cleared: `/` intro → door → board
   (tip + chevrons) → tap a stop name → `/stop/:code` → tap a service number →
   `/bus/:no?stop=…` anchored to the right stop → back. Every hop lands where it should —
   including the unmarked bus-number link, which must still be clickable and correctly
   href'd even though nothing draws attention to it.
4. **Surface matrix.** Chevron present on: board cards, the intro sample. Absent on
   `/stop/:code` (live rows and schedule table), `/bus/:no`, `/buses`.
5. **No-underline regression.** `a.service-no` computed `text-decoration-line` is `none` on
   `/` and on `/stop/10001` (live rows, first/last-bus table, and an ended `.sp-off`
   service). This is the check that the rejected option did not creep back in.
6. **Tip lifecycle:** three showings then retired; "Got it" retires in one, from any count;
   no tip on the gate or an empty board.
7. **320px** on `/`, `/stop/10001`, `/bus/52`, `/buses`:
   `document.documentElement.scrollWidth === window.innerWidth` on each.
8. **Reduced motion** (`prefers-reduced-motion: reduce`): nothing new animates, and the
   vehicle-mark trails still hold still at full ink.
9. **style-guide.md "Changing this"** checklist, run item by item.
10. **Real-shape upstream:** `node tools/stub-datamall.mjs`, then
    `LTA_ACCOUNT_KEY=stub-key LTA_BASE_URL=http://localhost:9099 node dist/index.js`.
    `GET /_mode?set=empty` → "No buses at this hour."; `GET /_mode?set=500` → "Timings
    unavailable — will retry." — with the card head and chevron intact in both states.
11. **Crawl regression:** `node tools/crawl-check.mjs` against the running server. Nothing
    in this feature adds or removes an href, so this is a pure guard on the SEO link graph.
12. **Screen reader pass** on `/`: card link and tip each announced once, with no stray
    punctuation from the chevron.
13. Produce a pass/fail report per item; any fail loops back to the owning task.

---

## Task status

- [x] T1 chevron on the board card's stop link — `7b782b1`
- [x] T2 pure hint decision logic — `4249110`
- [x] T3 first-visit navigation tip — `443c699`
- [x] T4 end-to-end verification — 13/13 items pass; one fix, `ce803b1`

### Divergences from the plan as written (16 Aug 2026)

1. **`hintDecision` gates on `boardHasCards !== true`, not `=== false`.** The
   stricter reading matches the house idiom for `geolocationSupported` in
   `originsState`: a caller that forgets the flag loses the tip, which is
   recoverable, rather than teaching over a gate, which is not. Callers must pass
   `boardHasCards: board.length > 0` explicitly.
2. **Three stale documentation lines were corrected, not the one the plan named.**
   T3's scope said "one line of AGENTS.md" (§4's "clear all four keys"). Also
   contradicted, and fixed: `AGENTS.md:74`'s key enumeration, which counts
   `bus-route.anchor.v1` and so went five → **six**; and `style-guide.md:185`,
   which is the checklist T4 item 9 runs — left stale it would have produced a
   phantom failure in the final sweep. `AGENTS.md:107`'s "cleared with the other
   three" was missed by T3 and caught by T4. Two counts coexist on purpose: six
   `localStorage` keys in total, five scoped to `bus-board.*`.
3. **The coach mark's accent bar is a real `border-left`, not the inset
   box-shadow.** The plan called for reusing the marker `.card.pinned` and
   `.origin-row[aria-current]` draw, and those two differ:
   `.origin-row[aria-current]` already uses `border-left: 3px solid var(--accent)`
   and only `.card.pinned` uses `box-shadow: inset 3px 0 0`, because it has
   `overflow: hidden` for a border to fall foul of. `.coach` has no such
   constraint, so it matches the former exactly.

### Notes for whoever picks this up next

- **Mock mode cannot produce an empty board.** `StopIndex.nearby()` has no radius
  cutoff, so any Singapore coordinate returns 8 of the 12 mock stops. The
  "no tip on an empty board" rule was verified by overriding `fetch` to return
  `{stops:[]}`.
- **Re-running T4 item 10: test `500` before `empty`, or restart in between.**
  `TtlCache` is stale-on-error by design, so a `500` following an `empty` re-serves
  the cached `[]` and renders "No buses at this hour." instead of "Timings
  unavailable — will retry." That is the cache behaving correctly, not a defect.
- **Both degraded upstream states still show the tip**, since the board has 8 real
  cards with working stop links and only the timings are missing. Consistent with
  the contract, but "Timings unavailable" beside "Tap a stop for every bus that
  calls there" is an odd pairing. If unwanted, it belongs to T3's call site.
- **Never verified here:** a real screen reader (the accessibility tree was
  asserted over CDP instead), a real iPhone, and storage genuinely disabled in
  Firefox (simulated by making `localStorage` throw).
