// Bus arrival board — no framework, no build step.
//
// A first visit opens a dialog with two doors: use my current location, or enter
// a stop code. Nothing loads and no request fires until one is chosen, because
// the site cannot explain itself from behind a native permission prompt. Both
// doors reduce to a coordinate, and `/api/board` does not care which one it came
// from — stop mode is "rank stops around a fixed place", not a second rendering
// path. A returning visit skips the dialog entirely and paints the board from
// whichever door was used last. Search and pinning stay out of the way until
// asked for.
//
// Three localStorage keys, all client-side; the server is told a coordinate to
// rank stops by and remembers nothing:
//   bus-board.pins.v1    stops kept at the top of the board
//   bus-board.loc.v1     the last GPS fix and its age — the sole owner of both
//   bus-board.origin.v1  which door: {mode:'gps'} or {mode:'stop', code, lat, lon}
//
// The decisions live in ./origin.js (pure, unit tested); this file is the glue —
// elements, `fetch`, `localStorage`, event wiring, and one assignment per apply
// site. Keep new rules on that side of the line.

import {
  boardParams,
  chipState,
  commitDecision,
  decideBoot,
  delistedNote,
  distanceLabel,
  gateMessageFor,
  gateState,
  introVariant,
  isUsableStopCoord,
  noStopsMessage,
  originCoord,
  readOriginRecord,
  refusalCopy,
  shouldRelocateOnFocus,
  shouldShowDelistedNote,
  taglineFor,
} from './origin.js';

const PINS_KEY = 'bus-board.pins.v1';
const LOC_KEY = 'bus-board.loc.v1';
// Which door the board is ranked from: {mode:'gps'} or {mode:'stop', code, …}.
// LOC_KEY stays the sole owner of the fix and its age, so the gps record carries
// no coordinate — it is one bit.
const ORIGIN_KEY = 'bus-board.origin.v1';

const NEARBY_LIMIT = 8;
const REFRESH_MS = 30_000; // arrivals refetch, visible cards only
const TICK_MS = 10_000; // local re-render so minutes count down between fetches
const LOC_MAX_AGE_MS = 12 * 60 * 60 * 1000; // cached coordinate still worth a first paint
const MOVED_M = 200; // re-rank the board once the live fix differs by this much
const SEARCH_DEBOUNCE_MS = 250;

const el = {
  originChip: document.getElementById('origin-chip'),
  finder: document.getElementById('finder'),
  useLocation: document.getElementById('use-location'),
  search: document.getElementById('search'),
  results: document.getElementById('results'),
  finderNote: document.getElementById('finder-note'),
  gate: document.getElementById('gate'),
  gateMsg: document.getElementById('gate-msg'),
  gateAction: document.getElementById('gate-action'),
  gateAlt: document.getElementById('gate-alt'),
  boardNote: document.getElementById('board-note'),
  board: document.getElementById('board'),
  status: document.getElementById('status'),
  tagline: document.getElementById('tagline'),
  intro: document.getElementById('intro'),
  introGps: document.getElementById('intro-gps'),
  introGpsSub: document.getElementById('intro-gps-sub'),
  introNoGps: document.getElementById('intro-no-gps'),
  introCode: document.getElementById('intro-code'),
};

/** @type {Array<{code: string, description: string, roadName: string}>} */
let pins = readPins();
/** @type {{lat: number, lon: number, at: number} | null} */
let lastLoc = readLoc();
/** @type {{mode: 'gps' | 'stop', code?: string, lat?: number, lon?: number} | null} */
let origin = readOrigin();
/** @type {Array<object>} */
let board = [];
/**
 * The last search response, parsed. Held here rather than in DOM attributes so a
 * result's coordinate never has to be written into the markup and read back out.
 * @type {Array<{code: string, description: string, roadName: string, lat: number, lon: number}>}
 */
