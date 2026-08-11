# Trip Planner — self-hosted web app

Trip Planner is a local-first itinerary application for trips anywhere in the world. It keeps one human-readable JSON document and provides connected Schedule, route-map and editing views without a database or heavy frontend framework.

The canonical private file is `data/itinerary.json`. For a fresh checkout:

```bash
cp data/itinerary.example.json data/itinerary.json
```

The real file, backups and exports are ignored by Git. Edits stay in a browser draft until **Save to itinerary file** is pressed. Saves require the revision that was loaded, validate the complete document, preserve the previous bytes in `data/backups/`, and atomically replace the file. The latest 50 backups are retained.

## Run locally

macOS/Linux:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
python app.py
```

Windows PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe app.py
```

Open `http://127.0.0.1:8765`. The `install.sh`, `run_local.sh`, and `run_local.bat` helpers use the same loopback-only default.

Run checks with:

```bash
python -m pytest -q
node --test tests/map-data.test.mjs
node --check static/app.js static/map-config.js static/map-data.js static/map-view.js
python tools/validate_itinerary.py data/itinerary.example.json
```

## JSON portability and time model

The documented current format is schema v8: [docs/itinerary-schema.md](docs/itinerary-schema.md). It has stable IDs, structured booking lifecycle/timing advice, first-class budget items, typed fields and cross-reference validation. Supported older files are deterministically migrated in memory and are not rewritten until an explicit save.

Use **AI handoff** to download a saved trip or explicitly-labelled current draft, copy concise AI instructions, and preview an imported complete JSON trip. Import migration/validation is in-memory; applying replaces only the draft and the normal revision-protected Save remains separate. See [AI handoff](docs/ai-handoff.md).

Events use floating local wall-clock timestamps. `2027-04-09T08:30` means 08:30 at that point in the trip; it has no `Z` or UTC offset and is not converted through the browser timezone. Events can last exact minutes or span several days.

Download/upload supports an AI-assisted workflow: download JSON, edit it with a person or AI, upload it into a browser draft, review validation, then explicitly save. Unknown extension fields are preserved. Keep a backup and never bypass validation when generating files.

## Views and editing

- **Schedule** has two day-by-day modes on the same 24-hour timeline. **Events** renders exact-minute event segments, overlaps, multi-day clipping, search and independent category filters. **Places & travel** derives one non-overlapping physical sequence per day: location, travel, then destination. Overnight journeys clip across rows, while untimed transitions and contradictory legs remain visibly uncertain instead of gaining invented clock times. Desktop selections use a closeable detail panel; phone selections open a full-screen detail view.
- **Map** uses a locally served, pinned MapLibre GL JS runtime with an OpenFreeMap Positron vector basemap. It shows ordered visit markers, repeated visits, secondary event locations and tappable dashed route connections. Map selections can open the relevant day or event, while explicit focus actions leave ordinary manual exploration alone.
- **Budget** keeps exact-decimal native-currency cost items, stored FX snapshots, expected/committed/paid totals, deposits/refunds, category and visit breakdowns, plus a responsive cost editor and quick-expense flow. `budget.base_currency` is the sole home/reporting currency. Linked costs show their native price first and a stored-rate home equivalent second. No live currency service is used; an item without an FX snapshot is visibly excluded from affected home-currency totals.
- **Bookings** is an action-first view: lifecycle, explainable timing strategy, moving lead-time recommendations, hard deadlines, risk/flexibility rationale and optional Budget links. It does not scrape providers or claim live availability.
- **Edit** supports events, locations, visit duration/order, day information and route date reflow.

Route reflow shifts a complete visit, its days and its events while retaining floating-local times.

All current map route lines are approximate endpoint connections: they do not claim to follow a road, railway, flight path, ferry route or walking trail. No itinerary schema change was needed for the map overhaul. See [docs/map.md](docs/map.md) for provider configuration, attribution, failure behavior and the future PMTiles seam.

## Offline read resilience

On a deployed same-origin host, Trip Planner is a modest installable PWA. After a successful online load it keeps an app shell and one server-confirmed itinerary snapshot on that browser/device, so it can remain useful when Tailscale or the home server is temporarily unreachable. Offline data is clearly labelled and **read-only**: no edits, saves, import application or write queue exist. See [offline read resilience](docs/offline.md) for privacy, clearing local data, basemap limits and local-development behaviour.

## Private deployment and Tailscale

There is no user-account system and no read authentication. Anyone who can reach the HTTP service can read and download the itinerary. The optional `ITINERARY_EDIT_TOKEN` protects writes only. The intended security boundary is a private host plus Tailscale access control.

Safe rules:

1. Never port-forward this service or publish it through a public proxy/tunnel.
2. Bind to `127.0.0.1` for one-machine use or directly to the host's Tailscale IP.
3. Do not bind to `0.0.0.0` on the host; that commonly exposes the app to the whole LAN.
4. Protect the host account, Tailscale account, `data/` directory and backups independently.

For direct tailnet access on Linux:

```bash
export ITINERARY_EDIT_TOKEN='a-long-random-secret'  # optional write protection
./run_tailscale.sh
```

The script binds only to `tailscale ip -4` and fails closed if no Tailscale address is available. Visit `http://TAILSCALE_IP:8765` from an authorised tailnet device.

The template `deploy/americas-itinerary.service` retains its historical filename so existing installs do not break, but runs the generic app through the fail-closed Tailscale script. Adjust `User`, `Group`, and `/home/pi/americas_itinerary_webapp` paths before installing it.

## Docker

First create `data/itinerary.json`, then:

```bash
docker compose up -d --build
```

Compose publishes to host loopback by default. For direct Tailscale binding, set the host address for that invocation:

```bash
ITINERARY_BIND_ADDRESS="$(tailscale ip -4)" docker compose up -d --build
```

Inside the container the process listens on `0.0.0.0`; Docker publishes it only on the explicit host address. `.dockerignore` excludes live itineraries, backups, exports, secrets and development state, and the Dockerfile copies only runtime source plus the public example. `./data` is mounted for persistence and should be backed up separately.

The application shell and pinned MapLibre library are served by this app. The default map style, tiles, fonts and sprites are fetched by each browser from OpenFreeMap, so basemap requests do not travel through the home server or Tailscale. The itinerary still loads and edits if that provider is unavailable; the map falls back to a plain background with trip overlays.

## Project layout

```text
app.py                         FastAPI API, revisions, atomic saves and backups
trip_schema.py                 Schema v8 models, validation and migrations
static/                        Plain-JavaScript UI, timeline derivation, MapLibre integration and pinned map runtime
data/itinerary.example.json    Canonical public demo data
data/itinerary.json            Private live itinerary (ignored)
data/backups/                  Private automatic backups (ignored)
docs/itinerary-schema.md       Human- and AI-oriented JSON specification
docs/map.md                    Map architecture, provider configuration and offline limits
tests/                         Validation, migration and persistence tests
tools/validate_itinerary.py    Command-line validator
tools/migrate_existing_itinerary.py  Historical spreadsheet conversion utility
```

See [AGENTS.md](AGENTS.md) for project constraints future coding sessions must preserve.
