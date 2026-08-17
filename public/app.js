// Bus arrival board — no framework, no build step.
//
// A first visit opens a dialog with two doors: use my current location, or enter
// an address. Nothing loads and no request fires until one is chosen, because
// the site cannot explain itself from behind a native permission prompt. Both
// doors reduce to a coordinate, and `/api/board` does not care which one it came
// from — place mode is "rank stops around a fixed place", not a second rendering
// path. A returning visit skips the dialog entirely and paints the board from
// whichever door was used last. Search and pinning stay out of the way until
// asked for.
//
// Five localStorage keys, all client-side; the server is told a coordinate to
// rank stops by and remembers nothing:
//   bus-board.pins.v1    stops kept at the top of the board
//   bus-board.loc.v1     the last GPS fix and its age — the sole owner of both
//   bus-board.origin.v1  which door: {mode:'gps'} or a {mode:'place', …} record
//   bus-board.recent.v1  the last five addresses committed, most recent first
//   bus-board.hint.v1    how many times the navigation tip has been shown
//
// The decisions live in ./origin.js (pure, unit tested); this file is the glue —
// elements, `fetch`, `localStorage`, event wiring, and one assignment per apply
// site. Keep new rules on that side of the line.

import {
  ADDRESS_DOOR_LABEL,
  boardParams,
  chipState,
  commitDecision,
  decideBoot,
  dismissedHintRecord,
  dismissGate,
  distanceLabel,
  finderState,
  gateMessageFor,
  gateState,
  HINT_COPY,
  HINT_DISMISS_LABEL,
  hintDecision,
  introVariant,
  isIncoming,
  minutesUntil,
  moveActive,
  noStopsMessage,
  originCoord,
  originsState,
  placeFromRow,
  readOriginRecord,
  readRecents,
  refusalCopy,
  rememberRecent,
  SEARCH_DEBOUNCE_MS,
  shouldRelocateOnFocus,
  taglineFor,
} from './origin.js';
import { VEHICLE, vehicleIcon } from './vehicle-marks.js';

const PINS_KEY = 'bus-board.pins.v1';
const LOC_KEY = 'bus-board.loc.v1';
// Which door the board is ranked from: {mode:'gps'}, or a {mode:'place', …}
// record carrying its own coordinate. The key is deliberately *not* versioned
// past v1 — `readOriginRecord` migrates the legacy {mode:'stop', …} record it
// used to hold, because bumping the key would send every returning user of that
// door back to the intro dialog.
// LOC_KEY stays the sole owner of the fix and its age, so the gps record carries
// no coordinate — it is one bit.
const ORIGIN_KEY = 'bus-board.origin.v1';
/**
 * The last five committed addresses, most recent first, no timestamps. Not
 * configuration — there is nothing here to explain or to set — but a cache of
 * what the user already did, the same bargain `loc.v1` makes: it removes a round
 * trip and, more to the point, it is the mitigation for what this finder costs.
 * A 5-digit stop code is printed on the pole in front of you; a 6-digit postal
 * code is not, and forgetting it is otherwise a dead end.
 *
 * Worth stating rather than inheriting silently: this stores up to five labelled
 * addresses, plausibly home and work, in cleartext on the device. It is never
 * transmitted, the server never sees it, and it clears with the other keys.
 */
const RECENT_KEY = 'bus-board.recent.v1';
/**
 * How many times the navigation tip has been shown, `{shown: n}`. The whole
 * record is a counter with a ceiling, and it exists because the board's two
 * doors are quiet: the stop name carries a chevron and the bus number carries
 * nothing at all, so this sentence is the only thing that ever says the number
 * is tappable. Retiring itself is the point — chrome that outlives its lesson is
 * just a smaller board.
 *
 * Nothing about a rider is in here, so it clears with the other four and costs
 * at most five showings of one sentence if it is lost.
 */
const HINT_KEY = 'bus-board.hint.v1';

const NEARBY_LIMIT = 8;
const REFRESH_MS = 30_000; // arrivals refetch, visible cards only
const TICK_MS = 10_000; // local re-render so minutes count down between fetches
const LOC_MAX_AGE_MS = 12 * 60 * 60 * 1000; // cached coordinate still worth a first paint
const MOVED_M = 200; // re-rank the board once the live fix differs by this much
/**
 * How long a wait for a position runs before the gate also offers the other door.
 * `getPosition` gives up at 12 s and an unanswered permission prompt calls nothing
 * back at all, so without this the only thing on screen for that whole time is a
 * sentence. Long enough that a fix that is about to arrive is not interrupted by a
 * button appearing under it.
 */
const WAIT_HATCH_MS = 3_000;
/** Enough to fill a phone's first screenful, so the wait has the board's shape. */
const SKELETON_CARDS = 3;

const el = {
  originChip: document.getElementById('origin-chip'),
  finder: document.getElementById('finder'),
  origins: document.getElementById('origins'),
  search: document.getElementById('search'),
  finderClear: document.getElementById('finder-clear'),
  resultsHead: document.getElementById('results-head'),
  results: document.getElementById('results'),
  finderNote: document.getElementById('finder-note'),
  gate: document.getElementById('gate'),
  gateMsg: document.getElementById('gate-msg'),
  gateAction: document.getElementById('gate-action'),
  gateAlt: document.getElementById('gate-alt'),
  coach: document.getElementById('coach'),
  coachText: document.getElementById('coach-text'),
  coachDismiss: document.getElementById('coach-dismiss'),
  board: document.getElementById('board'),
  status: document.getElementById('status'),
  tagline: document.getElementById('tagline'),
  intro: document.getElementById('intro'),
  introGps: document.getElementById('intro-gps'),
  introNoGps: document.getElementById('intro-no-gps'),
  introCode: document.getElementById('intro-code'),
};

/** @type {Array<{code: string, description: string, roadName: string}>} */
let pins = readPins();
/** @type {{lat: number, lon: number, at: number} | null} */
let lastLoc = readLoc();
/** @type {{mode: 'gps' | 'place', label?: string, name?: string, postal?: string | null,
 *   code?: string | null, lat?: number, lon?: number} | null} */
let origin = readOrigin();
/** @type {Array<object>} */
let board = [];
/** The last five addresses committed, most recent first. @type {Array<object>} */
let recents = readRecents(readRaw(RECENT_KEY));
/**
 * The last search response, already mapped to rows. Held here rather than in DOM
 * attributes so an address's coordinate never has to be written into the markup
 * and read back out.
 * @type {Array<{place: object | null}>}
 */
let searchResults = [];
/**
 * What is actually on screen in `#results` — search results, or nothing. Recent
 * used to be in here too, which is why the listbox announced the wrong name in
 * three of its six states; it lives in `#origins` now.
 *
 * **Written in the same synchronous block as the markup** (see `applyFinder`),
 * which is the whole reason a `data-index` read off the DOM can be trusted to
 * address this array and not the one before it.
 * @type {Array<{place: object}>}
 */
let searchRows = [];
/**
 * What is on screen in `#origins`. Same invariant as `searchRows` and the same
 * reason — see `renderOrigins`, which is the only writer.
 * @type {Array<{kind: string, place: object | null}>}
 */
let originRows = [];
/** The highlighted row, or -1 for none. Arrow keys move it; `moveActive` decides. */
let activeIndex = -1;
/**
 * Where the last request got to. `offline` is the one that earns its keep:
 * "nothing matched" and "we never got to ask" are different answers and the row
 * list looks identical from both.
 * @type {'idle' | 'searching' | 'ok' | 'offline'}
 */