let searchResults = [];
let shellSignature = '';
let loadingBoard = false;
let pendingLoad;
/** Set once the server admits the timings are synthetic; never unset. */
let mockActive = false;
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
 * The only writer of ORIGIN_KEY. The governing rule — persist an origin only
 * when a coordinate is actually in hand — is enforced by keeping the call sites
 * to four: a successful fix in `startWithLocation()`, a stop chosen from search
 * (via `switchOrigin`), `boot()`'s grandfather branch, and `switchOrigin()`
 * putting back a record whose board would not load. Denials, dismissals and typos
 * persist nothing, which is why a half-finished first run degrades to a first run.
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

/** The same shape as `note()`, for the line that sits above the board. */
function boardNote(message) {
  el.boardNote.textContent = message ?? '';
  el.boardNote.hidden = !message;
}

/**
 * Mock mode's warning outranks the tagline: "Stops near 20021, live from LTA"
 * over synthetic timings is a false claim about live data, in exactly the
 * environment used for manual testing.
 */
function applyTagline() {
  if (!mockActive) el.tagline.textContent = taglineFor(origin);
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

function hideGate() {
  el.gate.hidden = true;
  el.gateAction.onclick = null;
  el.gateAlt.onclick = null;
}

// --- rendering ----------------------------------------------------------

/** Minutes until arrival, floored, from the server's ISO timestamp. */
function minutesUntil(iso) {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 60_000);
}

const LOAD_LABEL = { SEA: 'Seats', SDA: 'Standing', LSD: 'Crowded' };
const LOAD_TITLE = {
  SEA: 'Seats available',
  SDA: 'Standing room available',
  LSD: 'Limited standing — crowded',
};

/**
 * One arrival: minutes stacked over that bus's own crowding label. Every bus
 * carries its own load, so a full bus now and an empty one in nine minutes is
 * visible at a glance on a phone.
 */
function renderEta(bus, index) {
  const classes = ['eta'];
  if (index === 0) classes.push('eta-lead');

  if (!bus || !bus.estimatedArrival) {
    return `<div class="${classes.join(' ')} eta-empty">
      <span class="eta-value">–</span><span class="eta-load"></span>
    </div>`;
  }

  const mins = minutesUntil(bus.estimatedArrival);
  if (mins <= 1) classes.push('arriving');
  if (!bus.monitored) classes.push('scheduled');

  const value =
    mins <= 0
      ? '<span class="eta-value">Arr</span>'
      : `<span class="eta-value">${mins}${
          index === 0 ? '<span class="eta-unit">min</span>' : ''
        }</span>`;

  const label = bus.load && LOAD_LABEL[bus.load] ? LOAD_LABEL[bus.load] : '';
  const load = label
    ? `<span class="eta-load load-${escape(bus.load.toLowerCase())}" title="${escape(
        LOAD_TITLE[bus.load],
      )}">${escape(label)}</span>`
    : '<span class="eta-load"></span>';

  const title = bus.monitored ? '' : ' title="Scheduled timing — bus not currently tracked"';
  return `<div class="${classes.join(' ')}"${title}>${value}${load}</div>`;
}

/** Vehicle facts that belong to the service line, tucked under its number. */
function renderTags(bus) {
  if (!bus) return '';
  const tags = [];
  if (bus.type === 'DD') tags.push('<span class="tag" title="Double deck">DD</span>');
  if (bus.type === 'BD') tags.push('<span class="tag" title="Bendy bus">Bendy</span>');
  if (bus.wheelchairAccessible) {
    tags.push(
      '<span class="tag tag-icon" title="Wheelchair accessible" aria-label="Wheelchair accessible">♿</span>',
    );
  }
  return tags.length > 0 ? `<span class="service-tags">${tags.join('')}</span>` : '';
}

