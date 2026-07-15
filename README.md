# Americas Itinerary — self-hosted web app

A local-first itinerary application for the 182-day Americas trip from **3 January to 3 July 2027**.

It provides three connected views from one JSON file:

1. **Day bars** — exact-time, interactive 24-hour bars for every day.
2. **Map** — ordered route, stay lengths, travel modes and estimated transfer times.
3. **Edit** — staged edits with validation, Save/Cancel, route reflow, and JSON import/export.

The canonical data file is:

```text
data/itinerary.json
```

For a fresh public checkout, create it from the safe sample file:

```bash
cp data/itinerary.example.json data/itinerary.json
```

The real `data/itinerary.json` is ignored by Git so private trip details, booking notes and local edits stay on your machine.

The server dynamically reads and writes that file. The website never writes changes merely because a form field was edited: all edits remain in a browser draft until **Save to itinerary file** is pressed.

## What is different from the spreadsheet model

Events now contain exact local start and end timestamps:

```json
{
  "id": "evt_example",
  "title": "Bus to the next city",
  "category": "Travel",
  "start": "2027-02-01T10:34",
  "end": "2027-02-03T22:34"
}
```

An event may be a few minutes or several days long. The day view automatically clips the same event across each affected day. Clicking any piece highlights every piece belonging to that event.

Times use the **floating local itinerary clock**. They do not contain UTC offsets, so `10:34` means 10:34 at that point in the itinerary. Optional IANA timezones are retained on locations for reference.

## Run locally on a laptop

### macOS or Linux

```bash
cd americas_itinerary_webapp
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Open:

```text
http://127.0.0.1:8765
```

The included `install.sh` and `run_local.sh` perform the same steps.

### Windows

```bat
py -m venv .venv
.venv\Scripts\activate
py -m pip install -r requirements.txt
py app.py
```

You can also double-click `run_local.bat` after installing the dependencies.

## Raspberry Pi and Tailscale

The safest simple arrangement is:

1. Keep the site unavailable to the public internet.
2. Install Tailscale on the Pi and your phone/laptop.
3. Bind the app to the Pi's Tailscale address.

Run:

```bash
./run_tailscale.sh
```

The script uses `tailscale ip -4` when available. Visit:

```text
http://PI_TAILSCALE_IP:8765
```

There is no built-in user account system. Tailscale supplies the network access control. Do **not** port-forward this application to the public internet.

### Optional write token

For an extra layer around edits, set an environment variable before starting the app:

```bash
export ITINERARY_EDIT_TOKEN='a-long-random-secret'
./run_tailscale.sh
```

The website will reveal an Edit token field. Reading the itinerary remains available, but saving requires the token.

## Install as a Raspberry Pi service

A template is included at:

```text
deploy/americas-itinerary.service
```

Adjust the user and paths, then:

```bash
sudo cp deploy/americas-itinerary.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now americas-itinerary
sudo systemctl status americas-itinerary
```

## Docker option

```bash
docker compose up -d --build
```

The `data` directory is mounted as persistent storage. Back it up independently.

## Day bars

- All daily bars represent 00:00–24:00 with exact minute positioning.
- Events can overlap; overlapping items use separate lanes.
- Search and category filters operate without changing data.
- Selecting an event shows:
  - exact start and end date/time;
  - weekdays;
  - total duration;
  - every affected calendar day;
  - location and visit;
  - transport route/mode;
  - confidence and planning notes;
  - daily context retained from the spreadsheet.

## Map

- Nodes are numbered in route order.
- Node size reflects the number of days at a stop.
- Line thickness reflects estimated transfer time.
- Line colour/style reflects travel mode.
- Previous/next buttons step exactly one day.
- Play animates the trip.
- Mouse wheel zooms and drag pans.
- Markers are inversely scaled during zoom, so they remain usable instead of becoming enormous and overlapping.

## Editing safely

### Events

The Events editor supports exact minute input through `datetime-local` controls. You can add, duplicate, delete and edit events, including multi-day travel.

### Route blocks

Move a stop up or down, then press **Reflow dates**. This shifts the complete visit block, all its days and all its events while preserving their internal timings.

You can also:

- change a visit location;
- update arrival mode and estimated hours;
- extend or shorten a visit by one day;
- edit every day's base, country, summary, notes and confidence.

### Locations

Locations contain name, country, coordinates, timezone and notes. A location cannot be deleted while it is referenced.

### Save and Cancel

- **Apply to draft** changes only the in-browser draft.
- **Cancel all changes** restores the last saved JSON.
- **Save to itinerary file** validates and atomically replaces `data/itinerary.json`.
- The server rejects stale saves when another browser changed the file first.

Every successful save creates a timestamped backup in:

```text
data/backups/
```

The latest 50 automatic backups are retained.

## Download and upload

The Edit toolbar includes:

- **Download saved JSON** — the exact server file currently on disk.
- **Download draft JSON** — includes unsaved edits for inspection or transfer.
- **Upload JSON** — validates the file and loads it into the draft only. It is not written to disk until Save is pressed.

## Validation

The server checks:

- schema version;
- continuous day dates and day numbers;
- visit and location references;
- coordinates;
- unique IDs and route order;
- visit date ranges;
- valid exact local timestamps;
- event end later than start;
- multi-day events within the itinerary date range;
- allowed confidence and transport values;
- JSON serialisability.

Run the tests with:

```bash
pytest -q
```

## Project layout

```text
app.py                         FastAPI server, validation, atomic saves and backups
static/index.html              Website structure
static/styles.css              Responsive styling
static/app.js                  Day bars, map and editor logic
static/americas_basemap.geojson Offline country outlines
data/itinerary.json            Canonical itinerary data
data/itinerary.example.json    Public-safe sample data for new clones
data/backups/                  Automatic save backups
exports/                       Existing spreadsheet and screenshots
tools/migrate_existing_itinerary.py  Recreates schema v4 from the previous project
 tests/                        API and validation tests
```

## Existing spreadsheet

The last compiled spreadsheet remains in `exports/` for comparison and offline reference. All its daily summaries, notes, confidence values, locations and timeline segments were migrated into `data/itinerary.json`.