let searchStatus = 'idle';
let shellSignature = '';
let loadingBoard = false;
let pendingLoad;
/**
 * Whether the server has admitted the timings are synthetic. Plain state, read by
 * `applyTagline` on every origin change — not a latch. It used to be one, because
 * the demo notice *replaced* the tagline and had to defend itself against the next
 * origin switch; the cost was that the sentence saying where the board is ranked
 * from never came back for the rest of the session. `taglineFor` composes both
 * clauses now, so there is nothing to defend.
 */
let mock = false;
/**
 * The intro has been put on screen this session. Nothing is persisted about it —
 * the dialog's job is done the moment a door is chosen, and a door being chosen
 * writes an origin, which is what keeps it from coming back. So a dismissal
 * legitimately shows it again next reload, and this flag only stops it opening
 * twice within one page life.
 */
let introSeen = false;
/**
 * Whether the dialog is closing because a door was tapped rather than dismissed.
 * `close` fires for both, and only a dismissal should open the finder — otherwise
 * choosing "Use my current location" would also slide the search panel open
 * behind the gate.
 */
let introDoorTaken = false;
/**
 * The navigation tip has had its one decision for this page load. Not "the tip
 * is on screen": an origin switch runs `loadBoard` again, and without this the
 * second board of the same page life would count a second showing for a tip the
 * rider has been looking at the whole time.
 *
 * It latches on the first board that loads, whatever that board held. So a first
 * load that came back empty spends this page's decision and the tip waits for
 * the next reload — the counter is untouched, so nothing is lost but a delay.
 */
let hintDecided = false;
const visible = new Set();

// --- storage ------------------------------------------------------------

function readPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s) => s && typeof s.code === 'string') : [];
  } catch {
    return [];
  }
}

function readLoc() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOC_KEY) ?? 'null');
    if (!raw || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Reading a key, guarded. With storage disabled outright (Firefox's
 * `dom.storage.enabled = false`) the `localStorage` access itself throws, not
 * just the write — which is why every reader in this file has a try around it.
 */
function readRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readOrigin() {
  return readOriginRecord(readRaw(ORIGIN_KEY));
}

/**
 * The mode as it is *written* in storage, which is not always the mode
 * `readOriginRecord` hands back: exactly one record differs, the legacy
 * `{mode:'stop', …}` one that migrates to a place on read. `boot()` compares the
 * two so it can rewrite that record once, rather than re-migrating it on every
 * visit for the rest of the user's life. Parsed here rather than in `origin.js`
 * because "what is literally in the key" is a storage fact, not a rule.
 */
function storedOriginMode() {
  try {
    return JSON.parse(readRaw(ORIGIN_KEY) ?? 'null')?.mode ?? null;
  } catch {
    return null;
  }
}

/**
 * The only writer of ORIGIN_KEY. The governing rule — persist an origin only
 * when a coordinate is actually in hand — is enforced by keeping the call sites
 * to five: a successful fix in `startWithLocation()`, an address chosen from
 * search (via `switchOrigin`), `boot()`'s grandfather branch, `boot()`'s
 * one-off legacy migration, and `switchOrigin()` putting back a record whose
 * board would not load. Denials, dismissals and typos persist nothing, which is
 * why a half-finished first run degrades to a first run.
 *
 * Not `locate()`: it only runs when an origin record already exists, so there is
 * nothing there for it to write.
 *
 * `null` is the un-persist: the stored `'null'` fails the read guard, so it reads
 * back as absent, which is what a restore-to-nothing has to mean.
 */
function writeOrigin(next) {
  origin = next ? { ...next, at: Date.now() } : null;
  write(ORIGIN_KEY, origin);
  applyTagline();
  renderChip();
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing with storage blocked: this session still works, it just
    // will not be remembered next time.
  }
}

// --- helpers ------------------------------------------------------------

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;