function renderServices(stop) {
  if (stop.services === null) return '<p class="card-msg">Timings unavailable — will retry.</p>';
  if (stop.services.length === 0) {
    return '<p class="card-msg">No buses at this hour.</p>';
  }

  const rows = stop.services
    .map(
      (service) => `
      <li class="service">
        <div class="service-id">
          <span class="service-no">${escape(service.serviceNo)}</span>
          ${renderTags(service.buses[0])}
        </div>
        ${renderEta(service.buses[0], 0)}
        ${renderEta(service.buses[1], 1)}
        ${renderEta(service.buses[2], 2)}
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
      // is one decision: a walk from the user, metres from the named stop, or
      // "(This stop)" on the card the board is ranked from.
      const distance = distanceLabel(stop, origin);
      return `
      <article class="card${stop.pinned ? ' pinned' : ''}" data-code="${escape(stop.code)}">
        <div class="card-head">
          <div class="card-title">
            <span class="card-name">${escape(stop.description)}</span>
            <span class="card-sub">
              <span class="meta-where"><span class="meta-code">${escape(stop.code)}</span>${
                stop.roadName ? `&nbsp;· ${escape(stop.roadName)}` : ''
              }</span>
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
 * Whether the origin stop is genuinely gone from LTA's list, applied to the line
 * above the board. Two call sites — a fresh board, and a restored one after a
 * failed switch — so the rule is applied in one place rather than mirrored.
 */
function applyBoardNote() {
  boardNote(shouldShowDelistedNote(origin, board) ? delistedNote(origin) : '');
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
    // gps mode sends the last fix, stop mode the chosen stop's own coordinate,
    // and no caller gets to pick the wrong one. `loc` survives only as the
    // coalescing value above and the retry closure below.
    const coord = originCoord(origin, lastLoc);

    const query = boardParams({ origin, lastLoc, pins, limit: NEARBY_LIMIT });
    const res = await fetch(`/api/board?${query}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();

    board = data.stops ?? [];
    applyBoardNote();
    if (board.length > 0) hideGate();
    else if (coord) {
      gate(noStopsMessage(origin), {
        label: 'Try again',
        // Only a gps origin is worth sending back to geolocation; in stop mode the
        // retry re-runs the same load.
        onClick: origin?.mode === 'gps' ? () => void locate(true) : () => void loadBoard(coord),
      });
    }
    render();
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

function flagMock() {
  // First, not last: from here on the tagline belongs to this warning, so no
  // later origin switch can quietly replace it with "live from LTA".
  mockActive = true;
  el.tagline.textContent = 'Demo data — no LTA API key configured yet';
  el.tagline.classList.add('mock');
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
 * asked for. A tap is always answered — a stop-mode user pressing "Use my current
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
    { label: 'Enter a stop code', onClick: startWithCode },
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
 * two would otherwise ask a stop-mode user for their location.
 *
 * Nothing is persisted on success: an origin record is the precondition for
 * getting here, so it is already in storage.
 */
async function locate(force = false) {
  if (origin?.mode !== 'gps') return;

  const fresh = lastLoc && Date.now() - lastLoc.at < LOC_MAX_AGE_MS;

  if (board.length === 0) gate(gateMessageFor(origin));

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

// --- search fallback ----------------------------------------------------

/** The pending keystroke debounce, or null when no search is waiting to fire. */
let debounce = null;
/**
 * The last search request failed outright, rather than matching nothing. The two
 * are different answers and `commitDecision` cannot tell them apart — it is handed
 * a result list, and "empty because nothing matched" looks identical from there to
 * "empty because we never got to ask". Enter reads this before overwriting the
 * note, so an offline commit does not blame the stop for the network.
 */
let searchUnavailable = false;

/** Ticks the location button when gps is the mode the board is already using. */
function applyModePressed() {
  el.useLocation.setAttribute('aria-pressed', String(origin?.mode === 'gps'));
}

function openSearch() {
  el.finder.hidden = false;
  el.originChip.setAttribute('aria-expanded', 'true');
  applyModePressed();
  el.search.focus();
}

function closeSearch() {
  // Whether focus has to be put somewhere: the button that closed the panel may
  // have been inside it (`#use-location`, a result), and hiding the focused
  // element drops focus to the body. Called with the panel already shut — the
  // gate's retry does that — this leaves focus wherever it is.
  const wasOpen = !el.finder.hidden;

  // A keystroke still in the debounce would otherwise fire into a closed panel and
  // repopulate `searchResults` after they were cleared, leaving Enter to commit
  // against a list nobody can see.
  clearTimeout(debounce);
  debounce = null;

  el.finder.hidden = true;
  el.originChip.setAttribute('aria-expanded', 'false');
  applyModePressed();
  el.results.hidden = true;
  el.results.innerHTML = '';
  searchResults = [];
  searchUnavailable = false;
  note('');

  if (wasOpen) el.originChip.focus();
}

let searchSeq = 0;

async function runSearch(query) {
  // Below two characters there is nothing to ask for: `/api/stops` answers 400.
  if (query.trim().length < 2) {
    el.results.hidden = true;
    searchResults = [];
    searchUnavailable = false;
    note('');
    return;
  }
  const seq = ++searchSeq;
  try {
    const res = await fetch(`/api/stops?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (seq !== searchSeq) return; // a newer keystroke already won

    const stops = data.stops ?? [];
    // Kept whole, before rendering: `chooseStop` needs each result's coordinate,
    // and holding the array here keeps coordinates out of DOM attributes.
    searchResults = stops;
    searchUnavailable = false;
    if (stops.length === 0) {
      el.results.hidden = true;
      note('No stops matched.');
      return;
    }
    el.results.innerHTML = stops
      .map(
        (stop) => `
        <li>
          <button class="result-btn" type="button" data-code="${escape(stop.code)}">
            <span class="result-code">${escape(stop.code)}</span>
            <span class="result-name">${escape(stop.description)}
              <span class="result-road">${escape(stop.roadName)}</span>
            </span>
          </button>
        </li>`,
      )
      .join('');
    el.results.hidden = false;
    note('');
  } catch {
    if (seq === searchSeq) {
      searchUnavailable = true;
      note('Search is unavailable right now.');
    }
  }
}

/**
 * Enter in the finder. `commitDecision` is the whole decision; this switch only
 * applies it.
 *
 * The flush is not optional. Enter arrives on the same reach as the last digit, so
 * a 250 ms debounce is routinely still pending when it lands — and deciding against
 * the results from four digits ago answers "No stop with code 43179." for a stop
 * that exists. Awaiting the search first costs nothing here: no transient
 * activation is at stake on this path (that constraint belongs to
 * `startWithLocation`), and `runSearch` still asks for nothing below two
 * characters, so a one-character query fires no request.
 */
async function commitSearch(value) {
  if (debounce !== null) {
    clearTimeout(debounce);
    debounce = null;
    await runSearch(value);
  }

  // The box already explains that the search itself failed; "No stop with code
  // 43179." would replace that with a claim about the stop.
  if (searchUnavailable) return;

  const decision = commitDecision(value, searchResults);
  switch (decision.action) {
    case 'choose':
      chooseStop(decision.code);
      break;
    case 'note':
      note(decision.message);
      break;
    default:
      // 'wait' — several stops matched a name and the list is on screen. Picking
      // the first one would be guessing on the user's behalf.
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
 * A tapped search result becomes the origin. This replaced pin-on-tap: a tap now
 * re-ranks the board around that stop rather than adding a ninth card to it, and
 * ★ is still how a stop is pinned.
 */
function chooseStop(code) {
  const stop = searchResults.find((s) => s.code === code);
  if (!stop || !isUsableStopCoord(stop.lat, stop.lon)) {
    // A real `0,0` stop: `search()` keeps those findable while `nearby()` drops
    // them, so a result can be perfectly tappable and still impossible to rank
    // from. The "no such stop" wording is reused rather than a second sentence
    // invented for a distinction the user has no way to see. `commitDecision`
    // returns this same sentence for the Enter path — keep the two in step.
    note(`No stop with code ${code}.`);
    return;
  }
  void switchOrigin({
    mode: 'stop',
    code: stop.code,
    description: stop.description,
    roadName: stop.roadName,
    lat: stop.lat,
    lon: stop.lon,
  });
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
  boardNote('');
  gate(gateMessageFor(origin));

  const loaded = await loadBoard(originCoord(origin, lastLoc));
  if (loaded !== false) return;

  writeOrigin(previousOrigin);
  shellSignature = '';
  render();
  applyBoardNote();
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
 * The first-visit chooser. Two doors and a sentence about what the site is,
 * because a native permission prompt cannot explain either.
 *
 * When location cannot possibly work — an insecure context, or no geolocation at
 * all — the button is *removed* rather than hidden or disabled. A hidden button is
 * still nothing; a disabled one is a keyboard stop and a screen-reader
 * announcement for a promise the page cannot keep. Its sub-label goes with it, or
 * "Stops nearest you" is left captioning nothing.
 */
function showIntro() {
  if (introSeen) return;
  introSeen = true;

  const variant = introVariant({
    isSecureContext: window.isSecureContext,
    hasGeolocation: 'geolocation' in navigator,
  });

  if (variant !== 'full') {
    el.introGps.remove();
    el.introGpsSub.remove();
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
 * and `gate()` are synchronous DOM calls for exactly that reason, and this is why
 * the retry does not go through `locate()`, which awaits a permissions query
 * first. See the comment on `getPosition`.
 */
async function startWithLocation() {
  introDoorTaken = true;
  el.intro.close(); // a no-op when it was never opened, e.g. the gate's retry
  // Also the finder's location button, which sits *inside* the panel: leaving it
  // open would stack a search box above the gate and then above the new board.
  // A no-op when the panel is already shut, and synchronous either way.
  closeSearch();
  gate(gateMessageFor(origin));

  try {
    const coords = await getPosition();
    rememberLoc(coords.latitude, coords.longitude);
    // Leaving stop mode: the shells have to be thrown away even though the load
    // below may return the very same stops in the very same order — which is
    // exactly what happens for someone standing at the stop they had named.
    // `shellSignature` does not encode the mode, so without this the cards keep
    // "(This stop)" and bare metres where walking times now belong. `switchOrigin`
    // resets for the same reason; this path does not go through it. Deliberately
    // after the fix rather than before, so a 12-second wait for a GPS that may
    // never arrive does not blank a board that is still true.
    if (origin?.mode !== 'gps') resetBoard();
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
 * The stop-code door, and the dismissal landing. Persists nothing and asks for
 * nothing — there is no coordinate in hand yet, so under the governing rule there
 * is no origin to write, and the dialog is right to come back next reload.
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

// Escape, the backdrop and a door all end here. Only a dismissal opens the
// finder: the user declined to choose, and the searchable list of stops is the
// one thing that works without deciding anything first.
el.intro.addEventListener('close', () => {
  if (introDoorTaken) return;
  openSearch();
});

el.originChip.addEventListener('click', () => {
  if (el.finder.hidden) openSearch();
  else closeSearch();
});

// The finder's other door. Same path as the intro's button, so the no-`await`
// rule above `getPosition` covers this click too.
el.useLocation.addEventListener('click', () => void startWithLocation());

el.search.addEventListener('input', (event) => {
  clearTimeout(debounce);
  const value = event.target.value;
  debounce = setTimeout(() => {
    // Cleared before the call, so `debounce` means "a search is still pending"
    // and `commitSearch` can tell whether it has anything to flush.
    debounce = null;
    void runSearch(value);
  }, SEARCH_DEBOUNCE_MS);
});

// `enterkeyhint="search"` is what puts this key on a phone keyboard; this is what
// it does. `preventDefault` because the input has no form to submit and Safari
// would otherwise treat Enter as a native search-field commit.
el.search.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void commitSearch(event.target.value);
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

el.results.addEventListener('click', (event) => {
  const button = event.target.closest('[data-code]');
  if (button) chooseStop(button.dataset.code);
});

el.board.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pin]');
  if (button) togglePin(button.dataset.pin);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Coming back after a while: re-check where we are before re-checking times.
  // This used to test `lastLoc` alone, which asked a stop-mode user — who
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
  } else {
    origin = decision.origin;
    // A returning stop-mode visitor persists nothing on boot, so the tagline and
    // the chip have to be applied here too — otherwise the masthead claims "stops
    // nearest you" over a board ranked around a stop they may be nowhere near.
    applyTagline();
    renderChip();
  }

  // A first visit loads nothing and asks for nothing until a door is chosen —
  // not a board, not a position, not even the stop list behind the search box.
  if (decision.journey === 'intro') {
    showIntro();
    return;
  }

  if (decision.journey === 'stop') {
    gate(gateMessageFor(origin));
    void loadBoard(originCoord(origin, lastLoc));
    return;
  }

  void locate();
}

boot();
