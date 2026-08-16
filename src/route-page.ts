import { escapeHtml } from './stop-page.js';
import type { RouteDirectionPayload, RouteStopJoined, RouteStopTimes } from './types.js';

/**
 * The route page's server-rendered static body — everything stable about a
 * service (both directions' full stop lists, first/last bus, operator, loop,
 * structured data) rendered to HTML at request time so a crawler's fetch of
 * /bus/:service is a complete page, not a stencil. These lists are the bulk of
 * the internal link graph: ~370 route pages each linking 20–80 stop pages.
 * Live arrivals are deliberately absent, the same rule stop-page.ts states.
 *
 * Everything here is a pure function — hand-written records in, HTML string
 * out — so the tests can feed fixtures without the server, the same bargain
 * `buildRoutes` strikes in routes.ts.
 *
 * ROUTE_STATIC_TARGET is the body-region swap anchor, verbatim from
 * public/route.html — the same exact-string whole-region pattern as the head
 * tags: the shell served unreplaced (unknown service, or /route.html via
 * express.static) is already valid, sensibly generic HTML. Edit the target in
 * the shell and the constant here in the same commit; route-page.test.ts pins
 * the pairing. The section is removed by route.js once the live view renders —
 * the interactive spine shows the same stops, and both at once would be the
 * route twice — so with JS on the reader never sees them together, and with JS
 * off this section is the page.
 */

// --- the swap target, verbatim from public/route.html -------------------------

/** The generic invite to the board — the no-JS sentence for a shell served
 *  unreplaced. Known services swap it for the full route plus JSON-LD. */
export const ROUTE_STATIC_TARGET =
  '<section id="rt-static"><p class="card-msg">Looking for a Singapore bus route? <a href="/">Open the ezbus board</a> to see every bus arriving near you, live.</p></section>';

// --- display formatting --------------------------------------------------------

/** The service facts the static body needs — `RouteService` satisfies it
 *  structurally, and the tests can hand-write it without a directions Map. */
export interface RouteStaticInfo {
  serviceNo: string;
  operator: string;
  loop: boolean;
  /** Empty string for a normal two-direction service, as RouteService spells it. */
  loopDesc: string;
}

/** DataMall HHMM: hours 00-23, minutes 00-59 — the same rule stop-page.ts
 *  applies, so '' and '-' render as the en dash, never as a time. */
const HHMM_RE = /^([01]\d|2[0-3])([0-5]\d)$/;

const fmtHHMM = (hhmm: string): string | null => {
  const match = HHMM_RE.exec(hhmm.trim());
  return match ? `${match[1]}:${match[2]}` : null;
};

/** One day-type's span, "05:30 – 23:30", or null when the feed has neither end. */
const daySpan = (
  first: RouteStopTimes | null,
  last: RouteStopTimes | null,
  day: 'wd' | 'sat' | 'sun',
): string | null => {
  const from = first ? fmtHHMM(first[day]) : null;
  const to = last ? fmtHHMM(last[day]) : null;
  if (!from && !to) return null;
  return `${from ?? '–'} – ${to ?? '–'}`;
};

/** "first bus – last: weekdays 05:30 – 23:30 · Sat … · Sun …", or '' with no data. */
const timesLine = (direction: RouteDirectionPayload): string => {
  const spans: Array<[string, string | null]> = [
    ['weekdays', daySpan(direction.firstBus, direction.lastBus, 'wd')],
    ['Sat', daySpan(direction.firstBus, direction.lastBus, 'sat')],
    ['Sun', daySpan(direction.firstBus, direction.lastBus, 'sun')],
  ];
  const parts = spans
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, span]) => `${label} ${span}`);
  return parts.length === 0 ? '' : `first bus – last: ${parts.join(' · ')}`;
};

// --- the static body -------------------------------------------------------------

/**
 * The full route as crawlable HTML: one card per direction — heading, first/last
 * bus, and a real `<ol>` of every stop in seq order, each linked to its stop
 * page — plus the operator line. Duplicated codes stay duplicated: a loop
 * legitimately calls at its origin twice, and collapsing the pair would
 * straighten the loop into a line (the duplicates are the two ends of the list,
 * never adjacent, so the repeated link reads fine). A join-miss stop arrives
 * with its code as description and no road, and renders exactly that — the same
 * degradation /api/route/:service documents. Empty input (cold route index)
 * collapses to the shell's own generic section.
 */
export const buildRouteStatic = (
  service: RouteStaticInfo,
  directions: RouteDirectionPayload[],
): string => {
  if (directions.length === 0) return ROUTE_STATIC_TARGET;
  const no = escapeHtml(service.serviceNo);
  const cards = directions
    .map((direction) => {
      const heading = service.loop
        ? `⟲ Loop at ${escapeHtml(service.loopDesc || direction.origin.description)}`
        : `To ${escapeHtml(direction.destination.description)}`;
      const meta = [`${direction.stops.length} stops`, timesLine(direction)]
        .filter(Boolean)
        .join(' · ');
      const rows = direction.stops
        .map((stop) => {
          const road = stop.roadName ? `<span class="nb-sub">${escapeHtml(stop.roadName)}</span>` : '';
          return (
            `<li><a href="/stop/${escapeHtml(stop.code)}">` +
            `<span class="nb-name">${escapeHtml(stop.description)}</span>${road}</a></li>`
          );
        })
        .join('');
      return (
        `<div class="card rt-dir">` +
        `<div class="card-head"><div class="card-title">` +
        `<h2 class="rt-dir-head">${heading}</h2>` +
        `<p class="rt-dir-meta">${meta}</p>` +
        `</div></div>` +
        `<ol class="rt-stops">${rows}</ol>` +
        `</div>`
      );
    })
    .join('');
  const operator = service.operator
    ? `<p class="honesty">Operated by ${escapeHtml(service.operator)}.</p>`
    : '';
  return (
    `<section id="rt-static" aria-label="All stops on bus ${no}">` +
    `<p class="rt-sec">Bus ${no} — all stops</p>` +
    cards +
    operator +
    `</section>`
  );
};

// --- structured data ---------------------------------------------------------------

/**
 * JSON-LD: the Home → Buses → this service BreadcrumbList and an ItemList of
 * the first direction's stops (name + url per element) — no invented schema
 * types. Built as objects and serialised with JSON.stringify — never
 * string-concatenated — then every `<` escaped to the JSON escape
 * (backslash-u003c), the same anti-`</script` treatment as buildStopJsonLd.
 */
export const buildRouteJsonLd = (
  serviceNo: string,
  stops: Array<Pick<RouteStopJoined, 'code' | 'description'>>,
): string => {
  const url = `https://ezbus.sg/bus/${serviceNo}`;
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ezbus', item: 'https://ezbus.sg/' },
      { '@type': 'ListItem', position: 2, name: 'Buses', item: 'https://ezbus.sg/buses' },
      { '@type': 'ListItem', position: 3, name: `Bus ${serviceNo}`, item: url },
    ],
  };
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Stops on bus ${serviceNo}`,
    numberOfItems: stops.length,
    itemListElement: stops.map((stop, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: stop.description,
      url: `https://ezbus.sg/stop/${stop.code}`,
    })),
  };
  const json = JSON.stringify([breadcrumb, itemList]).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
};
