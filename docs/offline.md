# Offline read resilience

Trip Planner is an installable PWA on deployed same-origin hosts. After one successful online load, the browser keeps a versioned application shell and one **server-confirmed itinerary snapshot** in IndexedDB on that device.

## What works offline

If the home server or Tailscale is unreachable, the shell can boot from cache and shows the most recently accepted snapshot in read-only mode. Today, both Schedule modes, Bookings, Budget, AI handoff reading/export, and trip map overlays continue to derive from that data. The banner states that it is an offline copy and when it was refreshed.

The snapshot is written only after `GET /api/itinerary` succeeds and the response has been accepted into normal application state, or after a successful revision-protected server save. Import previews and unsaved browser drafts are never stored as the offline trip.

## What does not work offline

Offline mode intentionally disables itinerary edits, saves, Today outcome buttons, Budget/Booking writes, quick expenses, import application and other draft mutations. There is no mutation queue, background sync, merge, or later write replay. Once the server is reachable again, Trip Planner fetches live data and its live revision before editing can resume; a cached revision is never used to save.

The MapLibre runtime and trip overlays are part of the app shell. The online OpenFreeMap basemap is not cached or promised offline; MapLibre falls back to its existing plain trip-overlay view when provider resources cannot load.

## Privacy and clearing data

The offline copy includes private itinerary information such as dates, exact accommodation/venue addresses, travel logistics, bookings, references and budget data. It stays in this browser profile on this device and is not sent to a third party. Use **AI handoff → Clear offline trip copy** to remove the IndexedDB itinerary snapshot; this never changes the home-server file. Browser site-data controls can also clear the app shell and any remaining browser storage.

## Development

Service-worker registration is deliberately disabled on `localhost` and `127.0.0.1` so Uvicorn reload remains predictable. To test PWA behaviour locally, open the app with `?pwa=1`, for example `http://127.0.0.1:32912/?pwa=1`.