function metresBetween(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function note(message) {
  el.finderNote.textContent = message ?? '';
  el.finderNote.hidden = !message;
}

/**
 * The tagline: where the board is ranked from, and where its timings come from.
 * `taglineFor` composes both, so there is no longer a guard here choosing between
 * two contradictory sentences — and no way for one of them to win permanently.
 *
 * The class stays, because "not live" is worth a colour; it is no longer a
 * different sentence.
 */
function applyTagline() {
  el.tagline.textContent = taglineFor(origin, mock);
  el.tagline.classList.toggle('mock', mock);
}

/**
 * The chip's whole "component": `chipState` decided both strings, this assigns
 * them. Wired exactly where `applyTagline()` is — `writeOrigin()` and `boot()`'s
 * non-persisting branch — because those are the only two places `origin` changes.
 */
function renderChip() {
  const chip = chipState(origin);
  el.originChip.textContent = chip.label;
  el.originChip.setAttribute('aria-label', chip.ariaLabel);
}

/**
 * The gate: a sentence and up to two buttons. Each action is `{label, onClick}`
 * or omitted, and `gateState` decides what is shown — this only assigns.
 *
 * Both buttons are written on every call, hidden ones included: the gate is
 * reused for the "finding stops" message, three refusals and two load failures,
 * so a label or a handler left behind from the previous state is a button that
 * does the wrong thing the moment something unhides it.
 */
function gate(message, primary, secondary) {
  // Every gate state change cancels the pending escape hatch: it exists to add a
  // button to *this* wait, and a wait that has already been answered — by a board,
  // a refusal or a switch — must not have one appear under it afterwards.
  clearHatch();
  // And drops the skeletons, for the same reason: a refusal or a failure is the end
  // of the wait, so cards still pulsing underneath it promise a board that is not
  // coming. `busy()` puts them back straight after calling this, which is why the
  // order there is gate-then-skeleton and not the other way round.
  clearSkeleton();
  const state = gateState(message, primary, secondary);
  el.gate.hidden = false;
  el.gateMsg.textContent = state.message;
  el.gateAction.hidden = state.primary.hidden;
  el.gateAction.textContent = state.primary.label;
  el.gateAction.onclick = primary?.onClick ?? null;
  el.gateAlt.hidden = state.secondary.hidden;
  el.gateAlt.textContent = state.secondary.label;
  el.gateAlt.onclick = secondary?.onClick ?? null;
}

/**
 * The skeletons are not cleared here. The only caller is `loadBoard` on a board it
 * is about to `render()`, and `renderShells` replaces the whole board's markup —
 * clearing first would mean two writes to paint one board.
 */
function hideGate() {
  clearHatch();
  el.gate.hidden = true;
  el.gateAction.onclick = null;
  el.gateAlt.onclick = null;
}

/** The pending escape hatch, or null. See `WAIT_HATCH_MS`. */
let hatchTimer = null;

function clearHatch() {
  clearTimeout(hatchTimer);
  hatchTimer = null;
}

/**
 * A wait, with the shape of the answer on screen instead of an empty page: the
 * gate's sentence over skeleton cards. Every "…" gate goes through this — a first
 * visit's location request, a returning visit's first load, an origin switch — which
 * is the whole of the fix for a page that used to be one grey line and a footer
 * stranded in the middle of it.
 *
 * `offerCode` is for waits that are on a position rather than on the network, and
 * only those: a wait for `/api/board` fails on its own and raises a retry, whereas
 * a permission prompt nobody answers never calls back, so the way out has to be
 * offered on a timer.
 */
function busy(message, { offerCode = false } = {}) {
  gate(message); // clears any previous hatch, so arm after it, never before
  showSkeleton();
  if (offerCode) {
    hatchTimer = setTimeout(() => {
      hatchTimer = null;
      // Same sentence, one more way out. The board is not checked here: anything
      // that painted one has already been through `gate()` or `hideGate()`, and
      // both cancel this.
      gate(message, { label: ADDRESS_DOOR_LABEL, onClick: startWithCode });
      showSkeleton();
    }, WAIT_HATCH_MS);
  }
}

/**
 * Placeholder cards, so a wait reads as an answer arriving rather than as an empty
 * app. `aria-hidden` because `#board` is a live region and three empty cards are
 * not an announcement; `data-code` is deliberately absent, which is what keeps the
 * ten-second `paintBodies()` tick from matching them.
 */
const SKELETON_CARD = `
  <article class="card skeleton" aria-hidden="true">
    <div class="card-head">
      <div class="card-title">
        <span class="sk sk-code"></span>
        <span class="sk sk-name"></span>
        <span class="sk sk-sub"></span>
      </div>
    </div>
    <div class="card-body">
      <div class="sk-row"><span class="sk sk-no"></span><span class="sk sk-eta"></span></div>
      <div class="sk-row"><span class="sk sk-no"></span><span class="sk sk-eta"></span></div>
      <div class="sk-row"><span class="sk sk-no"></span><span class="sk sk-eta"></span></div>
    </div>
  </article>`;

/**
 * The guard is on the *markup*, not on the `board` array. Cards on screen are worth
 * more than skeletons whatever their age — a refusal over a working board must not
 * blank it — while `switchOrigin` and `startWithLocation` clear the markup and leave
 * the array in place on purpose, and those are exactly the waits that need filling.
 *
 * `shellSignature` goes back to `''` for the same reason `resetBoard()` does it:
 * `renderShells` short-circuits on a matching signature, and skeletons in the DOM
 * under a signature that still matches the incoming board would never be replaced.
 */
function showSkeleton() {
  if (el.board.children.length > 0) return;
  el.board.innerHTML = SKELETON_CARD.repeat(SKELETON_CARDS);
  shellSignature = '';
}

/**
 * Takes placeholders off screen, and only placeholders — the test is for a skeleton
 * in the DOM rather than for an empty `board` array, because a real board and a
 * blanked-but-remembered one both leave that array full.
 */
function clearSkeleton() {
  if (el.board.querySelector('.skeleton')) resetBoard();
}

// --- rendering ----------------------------------------------------------

const LOAD_LABEL = { SEA: 'Seats', SDA: 'Standing', LSD: 'Crowded' };
const LOAD_TITLE = {
  SEA: 'Seats available',
  SDA: 'Standing room available',
  LSD: 'Limited standing — crowded',
};

/**
 * One arrival: minutes, and on the next bus its crowding as well.
 *
 * The crowding label is the lead column's alone. Three of them per service meant
 * nine on a card, all at the same weight, so the one number a commuter is actually
 * deciding on — the next bus — competed with eight others for the same glance; and
 * how full a bus will be in twenty minutes is a guess dressed as data anyway. The
 * width that frees goes to the lead number, which is the thing being read at arm's
 * length. Columns two and three are for "is it worth waiting", which minutes answer
 * on their own.
 *
 * The empty lead cell keeps its reserved label height so a service with no crowding
 * data does not sit a line taller than its neighbours.
 *
 * `now` is handed in rather than read here: the row's vehicle mark asks the same clock
 * question through `isIncoming`, and two reads either side of a minute boundary would put a
 * moving mark next to a number that says four minutes.
 */
function renderEta(bus, index, now) {
  const lead = index === 0;
  const classes = ['eta'];
  if (lead) classes.push('eta-lead');

  if (!bus || !bus.estimatedArrival) {
    return `<div class="${classes.join(' ')} eta-empty">
      <span class="eta-value">–</span>${lead ? '<span class="eta-load"></span>' : ''}
    </div>`;
  }

  const mins = minutesUntil(bus.estimatedArrival, now);
  if (mins <= 1) classes.push('arriving');
  if (!bus.monitored) classes.push('scheduled');

  const value =
    mins <= 0
      ? '<span class="eta-value">Arr</span>'
      : `<span class="eta-value">${mins}${lead ? '<span class="eta-unit">min</span>' : ''}</span>`;

  const label = lead && bus.load && LOAD_LABEL[bus.load] ? LOAD_LABEL[bus.load] : '';
  const load = label
    ? `<span class="eta-load load-${escape(bus.load.toLowerCase())}" title="${escape(
        LOAD_TITLE[bus.load],
      )}">${escape(label)}</span>`
    : lead
      ? '<span class="eta-load"></span>'
      : '';

  const title = bus.monitored ? '' : ' title="Scheduled timing — bus not currently tracked"';
  return `<div class="${classes.join(' ')}"${title}>${value}${load}</div>`;
}

/** Vehicle facts that belong to the service line, tucked under its number. */
function renderTags(bus, now) {
  if (!bus) return '';
  const tags = [];
  // An unrecognised code from upstream, or none at all, simply matches nothing and draws
  // nothing. That silence used to be a single decker's too and is now its own answer.
  const vehicle = VEHICLE[bus.type];
  if (vehicle) tags.push(vehicleIcon(vehicle, isIncoming(bus, now)));
  return tags.length > 0 ? `<span class="service-tags">${tags.join('')}</span>` : '';
}

function renderServices(stop) {
  if (stop.services === null) return '<p class="card-msg">Timings unavailable — will retry.</p>';
  if (stop.services.length === 0) {
    return '<p class="card-msg">No buses at this hour.</p>';
  }

  // One clock read for the whole card, passed to every cell that needs it: the numbers and
  // the marks answer the same question, and two reads a millisecond apart could answer it
  // differently at a minute boundary.
  const now = Date.now();

  const rows = stop.services
    .map(
      (service) => `
      <li class="service">
        <div class="service-id">
          <a class="service-no" href="/bus/${encodeURIComponent(service.serviceNo)}?stop=${escape(stop.code)}">${escape(service.serviceNo)}</a>
          ${renderTags(service.buses[0], now)}
        </div>
        ${renderEta(service.buses[0], 0, now)}
        ${renderEta(service.buses[1], 1, now)}
        ${renderEta(service.buses[2], 2, now)}
      </li>`,
    )
    .join('');

  return `<div class="services-head" aria-hidden="true">
      <span>Bus</span><span>Next</span><span>Then</span><span>After</span>
    </div>
    <ul class="services">${rows}</ul>`;
}

const observer =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const { code } = entry.target.dataset;
            if (entry.isIntersecting) visible.add(code);
            else visible.delete(code);
          }
        },
        // Count a card as visible slightly before it scrolls in, so its timings
        // are already fresh by the time it is on screen.
        { rootMargin: '200px 0px' },
      )
    : null;

/**
 * Rebuilds card shells only when the set or order of stops changes, so the
 * ten-second re-render touches nothing but the arrival rows.
 */
function renderShells() {
  const signature = board.map((stop) => `${stop.code}${stop.pinned ? '*' : ''}`).join(',');
  if (signature === shellSignature) return;
  shellSignature = signature;

  observer?.disconnect();
  visible.clear();

  el.board.innerHTML = board
    .map((stop) => {
      // What the distance means depends on the mode, so the cell's whole content
      // is one decision: metres and a walk, or "Here" on the card a gps user is
      // already standing at.
      const distance = distanceLabel(stop, origin);
      return `
      <article class="card${stop.pinned ? ' pinned' : ''}" data-code="${escape(stop.code)}">
        <div class="card-head">
          <div class="card-title">
            <a class="card-link" href="/stop/${escape(stop.code)}">
              <span class="meta-code">${escape(stop.code)}</span>
              <span class="card-name">${escape(stop.description)}<span class="card-chev" aria-hidden="true">›</span></span>
            </a>
            <span class="card-sub">
              ${stop.roadName ? `<span class="meta-where">${escape(stop.roadName)}</span>` : ''}
              ${distance ? `<span class="meta-dist">${escape(distance)}</span>` : ''}
            </span>
          </div>
          <button class="pin" type="button" data-pin="${escape(stop.code)}"
                  aria-pressed="${stop.pinned}"
                  aria-label="${stop.pinned ? 'Unpin' : 'Pin'} ${escape(stop.description)}"
                  title="${stop.pinned ? 'Unpin this stop' : 'Keep this stop at the top'}">${
                    stop.pinned ? '★' : '☆'
                  }</button>
        </div>
        <div class="card-body"></div>
      </article>`;
    })
    .join('');

  if (observer) {
    for (const card of el.board.children) observer.observe(card);
  }
}

