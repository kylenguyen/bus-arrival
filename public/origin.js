// Pure decision logic for the board — no framework, no build step, same as the
// rest of public/. Every export takes plain data and returns plain data.
//
// This module exists to be testable. `app.js` cannot be imported by a test: it
// reads `document` at module scope, installs two intervals and kicks off a
// location request on its last line. So the rules live here and `app.js` keeps
// only the side effects — elements, `fetch`, `localStorage`, event wiring — with
// each apply site a one- or two-line assignment. Do not inline this back into
// `app.js`; the tests in src/origin.test.ts are the reason for the split.
//
// Hard rules, inherited by everything added here later: no DOM, no `fetch`, no
// `localStorage`, and no reading the clock. Anything time-dependent takes `now`
// as a parameter and the caller supplies it — that is what lets the tests stay
// free of fake timers and sleeps (AGENTS.md).

/**
 * Whether a coordinate is one the board can rank from. A handful of real stops
 * carry `0,0`: `search()` keeps them findable while `nearby()` filters them out,
 * so a search result can be perfectly findable and still uncommittable as an
 * origin. A scraped address dump carries the same trap, which is why the name no
 * longer says "stop" — the guard is the same one either side. `lat: 0` with a
 * non-zero lon is a real place, so it tests the pair, not either half.
 *
 * @param {unknown} lat
 * @param {unknown} lon
 * @returns {boolean}
 */
export function isUsableCoord(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat !== 0 || lon !== 0;
}

/**
 * Distance on its own: metres below a kilometre, one decimal above. `''` for a
 * non-number so a stop the server sent no distance for renders an empty cell
 * rather than `NaN m`.
 *
 * @param {unknown} metres
 * @returns {string}
 */
export function formatMetres(metres) {
  if (typeof metres !== 'number') return '';
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

/**
 * Distance plus a walking time, as the cards have always shown it.
 *
 * @param {unknown} metres
 * @returns {string}
 */
export function formatDistance(metres) {
  if (typeof metres !== 'number') return '';
  // ~80 m/min, rough by design. The floor keeps a very short walk off "0 min
  // walk"; the stop you are actually standing at never reaches here, because
  // `distanceLabel` answers "Here" below AT_STOP_M first.
  const walk = Math.max(1, Math.round(metres / 80));
  return `${formatMetres(metres)} · ${walk} min walk`;
}

/**
 * Under this many metres, the user is at the stop rather than walking to it. It
 * is about the accuracy of a phone fix, so a walking time below it is invented
 * from noise — and "0 m · 1 min walk" contradicts itself on the card a commuter
 * standing at the stop looks at first.
 */
const AT_STOP_M = 30;

// --- origin state -------------------------------------------------------

/** How stale a fix may be before a tab focus is worth re-locating for. */
const FOCUS_FIX_MAX_AGE_MS = 5 * 60_000;

/**
 * The origin record as held in storage, or null if there is nothing usable
 * there. Takes the raw string (or null for "no key") and parses it inside a try,
 * mirroring `readLoc()` in app.js — corrupt state is indistinguishable from
 * absent state, which is what makes every half-finished first run degrade to a
 * first visit with no extra flags.
 *
 * A **normalising** read, not a validating one. Two things follow from that:
 *
 * - Every field of a `place` record is re-derived through `normalisePlace`, so a
 *   label written under an older `LABEL_MAX`, or hand-edited in DevTools, is
 *   re-capped and re-collapsed here rather than trusted. The property the old
 *   stop-code check bought — "safe to interpolate into the chip" — is now
 *   "**never a label longer than `LABEL_MAX`, and never one containing a
 *   newline**".
 * - A legacy `{mode:'stop', code, description, roadName, lat, lon}` record is
 *   **migrated in place** rather than rejected. The key is not versioned for it
 *   (`bus-board.origin.v1` stays), because the legacy record already carries a
 *   usable coordinate, which makes the migration lossless in the only dimension
 *   the board cares about. Dropping it instead would send every returning
 *   stop-mode user back to the intro dialog — the exact failure `decideBoot`'s
 *   grandfathering exists to prevent.
 *
 * The `0,0` rejection is load-bearing, not defensive noise: a handful of real
 * stops carry `0,0`, a scraped address dump carries the same trap, and an origin
 * there would rank the whole of Singapore ~1,300 km away.
 *
 * @param {string | null | undefined} raw
 * @returns {{mode: 'gps'} | Place | null}
 */
export function readOriginRecord(raw) {
  try {
    const record = JSON.parse(raw ?? 'null');
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.mode === 'gps') return record;
    if (record.mode === 'place') return normalisePlace(record);
    if (record.mode === 'stop') return normalisePlace(migrateStopRecord(record));
    return null;
  } catch {
    return null;
  }
}

/**
 * The legacy stop record, read as the place it always was: a fixed coordinate
 * with a name on it. `label` is the code because that is the short thing the
 * user chose it by, and `name` is the description and road they saw in the
 * search results.
 *
 * The 5-digit check survives the migration on purpose. It is no longer about
 * what the chip may interpolate — `normalisePlace` handles that now — but about
 * what `Stop {code}` may claim: a record whose code is four digits or a number
 * was never a stop this app wrote, and inventing a label from it would put a
 * plausible-looking lie in the masthead.
 *
 * @param {{code?: unknown, description?: unknown, roadName?: unknown,
 *   lat?: unknown, lon?: unknown, at?: unknown}} record
 * @returns {object | null}
 */
