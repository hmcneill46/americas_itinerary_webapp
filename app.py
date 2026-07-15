#!/usr/bin/env python3
"""Self-hosted Americas itinerary web application."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "itinerary.json"
BACKUP_DIR = DATA_DIR / "backups"
EXPORTS_DIR = ROOT / "exports"
EDIT_TOKEN = os.environ.get("ITINERARY_EDIT_TOKEN", "")

ALLOWED_MODES = {
    "",
    "Flight",
    "Road / bus",
    "Ferry / boat",
    "Train",
    "Trek / walk",
    "Mixed",
    "Local transfer",
}
ALLOWED_CONFIDENCE = {"Low", "Medium", "High"}

app = FastAPI(title="Americas Itinerary", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/exports", StaticFiles(directory=EXPORTS_DIR), name="exports")


def read_bytes() -> bytes:
    try:
        return DATA_FILE.read_bytes()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="The itinerary data file is missing.") from exc


def revision_for_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load_itinerary() -> tuple[dict[str, Any], str]:
    raw = read_bytes()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"The saved itinerary JSON is invalid: {exc}") from exc
    return data, revision_for_bytes(raw)


def parse_date(value: Any, path: str, errors: list[str]) -> date | None:
    if not isinstance(value, str):
        errors.append(f"{path} must be an ISO date string.")
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        errors.append(f"{path} is not a valid ISO date: {value!r}.")
        return None


def parse_local_datetime(value: Any, path: str, errors: list[str]) -> datetime | None:
    if not isinstance(value, str):
        errors.append(f"{path} must be an ISO local date-time string.")
        return None
    if value.endswith("Z"):
        errors.append(f"{path} must be a floating local time without Z or a UTC offset.")
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        errors.append(f"{path} is not a valid ISO date-time: {value!r}.")
        return None
    if parsed.tzinfo is not None:
        errors.append(f"{path} must not contain a timezone offset; use local itinerary time.")
        return None
    return parsed


def validate_itinerary(data: Any) -> dict[str, list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(data, dict):
        return {"errors": ["The uploaded value must be a JSON object."], "warnings": []}

    if data.get("schema_version") != 4:
        errors.append("schema_version must be exactly 4 for this application.")

    metadata = data.get("metadata")
    if not isinstance(metadata, dict):
        errors.append("metadata must be an object.")
        metadata = {}
    if not str(metadata.get("title", "")).strip():
        errors.append("metadata.title is required.")
    start_date = parse_date(metadata.get("start_date"), "metadata.start_date", errors)
    end_date = parse_date(metadata.get("end_date"), "metadata.end_date", errors)
    if start_date and end_date and end_date < start_date:
        errors.append("metadata.end_date must not be earlier than metadata.start_date.")
    if metadata.get("time_model") != "floating_local":
        errors.append("metadata.time_model must be 'floating_local'.")

    locations = data.get("locations")
    if not isinstance(locations, dict) or not locations:
        errors.append("locations must be a non-empty object keyed by location ID.")
        locations = {}
    for location_id, location in locations.items():
        path = f"locations.{location_id}"
        if not isinstance(location, dict):
            errors.append(f"{path} must be an object.")
            continue
        if location.get("id") != location_id:
            errors.append(f"{path}.id must match its object key.")
        if not str(location.get("name", "")).strip():
            errors.append(f"{path}.name is required.")
        if not str(location.get("country", "")).strip():
            errors.append(f"{path}.country is required.")
        try:
            latitude = float(location.get("latitude"))
            longitude = float(location.get("longitude"))
            if not -90 <= latitude <= 90:
                errors.append(f"{path}.latitude must be between -90 and 90.")
            if not -180 <= longitude <= 180:
                errors.append(f"{path}.longitude must be between -180 and 180.")
        except (TypeError, ValueError):
            errors.append(f"{path}.latitude and longitude must be numbers.")

    visits = data.get("visits")
    if not isinstance(visits, list) or not visits:
        errors.append("visits must be a non-empty array.")
        visits = []
    visit_ids: set[str] = set()
    visit_orders: set[int] = set()
    visit_by_id: dict[str, dict[str, Any]] = {}
    previous_order = -1
    for index, visit in enumerate(visits):
        path = f"visits[{index}]"
        if not isinstance(visit, dict):
            errors.append(f"{path} must be an object.")
            continue
        visit_id = str(visit.get("id", ""))
        if not visit_id:
            errors.append(f"{path}.id is required.")
            continue
        if visit_id in visit_ids:
            errors.append(f"Duplicate visit ID: {visit_id}.")
        visit_ids.add(visit_id)
        visit_by_id[visit_id] = visit
        location_id = visit.get("location_id")
        if location_id not in locations:
            errors.append(f"{path}.location_id references unknown location {location_id!r}.")
        try:
            order = int(visit.get("order"))
            if order in visit_orders:
                errors.append(f"Duplicate visit order: {order}.")
            visit_orders.add(order)
            if order <= previous_order:
                warnings.append("visits are not stored in increasing order; the UI will sort them.")
            previous_order = order
        except (TypeError, ValueError):
            errors.append(f"{path}.order must be an integer.")
        visit_start = parse_date(visit.get("start_date"), f"{path}.start_date", errors)
        visit_end = parse_date(visit.get("end_date"), f"{path}.end_date", errors)
        if visit_start and visit_end and visit_end < visit_start:
            errors.append(f"{path}.end_date must not be earlier than start_date.")
        if visit.get("arrival_mode", "") not in ALLOWED_MODES:
            errors.append(f"{path}.arrival_mode is not supported.")
        try:
            if float(visit.get("arrival_hours_estimate", 0)) < 0:
                errors.append(f"{path}.arrival_hours_estimate must be non-negative.")
        except (TypeError, ValueError):
            errors.append(f"{path}.arrival_hours_estimate must be numeric.")

    days = data.get("days")
    if not isinstance(days, list) or not days:
        errors.append("days must be a non-empty array.")
        days = []
    day_dates: set[date] = set()
    parsed_days: list[tuple[date, dict[str, Any]]] = []
    for index, day_row in enumerate(days):
        path = f"days[{index}]"
        if not isinstance(day_row, dict):
            errors.append(f"{path} must be an object.")
            continue
        current_date = parse_date(day_row.get("date"), f"{path}.date", errors)
        if current_date:
            if current_date in day_dates:
                errors.append(f"Duplicate day date: {current_date.isoformat()}.")
            day_dates.add(current_date)
            parsed_days.append((current_date, day_row))
        try:
            day_number = int(day_row.get("day_number"))
            if day_number != index + 1:
                errors.append(f"{path}.day_number must be {index + 1}.")
        except (TypeError, ValueError):
            errors.append(f"{path}.day_number must be an integer.")
        visit_id = day_row.get("visit_id")
        location_id = day_row.get("location_id")
        if visit_id not in visit_by_id:
            errors.append(f"{path}.visit_id references unknown visit {visit_id!r}.")
        if location_id not in locations:
            errors.append(f"{path}.location_id references unknown location {location_id!r}.")
        if visit_id in visit_by_id and location_id in locations:
            if visit_by_id[visit_id].get("location_id") != location_id:
                errors.append(f"{path} location does not match its visit location.")
        if day_row.get("confidence") not in ALLOWED_CONFIDENCE:
            errors.append(f"{path}.confidence must be Low, Medium or High.")
        for field in ("country", "base", "summary"):
            if not str(day_row.get(field, "")).strip():
                errors.append(f"{path}.{field} is required.")

    parsed_days.sort(key=lambda item: item[0])
    if start_date and end_date:
        expected_count = (end_date - start_date).days + 1
        if len(days) != expected_count:
            errors.append(f"days must contain exactly {expected_count} entries for the metadata date range.")
        expected = start_date
        for actual, day_row in parsed_days:
            if actual != expected:
                errors.append(f"Missing or out-of-order day: expected {expected}, found {actual}.")
                expected = actual
            visit_id = day_row.get("visit_id")
            visit = visit_by_id.get(visit_id)
            if visit:
                try:
                    visit_start = date.fromisoformat(visit["start_date"])
                    visit_end = date.fromisoformat(visit["end_date"])
                    if not visit_start <= actual <= visit_end:
                        errors.append(f"Day {actual} lies outside visit {visit_id}'s date range.")
                except (KeyError, ValueError):
                    pass
            expected += timedelta(days=1)

    events = data.get("events")
    if not isinstance(events, list):
        errors.append("events must be an array.")
        events = []
    event_ids: set[str] = set()
    category_colours = metadata.get("category_colours", {}) if isinstance(metadata, dict) else {}
    lower_bound = datetime.combine(start_date, time.min) if start_date else None
    upper_bound = datetime.combine(end_date + timedelta(days=1), time.min) if end_date else None
    for index, event in enumerate(events):
        path = f"events[{index}]"
        if not isinstance(event, dict):
            errors.append(f"{path} must be an object.")
            continue
        event_id = str(event.get("id", ""))
        if not event_id:
            errors.append(f"{path}.id is required.")
        elif event_id in event_ids:
            errors.append(f"Duplicate event ID: {event_id}.")
        event_ids.add(event_id)
        if not str(event.get("title", "")).strip():
            errors.append(f"{path}.title is required.")
        category = str(event.get("category", ""))
        if not category:
            errors.append(f"{path}.category is required.")
        elif category not in category_colours:
            warnings.append(f"{path}.category {category!r} has no configured colour.")
        start = parse_local_datetime(event.get("start"), f"{path}.start", errors)
        end = parse_local_datetime(event.get("end"), f"{path}.end", errors)
        if start and end:
            if end <= start:
                errors.append(f"{path}.end must be later than start.")
            if lower_bound and start < lower_bound:
                errors.append(f"{path}.start is before the itinerary begins.")
            if upper_bound and end > upper_bound:
                errors.append(f"{path}.end is after the itinerary ends.")
        visit_id = event.get("visit_id")
        location_id = event.get("location_id")
        if visit_id not in visit_by_id:
            errors.append(f"{path}.visit_id references unknown visit {visit_id!r}.")
        if location_id not in locations:
            errors.append(f"{path}.location_id references unknown location {location_id!r}.")
        for field in ("from_location_id", "to_location_id"):
            reference = event.get(field, "")
            if reference and reference not in locations:
                errors.append(f"{path}.{field} references unknown location {reference!r}.")
        if event.get("transport_mode", "") not in ALLOWED_MODES:
            errors.append(f"{path}.transport_mode is not supported.")
        if event.get("confidence") not in ALLOWED_CONFIDENCE:
            errors.append(f"{path}.confidence must be Low, Medium or High.")

    try:
        json.dumps(data, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        errors.append(f"The itinerary is not JSON serialisable: {exc}")

    # Avoid flooding the browser with repeated category warnings.
    warnings = list(dict.fromkeys(warnings))
    errors = list(dict.fromkeys(errors))
    return {"errors": errors, "warnings": warnings}


def require_edit_token(token: str | None) -> None:
    if EDIT_TOKEN and token != EDIT_TOKEN:
        raise HTTPException(status_code=401, detail="A valid edit token is required.")


def atomic_save(data: dict[str, Any]) -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    if DATA_FILE.exists():
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        revision = revision_for_bytes(DATA_FILE.read_bytes())[:12]
        shutil.copy2(DATA_FILE, BACKUP_DIR / f"itinerary_{timestamp}_{revision}.json")
        backups = sorted(BACKUP_DIR.glob("itinerary_*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        for old_backup in backups[50:]:
            old_backup.unlink(missing_ok=True)

    serialised = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    with tempfile.NamedTemporaryFile("wb", dir=DATA_DIR, prefix="itinerary_", suffix=".tmp", delete=False) as handle:
        temporary_path = Path(handle.name)
        handle.write(serialised)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_path, DATA_FILE)
    return revision_for_bytes(serialised)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    _, revision = load_itinerary()
    return {"ok": True, "revision": revision, "edit_token_required": bool(EDIT_TOKEN)}


@app.get("/api/itinerary")
def get_itinerary() -> dict[str, Any]:
    itinerary, revision = load_itinerary()
    return {"revision": revision, "itinerary": itinerary, "edit_token_required": bool(EDIT_TOKEN)}


@app.post("/api/validate")
async def validate_endpoint(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Request body is not valid JSON: {exc}") from exc
    itinerary = payload.get("itinerary") if isinstance(payload, dict) and "itinerary" in payload else payload
    result = validate_itinerary(itinerary)
    return JSONResponse({"valid": not result["errors"], **result})


@app.put("/api/itinerary")
async def save_itinerary(request: Request, x_itinerary_token: str | None = Header(default=None)) -> JSONResponse:
    require_edit_token(x_itinerary_token)
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Request body is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict) or "itinerary" not in payload:
        raise HTTPException(status_code=400, detail="The request must contain an itinerary object.")

    expected_revision = payload.get("expected_revision")
    current_raw = read_bytes()
    current_revision = revision_for_bytes(current_raw)
    if expected_revision and expected_revision != current_revision:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "The saved file changed after this edit session began. Reload before saving to avoid overwriting newer changes.",
                "current_revision": current_revision,
            },
        )

    itinerary = payload["itinerary"]
    result = validate_itinerary(itinerary)
    if result["errors"]:
        return JSONResponse(status_code=422, content={"valid": False, **result})

    new_revision = atomic_save(itinerary)
    return JSONResponse({"saved": True, "revision": new_revision, "warnings": result["warnings"]})


@app.get("/api/download")
def download_itinerary() -> FileResponse:
    return FileResponse(
        DATA_FILE,
        media_type="application/json",
        filename="itinerary.json",
    )


if __name__ == "__main__":
    host = os.environ.get("ITINERARY_HOST", "127.0.0.1")
    port = int(os.environ.get("ITINERARY_PORT", "8765"))
    uvicorn.run("app:app", host=host, port=port, reload=False)