function paintBodies() {
  for (const stop of board) {
    const body = el.board.querySelector(`.card[data-code="${CSS.escape(stop.code)}"] .card-body`);
    if (body) body.innerHTML = renderServices(stop);
  }
}

function render() {
  renderShells();
  paintBodies();
}

/**
 * Takes the board off screen without forgetting it. The two statements must move
 * together: `renderShells` short-circuits on a matching signature, so clearing
 * the markup while leaving the signature behind paints nothing at all next time.
 * The `board` array is deliberately left alone — `switchOrigin` restores from it.
 */
function resetBoard() {
  el.board.innerHTML = '';
  shellSignature = '';
}

// --- data ---------------------------------------------------------------

function stamp(when) {
  el.status.textContent = `Updated ${new Date(when).toLocaleTimeString('en-SG', { hour12: false })}`;
}

/**
 * The navigation tip, decided once per page load and written in the same breath
 * as it is shown — `hintDecision` hands back the record to persist exactly when
 * it says to show, so "shown" and "counted" cannot come apart.
 *
 * `boardHasCards` is passed explicitly and is never left to be inferred:
 * `hintDecision` counts only a literal `true`, so a caller that forgets the flag
 * loses the tip rather than teaching over a gate or an empty board. A sentence
 * about tapping stops, with no stops on screen, teaches nobody and burns a
 * showing.
 */
function maybeShowHint() {
  if (hintDecided) return;
  hintDecided = true;

  const { show, record } = hintDecision({
    raw: readRaw(HINT_KEY),
    boardHasCards: board.length > 0,
  });
  if (!show) return;

  el.coachText.textContent = HINT_COPY;
  el.coachDismiss.textContent = HINT_DISMISS_LABEL;
  el.coach.hidden = false;
  write(HINT_KEY, record);
}

/**
 * Loads the board for the current origin. Resolves `true` on a successful load
 * and `false` on the failure path; a load that was coalesced into one already in
 * flight resolves `undefined`, which a caller reads as "not my load".
 */
async function loadBoard(loc) {
  // A pin toggled while the previous load is in flight must not be dropped, so
  // coalesce rather than ignore.
  if (loadingBoard) {
    pendingLoad = loc ?? originCoord(origin, lastLoc);
    return;
  }
  loadingBoard = true;
  try {
    // The coordinate is resolved from the origin here, not taken from `loc`:
    // gps mode sends the last fix, place mode the chosen address's own coordinate,
    // and no caller gets to pick the wrong one. `loc` survives only as the
    // coalescing value above and the retry closure below.
    const coord = originCoord(origin, lastLoc);

    const query = boardParams({ origin, lastLoc, pins, limit: NEARBY_LIMIT });
    const res = await fetch(`/api/board?${query}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();

    board = data.stops ?? [];
    if (board.length > 0) hideGate();
    else if (coord) {
      gate(noStopsMessage(origin), {
        label: 'Try again',
        // Only a gps origin is worth sending back to geolocation; in place mode the
        // retry re-runs the same load.
        onClick: origin?.mode === 'gps' ? () => void locate(true) : () => void loadBoard(coord),
      });
    }
    render();
    maybeShowHint();
    stamp(data.fetchedAt);
    if (data.mock) flagMock();
    return true;
  } catch {
    if (board.length === 0) {
      gate('Could not load stops. Check your connection.', {
        label: 'Try again',
        onClick: () => void loadBoard(loc),
      });
    }
    return false;
  } finally {
    loadingBoard = false;
    if (pendingLoad !== undefined) {
      const next = pendingLoad;
      pendingLoad = undefined;
      void loadBoard(next);
    }
  }
}

/** Refresh path: only the cards on screen, plus pinned ones wherever they are. */
async function refreshArrivals() {
  if (board.length === 0 || document.visibilityState !== 'visible') return;

  const wanted = new Set(pins.map((p) => p.code));
  for (const code of visible) wanted.add(code);
  // No observer support (or nothing measured yet): refresh the lot.
  if (wanted.size === 0) for (const stop of board) wanted.add(stop.code);

  const codes = board.map((s) => s.code).filter((code) => wanted.has(code));
  if (codes.length === 0) return;

  try {
    const res = await fetch(`/api/arrivals?stops=${codes.join(',')}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();

    const byCode = new Map((data.arrivals ?? []).map((entry) => [entry.code, entry.services]));
    for (const stop of board) {
      if (byCode.has(stop.code)) stop.services = byCode.get(stop.code);
    }
    paintBodies();
    stamp(data.fetchedAt);
  } catch {
    // Leave the last good timings on screen; the next tick tries again.
  }
}

/**
 * The board's timings are synthetic, recorded and shown. One flag and one re-render:
 * the wording is `taglineFor`'s to decide, and it keeps the origin clause, so this
 * no longer has to overwrite anything or latch to stay overwritten.
 *
 * Still one-way — nothing sets it back — but that is now a property of the server,
 * whose credentials cannot change mid-session, rather than a defence.
 */
function flagMock() {
  mock = true;
  applyTagline();
}

// --- location -----------------------------------------------------------

function rememberLoc(lat, lon) {
  lastLoc = { lat, lon, at: Date.now() };
  write(LOC_KEY, lastLoc);
}

/**
 * Asks for a position. The browser remembers the grant itself on HTTPS, so a
 * returning visitor is never prompted twice; the coordinate is cached too, so
 * the board paints before the fix comes back.
 *
 * **Deliberately not `async`, and do not make it so.** A `Promise` executor runs
 * synchronously, so `getCurrentPosition` below is reached in the same task as the
 * click that led here — which is the only reason iOS Safari shows the prompt at
 * all. Safari spends the click's transient activation on the first `await`, and a
 * `getCurrentPosition` called after that point silently never prompts. An `await`
 * inserted anywhere above this call — here or in a caller — therefore breaks
 * first-run location on iPhone while working perfectly in desktop Chrome, and no
 * test in this repository can catch it. `startWithLocation()` is written the way
 * it is for the same reason.
 */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position.coords),
      reject,
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 5 * 60_000 },
    );
  });
}

/**
 * No position, for any of the three reasons. The gate carries both honest answers
 * — name a stop, or ask again — and nothing is persisted: under the governing
 * rule a refusal is not a door the user came in by, so the next visit is still a
 * first visit.
 *
 * The early return is what stops a returning visitor who revoked the permission
 * from being nagged: their cached board is already on screen and useful, so a
 * refusal is not worth interrupting it for. It applies only to attempts nothing
 * asked for. A tap is always answered — a place-mode user pressing "Use my current
 * location" over a working board would otherwise get silence, which reads as a
 * broken button rather than as a blocked permission.
 *
 * The search panel is deliberately *not* opened here. It used to be, which stole
 * focus from the message explaining what had just happened; the buttons below the
 * sentence are now the only affordance, and one of them is that panel.
 */