function migrateStopRecord(record) {
  if (typeof record.code !== 'string' || !/^\d{5}$/.test(record.code)) return null;
  const where = [collapseSpace(record.description), collapseSpace(record.roadName)]
    .filter(Boolean)
    .join(', ');
  return {
    mode: 'place',
    postal: null,
    code: record.code,
    label: `Stop ${record.code}`,
    name: where || `Stop ${record.code}`,
    lat: record.lat,
    lon: record.lon,
    at: record.at,
  };
}

/**
 * The last-fix guard, deliberately *not* the origin guard: it is exactly the
 * check `readLoc()` applies, so "does this user already hold a fix?" answers
 * identically to the existing key rather than to a stricter reading of it. No
 * `0,0` rejection here on purpose — a real fix at `0,0` would be absurd but it
 * is not this function's business to disagree with `LOC_KEY`.
 *
 * @param {string | null | undefined} raw
 */
function parseLastFix(raw) {
  try {
    const loc = JSON.parse(raw ?? 'null');
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
    return loc;
  } catch {
    return null;
  }
}

/**
 * The whole first-visit-versus-returning decision, grandfathering included.
 *
 * A usable origin record wins outright. Otherwise anyone who already holds a
 * fix or a pin is an existing user who must never be shown an introduction to a
 * site they have been using, so synthesise the gps record they would have had
 * and tell the caller to persist it (`persist: true`). Only a genuinely empty
 * profile gets the intro.
 *
 * A legacy `{mode:'stop'}` record therefore lands on `'place'` with
 * `persist: false`: `readOriginRecord` migrated it, so it is a usable record and
 * wins outright — it is not grandfathering, and it must never be mistaken for
 * it. Rewriting the migrated record back to storage is the caller's business.
 *
 * @param {{originRaw?: string | null, locRaw?: string | null, pinCount?: number,
 *   now: number}} input
 * @returns {{journey: 'intro' | 'gps' | 'place', origin: object | null, persist: boolean}}
 */
export function decideBoot({ originRaw, locRaw, pinCount, now }) {
  const origin = readOriginRecord(originRaw);
  if (origin) return { journey: origin.mode, origin, persist: false };

  if (parseLastFix(locRaw) || (pinCount ?? 0) > 0) {
    return { journey: 'gps', origin: { mode: 'gps', at: now }, persist: true };
  }

  return { journey: 'intro', origin: null, persist: false };
}

/**
 * The single mapping from origin state to a board coordinate. Place mode ignores
 * `lastLoc` entirely — that is the whole point of the mode, and it is why a
 * place-mode user never needs geolocation to have succeeded even once.
 *
 * @param {object | null} origin
 * @param {{lat: number, lon: number} | null} lastLoc
 * @returns {{lat: number, lon: number} | null}
 */
export function originCoord(origin, lastLoc) {
  if (!origin) return null;
  if (origin.mode === 'place') return { lat: origin.lat, lon: origin.lon };
  return lastLoc ?? null;
}

/**
 * The `/api/board` query string. One place decides which coordinate is sent, so
 * no call site can pick the wrong one.
 *
 * With no coordinate, `lat`/`lon` are omitted rather than sent empty: the server
 * reads them with `Number()`, and `lat=` would become `0` while `lat=null`
 * becomes `NaN` — only their absence reaches the `located: false` path.
 *
 * @param {{origin: object | null, lastLoc: object | null,
 *   pins?: Array<{code: string}>, limit: number}} input
 * @returns {string}
 */
export function boardParams({ origin, lastLoc, pins, limit }) {
  const params = new URLSearchParams({ limit: String(limit) });

  const coord = originCoord(origin, lastLoc);
  if (coord) {
    params.set('lat', String(coord.lat));
    params.set('lon', String(coord.lon));
  }

  const codes = (pins ?? []).map((pin) => pin.code);
  if (codes.length > 0) params.set('pinned', codes.join(','));

  return String(params);
}

/**
 * Whether returning to the tab should re-locate. True only for gps mode with no
 * fix or a stale one.
 *
 * False for place mode whatever the fix's age: a place-mode user usually has no
 * fix at all, so testing `lastLoc` alone — as the listener used to — fires an
 * unprompted geolocation request on every single tab focus. The `!== 'gps'`
 * guard covers a place origin unchanged; a chosen address no more re-locates
 * than a chosen stop did.
 *
 * @param {object | null} origin
 * @param {{at: number} | null} lastLoc
 * @param {number} now
 * @returns {boolean}
 */
export function shouldRelocateOnFocus(origin, lastLoc, now) {
  if (origin?.mode !== 'gps') return false;
  return !lastLoc || now - lastLoc.at > FOCUS_FIX_MAX_AGE_MS;
}

// --- copy ---------------------------------------------------------------

/**
 * The masthead tagline: where the board is ranked from, and where its timings come
 * from. Both clauses, always — which is the change.
 *
 * The two claims must not race: "demo data" contradicts "live from LTA". That used
 * to be a guard in `app.js`, which overwrote this sentence with the mock warning
 * and latched so it could never be overwritten back — so the demo notice
 * permanently destroyed the only line saying where the board was. Taking `mock` as
 * an input makes the contradiction impossible by construction instead: there is
 * one sentence, it is composed here, and no caller can produce half of it.
 *
 * `mock` is read for truthiness rather than compared to `true`. The lenient
 * reading is the safe one here — an omitted argument keeps the wording every
 * existing caller already gets, and the failure it risks is claiming demo data
 * when there is none, which is visible on the first load rather than a silent
 * false claim of live data.
 *
 * @param {object | null} origin
 * @param {unknown} [mock] whether the board's timings are synthetic
 * @returns {string}
 */
