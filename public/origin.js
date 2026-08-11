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
 * Whether a stop's coordinate is one the board can rank from. A handful of real
 * stops carry `0,0`: `search()` keeps them findable while `nearby()` filters
 * them out, so a search result can be perfectly findable and still uncommittable
 * as an origin. `lat: 0` with a non-zero lon is a real place, so the guard tests
 * the pair, not either half.
 *
 * @param {unknown} lat
 * @param {unknown} lon
 * @returns {boolean}
 */
export function isUsableStopCoord(lat, lon) {
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
  // ~80 m/min, rough by design. The floor is deliberate: the stop you are
  // standing at reads "1 min walk" rather than "0 min walk".
  const walk = Math.max(1, Math.round(metres / 80));
  return `${formatMetres(metres)} · ${walk} min walk`;
}

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
 * The `0,0` rejection is load-bearing, not defensive noise: a handful of real
 * stops carry `0,0`, `search()` keeps them findable, and an origin there would
 * rank the whole of Singapore ~1,300 km away.
 *
 * @param {string | null | undefined} raw
 * @returns {{mode: 'gps'} | {mode: 'stop', code: string, lat: number, lon: number} | null}
 */
export function readOriginRecord(raw) {
  try {
    const record = JSON.parse(raw ?? 'null');
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.mode === 'gps') return record;
    if (record.mode !== 'stop') return null;
    // A string, not just something that stringifies to five digits: the code is
    // written to the chip and read back out of storage, so keep the type tight.
    if (typeof record.code !== 'string' || !/^\d{5}$/.test(record.code)) return null;
    if (!isUsableStopCoord(record.lat, record.lon)) return null;
    return record;
  } catch {
    return null;
  }
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
 * @param {{originRaw?: string | null, locRaw?: string | null, pinCount?: number,
 *   now: number}} input
 * @returns {{journey: 'intro' | 'gps' | 'stop', origin: object | null, persist: boolean}}
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
 * The single mapping from origin state to a board coordinate. Stop mode ignores
 * `lastLoc` entirely — that is the whole point of the mode, and it is why a
 * stop-mode user never needs geolocation to have succeeded even once.
 *
 * @param {object | null} origin
 * @param {{lat: number, lon: number} | null} lastLoc
 * @returns {{lat: number, lon: number} | null}
 */