function onLocationRefused(err, explicit = false) {
  if (!explicit && board.length > 0) return; // already showing something useful
  gate(
    refusalCopy(err).message,
    { label: ADDRESS_DOOR_LABEL, onClick: startWithCode },
    // Not `locate()`: it returns early unless the origin is already gps, and it
    // awaits the permissions pre-check before asking for a position, which spends
    // the click's transient activation on iOS. Same path as the intro's button.
    { label: 'Try location again', onClick: () => void startWithLocation() },
  );
}

/**
 * The returning-gps path, and only that: a first visit reaches a position through
 * `startWithLocation()` instead. The guard is safe because `boot()` routes an
 * empty profile to `showIntro()` and never falls through to here, so every caller
 * left — `boot()`'s gps branch, the focus handler via `shouldRelocateOnFocus`, and
 * the empty-board retry — already holds a gps origin. It exists because the other
 * two would otherwise ask a place-mode user for their location.
 *
 * Nothing is persisted on success: an origin record is the precondition for
 * getting here, so it is already in storage.
 */
async function locate(force = false) {
  if (origin?.mode !== 'gps') return;

  const fresh = lastLoc && Date.now() - lastLoc.at < LOC_MAX_AGE_MS;

  // The hatch is armed here as well as on the first visit: a returning visitor who
  // revoked the permission, or one whose fix has gone stale on a phone that will not
  // give another, waits on the same silence.
  if (board.length === 0) busy(gateMessageFor(origin), { offerCode: true });

  // Paint from the last known coordinate first — a returning visitor sees the
  // board immediately rather than watching a spinner wait on the GPS.
  if (fresh && !force) void loadBoard(lastLoc);

  // A previously denied permission would otherwise fail silently every visit.
  // Only reachable from a returning visit, never from a click — `await`ing it
  // would spend the transient activation `getPosition` needs on iOS.
  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'denied') {
        onLocationRefused({ code: 1 });
        return;
      }
    } catch {
      // Permissions API unsupported for geolocation here; just ask directly.
    }
  }

  try {
    const coords = await getPosition();
    const previous = lastLoc;
    rememberLoc(coords.latitude, coords.longitude);
    const moved = !previous || metresBetween(previous, lastLoc) > MOVED_M;
    if (moved || board.length === 0) await loadBoard(lastLoc);
  } catch (err) {
    onLocationRefused(err);
  }
}

// --- the address finder -------------------------------------------------

/** The pending keystroke debounce, or null when no search is waiting to fire. */
let debounce = null;
/** The normalised query that debounce is holding, so the Enter flush asks for
 *  the same thing the timer would have. */
let pendingQuery = '';
/**
 * The request already out, or null. Enter waits on this as well as on the
 * debounce: a query whose timer has fired but whose answer has not landed would
 * otherwise be decided against the *previous* query's rows, which answers "No
 * address at 310155." for an address the server is at that moment returning.
 */
let inFlight = null;
/** Request ordering: only the newest sequence number may write a result. */
let searchSeq = 0;

/**
 * The destinations list, applied. `originsState` decides every row and every
 * string; this writes them.
 *
 * **`originRows` and the markup are written together, here, and nowhere else** —
 * the same invariant `applyFinder` rests on, for the same reason. Rows commit by
 * `data-index`, so an index read off the DOM must always address the array that
 * produced that DOM.
 *
 * Both interpolated fields are escaped: `primary` is an address out of a scraped
 * dump, by way of `localStorage`, where a user can hand-edit it.
 *
 * Neither half of the geolocation test is belt-and-braces. A page served over plain
 * http has `navigator.geolocation` and cannot use it, which is the case
 * `introVariant` already distinguishes. And the check is `!!navigator.geolocation`
 * rather than `'geolocation' in navigator`, matching the guard in `getPosition`:
 * a browser that exposes the property as null passes the `in` test and then refuses
 * the call, which would put a row here that cannot do the one thing it offers.
 *
 * Called from `openSearch` and nowhere else, deliberately: the list is only ever on
 * screen while the card is open, and `openSearch` is the only thing that opens it.
 * One render site is what keeps `originRows` and the markup impossible to desync.
 */
function renderOrigins() {
  const panel = originsState({
    origin,
    recents,
    geolocationSupported: window.isSecureContext && !!navigator.geolocation,
  });

  originRows = panel.rows;
  el.origins.innerHTML = panel.rows
    .map((row, index) => {
      const detail = row.detail ? `<span class="origin-detail">${escape(row.detail)}</span>` : '';
      const status = row.status ? `<span class="origin-status">${escape(row.status)}</span>` : '';
      // The update control is a second button inside the row's `<li>`, not inside
      // the row's own button: a button cannot contain a button. The `<li>` is the flex
      // line that puts it on the right of the row rather than under it.
      const update = row.showUpdate
        ? `<button type="button" class="ghost origin-update" data-update="1">↻ Refresh location</button>`
        : '';
      return `
        <li>
          <button type="button" class="origin-row" data-kind="${row.kind}" data-index="${index}"
                  ${row.current ? 'aria-current="true"' : ''}>
            <span class="origin-primary">${escape(row.primary)}</span>
            ${detail}${status}
          </button>
          ${update}
        </li>`;
    })
    .join('');
}

/**
 * The only place that knows the endpoint: the URL, the response key and the row
 * mapping all live here, so a change to any of them is a change to one function.
 *
 * Rows come back already converted — each carries a ready `Place`, or `null` for
 * one the board could not be ranked from — because `finderState` filters on that
 * and `choosePlace` commits it with no second lookup.
 */
