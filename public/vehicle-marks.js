// The vehicle silhouettes and their markup, moved out of ./app.js because the
// board is no longer the only page that draws them — the route page's position
// mark is the same three shapes. A second copy of the artwork would be two
// drawings free to drift apart, and the whole point of the marks is that a
// rider reads the same shape for the same vehicle wherever it appears.
//
// No DOM, no clock, no storage — strings in, markup out. The "is it incoming"
// decision stays with the caller (`isIncoming` in ./origin.js), which is what
// keeps the trail rule in one place rather than in each page's renderer.

/**
 * The vehicle silhouettes, keyed by DataMall's `Type`. "DD" and "Bendy" were the rider's
 * only clue before, and neither is a rider's word — the first is an operator code and the
 * second only names the joint if you already know what it is. A shape says "tall bus" or
 * "long bus" in no language at all.
 *
 * Inline SVG is a deliberate break from the card's text-glyph idiom (★ ▾ ↻ ×), because
 * Unicode offers nothing usable: U+1F68C is a single decker and emoji-presentation only,
 * so U+FE0E buys an inconsistent monochrome fallback of the wrong vehicle, and there is
 * no articulated bus at all.
 *
 * Each carries a viewBox cropped to its own artwork rather than a shared one. Drawn on a
 * common box the tall bus filled more of it than the low bendy, so a single CSS height
 * came out 20% taller for one than the other. Cropped, one height makes both marks' ink
 * exactly equal — which is why the box below is padded a touch: an SVG clips to its
 * viewport, and a stroke sitting flush on the edge would lose its outer half to the crop.
 *
 * Height is therefore no longer available to say "this one is taller", and the divider
 * carries that alone — the same drawing rotated: across for a double decker, because the
 * decks stack; down for a bendy, because the sections hinge. Read side by side that is one
 * idea told twice, which is why neither needs a legend. A single decker has neither deck
 * to stack nor section to hinge, so it is the same body with no divider at all, drawn
 * shorter than the bendy so length keeps separating the two.
 *
 * It used to be drawn as nothing, on the argument that absence means "ordinary bus". But
 * absence is also what a missing `Type` looks like, so the most common vehicle on the
 * network was saying exactly what no data says. An explicit `SD` now has a shape; a code
 * we were never sent still has none, which is the honest reading of a blank.
 *
 * Outlines at a hair under 2 units, not solid silhouettes, and no windows. A filled body
 * was tried and carried so much ink that it pulled the glance off the service number it
 * sits under, which is the one thing on the row that has to be read first; drawn open, the
 * mark stays a footnote to it. Window bands went with it — at this size they turned the
 * body into a stack of drawers, and once the divider is doing the work they were only ever
 * texture. The wheels are filled, small, and the only solid ink in any of the three — an
 * outlined circle at this size fills in and turns muddy, and they are what stop an empty
 * rounded box from reading as a container. Three of them is the bendy's other tell.
 *
 * The trailing strokes are the one piece of ink all three share, which is why they read as
 * a fact about the board rather than about the vehicle. `renderTags` is handed `buses[0]`
 * and nothing else, so the mark has always described the next arrival — but a silhouette
 * sitting still under a service number reads as "this route runs double deckers", a fleet
 * fact, when what is meant is "the one arriving in three minutes is a double decker".
 * Trails give the bus a direction and put it on its way here. They drift — see
 * `mark-drift` in the stylesheet — because at 11 px two motionless dashes are as easily
 * taken for scuffs on the drawing as for speed.
 *
 * Which is the whole argument for drawing them only when a bus actually is on its way:
 * `isIncoming` in origin.js. Every mark carrying trails made them a fact about the board's
 * existence rather than about any arrival on it — nine of them moving at once on one card,
 * saying the same nothing nine times. Inside three minutes they are the one thing on the row
 * that says "now", and outside it the mark is the plain silhouette it was always taken for.
 * So their absence is an answer too, and the drift is what a rider's eye is caught by on the
 * one row that has earned it.
 */
export const VEHICLE = {
  DD: {
    title: 'Double deck',
    label: 'Double deck bus',
    // Body 1.15–30.85 × 1.15–18.85 once the 1.7 stroke is counted, wheels down to 22.2,
    // trails back to -5.65. Every box shares that left edge; only the right one differs.
    box: '-5.85 0.95 36.9 21.45',
    trail: [6.5, 13.5],
    art:
      '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">' +
      '<rect x="2" y="2" width="28" height="16" rx="3.5"/><path d="M2 10h28"/></g>' +
      '<g fill="currentColor"><circle cx="9" cy="20.3" r="1.9"/>' +
      '<circle cx="23" cy="20.3" r="1.9"/></g>',
  },
  SD: {
    title: 'Single deck',
    label: 'Single deck bus',
    // The bendy's body with the hinge removed and nine units taken off the length, so at
    // one CSS height it comes out the shorter of the two rather than merely the plainer.
    box: '-5.85 5.45 28.4 16.85',
    trail: [9.5, 15],
    art:
      '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">' +
      '<rect x="1.5" y="6.5" width="20" height="11.5" rx="3"/></g>' +
      '<g fill="currentColor"><circle cx="6" cy="20.3" r="1.8"/>' +
      '<circle cx="17" cy="20.3" r="1.8"/></g>',
  },
  BD: {
    title: 'Bendy bus',
    label: 'Bendy bus',
    box: '-5.85 5.45 37.4 16.85',
    trail: [9.5, 15],
    art:
      '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">' +
      '<rect x="1.5" y="6.5" width="29" height="11.5" rx="3"/><path d="M15.5 6.5v11.5"/></g>' +
      '<g fill="currentColor"><circle cx="6.5" cy="20.3" r="1.8"/>' +
      '<circle cx="16" cy="20.3" r="1.8"/><circle cx="25.5" cy="20.3" r="1.8"/></g>',
  },
};

/**
 * The two strokes trailing a mark. Identical for all three vehicles but for the y pair,
 * which each one supplies from inside its own body so the trails sit in the band the bus
 * occupies rather than floating above or below it. Round caps, which is why the leftmost
 * ink lands at -5.65 and every box above crops to -5.85: the same 0.2 of padding the
 * bodies get, for the same reason.
 *
 * Emitted on every mark whether or not it is drawn; `is-incoming` on the parent `<svg>` is
 * what decides, in the stylesheet. Two hidden paths cost nothing, and the alternative would
 * put the rule in two places — this function and the hand-written sample mark in index.html,
 * which is static markup and can only opt in with a class.
 */
export function trail([upper, lower]) {
  return (
    '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
    `<path class="trail-a" d="M-4.8 ${upper}H-1.6"/>` +
    `<path class="trail-b" d="M-3.4 ${lower}H-1.6"/></g>`
  );
}

/**
 * The tag markup for one vehicle silhouette. Shared with the intro dialog's sample card.
 *
 * `incoming` only reaches the class list — the trail markup is the same either way, so no
 * geometry moves when a bus crosses the threshold and the boxes stay cropped as drawn. The
 * aria-label is deliberately left alone: the lead ETA sits inches away already reading "3
 * min", and a mark that also announced "arriving" would be the same fact read twice.
 */
export function vehicleIcon({ title, label, box, trail: pair, art }, incoming) {
  return (
    `<span class="tag-icon" title="${title}" aria-label="${label}">` +
    `<svg class="tag-svg${incoming ? ' is-incoming' : ''}" viewBox="${box}" fill="currentColor" aria-hidden="true" focusable="false">` +
    `${trail(pair)}${art}</svg></span>`
  );
}