export function taglineFor(origin, mock) {
  // The long name, not the label: the tagline has a line to itself, so this is
  // one of the two places with room to say where the board actually is.
  const where =
    origin?.mode === 'place'
      ? `Stops near ${origin.name}`
      : origin?.mode === 'gps'
        ? 'Stops nearest you'
        : // No door taken yet — behind the intro, and on the dismissal gate. "Stops
          // nearest you" over a page with no board describes something that is not
          // on screen, in a mode nothing has been granted for: the same claim
          // `chipState` already refuses to make.
          'Any stop in Singapore';

  // The provenance, which is the one thing worth saying before a door is chosen
  // and is true either way. It stops naming LTA in mock mode because in mock mode
  // none of it came from LTA; the wording is what a rider needs to know about the
  // numbers, not what a deploy needs to know about its configuration.
  return mock ? `${where} · demo timings, not live` : `${where}, live from LTA`;
}

/**
 * What the gate says while the first board is on its way. Place mode names the
 * address, because "near you" would be a lie about where the board is ranked
 * from — and in place mode nothing has asked for the user's location at all.
 *
 * The **short** label, not the name: this sentence sits centred over skeleton
 * cards on a 360 px phone, where a full address wraps to three lines and pushes
 * the placeholders off the first screenful.
 *
 * @param {object | null} origin
 * @returns {string}
 */
export function gateMessageFor(origin) {
  if (origin?.mode === 'place') return `Finding stops near ${origin.label}…`;
  return 'Finding stops near you…';
}

/**
 * The gate when the board comes back empty. In gps mode that means nothing is
 * near the user; in place mode it means nothing is near the address they named,
 * and saying "near you" there would misdescribe a board they may be nowhere
 * near. Short label again, for the same reason as `gateMessageFor`.
 *
 * @param {object | null} origin
 * @returns {string}
 */
export function noStopsMessage(origin) {
  if (origin?.mode === 'place') return `No bus stops found near ${origin.label}.`;
  return 'No bus stops found near you.';
}

/**
 * The distance cell on a card: metres and a walking time, except on the card the
 * user is already standing at.
 *
 * `Here` is **gps-only**, and that asymmetry is the whole content of this
 * function. `AT_STOP_M` is a statement about the noise in a phone's fix — below
 * it, "0 m · 1 min walk" is a walking time invented from error bars. A geocoded
 * building has no such noise, so a place origin at 0 m means the stop really is
 * outside that door and the walk is a real, useful number.
 *
 * Place mode used to refuse `formatDistance` outright, back when the origin was
 * a stop code the user might have been nowhere near. A typed address is somewhere
 * they are at or going to, so the walk is the most decision-relevant number on
 * the card. The origin-stop marker went with that reasoning: it named nothing a
 * place origin can be, and there is no longer a code to match a card against.
 *
 * @param {{distanceM?: unknown} | null} stop
 * @param {object | null} origin
 * @returns {string}
 */
export function distanceLabel(stop, origin) {
  if (!origin) return '';
  if (origin.mode === 'gps' && typeof stop?.distanceM === 'number' && stop.distanceM < AT_STOP_M) {
    return 'Here';
  }
  return formatDistance(stop?.distanceM);
}

// --- the gate -----------------------------------------------------------

/**
 * What the gate says when a location request comes back without a position.
 *
 * Three outcomes, three sentences — a denial is permanent until the user changes
 * a browser setting, a failed fix might work on the next try, and a timeout has
 * already had one. Anything without a `code` (the `unsupported` reject from
 * `getPosition`, or a caller passing nothing at all) reads as the middle case:
 * we do not have a position and cannot say why.
 *
 * The denial sentence deliberately stops after the browser-settings advice. It
 * used to end "…, or search for a stop instead", which is now the label on the
 * button sitting directly underneath it — prose should carry only what a button
 * cannot.
 *
 * @param {{code?: number} | null | undefined} err
 * @returns {{message: string}}
 */
export function refusalCopy(err) {
  if (err?.code === 1) {
    return { message: 'Location is blocked for this site. Allow it in your browser settings.' };
  }
  if (err?.code === 3) return { message: "Still can't get a fix on your location." };
  return { message: "Couldn't get your location." };
}

/**
 * The gate's two buttons, resolved. All the show/hide logic lives here so the
 * apply site in `app.js` is six assignments with no branch left in it.
 *
 * An action is `{label, onClick}` or absent. A falsy label counts as absent: a
 * caller that computes a label and gets `''` means "no button", not "a button
 * with nothing written on it", and the second form is unclickable-looking but
 * still focusable — the worst of both.
 *
 * `onClick` is deliberately not returned. This module stays free of anything the
 * DOM has to touch, so `app.js` reads the handler off the action it passed in.
 *
 * @param {string} message
 * @param {{label?: string} | null} [primary]
 * @param {{label?: string} | null} [secondary]
 * @returns {{message: string, primary: {label: string, hidden: boolean},
 *   secondary: {label: string, hidden: boolean}}}
 */
export function gateState(message, primary, secondary) {
  return {
    message: message ?? '',
    primary: buttonState(primary),
    secondary: buttonState(secondary),
  };
}

/** @param {{label?: string} | null | undefined} action */
function buttonState(action) {
  const label = action?.label;
  return label ? { label, hidden: false } : { label: '', hidden: true };
}

// --- the intro ----------------------------------------------------------

/**
 * Which introduction the dialog renders.
 *
 * `insecure` outranks `unsupported` on purpose. Only one sentence may ever be
 * shown — two explanations of the same missing button is worse than one — and an
 * insecure context is the cause the user can actually do something about
 * (`localhost` or the https URL), whereas "your browser can't" is a dead end.
 * The order also makes the answer deterministic when both are true, which is the
 * common case: a browser that withholds `navigator.geolocation` outside a secure
 * context reports both at once.
 *
 * @param {{isSecureContext?: boolean, hasGeolocation?: boolean}} input
 * @returns {'full' | 'insecure' | 'unsupported'}
 */