async function fetchPlaces(query) {
  const res = await fetch(`/api/places?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  return (data.places ?? []).map((row) => ({ place: placeFromRow(row) }));
}

/**
 * The whole panel, applied. `finderState` decides all six states and every
 * attribute below; this is a run of one-line assignments with no branch left in
 * it, which is what keeps the rules testable.
 *
 * **`searchRows` and the markup are written together, here, and nowhere else.**
 * That is the invariant the commit path rests on: rows carry `data-index`, not a
 * code, so an index read off the DOM must always address the array that produced
 * that DOM. Split these two statements across an `await` and a fast typist
 * commits the wrong address.
 *
 * The clamp is the other half of it. An async result can be shorter than the list
 * a highlight was set against, so an `activeIndex` past the end drops to -1 at
 * the single point where rows are assigned rather than at each reader.
 */
function applyFinder() {
  const panel = finderState({
    value: el.search.value,
    results: searchResults,
    status: searchStatus,
  });

  searchRows = panel.rows;
  if (activeIndex >= searchRows.length) activeIndex = -1;
  renderRows(searchRows);

  el.results.hidden = !panel.expanded;
  // The list's visibility and the combobox's `aria-expanded` are the same fact
  // told twice: a combobox that never reports itself expanded is worse than one
  // with no role at all, because assistive technology then announces a list it
  // has been told is not there.
  el.search.setAttribute('aria-expanded', String(panel.expanded));
  el.results.setAttribute('aria-busy', String(panel.busy));
  el.resultsHead.textContent = panel.heading;
  el.resultsHead.hidden = panel.heading === '';
  note(panel.note);
  el.finderClear.hidden = !panel.showClear;
  setActive(activeIndex);

  return panel;
}

/**
 * The one `innerHTML` site in the finder, and both interpolated fields are
 * escaped: the addresses come from a scraped dump, which is untrusted data by
 * definition.
 *
 * `role="option"` with **no inner button**, deliberately. An option must not
 * contain interactive content, and DOM focus has to stay in the input or a phone
 * keyboard closes mid-typing — activation is a delegated click plus Enter, and
 * the highlight travels by `aria-activedescendant` instead.
 *
 * The long `name` leads, because a row has a whole line to itself; `label` is for
 * the places that share one. The postal code goes underneath, which is the thing
 * a Singaporean can act on unambiguously.
 */
function renderRows(rows) {
  el.results.innerHTML = rows
    .map(({ place }, index) => {
      const detail = place.postal
        ? `Singapore ${place.postal}`
        : place.code
          ? `Stop ${place.code}`
          : '';
      return `
        <li class="result-row" id="opt-${index}" role="option" data-index="${index}"
            aria-selected="false">
          <span class="result-primary">${escape(place.name)}</span>
          ${detail ? `<span class="result-secondary">${escape(detail)}</span>` : ''}
        </li>`;
    })
    .join('');
}

/**
 * Moves the highlight. `aria-activedescendant` is what tells a screen reader
 * which option is current while DOM focus stays in the input; `aria-selected`
 * is what a sighted user sees, through the CSS.
 */
function setActive(index) {
  const options = el.results.children;
  for (let i = 0; i < options.length; i += 1) {
    options[i].setAttribute('aria-selected', String(i === index));
  }
  const active = index >= 0 ? options[index] : null;
  el.search.setAttribute('aria-activedescendant', active ? active.id : '');
  // `nearest` and not `center`: the list scrolls inside its own box, and a
  // highlight one row down should not jump the box halfway.
  active?.scrollIntoView({ block: 'nearest' });
}

/**
 * The Recent list, updated. Called from `switchOrigin` on the success path only:
 * an address whose board would not load is not worth offering again next time.
 */
function rememberPlace(place) {
  recents = rememberRecent(recents, place);
  write(RECENT_KEY, recents);
}

/**
 * Opens the card, with the destinations list on screen: the location door and every
 * address already used, one tap each.
 *
 * `focus` is `'list'` or `'search'`, and the difference matters on a phone. Opening
 * from the chip focuses the list, because focusing the input raises the keyboard
 * over the very rows the user came to tap. Coming through the address door — the
 * intro, the gate, the wait hatch — the user has already said they mean to type, so
 * that path asks for the input.
 *
 * `scrollIntoView` with `nearest`, so a card already on screen does not jump: the
 * card is in normal flow above the board, and on a short viewport opening it can
 * otherwise leave it below the fold.
 *
 * **Synchronous, and it must stay that way.** `startWithCode` calls this from a
 * click, and an `await` anywhere on that path spends the transient activation iOS
 * Safari needs for the location row inside it. `scrollIntoView` returns nothing;
 * keep it that way — a smooth-scroll promise here would cost the prompt.
 */
function openSearch(focus = 'search') {
  el.finder.hidden = false;
  el.originChip.setAttribute('aria-expanded', 'true');
  renderOrigins();
  applyFinder();
  if (focus === 'list') el.origins.querySelector('.origin-row')?.focus();
  else el.search.focus();
  el.finder.scrollIntoView({ block: 'nearest' });
}

function closeSearch() {
  // Whether focus has to be put somewhere: the button that closed the panel may
  // have been inside it (a destination row, a result), and hiding the focused
  // element drops focus to the body. Called with the panel already shut — the
  // gate's retry does that — this leaves focus wherever it is.
  const wasOpen = !el.finder.hidden;

  // A keystroke still in the debounce would otherwise fire into a closed panel and
  // repopulate `searchResults` after they were cleared, leaving Enter to commit
  // against a list nobody can see. A request already out is retired the same way,
  // by moving the sequence number past it — it cannot be cancelled, only ignored.
  clearTimeout(debounce);
  debounce = null;
  searchSeq += 1;

  el.finder.hidden = true;
  el.originChip.setAttribute('aria-expanded', 'false');

  // Collapsed by hand rather than through `applyFinder`: the box may still hold
  // text at this point (`switchOrigin` clears it afterwards), and rendering the
  // panel's own idea of itself would report `aria-expanded="true"` on a section
  // that is now hidden.
  searchResults = [];
  searchRows = [];
  // Cleared with the rows it addresses: a `data-index` left in a hidden panel must
  // not survive to be read against the next list.
  originRows = [];
  searchStatus = 'idle';
  activeIndex = -1;
  el.results.hidden = true;
  el.search.setAttribute('aria-expanded', 'false');
  el.search.setAttribute('aria-activedescendant', '');
  el.results.innerHTML = '';
  el.resultsHead.hidden = true;
  el.resultsHead.textContent = '';
  el.finderClear.hidden = true;
  note('');

  if (wasOpen) el.originChip.focus();
}

/**
 * One request, and the panel repainted around whatever comes back. `searchSeq`
 * and the debounce stay glue on purpose — they are mutable request ordering and
 * there is nothing pure about them.
 *
 * Always go through `startSearch`, never straight to this: the promise it keeps
 * is what Enter waits on.
 */
async function runSearch(query) {
  const seq = ++searchSeq;
  searchStatus = 'searching';
  applyFinder();
  try {
    const rows = await fetchPlaces(query);
    if (seq !== searchSeq) return; // a newer keystroke already won
    searchResults = rows;
    searchStatus = 'ok';
  } catch {
    if (seq !== searchSeq) return;
    // The rows are left alone: `offline` shows Recent instead, and a transient
    // failure should not throw away an answer the user may still want.
    searchStatus = 'offline';
  }
  applyFinder();
}

/** `runSearch`, with the promise kept so Enter can wait on it. `runSearch` never
 *  rejects — it turns a failure into the `offline` state — so this needs no catch. */
function startSearch(query) {
  const pending = runSearch(query).finally(() => {
    if (inFlight === pending) inFlight = null;
  });
  inFlight = pending;
  return pending;
}

/**
 * Enter in the finder. `commitDecision` is the whole decision; this switch only
 * applies it.
 *
 * The flush is not optional. Enter arrives on the same reach as the last digit, so
 * a 250 ms debounce is routinely still pending when it lands — and deciding against
 * the results from four digits ago answers "No address at 310155." for an address
 * that exists. Awaiting the search first costs nothing here: no transient
 * activation is at stake on this path (that constraint belongs to
 * `startWithLocation`), and nothing below two characters ever reaches the timer,
 * so a one-character query still fires no request.
 */
async function commitSearch() {
  if (debounce !== null) {
    clearTimeout(debounce);
    debounce = null;
    await startSearch(pendingQuery);
  } else if (inFlight) {
    // The timer already fired and the answer is on its way. Deciding now would
    // decide against the query before this one.
    await inFlight;
  }

  const decision = commitDecision({
    value: el.search.value,
    rows: searchRows,
    status: searchStatus,
    activeIndex,
  });
  switch (decision.action) {
    case 'choose':
      choosePlace(searchRows[decision.index]?.place);
      break;
    case 'note':
      note(decision.message);
      break;
    default:
      // 'wait' — either the search itself failed, or several addresses matched a
      // name and the list is on screen. Picking the first one would be guessing
      // on the user's behalf.
      break;
  }
}

// --- pinning ------------------------------------------------------------

function togglePin(code) {
  const already = pins.some((p) => p.code === code);
  if (already) {
    pins = pins.filter((p) => p.code !== code);
  } else {
    const stop = board.find((s) => s.code === code);
    if (!stop) return;
    pins = [...pins, { code, description: stop.description, roadName: stop.roadName }];
  }
  write(PINS_KEY, pins);
  void loadBoard(originCoord(origin, lastLoc));
}

// --- choosing an origin -------------------------------------------------

/**
 * A chosen row becomes the origin. This replaced pin-on-tap: a tap now re-ranks
 * the board around that address rather than adding a ninth card to it, and ★ is
 * still how a stop is pinned.
 *
 * There is no shaping and no lookup left here. Every row already carries a
 * `Place` built by `placeFromRow` inside `fetchPlaces`, and `finderState` dropped
 * the rows that had none — an address a board cannot be ranked from is never put
 * on screen in the first place, rather than refused after it is tapped.
 *
 * The guard is for one case only: an index that no longer addresses a row,
 * because the list was rewritten between the tap and this call. There is nothing
 * to say about it — the panel in front of the user is already the correction.
 */
function choosePlace(place) {
  if (!place) return;
  void switchOrigin(place);
}

/**
 * Commits a new origin and rebuilds the board around it, putting everything back
 * if that board will not load.
 *
 * The ordering matters, because it collides with two mechanisms that exist for
 * other reasons. `loadBoard`'s catch only gates when the board is empty, and the
 * `board` array is deliberately *not* cleared here — so a failed switch shows no
 * gate of its own and this function has to raise one. `renderShells`
 * short-circuits on a matching signature and the signature does not encode the
 * mode, so the same eight stops in a new mode would repaint nothing unless the
 * reset is explicit.
 *
 * `false` is a failure; `undefined` means the load was coalesced into one already
 * in flight, which is not this switch's failure and must not roll it back.
 */
async function switchOrigin(next) {
  // Only the origin is worth snapshotting. The old shell signature is not: the
  // restore has to force a repaint, so it goes back as `''` rather than as
  // whatever it was, or the short-circuit above swallows the restore.
  const previousOrigin = origin;

  closeSearch();
  el.search.value = '';
  writeOrigin(next);
  resetBoard();
  // No hatch: this wait is on `/api/board`, which answers or fails and raises its
  // own retry, and the door being offered is the one the user just came through.
  busy(gateMessageFor(origin));

  const loaded = await loadBoard(originCoord(origin, lastLoc));
  if (loaded !== false) {
    // Only once a board actually stands: an address that cannot be ranked from
    // is not worth offering back to the user next time they open the panel.
    rememberPlace(next);
    return;
  }

  writeOrigin(previousOrigin);
  shellSignature = '';
  render();
  gate('Could not load stops. Check your connection.', {
    label: 'Try again',
    onClick: () => void switchOrigin(next),
  });
}

// --- the intro ----------------------------------------------------------

/** Set from `showIntro()`, not from the markup: only one can ever be true. */
const INTRO_NO_GPS = {
  insecure: 'This page needs a secure (https) connection to use your location.',
  unsupported: "Your browser can't share a location.",
};

/**
 * The two doors, by name, so `dismissGate` can nominate one without this file
 * mapping a label back to a handler. The location door goes through
 * `startWithLocation` rather than `locate` for the transient-activation reason
 * documented there — every door the user can tap does.
 */
const DOOR = {
  gps: () => void startWithLocation(),
  code: () => startWithCode(),
};

/**
 * Which introduction was rendered, kept because the dismissal gate needs it after
 * the dialog has closed: with no location button in the dialog there is no location
 * door on the gate either. `showIntro` is the only writer, and a dismissal cannot
 * happen before it runs.
 */
let introVariantUsed = 'full';

/**
 * The first-visit chooser: one example of what the board answers, then the two
 * doors that get there. It shows before it asks because a native permission
 * prompt can explain neither, and a stranger has been shown nothing else.
 *
 * When location cannot possibly work — an insecure context, or no geolocation at
 * all — the door is *removed* rather than hidden or disabled. A hidden button is
 * still nothing; a disabled one is a keyboard stop and a screen-reader
 * announcement for a promise the page cannot keep. Removing it also hands the
 * dialog's `autofocus` to the address door, which is the right answer in that
 * state.
 */
function showIntro() {
  if (introSeen) return;
  introSeen = true;

  const variant = introVariant({
    isSecureContext: window.isSecureContext,
    hasGeolocation: 'geolocation' in navigator,
  });
  introVariantUsed = variant;

  if (variant !== 'full') {
    // The door's caption — "Stops nearest you" — is a child of the button rather
    // than a sibling of it, so this one removal takes both. If the card is ever
    // unpicked back into a bare button with the caption beside it, that caption
    // has to be removed here too, or it is left captioning nothing.
    el.introGps.remove();
    el.introNoGps.textContent = INTRO_NO_GPS[variant];
    el.introNoGps.hidden = false;
  }

  // iOS below 15.4 has `<dialog>` but not `showModal`. The `open` attribute
  // renders it in flow: no focus trap, no backdrop, no Escape — but both doors
  // still work, which is the part that matters. The class carries the fallback's
  // margin, because a CSS-only `:not(:modal)` test is unrecognised — and so
  // dropped — in precisely the browsers that land here.
  if (typeof el.intro.showModal === 'function') {
    el.intro.showModal();
  } else {
    el.intro.classList.add('intro-inflow');
    el.intro.setAttribute('open', '');
  }
}

/**
 * The location door, shared by the intro button and the gate's retry.
 *
 * **Nothing may be `await`ed above the `getPosition()` call.** iOS Safari spends
 * the click's transient activation on the first `await`, and `getCurrentPosition`
 * after that point never prompts — silently, and only on iPhone. `intro.close()`
 * and `busy()` are synchronous DOM calls for exactly that reason — a `setTimeout`
 * inside `busy` schedules work but awaits nothing, so the hatch does not cost the
 * activation either — and this is why the retry does not go through `locate()`,
 * which awaits a permissions query first. See the comment on `getPosition`.
 */
async function startWithLocation() {
  introDoorTaken = true;
  el.intro.close(); // a no-op when it was never opened, e.g. the gate's retry
  // Also the finder's location button, which sits *inside* the panel: leaving it
  // open would stack a search box above the gate and then above the new board.
  // A no-op when the panel is already shut, and synchronous either way.
  closeSearch();
  // The longest wait in the product: up to 12 s, and an unanswered prompt never
  // returns at all. Skeletons for the shape of it, and the other door on a timer.
  busy(gateMessageFor(origin), { offerCode: true });

  try {
    const coords = await getPosition();
    rememberLoc(coords.latitude, coords.longitude);
    // Leaving place mode: the shells have to be thrown away even though the load
    // below may return the very same stops in the very same order — which is
    // exactly what happens for someone standing at the address they had named.
    // `shellSignature` does not encode the mode, so without this the nearest card
    // keeps a walking time where "Here" now belongs. `switchOrigin` resets for the
    // same reason; this path does not go through it. Deliberately after the fix
    // rather than before, so a 12-second wait for a GPS that may never arrive does
    // not blank a board that is still true.
    if (origin?.mode !== 'gps') resetBoard();
    // Whatever the reset left behind, the load below is still a wait: refill it
    // rather than leaving the gate's sentence over an empty page for a round trip.
    showSkeleton();
    // Before `loadBoard`, not after: `boardParams` resolves the request
    // coordinate from `origin`, so loading with `origin` still null would send no
    // coordinate at all and paint an empty board.
    writeOrigin({ mode: 'gps' });
    await loadBoard(lastLoc);
  } catch (err) {
    onLocationRefused(err, true);
  }
}

/**
 * The address door: the dialog's second button, and the same door offered again on
 * the dismissal gate and on a refusal. Persists nothing and asks for nothing — there
 * is no coordinate in hand yet, so under the governing rule there is no origin to
 * write, and the dialog is right to come back next reload.
 */
function startWithCode() {
  introDoorTaken = true;
  el.intro.close();
  openSearch(); // focuses the input
}

// --- wiring -------------------------------------------------------------

el.introGps.addEventListener('click', () => void startWithLocation());
el.introCode.addEventListener('click', startWithCode);

// A native <dialog> does not close on a backdrop click; the backdrop is painted
// by the dialog element itself, so a click that lands on the element rather than
// on anything inside it is a click outside the content.
el.intro.addEventListener('click', (event) => {
  if (event.target === el.intro) el.intro.close();
});

// Escape, the backdrop and a door all end here. A dismissal is the interesting
// one: on a phone the backdrop is most of the screen, so it is usually an accident
// rather than a decision, and it used to open the search panel and nothing else —
// a page with a search box, no board, no gate and three quarters of the viewport
// empty. It lands on the gate instead, which already exists to say why the board
// is not there and to carry the doors as buttons. `dismissGate` decides both.
el.intro.addEventListener('close', () => {
  if (introDoorTaken) return;
  const copy = dismissGate(introVariantUsed);
  gate(
    copy.message,
    { label: copy.primary.label, onClick: DOOR[copy.primary.door] },
    copy.secondary ? { label: copy.secondary.label, onClick: DOOR[copy.secondary.door] } : null,
  );
});

el.originChip.addEventListener('click', () => {
  // The list, not the box: the chip's caret promises a menu, and the rows are what
  // it opens onto. A phone keyboard over them would hide the promise being kept.
  if (el.finder.hidden) openSearch('list');
  else closeSearch();
});

// The destinations list. Delegated and by index, the same contract `#results` uses:
// `renderOrigins` writes `originRows` and this markup in one synchronous block.
//
// **Nothing above `startWithLocation()` may await.** This is a click path to
// `getPosition`, so the transient-activation rule documented on `startWithLocation`
// governs this handler — no `await`, no dynamic `import()`, no promise before the
// call. The update button is checked first because it sits inside the row's `<li>`
// and would otherwise fall through to the row itself.
el.origins.addEventListener('click', (event) => {
  if (event.target.closest('[data-update]')) {
    void startWithLocation();
    return;
  }

  const button = event.target.closest('[data-index]');
  if (!button) return;
  const row = originRows[Number(button.dataset.index)];
  if (!row) return;

  if (row.kind === 'gps') {
    void startWithLocation();
    return;
  }
  choosePlace(row.place);
});

el.search.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = null;

  const panel = applyFinder();
  if (panel.shouldSearch) {
    pendingQuery = panel.query;
    debounce = setTimeout(() => {
      // Cleared before the call, so `debounce` means "a search is still pending"
      // and `commitSearch` can tell whether it has anything to flush.
      debounce = null;
      void startSearch(pendingQuery);
    }, SEARCH_DEBOUNCE_MS);
    return;
  }

  // Below two characters nothing will be asked for, so the previous answer goes
  // with the query it answered — otherwise a backspace leaves "No address
  // matched." under a box that is no longer searching for anything. No repaint
  // is needed for it: `finderState` reads neither `results` nor `status` once
  // the query is that short.
  searchResults = [];
  searchStatus = 'idle';
});

