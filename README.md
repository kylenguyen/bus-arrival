# ezbus — live bus arrival times for Singapore

Live Singapore bus arrival times, served at [ezbus.sg](https://ezbus.sg). On the
first visit, pick one of two doors —
your current location, or an address you already know — and the 8 nearest stops
to it appear with what is coming, when, and how full it is. An address is a
6-digit postal code, a building name or a road; a 5-digit stop code still works
too, for the estates the address data has not caught up with. Later visits open
on the same door with no taps. Nothing to sign up for and nothing to configure.

Stops can be pinned (★) to keep them at the top of the board regardless of where
you are. Four things live in `localStorage` and nowhere else — pins, your last
coordinate, which door you came in by (your location, or an address you named),
and the last five addresses you chose. The server stores nothing about anyone.

Runs in **mock mode** until an LTA DataMall AccountKey is supplied, so the whole
thing is deployable and demoable today. The address finder is unaffected either
way — it searches a committed file, not DataMall — so mock mode is the one place
the two halves disagree: a Jurong postal code resolves exactly right and then
ranks 12 synthetic stops around it, the nearest of which is 15 km away. Expected,
not a bug.

## The journey

1. First visit: a dialog shows one example of what the board answers — a real
   stop card with its next arrivals — then asks, offering the two doors. Nothing
   loads and nothing is asked for until one is chosen; a native permission prompt
   cannot say what it is for, so it no longer comes first.
   Dismissing the dialog lands on a gate carrying one sentence and the same two
   doors as buttons, remembers nothing, and brings the dialog back next visit.
   Choose location and the browser asks; on HTTPS the grant is
   remembered, so a returning visitor is never asked again. Where location cannot
   possibly work — an insecure origin, or a browser without geolocation — that
   door is removed rather than offered and refused.
2. The nearest stops render in one request — stops and arrivals together.
3. In location mode the coordinate is cached locally, so repeat visits paint the
   board before the GPS fix comes back, and only re-rank if you have moved more
   than ~200 m.
4. Refused or unavailable location: the page says which of the three things went
   wrong and offers both remaining answers — enter an address, or try location
   again. Nothing is opened or focused for you, so the explanation stays
   readable. A returning visitor who revoked the permission keeps their cached
   board and is not interrupted at all.
5. Either way into the search box, tapping an address there ranks the whole board
   around it — the 8 stops nearest that address — and later visits open the same
   way, with no location request at all. A full 6-digit postal code commits on
   Enter without a tap, and so does a 5-digit stop code. Arrow keys move the
   highlight; Enter takes the highlighted row over anything typed. Choosing an
   address pins nothing; ★ is still how a stop is pinned. Distances are then
   metres and a walking time from that address.
6. The last five addresses chosen come back as one-tap rows, always on screen while
   the panel is open rather than only when the box is empty — so a place checked
   every morning is one tap from the board, and a search that is unreachable costs
   nothing. A postal code therefore has to be remembered once, which is the point —
   it is not printed on the pole the way a stop code is.
7. The chip in the masthead says which door the board is ranked from — "Near you",
   or a short form of the address — and its caret opens the list of everywhere else
   it could be: your location, then those recent addresses, then a box for one that
   is not in the list yet. The row the board is using is marked "Showing now"; the
   one control that re-runs a location fix sits inside it and says so. It is where
   the Search button used to be, because what this changes is which stops the board
   shows, not just what you are looking for.

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

The address finder adds nothing to this table, on purpose. Its data file is
committed and its path is derived from the app's own location, so there is no
setting to get wrong and nothing to configure per environment.

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
| `GET /healthz` | Readiness, stop count, address count (`places`) and the address file's vintage (`placesGeneratedAt`), mock flag, and upstream call counters (`upstreamCalls` since boot, `upstreamCallsPerMin` over the trailing 60 s, `breakerOpen`). Ready means both lists are in memory, so it stays 503 for the ~180 ms the address file takes to load. Publicly reachable, so it stays at the level of traffic volume — nothing per-IP or per-stop |
| `GET /api/board?lat=&lon=&limit=&pinned=` | The whole page in one call: nearest stops (plus pinned) with arrivals attached. `no-store`, not logged. Missing or out-of-range coordinates return `located: false` and only the pinned stops |
| `GET /api/arrivals?stops=a,b,c` | Refresh path. Arrivals only, for the cards the client can see |
| `GET /api/places?q=` | The address finder, and the only door for someone who will not share a location. Six digits resolve a postal code, five digits a stop code (an exact lookup, the escape hatch), anything else searches building and road names and returns at most 10 rows. Under 2 characters is a 400. `private, max-age=300` — the query is whatever the user typed, routinely their own home postal code, so no shared cache may hold it and it is never logged |

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
- **No database.** The stop list is a few thousand rows: loaded into memory on
  boot, refreshed daily, ranked by a linear scan. At that size a scan is well
  under a millisecond and there is nothing to keep in sync. The addresses beside
  it are 121,360 rows, which is too many for the same trick — a scan of them
  costs 3–18 ms per keystroke, and Node is single-threaded, so that time would
  sit in front of every arrival request on the pod. They are read once at
  startup into an inverted index over building and road names, which answers in
  well under a millisecond for about 38 MB of resident heap. Still no database
  and still nothing to keep in sync: the file is baked into the image and cannot
  change under a running pod.
- **Address data.** `data/sg-places.json.gz` holds 121,360 Singapore postal
  codes with their building, block, road and coordinates. It is committed on
  purpose — nothing downloads it at build time — and regenerated by hand with
  `node tools/build-places.mjs`, which is expected to happen roughly never. The
  source is a ~2020 scrape of OneMap, so estates built since then — Tengah,
  Bidadari, the newer BTO blocks — are covered patchily or not at all. That is
  why a 5-digit stop code still works: in a new estate the code on the pole may
  be the only way in. `placesGeneratedAt` on `/healthz` is how stale the data is,
  as a number. Address data © OneMap / Singapore Land Authority, under the
  Singapore Open Data Licence.
- **Design records.** Two changes were designed before they were built and the
  designs are committed with the code: [docs/first-run-journey.md](docs/first-run-journey.md)
  for the two-door first visit, and [docs/postal-code-finder.md](docs/postal-code-finder.md)
  for the address finder that replaced stop search. Each keeps its body as
  approved and carries a dated section at the end recording where the shipped
  code diverged — read that section before trusting the body.
- **Quota safety.** DataMall is one request per stop, so a full 8-stop board is
  8 requests. They run 5 at a time, are cached for 15s with in-flight
  de-duplication (concurrent viewers of a stop cost one upstream call), and a
  stop whose call fails degrades to "timings unavailable" instead of blanking
  the board. Background tabs stop polling entirely.
- **Privacy.** Coordinates are used to rank stops and discarded; `/api/board`
  sets `no-store` and nothing identifiable is logged, and neither is a search
  query. The Recent list is up to five labelled addresses — plausibly home and
  work — held in cleartext on the device, never transmitted, and cleared with
  the other keys. Keep it that way — once other people use this, PDPA is in
  scope.

## Before sharing the link

- Endpoint paths and field names in `src/lta.ts` match API User Guide v6.9
  (3 Aug 2026), §2.1 Bus Arrival and §2.4 Bus Stops — checked 10 Aug 2026, PDF
  in `docs/`. Re-verify only if LTA publishes a later guide. The code has still
  only been exercised against the mock and the stub, so watch the logs on the
  first real call.
- Check DataMall's terms on redistributing their data before exposing
  `/api/*` as a public API rather than as the UI's own backend. The same
  question applies twice over to `/api/places`, which serves an address list
  this repository redistributes rather than owns.
- The address data is OneMap-derived and carried under the Singapore Open Data
  Licence, which requires attribution. The artefact states its source and licence
  in its own envelope, and "Design notes → Address data" above is the visible
  credit. **The page footer still credits DataMall only** — the OneMap line has
  to go beside it before the link is shared.
- `data/sg-places.json.gz` must be committed, not just present locally. The
  Dockerfile does `COPY data ./data`, so an image build without it fails, and
  `/healthz` gates readiness on the address count — a pod with no artefact never
  becomes ready and blocks its own rollout.
- Confirm your account's rate limit against the fan-out above and raise
  `ARRIVAL_TTL_MS` if the board turns out to be too expensive.
