# Trip Planner: notes for future Codex sessions

This is a private, self-hosted trip planner. It uses FastAPI, a plain JavaScript frontend, and one portable JSON itinerary. Keep it lightweight enough for a Raspberry Pi-class home server; do not add a database or a heavyweight frontend framework without an explicit product decision.

## Important paths

- `app.py` — HTTP API, revision checks, atomic saves and backups.
- `trip_schema.py` — current typed schema, cross-record checks and migrations.
- `static/` — browser UI; `map-data.js` derives provider-neutral features, `map-view.js` owns MapLibre, and `map-config.js` loads public provider settings.
- `data/itinerary.example.json` — public, canonical, non-personal demo document.
- `data/itinerary.json` — private live data; ignored by Git.
- `docs/itinerary-schema.md` — authoritative JSON contract for people and AI tools.
- `tests/` — schema, migration, API and persistence tests.
- `run_local.*`, `run_tailscale.sh`, `docker-compose.yml`, `deploy/` — deployment entry points.

## Run and test

Create `data/itinerary.json` from the example, install `requirements-dev.txt`, then run `python app.py`. For local browser work, prefer `python -m uvicorn app:app --host 0.0.0.0 --port 32912 --reload`; that binding is local-development-only, not production deployment guidance. Run all tests with `python -m pytest -q`. Validate a file with `python tools/validate_itinerary.py PATH`.

For meaningful frontend, layout or interaction changes, perform actual screenshot-based visual inspection as well as functional checks. Review both desktop (about `1440 × 900`) and phone portrait (about `390 × 844`; also consider `360 × 800` for dense UI), checking hierarchy, spacing, overflow, dialog fit, touch targets and polish. Fix clear in-scope visual defects before handoff; do not treat DOM assertions alone as UX verification.

## Non-negotiable data rules

- The JSON document is the product boundary: it must remain human-readable, deterministic, portable and safe for AI-assisted export/edit/import.
- Increment `schema_version` only for a real format change. Add one deterministic migration per version, retain unknown/legacy values, validate the migrated result, document it, and add fixture-based migration and idempotence tests. Budget money is exact decimal strings in JSON, not JavaScript/Python binary floats; keep its shared calculations in `static/budget.js` so summaries and breakdowns agree.
- Defined fields must not rely on array positions. IDs must be stable and references must validate.
- Event timestamps are floating local wall-clock values (`YYYY-MM-DDTHH:MM`) with no `Z` or UTC offset. Do not let browser or server timezone conversion alter them.
- Preserve unknown JSON extension fields. Never silently discard meaningful user data during validation or migration.

## Security and architecture

- Treat itineraries, bookings, backups and exports as private. Keep them out of Git and Docker build contexts. Never serve `exports/` as static content.
- The application has no read authentication. Bind only to loopback or a Tailscale address; never default to `0.0.0.0` on a host or recommend public port forwarding. The optional edit token protects writes only.
- Preserve mandatory optimistic concurrency, atomic replacement, exact pre-save backups and bounded backup rotation.
- Keep dependencies modest. Prefer standard library, FastAPI/Pydantic and browser-native ES modules/DOM APIs. MapLibre is pinned under `static/vendor/`; do not add a frontend build pipeline merely to upgrade it.
- Keep basemap, trip features and selection state separate. Current route lines are deliberately dashed and schematic; never present endpoint-only geometry as an actual road, rail or walking route.
- Preserve route reflow and existing editors unless the task explicitly replaces them. Avoid a cosmetic frontend rewrite. Design and test phone-sized behavior for user-facing additions.

## Definition of done

A change is complete only when the canonical example validates, old supported schemas still migrate, the full test suite passes, relevant API/UI behavior is smoke-tested, deployment/privacy defaults remain safe, documentation matches the actual schema, and the diff contains no private data or secrets.