export function introVariant({ isSecureContext, hasGeolocation }) {
  if (!isSecureContext) return 'insecure';
  if (!hasGeolocation) return 'unsupported';
  return 'full';
}

/**
 * The landing when the dialog closes with no door taken — Escape, or a tap on the
 * backdrop, which on a phone is most of the screen and so is usually an accident.
 *
 * It used to open the search panel, which left a page carrying a search box, no
 * board, no gate and nothing saying why: on a 375 px phone, three quarters of the
 * viewport was empty. This is the same shape as the refusal gate instead — one
 * sentence for why the page is empty, and the doors as buttons underneath it,
 * where prose does not have to describe what a button already says.
 *
 * The doors come back as names, not handlers: this module never touches the DOM,
 * so `app.js` maps them. `secondary` is `null` rather than an empty label because
 * the caller passes it straight to `gateState`, which already reads a falsy label
 * as "no button" — one absent-button convention, not two.
 *
 * @param {'full' | 'insecure' | 'unsupported'} variant from `introVariant`
 * @returns {{message: string, primary: {label: string, door: 'gps' | 'code'},
 *   secondary: {label: string, door: 'gps' | 'code'} | null}}
 */
export function dismissGate(variant) {
  if (variant === 'full') {
    return {
      message: 'Nothing to show yet — choose how to start.',
      primary: { label: 'Use my current location', door: 'gps' },
      secondary: { label: ADDRESS_DOOR_LABEL, door: 'code' },
    };
  }
  // The sentence explaining why location is impossible here was in the dialog,
  // which has just closed. Repeating it above the one remaining door would explain
  // a button that is not on screen; the door that does work is the whole answer,
  // and it moves into the primary slot rather than being left as a lone ghost.
  return {
    message: 'Nothing to show yet — enter an address to see arrivals.',
    primary: { label: ADDRESS_DOOR_LABEL, door: 'code' },
    secondary: null,
  };
}

/**
 * The second door's label, wherever it is offered: this gate, the wait hatch and
 * every refusal in `app.js`, and the intro dialog's static markup. Exported so
 * the three JS sites cannot drift apart from each other — the fourth is in
 * `index.html`, which nothing can import from, so it is written out there and
 * kept in step by hand.
 *
 * It no longer says "stop code" because the door no longer leads to one. The
 * postal code, the building and the road are all addresses; the 5-digit stop
 * code that still works behind it is an escape hatch, not the headline.
 */
export const ADDRESS_DOOR_LABEL = 'Enter an address';

// --- the chip and the finder --------------------------------------------

/** U+25BE BLACK DOWN-POINTING SMALL TRIANGLE — a character, not an icon font. */
const CARET = '▾';

/**
 * The masthead chip: what the board is ranked from, and the handle for changing
 * it.
 *
 * The visible label stays short and the long description goes in `ariaLabel`
 * only. That is a layout decision, not an oversight: the chip shares one flex row
 * with the `h1` inside roughly 333 px of usable width on a 360 px phone, and
 * `.ghost` is `white-space: nowrap`, so a label carrying "155 Lorong 1 Toa
 * Payoh, Singapore 310155" would push the row wider than the viewport rather
 * than wrapping. A screen reader has no such budget, so it gets the whole
 * sentence.
 *
 * The three defences on that budget are `label` capped at 18 in `placeFromRow`,
 * re-capped on every read by `readOriginRecord`, and an `text-overflow: ellipsis`
 * backstop on `#origin-chip` — so nothing that reaches here needs wrapping,
 * escaping or truncating again.
 *
 * @param {object | null} origin
 * @returns {{label: string, ariaLabel: string}}
 */
export function chipState(origin) {
  if (origin?.mode === 'place') {
    // The postal is the one thing a Singaporean can act on unambiguously, so it
    // is spoken in full; it is omitted rather than left as "Singapore null" for
    // a stop row or a road-only row, which have none.
    const where = [origin.name, origin.postal && `Singapore ${origin.postal}`]
      .filter(Boolean)
      .join(', ');
    return {
      label: `${origin.label} ${CARET}`,
      ariaLabel: `Change stops shown. Currently: stops near ${where}`,
    };
  }
  if (origin?.mode === 'gps') {
    return {
      label: `Near you ${CARET}`,
      ariaLabel: 'Change stops shown. Currently: stops near you',
    };
  }
  // No door chosen yet — during the intro, and after it is dismissed. Neutral on
  // purpose: "Near you" would claim a mode nothing has been granted for, and
  // interpolating an absent record would put "undefined" in the masthead.
  return { label: `Choose ${CARET}`, ariaLabel: 'Choose which stops to show' };
}

/** What to say when there is not enough typed to act on. */
const COMMIT_HINT = 'Enter a 6-digit postal code, or at least two letters.';