/**
 * Empties the box without closing the panel. **Synchronous throughout, and it must
 * stay that way** — this is a click handler, and an `await` anywhere on it spends
 * the transient activation that the location button one panel up still needs (see
 * the iOS note in AGENTS.md). Nothing here needs the network, so there is nothing
 * to await.
 *
 * The debounce is cancelled first: a keystroke still pending would otherwise fire
 * 250 ms later and repopulate the list the user just cleared. `focus()` is last, so
 * the phone keyboard never drops — clearing a typo and retyping is one gesture.
 *
 * It empties the box back to the idle panel rather than to nothing, so the Recent
 * list is what a cleared field shows.
 */
el.finderClear.addEventListener('click', () => {
  clearTimeout(debounce);
  debounce = null;
  el.search.value = '';
  searchResults = [];
  searchStatus = 'idle';
  activeIndex = -1;
  applyFinder();
  el.search.focus();
});

// `enterkeyhint="search"` is what puts Enter on a phone keyboard; this is what it
// does. `preventDefault` because the input has no form to submit and Safari would
// otherwise treat Enter as a native search-field commit.
//
// The arrows move the highlight and wrap at both ends, which `moveActive` decides.
// They `preventDefault` too: in a text field the browser would otherwise send the
// caret to one end of the query instead.
el.search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex = moveActive(activeIndex, event.key === 'ArrowDown' ? 1 : -1, searchRows.length);
    setActive(activeIndex);
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void commitSearch();
});