export function originCoord(origin, lastLoc) {
  if (!origin) return null;
  if (origin.mode === 'stop') return { lat: origin.lat, lon: origin.lon };
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
 * False for stop mode whatever the fix's age: a stop-mode user usually has no
 * fix at all, so testing `lastLoc` alone — as the listener used to — fires an
 * unprompted geolocation request on every single tab focus.
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
 * The masthead tagline. Never returns the mock-mode warning: that claim ("demo
 * data") contradicts this one ("live from LTA"), and the two must not race. The
 * guard lives in `app.js`, which knows whether mock mode is on, and this function
 * stays a pure function of the origin so the guard cannot be forgotten quietly.
 *
 * @param {object | null} origin
 * @returns {string}
 */
export function taglineFor(origin) {
  if (origin?.mode === 'stop') return `Stops near ${origin.code}, live from LTA`;
  return 'Stops nearest you, live from LTA';
}

/**
 * What the gate says while the first board is on its way. Stop mode names the
 * code, because "near you" would be a lie about where the board is ranked from —
 * and in stop mode nothing has asked for the user's location at all.
 *
 * @param {object | null} origin
 * @returns {string}
 */
export function gateMessageFor(origin) {
  if (origin?.mode === 'stop') return `Finding stops near ${origin.code}…`;
  return 'Finding stops near you…';
}

/**
 * The gate when the board comes back empty. In gps mode that means nothing is
 * near the user; in stop mode it means nothing is near the stop they named, and
 * saying "near you" there would misdescribe a board they may be nowhere near.
 *
 * @param {object | null} origin
 * @returns {string}
 */
export function noStopsMessage(origin) {
  if (origin?.mode === 'stop') return `No bus stops found near ${origin.code}.`;
  return 'No bus stops found near you.';
}

/**
 * Whether the board should carry the delisted-stop note.
 *
 * "The origin code is absent from the board" is *not* sufficient, and this is the
 * subtle one. Pinned stops are pushed first and the board is truncated to 8
 * before the arrivals fan-out (src/index.ts), so a user holding 8 pins gets zero
 * nearby slots and the origin stop is missing for a reason that has nothing to do
 * with LTA delisting it. `nearby()` always sorts the origin stop first at
 * `distanceM: 0` (pinned by src/stops.test.ts), so if any non-pinned stop made it
 * onto the board and the origin did not, the stop list genuinely no longer has
 * it.
 *
 * @param {object | null} origin
 * @param {Array<{code?: string, pinned?: boolean}>} stops
 * @returns {boolean}
 */
export function shouldShowDelistedNote(origin, stops) {
  if (origin?.mode !== 'stop') return false;
  const board = Array.isArray(stops) ? stops : [];
  if (board.some((stop) => stop?.code === origin.code)) return false;
  return board.some((stop) => !stop?.pinned);
}

/**
 * The note itself. Empty for anything but a stop origin, so a caller that
 * forgets `shouldShowDelistedNote` renders nothing rather than "Stop undefined".
 *
 * @param {object | null} origin
 * @returns {string}
 */
export function delistedNote(origin) {
  if (origin?.mode !== 'stop') return '';
  return `Stop ${origin.code} is no longer in service. Showing stops near it.`;
}

/**
 * The distance cell on a card, which means something different in each mode.
 *
 * In gps mode it is the walk from where the user is standing, as it has always
 * been. In stop mode the board is ranked from a stop that may be nowhere near
 * them, so a walking time would be a claim about their legs that nothing
 * supports — metres from the named stop is the honest reading. The origin's own
 * card is matched **by code, not by distance**: a co-located stop can also be
 * `0 m` away and is still a different stop.
 *
 * Kept separate from `formatDistance` rather than added as a second parameter:
 * `(This stop)` is not a distance format, `renderShells` still has exactly one
 * call site, and `formatMetres`/`formatDistance` stay single-argument.
 *
 * @param {{code?: string, distanceM?: unknown} | null} stop
 * @param {object | null} origin
 * @returns {string}
 */
export function distanceLabel(stop, origin) {
  if (!origin) return '';
  if (origin.mode === 'stop') {
    if (stop?.code === origin.code) return '(This stop)';
    return formatMetres(stop?.distanceM);
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
 * `.ghost` is `white-space: nowrap`, so a label carrying "Blk 155, Lor 1 Toa
 * Payoh" would push the row wider than the viewport rather than wrapping. A
 * screen reader has no such budget, so it gets the whole sentence.
 *
 * Only the code reaches the label, and `readOriginRecord` guarantees five digits,
 * so there is nothing in it to wrap, escape or truncate.
 *
 * @param {object | null} origin
 * @returns {{label: string, ariaLabel: string}}
 */
export function chipState(origin) {
  if (origin?.mode === 'stop') {
    const where = [origin.description, origin.roadName].filter(Boolean).join(', ');
    return {
      label: `Stop ${origin.code} ${CARET}`,
      ariaLabel: `Change stops shown. Currently: stops near ${origin.code}${
        where ? ` — ${where}` : ''
      }`,
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
const COMMIT_HINT = 'Enter a 5-digit stop code, or at least two letters of a stop name.';

/**
 * The whole decision for what pressing Enter in the finder does. `app.js` reads
 * `action` and nothing else.
 *
 * A five-digit query is an unambiguous instruction, so it commits without a tap —
 * but only against a result that is actually there and actually rankable. A name
 * query never commits: the top hit is a guess, and the list is right there to tap.
 *
 * The `0,0` case is why this cannot just test the digits. `search()` deliberately
 * keeps those stops findable while `nearby()` drops them, so "43179 matched" and
 * "43179 can be ranked from" are different questions. The refusal reuses the
 * "no such stop" sentence rather than inventing a second one for a distinction the
 * user has no way to see — the same wording, for the same reason, as the tap path
 * in `chooseStop()`.
 *
 * @param {unknown} value the raw input value
 * @param {Array<{code?: string, lat?: unknown, lon?: unknown}>} results
 * @returns {{action: 'choose', code: string} | {action: 'note', message: string} |
 *   {action: 'wait'}}
 */
export function commitDecision(value, results) {
  // Trimmed, because a trailing space off a phone keyboard's autocomplete is not
  // the user changing their mind about which stop they meant.
  const query = String(value ?? '').trim();
  const list = Array.isArray(results) ? results : [];

  if (/^\d{5}$/.test(query)) {
    const match = list.find((stop) => stop?.code === query);
    if (match && isUsableStopCoord(match.lat, match.lon)) return { action: 'choose', code: query };
    return { action: 'note', message: `No stop with code ${query}.` };
  }

  // Below two characters `runSearch` asks for nothing (`/api/stops` answers 400),
  // so there is no list to have matched against and nothing to report but how much
  // is needed.
  if (query.length < 2) return { action: 'note', message: COMMIT_HINT };

  // A name with hits: leave it. Committing the first row would silently pick one
  // of several stops the user can see and has not chosen between.
  if (list.length > 0) return { action: 'wait' };

  // Same sentence `runSearch` already wrote under the box; Enter should not
  // rephrase a fact the user is already looking at.
  return { action: 'note', message: 'No stops matched.' };
}