/**
 * The whole decision for what pressing Enter in the finder does. `app.js` reads
 * `action` and nothing else.
 *
 * **Commits by index, not by code.** An address has no client-known unique key —
 * two rows can share a road, a block and even a coordinate — so the answer is a
 * position in the row list. What makes that safe is an invariant on the caller:
 * `searchRows` and the `#results` markup are written in the same synchronous
 * block, so an index read off the DOM always addresses the array that produced
 * it. `rows` here is that same array.
 *
 * The order of the ladder is the whole content of this function:
 *
 * 1. `offline` waits, and says nothing. This absorbs the untested early return
 *    that used to guard this call in `app.js`: "empty because nothing matched"
 *    and "empty because we never got to ask" are different answers, and only the
 *    caller's status can tell them apart. Naming a postal code that was never
 *    searched for would blame the address for the network.
 * 2. A highlighted row outranks everything, digits included: a user who typed
 *    six digits *and* arrowed down to a row means the row.
 * 3. Six digits, with or without the `S` a Singaporean naturally types.
 * 4. Five digits — the stop-code escape hatch.
 * 5. Too little typed.
 * 6. Rows on screen and nothing to disambiguate them: wait. Committing the top
 *    row would guess between places the user can see and has not chosen.
 * 7. Nothing matched, in `finderState`'s exact words.
 *
 * A row that reaches here is already rankable — `finderState` drops the rest
 * before they are rendered — so this no longer re-checks coordinates the way the
 * stop-code version had to.
 *
 * @param {{value?: unknown, rows?: Array<{place?: Place | null}> | null,
 *   status?: 'idle' | 'searching' | 'ok' | 'offline', activeIndex?: unknown}} input
 * @returns {{action: 'choose', index: number} | {action: 'note', message: string} |
 *   {action: 'wait'}}
 */
export function commitDecision({ value, rows, status, activeIndex }) {
  // Trimmed, because a trailing space off a phone keyboard's autocomplete is not
  // the user changing their mind about which address they meant.
  const query = String(value ?? '').trim();
  // Deliberately *not* filtered: the returned index addresses the caller's own
  // array, so compacting it here would answer with a position that means
  // something different at the other end.
  const list = Array.isArray(rows) ? rows : [];

  if (status === 'offline') return { action: 'wait' };

  const active = Number.isFinite(activeIndex) ? Math.trunc(activeIndex) : -1;
  if (active >= 0 && active < list.length && list[active]?.place) {
    return { action: 'choose', index: active };
  }

  const postal = /^s?\s*(\d{6})$/i.exec(query)?.[1];
  if (postal) {
    const at = list.findIndex((row) => row?.place?.postal === postal);
    if (at >= 0) return { action: 'choose', index: at };
    return { action: 'note', message: `No address at ${postal}.` };
  }

  if (/^\d{5}$/.test(query)) {
    const at = list.findIndex((row) => row?.place?.code === query);
    if (at >= 0) return { action: 'choose', index: at };
    return { action: 'note', message: `No stop with code ${query}.` };
  }

  // Below two characters `runSearch` asks for nothing (`/api/places` answers
  // 400), so there is no list to have matched against and nothing to report but
  // how much is needed.
  if (query.length < 2) return { action: 'note', message: COMMIT_HINT };

  if (list.some((row) => row?.place)) return { action: 'wait' };

  // Same sentence `finderState` already wrote under the box; Enter should not
  // rephrase a fact the user is already looking at.
  return { action: 'note', message: NO_MATCH_NOTE };
}

// --- places -------------------------------------------------------------
//
// Everything below is the pure half of the postal-code finder
// (docs/postal-code-finder.md, D5 and D6). `Place` is *the* origin record —
// `readOriginRecord` above returns one, and migrates the legacy stop record into
// one — and `finderState` decides the whole panel, which `app.js` applies in a
// single run of assignments.

/**
 * What the board is ranked from, once an address has been chosen.
 *
 * Two names, not one, and the split is the whole point: `label` is for anywhere
 * something shares a line or a glance (the chip, the gate), `name` is for
 * anywhere there is a line to spare (the tagline, an aria-label). Compose
 * `name` + `postal` at the render site rather than storing a third string.
 *
 * `postal` is a **string or null**, never a number — `Number('018956')` loses the
 * leading zero, and the leading zero is most of Singapore's city centre.
 *
 * @typedef {{mode: 'place', postal: string | null, code: string | null,
 *   label: string, name: string, lat: number, lon: number, at?: number}} Place
 */

/**
 * The chip's budget, and the reason `label` exists at all. At 360 px the masthead
 * row has ~333 px, the `h1` takes ~110 px and the chip's own padding ~31 px,
 * which leaves roughly 24 characters for label plus caret. 18 keeps a margin for
 * a wider font and for the caret itself.
 */
const LABEL_MAX = 18;

/** The tagline and the aria-label each have a line to themselves, so: more. */
const NAME_MAX = 40;

/** How many addresses the Recent list keeps. Five fits above the fold at 375 px. */
const RECENT_MAX = 5;

/**
 * Whitespace runs collapsed to one space and trimmed; `''` for anything that is
 * not a string. The address data is a scrape, so a stray newline or tab inside a
 * building name is a real possibility, and the chip is one `white-space: nowrap`
 * flex row that a newline would silently break.
 *
 * @param {unknown} value
 * @returns {string}
 */
