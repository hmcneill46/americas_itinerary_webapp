# Map architecture and providers

The map uses MapLibre GL JS 6.3.0. Its JavaScript, worker, CSS and BSD licence are pinned in `static/vendor/maplibre-gl/` and served by FastAPI, so the application shell does not depend on a JavaScript CDN.

The implementation deliberately separates four concerns:

- `static/map-config.js` loads and normalises public basemap settings from `GET /api/map-config`.
- `static/map-data.js` converts validated schema-v5 locations, visits, events and bookings into provider-neutral visit, secondary-location and route records.
- `static/map-view.js` owns the long-lived MapLibre instance, GeoJSON sources/layers, markers, popups, camera and network fallback.
- `static/app.js` connects map selections to days/events and sends only explicit focus requests to the camera.

Itinerary rerenders update sources and markers without recreating MapLibre. Moving the map by hand is preserved until the user presses **Fit whole trip**, **Focus day**, selects a route/visit from the itinerary, or invokes another explicit focus action.

## Default provider

The default is OpenFreeMap's **Positron** style:

```text
https://tiles.openfreemap.org/styles/positron
```

It provides worldwide OpenStreetMap-derived vector data, roads and place labels with restrained colours, requires no API key, and is currently offered free of charge. It is an external best-effort service, not part of this repository. The map displays attribution links for OpenFreeMap, OpenMapTiles and OpenStreetMap contributors.

Each browser connects directly to `tiles.openfreemap.org` for the style, vector tiles, sprites and fonts. That exposes the browser's IP address and normal HTTP request metadata to the provider/its CDN. No itinerary JSON is sent to the provider; markers and routes are rendered locally after the basemap loads.

## Provider configuration

The server exposes only public browser configuration. Set these environment variables before starting the app:

| Variable | Purpose |
| --- | --- |
| `TRIP_MAP_STYLE_URL` | HTTPS MapLibre style URL, or a same-origin absolute path such as `/static/maps/style.json`. |
| `TRIP_MAP_PROVIDER_NAME` | Short provider label. |
| `TRIP_MAP_ATTRIBUTION_TEXT` | Required attribution text for a custom provider. |
| `TRIP_MAP_ATTRIBUTION_URL` | HTTPS link for that attribution. |

Docker Compose forwards the same variables. Restart the app after changing them. URLs using insecure schemes, embedded credentials or protocol-relative syntax are rejected. A commercial provider token can technically be placed in its style URL through the environment, but any browser-side map token is visible to authorised users; use only a provider's public, origin-restricted token and never commit it.

Changing providers should require configuration, not edits to trip logic. A custom style must retain the data provider's required attribution and should leave enough visual contrast for the trip overlays.

## Trip overlays

Primary visits use numbered DOM markers. Separate visits to the same coordinates receive stable screen-space offsets and small repeat badges, so returning to a place does not silently collapse into one point. Locations referenced by events but not visits use smaller secondary dots.

Travel/Hike events with valid `from_location_id` and `to_location_id` references become route segments. When a consecutive visit has no complete travel event, the visit's arrival information supplies a fallback segment. Every current segment has `geometryKind: "schematic"` in the derived browser model and is drawn as a dashed endpoint connection. Popups and details repeat that it is approximate. Real route geometry can later replace the geometry resolver without coupling it to the basemap provider; it is not yet a persisted schema-v5 field.

Popup content is constructed with DOM nodes and `textContent`, not raw itinerary HTML.

## Network failure and offline limits

If the online style cannot load, the map switches to a local blank style and keeps trip markers, schematic routes, controls and itinerary-side details available. If individual tile resources fail after the style loads, a map-specific warning appears and the rest of Trip Planner continues normally. The PWA app shell caches the locally vendored MapLibre runtime, but deliberately does not cache OpenFreeMap's third-party style, tiles, fonts or sprites; see [offline read resilience](offline.md).

The application JavaScript and CSS work from the home server, but roads, labels, sprites, fonts and vector tiles are not available offline unless already cached by the browser. There is no offline download workflow in this version.

MapLibre supports custom protocols and PMTiles, and the provider boundary is intentionally narrow enough to add a self-hosted PMTiles protocol/style later. This task does not include PMTiles archives, tile generation, offline packs or a routing service.

## Upgrading MapLibre

Download a specific npm release, copy only `maplibre-gl.mjs`, `maplibre-gl-shared.mjs`, `maplibre-gl-worker.mjs`, `maplibre-gl.css` and `LICENSE.txt` into `static/vendor/maplibre-gl/`, then update the version query in `static/map-view.js` and this document. Run backend tests, JavaScript tests/syntax checks and desktop/phone browser smoke tests. FastAPI explicitly serves `.mjs` as `application/javascript`; keep the MIME regression test.
