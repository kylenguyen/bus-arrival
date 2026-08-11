// Bus arrival board — no framework, no build step.
//
// The whole journey is: open the page, allow location once, read the nearest
// stops. Everything else (search, pinning) is a fallback or a convenience and
// stays out of the way until asked for.
//
// Location and pins live in localStorage. The server is told a coordinate to
// rank stops by and remembers nothing.

const PINS_KEY = 'bus-board.pins.v1';
const LOC_KEY = 'bus-board.loc.v1';

const NEARBY_LIMIT = 8;
const REFRESH_MS = 30_000; // arrivals refetch, visible cards only
const TICK_MS = 10_000; // local re-render so minutes count down between fetches
const LOC_MAX_AGE_MS = 12 * 60 * 60 * 1000; // cached coordinate still worth a first paint
const MOVED_M = 200; // re-rank the board once the live fix differs by this much
const SEARCH_DEBOUNCE_MS = 250;

const el = {
  searchToggle: document.getElementById('search-toggle'),
  finder: document.getElementById('finder'),
  search: document.getElementById('search'),
  results: document.getElementById('results'),
  finderNote: document.getElementById('finder-note'),
  gate: document.getElementById('gate'),
  gateMsg: document.getElementById('gate-msg'),
  gateAction: document.getElementById('gate-action'),
  board: document.getElementById('board'),
  status: document.getElementById('status'),
  tagline: document.getElementById('tagline'),
};

/** @type {Array<{code: string, description: string, roadName: string}>} */
let pins = readPins();
/** @type {{lat: number, lon: number, at: number} | null} */
let lastLoc = readLoc();
/** @type {Array<object>} */
let board = [];
let shellSignature = '';
let loadingBoard = false;
let pendingLoad;
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

function formatDistance(metres) {
  if (typeof metres !== 'number') return '';
  const walk = Math.max(1, Math.round(metres / 80)); // ~80 m/min, rough by design
  const shown = metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
  return `${shown} · ${walk} min walk`;
}

function note(message) {
  el.finderNote.textContent = message ?? '';
  el.finderNote.hidden = !message;
}

function gate(message, actionLabel, onAction) {
  el.gate.hidden = false;
  el.gateMsg.textContent = message;
  el.gateAction.hidden = !actionLabel;
  if (actionLabel) {
    el.gateAction.textContent = actionLabel;
    el.gateAction.onclick = onAction;
  }
}

function hideGate() {
  el.gate.hidden = true;
  el.gateAction.onclick = null;
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
    .map(
      (stop) => `
      <article class="card${stop.pinned ? ' pinned' : ''}" data-code="${escape(stop.code)}">
        <div class="card-head">
          <div class="card-title">
            <span class="card-name">${escape(stop.description)}</span>
            <span class="card-sub">
              <span class="meta-where"><span class="meta-code">${escape(stop.code)}</span>${
                stop.roadName ? `&nbsp;· ${escape(stop.roadName)}` : ''
              }</span>
              ${
                typeof stop.distanceM === 'number'
                  ? `<span class="meta-dist">${escape(formatDistance(stop.distanceM))}</span>`
                  : ''
              }
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
      </article>`,
    )
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

// --- data ---------------------------------------------------------------

function stamp(when) {
  el.status.textContent = `Updated ${new Date(when).toLocaleTimeString('en-SG', { hour12: false })}`;
}

async function loadBoard(loc) {
  // A pin toggled while the previous load is in flight must not be dropped, so
  // coalesce rather than ignore.
  if (loadingBoard) {
    pendingLoad = loc ?? lastLoc;
    return;
  }
  loadingBoard = true;
  try {
    const params = new URLSearchParams({ limit: String(NEARBY_LIMIT) });
    if (loc) {
      params.set('lat', String(loc.lat));
      params.set('lon', String(loc.lon));
    }
    if (pins.length > 0) params.set('pinned', pins.map((p) => p.code).join(','));

    const res = await fetch(`/api/board?${params}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();

    board = data.stops ?? [];
    if (board.length > 0) hideGate();
    else if (loc) gate('No bus stops found near you.', 'Try again', () => void locate(true));
    render();
    stamp(data.fetchedAt);
    if (data.mock) flagMock();
  } catch {
    if (board.length === 0) {
      gate('Could not load stops. Check your connection.', 'Try again', () => void loadBoard(loc));
    }
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

function onLocationRefused(err) {
  if (board.length > 0) return; // already showing something useful
  const denied = err && err.code === 1;
  gate(
    denied
      ? 'Location is blocked for this site. Allow it in your browser settings, or search for a stop instead.'
      : 'Could not get your location. Search for a stop instead, or try again.',
    'Try again',
    () => void locate(true),
  );
  openSearch();
}

async function locate(force = false) {
  const fresh = lastLoc && Date.now() - lastLoc.at < LOC_MAX_AGE_MS;

  if (board.length === 0) gate('Finding stops near you…');

  // Paint from the last known coordinate first — a returning visitor sees the
  // board immediately rather than watching a spinner wait on the GPS.
  if (fresh && !force) void loadBoard(lastLoc);

  // A previously denied permission would otherwise fail silently every visit.
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

function openSearch() {
  el.finder.hidden = false;
  el.searchToggle.setAttribute('aria-expanded', 'true');
  el.search.focus();
}

function closeSearch() {
  el.finder.hidden = true;
  el.searchToggle.setAttribute('aria-expanded', 'false');
  el.results.hidden = true;
  el.results.innerHTML = '';
  note('');
}

let searchSeq = 0;

async function runSearch(query) {
  if (query.trim().length < 2) {
    el.results.hidden = true;
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
    if (stops.length === 0) {
      el.results.hidden = true;
      note('No stops matched.');
      return;
    }
    el.results.innerHTML = stops
      .map(
        (stop) => `
        <li>
          <button class="result-btn" type="button" data-add="${escape(stop.code)}">
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
    if (seq === searchSeq) note('Search is unavailable right now.');
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
  void loadBoard(lastLoc);
}

function pinByCode(code) {
  if (!pins.some((p) => p.code === code)) {
    pins = [...pins, { code, description: code, roadName: '' }];
    write(PINS_KEY, pins);
  }
  closeSearch();
  el.search.value = '';
  void loadBoard(lastLoc);
}

// --- wiring -------------------------------------------------------------

el.searchToggle.addEventListener('click', () => {
  if (el.finder.hidden) openSearch();
  else closeSearch();
});

let debounce = null;
el.search.addEventListener('input', (event) => {
  clearTimeout(debounce);
  const value = event.target.value;
  debounce = setTimeout(() => void runSearch(value), SEARCH_DEBOUNCE_MS);
});

el.results.addEventListener('click', (event) => {
  const button = event.target.closest('[data-add]');
  if (button) pinByCode(button.dataset.add);
});

el.board.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pin]');
  if (button) togglePin(button.dataset.pin);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Coming back after a while: re-check where we are before re-checking times.
  if (!lastLoc || Date.now() - lastLoc.at > 5 * 60_000) void locate();
  else void refreshArrivals();
});

setInterval(() => void refreshArrivals(), REFRESH_MS);
setInterval(paintBodies, TICK_MS);

void locate();