// Escape closes the panel. The dialog handles its own Escape natively and its
// `close` listener opens the finder immediately afterwards, so this must stand
// down while the dialog is up — otherwise one key would open the finder and shut
// it again in the same breath. Two guards, no second dialog handler.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (el.intro.open || el.finder.hidden) return;
  closeSearch();
});

// Delegated, and by index rather than by code: an address has no unique key the
// client knows, and `applyFinder` writes `searchRows` and this markup in one
// synchronous block so the index can only ever address the array behind it.
el.results.addEventListener('click', (event) => {
  const row = event.target.closest('[data-index]');
  if (!row) return;
  choosePlace(searchRows[Number(row.dataset.index)]?.place);
});

// "Got it" retires the tip outright rather than counting one more showing: the
// rider has said the lesson landed, so `dismissedHintRecord()` jumps straight to
// the ceiling and it never comes back — on the first showing or the third. The
// three-showing count is the backstop for someone who never presses anything.
el.coachDismiss.addEventListener('click', () => {
  el.coach.hidden = true;
  write(HINT_KEY, dismissedHintRecord());
});

el.board.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pin]');
  if (button) togglePin(button.dataset.pin);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Coming back after a while: re-check where we are before re-checking times.
  // This used to test `lastLoc` alone, which asked a place-mode user — who
  // usually holds no fix at all — for their location on every single focus.
  if (shouldRelocateOnFocus(origin, lastLoc, Date.now())) void locate();
  else void refreshArrivals();
});

setInterval(() => void refreshArrivals(), REFRESH_MS);
setInterval(paintBodies, TICK_MS);

/**
 * Which journey this visit is. `decideBoot` owns the decision; this only applies
 * it, synchronously and with no request of its own.
 */
function boot() {
  const decision = decideBoot({
    originRaw: readRaw(ORIGIN_KEY),
    locRaw: readRaw(LOC_KEY),
    pinCount: pins.length,
    now: Date.now(),
  });

  if (decision.persist) {
    writeOrigin(decision.origin);
  } else if (decision.origin?.mode === 'place' && storedOriginMode() !== 'place') {
    // The legacy `{mode:'stop'}` record, migrated. `decideBoot` says
    // `persist: false` — correctly, because a returning user is not being
    // grandfathered, they already had a door — but the migrated record is worth
    // writing back once so the next visit reads a place record directly. The
    // coordinate is already in hand, so the governing rule is satisfied.
    // `writeOrigin` applies the tagline and the chip on its way through.
    writeOrigin(decision.origin);
  } else {
    origin = decision.origin;
    // A returning place-mode visitor persists nothing on boot, so the tagline and
    // the chip have to be applied here too — otherwise the masthead claims "stops
    // nearest you" over a board ranked around an address they may be nowhere near.
    applyTagline();
    renderChip();
  }

  // A first visit loads nothing and asks for nothing until a door is chosen —
  // not a board, not a position, not even the stop list behind the search box.
  if (decision.journey === 'intro') {
    showIntro();
    return;
  }

  if (decision.journey === 'place') {
    // No hatch: nothing here is waiting on a position, only on `/api/board`.
    busy(gateMessageFor(origin));
    void loadBoard(originCoord(origin, lastLoc));
    return;
  }

  void locate();
}

boot();