function collapseSpace(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Truncated with an ellipsis, counting the ellipsis *inside* the budget — a cap
 * that overflows by one character is not a cap, and the layout sums that were
 * used to pick `LABEL_MAX` assumed the returned length.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function cap(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Words that are said as letters, not read as words, and so keep their capitals.
 * Alphabetised; add to it in order.
 *
 * **An allowlist is the whole rule — there is no heuristic behind it.** The
 * obvious one, "short and no vowels", is wrong on the data: `ST`, `BLK`, `JLN`,
 * `RD`, `DR`, `PL`, `CL`, `TG` and `KG` all qualify and all are ordinary
 * abbreviations a rider reads as words, so it would render `ST. GEORGE'S ROAD` as
 * `ST. George's Road` and `BLK 155` as `BLK 155`. The list is bounded, which the
 * plan for this function called its cost; the heuristic is unbounded in the
 * damage it does, which is worse.
 */
const ACRONYMS = new Set([
  'CPF',
  'DBS',
  'HDB',
  'ITE',
  'JTC',
  'LRT',
  'MRT',
  'MSCP',
  'NTU',
  'NTUC',
  'NUS',
  'OCBC',
  'POSB',
  'PSA',
  'SBS',
  'SIT',
  'SMRT',
  'SMU',
  'SUTD',
  'UOB',
  'URA',
]);

/**
 * ALL CAPS from the dump into something a card can show.
 *
 * The casing conversion lives here, pure and tested, which is exactly why the
 * server ships uppercase: normalising 121k records on disk would cost megabytes
 * to save a client-side `replace`.
 *
 * Run by run, where a run is letters, digits and apostrophes — **not** word by
 * word.** The difference is `HDB-WOODLANDS`, which is one space-delimited word and
 * two names: splitting on spaces alone rendered it `Hdb-Woodlands`, because
 * `HDBWOODLANDS` matches nothing. It is all over the real index, and it is the case
 * a fixture of tidy building names does not contain.
 *
 * The apostrophe is inside the run on purpose. Excluded, `GEORGE'S` becomes two
 * runs and the second capitalises to `George'S` — the exact defect the previous
 * implementation's `[^a-z']` class existed to avoid.
 *
 * A matching run is upper-cased rather than returned untouched, so a lower-case
 * `hdb` from a future data source comes out as `HDB`. Membership is tested on the
 * letters and digits alone, so punctuation cannot hide a match — and `ST.` still
 * fails it, because `ST` is not on the list.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function titleCase(value) {
  return collapseSpace(value).replace(/[a-z0-9']+/gi, (run) => {
    if (ACRONYMS.has(run.replace(/[^a-z0-9]/gi, '').toUpperCase())) return run.toUpperCase();
    return run.charAt(0).toUpperCase() + run.slice(1).toLowerCase();
  });
}

/**
 * The **single** mapping from a server row to an origin record. Every commit path
 * goes through it, so the label rules cannot drift between the tap path, the
 * Enter path and the Recent list.
 *
 * `null` for a row the board could not be ranked from — no usable coordinate — and
 * for a row with nothing to call it, because a chip reading `▾` on its own is
 * worse than a row that was never offered. Filtering here rather than refusing on
 * tap is what lets `finderState` drop the row before it is rendered.
 *
 * `postal` and `code` are mutually exclusive and either may be null: a row is
 * either an address or the 5-digit stop-code escape hatch. Both are type-checked
 * rather than trusted, and a malformed one is nulled rather than taken as a reason
 * to drop an otherwise usable row.
 *
 * @param {{postal?: unknown, code?: unknown, building?: unknown, block?: unknown,
 *   road?: unknown, lat?: unknown, lon?: unknown} | null | undefined} row
 * @returns {Place | null}
 */
export function placeFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (!isUsableCoord(row.lat, row.lon)) return null;

  const building = titleCase(row.building);
  const block = collapseSpace(row.block);
  const road = titleCase(row.road);
  const postal = typeof row.postal === 'string' && /^\d{6}$/.test(row.postal) ? row.postal : null;
  const code = typeof row.code === 'string' && /^\d{5}$/.test(row.code) ? row.code : null;

  // Shortest first: a building name is what someone would say out loud, and the
  // postal code is the last resort because it is the thing they had to look up.
  const label =
    building ||
    (block && `Blk ${block}`) ||
    road ||
    (code && `Stop ${code}`) ||
    (postal && `S${postal}`) ||
    '';
  if (!label) return null;

  const street = [block, road].filter(Boolean).join(' ');
  const name = [building, street].filter(Boolean).join(', ');

  return {
    mode: 'place',
    postal,
    code,
    // A stop row and a bare postal row have no street to describe, so `name`
    // falls back to the label rather than to an empty tagline.
    label: cap(label, LABEL_MAX),
    name: cap(name || label, NAME_MAX),
    lat: row.lat,
    lon: row.lon,
  };
}

/**
 * A stored `Place` read back, or null. Every field is re-derived rather than
 * trusted: the record is JSON a user could hand-edit in DevTools, and it may also
 * predate a change to `LABEL_MAX`, so the caps are re-applied on every read
 * instead of only on write.
 *
 * The single exit for both stored shapes — `readOriginRecord` sends `place`
 * records and migrated `stop` records through it, and `readRecents` sends every
 * entry of the Recent list — which is what makes "a label is never longer than
 * `LABEL_MAX` and never contains a newline" a property of the whole module
 * rather than of one code path.
 *
 * @param {unknown} record
 * @returns {Place | null}
 */
function normalisePlace(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.mode !== 'place') return null;
  if (!isUsableCoord(record.lat, record.lon)) return null;

  const label = collapseSpace(record.label);
  if (!label) return null;
  const name = collapseSpace(record.name);

  /** @type {Place} */
  const place = {
    mode: 'place',
    postal: typeof record.postal === 'string' && /^\d{6}$/.test(record.postal) ? record.postal : null,
    code: typeof record.code === 'string' && /^\d{5}$/.test(record.code) ? record.code : null,
    label: cap(label, LABEL_MAX),
    name: cap(name || label, NAME_MAX),
    lat: record.lat,
    lon: record.lon,
  };
  if (Number.isFinite(record.at)) place.at = record.at;
  return place;
}

/**
 * The Recent list as held in storage. Corrupt state reads as an empty list, the
 * same bargain `readOriginRecord` and `readLoc` already make — a broken key must
 * cost a convenience, never the app.
 *
 * A single unrankable entry drops itself rather than the whole list: the other
 * four addresses are still one tap away, and there is nothing the user could do
 * about the bad one anyway.
 *
 * @param {string | null | undefined} raw
 * @returns {Place[]}
 */
