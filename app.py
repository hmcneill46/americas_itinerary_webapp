#!/usr/bin/env python3
"""Self-hosted Trip Planner web application."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from trip_schema import MigrationError, migrate_to_current, validate_current_itinerary

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "itinerary.json"
BACKUP_DIR = DATA_DIR / "backups"
EDIT_TOKEN = os.environ.get("ITINERARY_EDIT_TOKEN", "")
SAVE_LOCK = threading.Lock()
MAX_BACKUPS = 50

app = FastAPI(title="Trip Planner", version="1.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def read_bytes() -> bytes:
    try:
        return DATA_FILE.read_bytes()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="The itinerary data file is missing.") from exc


def revision_for_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def prepare_itinerary(data: Any) -> dict[str, Any]:
    """Migrate a document copy to the current schema, then validate it."""

    try:
        itinerary, migrations, source_schema_version = migrate_to_current(data)
    except MigrationError as exc:
        return {
            "itinerary": None,
            "errors": [str(exc)],
            "warnings": [],
            "migrations": [],
            "source_schema_version": data.get("schema_version") if isinstance(data, dict) else None,
        }
    result = validate_current_itinerary(itinerary)
    return {
        "itinerary": itinerary if not result["errors"] else None,
        **result,
        "migrations": migrations,
        "source_schema_version": source_schema_version,
    }


def validate_itinerary(data: Any) -> dict[str, Any]:
    """Compatibility wrapper used by tools and tests."""

    return prepare_itinerary(data)


def load_itinerary() -> tuple[dict[str, Any], str, list[str]]:
    raw = read_bytes()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"The saved itinerary JSON is invalid: {exc}") from exc
    prepared = prepare_itinerary(data)
    if prepared["errors"]:
        message = "; ".join(prepared["errors"][:8])
        raise HTTPException(status_code=500, detail=f"The saved itinerary is invalid: {message}")
    return prepared["itinerary"], revision_for_bytes(raw), prepared["migrations"]


def require_edit_token(token: str | None) -> None:
    if EDIT_TOKEN and token != EDIT_TOKEN:
        raise HTTPException(status_code=401, detail="A valid edit token is required.")


def atomic_save(data: dict[str, Any]) -> str:
    """Atomically replace the itinerary after preserving the previous bytes."""

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    serialised = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "wb", dir=DATA_DIR, prefix="itinerary_", suffix=".tmp", delete=False
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(serialised)
            handle.flush()
            os.fsync(handle.fileno())

        if DATA_FILE.exists():
            previous = DATA_FILE.read_bytes()
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            revision = revision_for_bytes(previous)[:12]
            backup_path = BACKUP_DIR / f"itinerary_{timestamp}_{revision}.json"
            shutil.copy2(DATA_FILE, backup_path)

        os.replace(temporary_path, DATA_FILE)
        temporary_path = None

        backups = sorted(
            BACKUP_DIR.glob("itinerary_*.json"), key=lambda path: path.stat().st_mtime_ns, reverse=True
        )
        for old_backup in backups[MAX_BACKUPS:]:
            old_backup.unlink(missing_ok=True)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return revision_for_bytes(serialised)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    _, revision, migrations = load_itinerary()
    return {
        "ok": True,
        "revision": revision,
        "edit_token_required": bool(EDIT_TOKEN),
        "pending_migrations": migrations,
    }


@app.get("/api/itinerary")
def get_itinerary() -> dict[str, Any]:
    itinerary, revision, migrations = load_itinerary()
    return {
        "revision": revision,
        "itinerary": itinerary,
        "edit_token_required": bool(EDIT_TOKEN),
        "migrations": migrations,
    }


@app.post("/api/validate")
async def validate_endpoint(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Request body is not valid JSON: {exc}") from exc
    itinerary = payload.get("itinerary") if isinstance(payload, dict) and "itinerary" in payload else payload
    result = prepare_itinerary(itinerary)
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
    if not isinstance(expected_revision, str) or not expected_revision:
        raise HTTPException(
            status_code=428,
            detail="expected_revision is required for every itinerary save; reload before saving.",
        )

    result = prepare_itinerary(payload["itinerary"])
    if result["errors"]:
        return JSONResponse(status_code=422, content={"valid": False, **result})
    itinerary = result["itinerary"]

    with SAVE_LOCK:
        current_raw = read_bytes()
        current_revision = revision_for_bytes(current_raw)
        if expected_revision != current_revision:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "The saved file changed after this edit session began. Reload before saving to avoid overwriting newer changes.",
                    "current_revision": current_revision,
                },
            )
        new_revision = atomic_save(itinerary)
    return JSONResponse(
        {
            "saved": True,
            "revision": new_revision,
            "itinerary": itinerary,
            "warnings": result["warnings"],
            "migrations": result["migrations"],
        }
    )


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
