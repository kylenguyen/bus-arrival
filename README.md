# Bus arrival board

Live Singapore bus arrival times. On the first visit, pick one of two doors —
your current location, or a stop code you already know — and the 8 nearest stops
to it appear with what is coming, when, and how full it is. Later visits open on
the same door with no taps. Nothing to sign up for and nothing to configure.

Stops can be pinned (★) to keep them at the top of the board regardless of where
you are. Pins, your last coordinate and which door you came in by — your location
or a stop you named — live in `localStorage`; the server stores nothing about
anyone.

Runs in **mock mode** until an LTA DataMall AccountKey is supplied, so the whole
thing is deployable and demoable today. Mock mode only has 12 synthetic stops —
enough to fill the board, but little to search through.

## The journey

1. First visit: a dialog explains the site in two sentences and offers the two
   doors. Nothing loads and nothing is asked for until one is chosen — a native
   permission prompt cannot say what it is for, so it no longer comes first.
   Dismissing the dialog opens the search box, remembers nothing, and brings it
   back next visit. Choose location and the browser asks; on HTTPS the grant is
   remembered, so a returning visitor is never asked again. Where location cannot
   possibly work — an insecure origin, or a browser without geolocation — that
   door is removed rather than offered and refused.
2. The nearest stops render in one request — stops and arrivals together.
3. In location mode the coordinate is cached locally, so repeat visits paint the
   board before the GPS fix comes back, and only re-rank if you have moved more
   than ~200 m.
4. Refused or unavailable location: the page says which of the three things went
   wrong and offers both remaining answers — enter a stop code, or try location
   again. Nothing is opened or focused for you, so the explanation stays
   readable. A returning visitor who revoked the permission keeps their cached
   board and is not interrupted at all.
5. Either way into the search box, tapping a stop there ranks the whole board
   around that stop — that stop first, then its nearest neighbours — and later
   visits open the same way, with no location request at all. A full 5-digit code
   commits on Enter, without a tap. Choosing a stop does not pin it; ★ is still
   how a stop is pinned. Distances are then metres from that stop, not a walk
   from you.
6. The chip in the masthead says which door the board is ranked from — "Near you",
   or the stop code — and opens that same box to change it. It is where the Search
   button used to be, because what the box changes is which stops the board shows,
   not just what you are looking for.

## Local run

```sh
npm install
npm run build
npm start           # http://localhost:8080, mock mode

LTA_ACCOUNT_KEY=... npm start   # against the real API
```

Geolocation needs a secure context. `localhost` counts as one; a bare LAN IP
does not, so test on localhost or through the tunnel.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `LTA_ACCOUNT_KEY` | _unset_ | DataMall key. Unset ⇒ mock mode |
| `ARRIVAL_TTL_MS` | `15000` | Arrival cache TTL |
| `STOP_REFRESH_MS` | `86400000` | Stop-list reload interval |
| `UPSTREAM_TIMEOUT_MS` | `8000` | DataMall request timeout |

## Getting the API key

1. Register for a DataMall account at LTA's developer portal and request an
   AccountKey. It is free; approval is not instant.
2. Put it in a Secret — do not commit it, and do not paste it into a chat:

   ```sh
   kubectl create secret generic lta-datamall --from-literal=accountKey='YOUR_KEY'
   kubectl rollout restart deployment/bus-arrival
   ```

3. Once it works, drop `optional: true` from the `secretKeyRef` in
   `k8s/bus-arrival.yaml` so a missing key fails loudly instead of silently
   serving synthetic timings.

## Endpoints

| Route | Notes |
| --- | --- |
| `GET /healthz` | Readiness, stop count, mock flag, and upstream call counters (`upstreamCalls` since boot, `upstreamCallsPerMin` over the trailing 60 s, `breakerOpen`). Publicly reachable, so it stays at the level of traffic volume — nothing per-IP or per-stop |
| `GET /api/board?lat=&lon=&limit=&pinned=` | The whole page in one call: nearest stops (plus pinned) with arrivals attached. `no-store`, not logged. Missing or out-of-range coordinates return `located: false` and only the pinned stops |
| `GET /api/arrivals?stops=a,b,c` | Refresh path. Arrivals only, for the cards the client can see |
| `GET /api/stops?q=` | Search fallback, by code, description or road |

Both stop-list parameters are capped at 8 codes per request so a single caller
cannot fan out across the whole feed.

## Design notes

- **Phone first.** This is read standing at a stop, so the phone layout is the
  base stylesheet and the wide screen is the override. Each service is a
  four-column row — number, then the next three buses — with every bus showing
  its own crowding label, so occupancy for the bus after next is as readable as
  for the one arriving. Below ~344 px the third bus is dropped rather than
  letting the columns crush each other. Tap targets are 44 px, gutters follow
  the safe-area insets, and the search input stays at 16 px so iOS does not
  zoom the page on focus.
- **One request per paint.** First load is a single `/api/board` call rather
  than one call to rank stops and eight to fill them in. On the 30-second
  refresh the client sends only the codes currently on screen (plus pinned
  ones), so a long board does not cost a long board's worth of quota.
- **No database.** The stop list is a few thousand rows; it is loaded into
  memory on boot, refreshed daily, and both search and nearest-neighbour are
  linear scans. Nothing to keep in sync.
- **Quota safety.** DataMall is one request per stop, so a full 8-stop board is
  8 requests. They run 5 at a time, are cached for 15s with in-flight
  de-duplication (concurrent viewers of a stop cost one upstream call), and a
  stop whose call fails degrades to "timings unavailable" instead of blanking
  the board. Background tabs stop polling entirely.
- **Privacy.** Coordinates are used to rank stops and discarded; `/api/board`
  sets `no-store` and nothing identifiable is logged. Keep it that way — once
  other people use this, PDPA is in scope.

## Before sharing the link

- Endpoint paths and field names in `src/lta.ts` match API User Guide v6.9
  (3 Aug 2026), §2.1 Bus Arrival and §2.4 Bus Stops — checked 10 Aug 2026, PDF
  in `docs/`. Re-verify only if LTA publishes a later guide. The code has still
  only been exercised against the mock and the stub, so watch the logs on the
  first real call.
- Check DataMall's terms on redistributing their data before exposing
  `/api/*` as a public API rather than as the UI's own backend.
- Confirm your account's rate limit against the fan-out above and raise
  `ARRIVAL_TTL_MS` if the board turns out to be too expensive.
