# Style guide — Void Deck

The visual system for ezbus. Read this before any change that touches colour, type,
shape or card anatomy. [AGENTS.md](AGENTS.md) governs behaviour; this governs how it
looks. Where the two meet, AGENTS.md wins — every rule here is subordinate to "a
commuter finds out what bus is coming, as fast as possible, on a phone at a bus stop".

The tokens live in the `:root` blocks at the top of
[public/styles.css](public/styles.css). That file is the implementation; this is the
argument for it.

## The thesis

**An HDB estate, not a flag.** The palette is taken off the things a rider is actually
standing among: pale concrete underfoot, the turquoise mosaic tile that lines a void
deck's pillars, and stencilled block numerals. Nothing here is red-and-white, there is
no merlion, and there is no Singlish. What makes it local is the ground and the
numerals — a Singaporean recognises the estate without being told it is one, and
everyone else just gets a legible board.

Two consequences that are easy to undo by accident:

- **The neutral is not neutral.** `--bg` is a concrete grey with a deliberate green
  bias. Swapping it for a plain cool grey costs the whole direction and looks like a
  tidy-up in a diff.
- **This is a rectilinear world.** Block numbers, tile courses and kerb lines are drawn
  with a set square, so `--radius` is 4px and every hand-written radius in the file was
  squared to match. A soft radius is the single change that would make this read as a
  generic app wearing an estate palette.

## Colour

### Tokens

| Token | Light | Dark | What it is |
| --- | --- | --- | --- |
| `--bg` | `#e7ebe7` | `#121715` | Pale concrete; the same deck after dark |
| `--surface` | `#ffffff` | `#1b2220` | The card face |
| `--surface-2` | `#dce4de` | `#242d2a` | Card head, pressed states, skeleton bars |
| `--border` | `#c4d0c8` | `#2e3835` | Every edge and row divider |
| `--text` | `#16201b` | `#e3eae5` | Near-black with a green bias, and its inverse |
| `--muted` | `#54625b` | `#93a29a` | Secondary text; ≥5:1 on both `--surface` and `--bg` |
| `--accent` | `#0a6a72` | `#47cbdb` | Mosaic turquoise |
| `--on-accent` | `#ffffff` | `#08161a` | The label on a filled accent |
| `--seats` | `#0d6c37` | `#45cf8b` | Crowding: seats available |
| `--standing` | `#8a5300` | `#e2a53a` | Crowding: standing room |
| `--limited` | `#b3211b` | `#ff7a72` | Crowding: crowded |

### The rule that decides arguments

**Two colour families, because a rider asks two independent questions.** `--accent`
answers *when does it come* and owns every interactive affordance — the arriving ETA,
the pinned card, the focus ring, the origin chip, the intro band, the primary button.
`--seats`/`--standing`/`--limited` answer *can I get on* and are used nowhere else.

They have collided twice and both times it shipped:

1. `--accent` and `--limited` were once the same red, so an arriving bus, a pinned stop,
   a focus ring and a crowded bus all looked alike.
2. Void Deck was first drawn with **gate green** as the accent, which is the void deck's
   other signature colour and the more obvious choice. It is wrong here: `--seats` is
   green, and the lead ETA cell puts a 1.65rem accent number directly above a small
   crowding pill. Green over green is the first collision wearing a new hue. The
   turquoise is the resolution, not a preference — it keeps the two families ~37° apart.

So: **do not introduce a third colour family, and do not move `--accent` into the green
or amber range.** If a new state needs marking, spend shape, weight or position first.
Two things already do this and are the pattern to copy — a pinned card takes a 3px
accent bar rather than a new colour, and crowding is the only thing on the card that is
ever a filled pill, which is what keeps it separable from the accent even at a glance.

### Non-negotiables

- **`--on-accent` is a token, not `#fff`.** In dark the accent is light enough that
  white on it measures 2.0:1. A hard-coded white cannot warn you about that.
- **Dark mode's `--shadow` is a *transparent* shadow, not `none`.** `none` inside a
  `box-shadow` list is invalid and silently drops the whole declaration, which would
  delete `.card.pinned`'s inset bar in dark mode only. Every raised surface must
  therefore carry a 1px `--border`, because in dark that border is its only edge.
- **A child background paints over a parent's inset shadow.** `.card-head` is filled
  with `--surface-2`, so `.card.pinned .card-head` restates the marker bar. Anything
  else that gains a fill inside `.card` has to do the same.
- Contrast floor is WCAG AA for text in **both** schemes. `--muted` and the crowding
  labels are the ones that go under first; check them, not the obvious ones.

## Type

Two faces, and the split is a rule rather than a taste.

- **Archivo Narrow 700** (SIL OFL, self-hosted at
  `public/fonts/archivo-narrow-700.woff2`, 11.9 KB Latin subset) is used **only where a
  number is matched against something physical**: the stop code on the pole — the stop
  page's `.meta-code`, not the board's, whose demoted code rides `.card-sub` in the
  system face (see Card anatomy) — the service number on the front of the bus
  (`.service-no`), and the wordmark. Condensed also buys width where the grid is
  tightest — `--col-service` is 3.6rem and has to hold `966B`.
- **The system stack** (`--sans`) takes everything else, including every ETA. That is
  deliberate: the ETA is the fastest-read number on the page and the platform UI face is
  better at small sizes than any webfont. It also keeps the display face away from
  characters outside its subset, such as the en dash `.eta-value` renders for an empty
  cell.

Rules:

- **Do not widen the display face's remit.** Prose set in a heavy condensed face reads
  as shouting, and every character it touches is one more that can fall outside the
  subset.
- Self-host; never link a font CDN. A second DNS lookup and TLS handshake on a bus
  shelter's 4G is exactly the cost AGENTS.md tells you to weigh.
- `font-display: swap`, not `optional` — a first visit that never swapped would sit in
  the fallback for the whole session.
- **Nothing on a card goes below ~11px (`0.7rem`).** The target is a phone held at arm's
  length in Singapore sunlight. Buy room by dropping content, never by shrinking type.
- `font-variant-numeric: tabular-nums` on every figure that sits in a column.

## Shape and layout

- `--radius: 4px`. Hand-written radii are 3px (small chips, rows) or 4px (icon buttons).
  Nothing is a pill any more; the crowding labels and the distance chip were squared with
  everything else.
- **Anything tappable is ≥2.75rem (44px)** and separated enough that a hurried thumb
  cannot hit the wrong control.
- Mobile is the base, wide screens the override. The breakpoints are `max-width: 21.5rem`
  (drop the third arrival column), `max-height: 620px` (drop the intro's example, keep
  both doors) and `min-width: 40rem` (multi-column board). All three encode a measured
  decision — read the comment above one before changing it.
- Gutters follow `env(safe-area-inset-*)`.

### Card anatomy

The head is a filled plate (`--surface-2`) and reads top-down as:

```
Opp Blk 123 ›                            ← .card-name   1rem/650, the recognised thing
Ang Mo Kio Ave 3 [180 m · 2 min walk] · 43179
                                         ← .card-sub, one even 0.78rem muted line;
                                            the code is always its last item
```

**The name leads (again — Aug 2026, reversing the 2025 inversion).** Rider feedback: the
board is read constantly and the pole matched rarely; the name and road are what riders
recognise, and the loudest type on a card should be an arrival, not the header. The code
is demoted, not deleted — it is still the only field guaranteed unique (two stops on the
same road routinely share a description), so it stays on every card: muted, system face,
always the meta line's last item, and still in the card link's accessible name as a
`.visually-hidden` "(code)". The accepted trade-off is slower pole-matching. On
`/stop/:code` the 2025 argument still wins — there the code **is** the headline, and
`.sp-plate` keeps it at pole size on top of the plate.

`.card-head` and `.skeleton .card-head` must stay in step: the skeleton's bar count
follows the head's line count — two bars on the board, three on the stop page plate,
where the code still leads. The bars are filled with `--border` rather than
`--surface-2` because the head *is* `--surface-2` and same-on-same is invisible.

## Motion

Sparing, and every piece of it means something.

- **Vehicle-mark trails are the one animation with semantics.** They are drawn only when
  `isIncoming` in [public/origin.js](public/origin.js) says the next bus is 1–3 minutes
  out and monitored. The lengths in `mark-drift` are SVG user units, not pixels, and the
  keyframe deliberately begins and ends at the same near-invisible opacity because
  `paintBodies` restarts the animation every 10 s. Read the comment before touching any
  of it; three separate things there look like tidy-ups and are not.
- Skeleton cards pulse; there is no spinner anywhere and there should not be. A wait
  shows the board's shape at the board's size.
- Everything animated has a `prefers-reduced-motion: reduce` branch, and the branch keeps
  the *meaning*: an incoming mark holds its trails still at full ink rather than losing
  them.

## Identity assets

| Asset | Where | Note |
| --- | --- | --- |
| Wordmark | `<h1>` in [public/index.html](public/index.html), and the intro band | `ez` in `--accent`, `bus` in `--text`. Lowercase — the domain is the brand. Two spans, neither `aria-hidden`, no whitespace between them, so it stays one accessible string. |
| Favicon | inline SVG data URI in `<head>` | The board's own double decker on the turquoise. A drawn mark, not an emoji: emoji render differently per platform and that was the one piece of the identity we did not control. `#` must be percent-encoded. |
| Home-screen icons | `public/icon-{180,192,512}.png` | Generated by `node tools/make-icons.mjs` from the same geometry. Re-run it if the mark or `--accent` moves; do not hand-edit the PNGs. |
| Manifest | `public/manifest.webmanifest` | `theme_color`/`background_color` duplicate light `--bg`. There is no service worker, so iOS add-to-home-screen works and Android's full install prompt does not. |

The two `theme-color` metas in `index.html` also duplicate `--bg` per scheme and **cannot
read a CSS variable**. Any change to `--bg` is a change in two files.

## Changing this

1. Change tokens, not component rules. If a component rule needs a literal colour, the
   token set is missing one — add it to both schemes or reconsider.
2. Check both colour schemes. In dark, `--shadow` draws nothing, so a surface without a
   `--border` has no edge at all.
3. Check at 320px and 390px. `document.documentElement.scrollWidth === window.innerWidth`
   is the test; headless Chrome's `--window-size` has a 500px layout floor, so pin the
   viewport over CDP or use a real device toolbar.
4. Check the first-run journey separately by clearing all five `bus-board.*` keys. A
   returning visitor never sees the intro dialog, and it is the only screen the wordmark
   is introduced on. `bus-board.hint.v1` is the one that is easy to leave behind, and it
   is silent about it: the dialog comes back without it, but the navigation tip above the
   board stays retired.
5. If you touched copy in `public/origin.js`, `npm test` will tell you — those strings
   are asserted verbatim in `src/origin.test.ts`.