export function readRecents(raw) {
  try {
    const parsed = JSON.parse(raw ?? 'null');
    if (!Array.isArray(parsed)) return [];
    const places = [];
    for (const entry of parsed) {
      const place = normalisePlace(entry);
      if (place) places.push(place);
    }
    return places.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/**
 * The Recent list with `place` moved to the front.
 *
 * Always a new array — the caller holds the old one in a module variable and
 * writes the returned one to storage, so mutating in place would leave the two
 * indistinguishable and make a failed write invisible.
 *
 * No clock and no `at`: order *is* the recency, so a timestamp would be a second
 * copy of the same fact and would drag `Date.now` into a module that must not
 * read it.
 *
 * @param {Place[] | null | undefined} list
 * @param {Place | null | undefined} place
 * @returns {Place[]}
 */
export function rememberRecent(list, place) {
  const current = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!place) return current.slice(0, RECENT_MAX);

  const key = recentKey(place);
  const rest = current.filter((entry) => recentKey(entry) !== key);
  return [place, ...rest].slice(0, RECENT_MAX);
}

/**
 * What counts as the same address, for `rememberRecent` and for `originsState`
 * alike. Postal when there is one — two rows sharing a postal code are the same
 * building — then the stop code, and the coordinate otherwise, which is the only
 * identity a road-only row has. Each prefixed so a postal can never collide with
 * a code or with a coordinate string.
 *
 * **One function, deliberately.** Two identity rules would let the Recent list
 * keep two entries that the destinations list collapses into one, and the row a
 * user tapped would then be a different address from the one stored under that
 * position.
 *
 * The `code` rung is why a hand-edited record cannot show the same stop twice
 * under two coordinates; before it, identity for a stop row was its coordinate,
 * which is the one field a stop row shares with the road it sits on.
 *
 * @param {Place} place
 * @returns {string}
 */
function recentKey(place) {
  if (place.postal) return `p:${place.postal}`;
  if (place.code) return `s:${place.code}`;
  return `c:${place.lat},${place.lon}`;
}

// --- the finder panel ---------------------------------------------------

/**
 * How long the box waits after a keystroke before asking the server. A
 * *duration* is not a clock read — nothing here observes the time, it only says
 * how much of it to wait — so this sits with the rules it belongs to rather than
 * in the glue.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/** What the panel says when there is one character in the box. */
const SHORT_NOTE = 'Keep typing — 2 letters, or a 6-digit postal code.';

/**
 * The no-match sentence. A constant because `commitDecision` must return the
 * exact same bytes: pressing Enter should never rephrase a fact the user is
 * already reading under the box.
 */
const NO_MATCH_NOTE = 'No address matched.';

/** Shown when the search request itself failed — the board and the pins are fine. */
const OFFLINE_NOTE = 'Search is unavailable right now.';

/**
 * Where the arrow keys move the highlight.
 *
 * `-1` is "nothing highlighted", which is a doorway rather than a ring position:
 * down from it lands on the first row, up from it on the last. Within the list it
 * wraps both ends, because a list this short has no bottom worth stopping at.
 *
 * An out-of-range start is treated as `-1` rather than clamped to the nearest
 * row: a stale index left over from a longer list means the user's highlight is
 * already gone, and moving to whatever now sits at that position would commit
 * them to a row they never looked at.
 *
 * @param {unknown} index
 * @param {unknown} delta
 * @param {unknown} count
 * @returns {number}
 */
export function moveActive(index, delta, count) {
  const total = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (total === 0) return -1;

  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const start = Number.isFinite(index) ? Math.trunc(index) : -1;
  if (start < 0 || start >= total) return step < 0 ? total - 1 : 0;

  return (((start + step) % total) + total) % total;
}

/** The heading over the destinations list. */
const ORIGINS_HEADING = 'Show stops near';

/**
 * What the gps row says about itself when the board is *not* already ranked from
 * it. Once it is, the row has nothing left to explain and says `CURRENT_STATUS`
 * instead — a control that describes what it would do, while also being the thing
 * already done, is the confusion this list exists to remove.
 */
const GPS_DETAIL = 'Uses your device location';

/** What marks the row the board is ranked from, wherever that row appears. */
const CURRENT_STATUS = 'Showing now';

/**
 * The destinations list: everywhere the board could be ranked from, and which one
 * it already is.
 *
 * This replaces a pair of `.ghost` buttons in which state and action were the same
 * control — a ✓ generated from `aria-pressed` on a button that still fired
 * geolocation, so the common state read as "already done, nothing to do". Here the
 * two are separate objects: `current` marks the row the board is using, and
 * `showUpdate` asks for the one affordance that re-runs a location fix.
 *
 * `showUpdate` is true **only** on a gps row that is already current. In place
 * mode the gps row itself is the action, so a second control beside it would be
 * two buttons for one job.
 *
 * An unsupported `geolocationSupported` **omits the row** rather than disabling
 * it, which is the rule `app.js` already applied by removing the DOM node: a
 * control that cannot work is worse than no control, because it still looks like
 * the way in. Only a literal `true` counts — a caller that forgets the flag loses
 * the primary door, which is loud in one manual pass, where the lenient reading
 * would silently ship a dead button to exactly the devices that cannot use it.
 *
 * The current place origin is hoisted to the front of the place rows whether or
 * not `recents` holds it. In practice `rememberPlace` has already put it first;
 * hoisting rather than trusting that is what keeps the list from ever failing to
 * contain the address the board is actually showing.
 *
 * Rows mirror `renderRows`' two lines — the long `name` leads, the postal code
 * goes underneath — so the destinations and the search results read as one list
 * split by a rule, not as two different widgets.
 *
 * @param {{origin?: object | null, recents?: Place[] | null,
 *   geolocationSupported?: unknown}} input
 * @returns {{heading: string, rows: Array<{kind: 'gps' | 'place', place: Place | null,
 *   primary: string, detail: string, status: string, current: boolean,
 *   showUpdate: boolean}>}}
 */
export function originsState({ origin, recents, geolocationSupported }) {
  const onGps = origin?.mode === 'gps';
  /** @type {Array<{kind: 'gps' | 'place', place: Place | null, primary: string,
   *   detail: string, status: string, current: boolean, showUpdate: boolean}>} */
  const rows = [];

  if (geolocationSupported === true) {
    rows.push({
      kind: 'gps',
      place: null,
      primary: 'Near you',
      detail: onGps ? '' : GPS_DETAIL,
      status: onGps ? CURRENT_STATUS : '',
      current: onGps,
      showUpdate: onGps,
    });
  }

  // A stored place with an unusable coordinate is dropped even when it is the
  // current origin: the board cannot be ranked from it either, so offering it as
  // the row that is "showing now" would name a state that does not exist.
  const currentPlace =
    origin?.mode === 'place' && isUsableCoord(origin.lat, origin.lon) ? origin : null;
  const currentKey = currentPlace ? recentKey(currentPlace) : null;

  const places = currentPlace ? [currentPlace] : [];
  for (const place of Array.isArray(recents) ? recents : []) {
    if (!place || !isUsableCoord(place.lat, place.lon)) continue;
    if (currentKey !== null && recentKey(place) === currentKey) continue;
    places.push(place);
  }

  for (const place of places.slice(0, RECENT_MAX)) {
    const isCurrent = place === currentPlace;
    rows.push({
      kind: 'place',
      place,
      primary: place.name,
      detail: place.postal ? `Singapore ${place.postal}` : place.code ? `Stop ${place.code}` : '',
      status: isCurrent ? CURRENT_STATUS : '',
      current: isCurrent,
      showUpdate: false,
    });
  }

  return { heading: ORIGINS_HEADING, rows };
}

/**
 * The whole finder panel, decided in one place: six states, and every attribute
 * the apply site sets, so `app.js` is a run of one-line assignments with no
 * branch left in it.
 *
 * Rows arrive already converted — each carries a ready `Place` — so committing is
 * `choosePlace(rows[i].place)` with no second lookup and no branch on where the
 * row came from. Anything without a rankable `Place` is dropped here rather than
 * refused on tap: a row that cannot become an origin should never have been on
 * screen.
 *
 * **Search results and nothing else.** This used to fill `idle`, `short` and
 * `offline` with the Recent list, which is why `#results` carried the wrong
 * accessible name in those three states. Recent now lives above the box in
 * `originsState`, permanently rather than only when there is nothing to show, so
 * the addresses used most are one tap away in *every* state — including the
 * offline one this function used to special-case for exactly that reason.
 *
 * One behaviour worth naming: during `searching` the previous rows stay put, so
 * the list does not empty and refill on every keystroke.
 *
 * `query` comes back normalised, including the `S310155` → `310155` strip, so the
 * caller sends the digits the server can resolve rather than the prefix a
 * Singaporean naturally types.
 *
 * @param {{value?: unknown, results?: Array<{place?: Place | null}> | null,
 *   status?: 'idle' | 'searching' | 'ok' | 'offline'}} input
 * @returns {{state: 'idle' | 'short' | 'searching' | 'results' | 'empty' | 'offline',
 *   query: string, shouldSearch: boolean, rows: Array<{place: Place}>,
 *   heading: string, note: string, busy: boolean, expanded: boolean,
 *   showClear: boolean}}
 */
export function finderState({ value, results, status }) {
  const typed = collapseSpace(value);
  // The strip happens here rather than at commit time, or the server never sees
  // the digits at all — it is the request that has to carry them.
  const postalMatch = /^s\s*(\d{6})$/i.exec(typed);
  const query = postalMatch ? postalMatch[1] : typed;

  const resultRows = (Array.isArray(results) ? results : []).filter(
    (row) => row?.place && isUsableCoord(row.place.lat, row.place.lon),
  );

  const base = { query, shouldSearch: query.length >= 2, showClear: typed.length > 0 };

  // No rows in these three: an empty box has nothing to have matched, and a
  // failed request has nothing to report but that it failed. `panel` derives the
  // empty heading and the collapsed `expanded` from the empty row list, so the
  // listbox cannot claim to hold options it does not have.
  if (query.length === 0) return panel(base, 'idle', [], '', '');
  if (query.length < 2) return panel(base, 'short', [], '', SHORT_NOTE);

  if (status === 'offline') return panel(base, 'offline', [], '', OFFLINE_NOTE);
  if (status === 'ok') {
    return resultRows.length > 0
      ? panel(base, 'results', resultRows, '', '')
      : panel(base, 'empty', [], '', NO_MATCH_NOTE);
  }
  // Anything else — `idle` between the keystroke and the debounce firing, or
  // `searching` once the request is out — is a wait, and a wait keeps what is
  // already on screen.
  return panel(base, 'searching', resultRows, '', '', true);
}

/**
 * The return shape assembled once, so no state can forget a field and hand
 * `app.js` an `undefined` to assign to an ARIA attribute.
 *
 * @param {{query: string, shouldSearch: boolean, showClear: boolean}} base
 * @param {string} state
 * @param {Array<{place: Place}>} rows
 * @param {string} heading
 * @param {string} note
 * @param {boolean} [busy]
 */
function panel(base, state, rows, heading, note, busy) {
  return {
    ...base,
    state,
    rows,
    // An empty list gets no heading, whatever the caller passed: a heading over
    // nothing describes a list that is not there.
    heading: rows.length > 0 ? heading : '',
    note,
    busy: busy === true,
    expanded: rows.length > 0,
  };
}
