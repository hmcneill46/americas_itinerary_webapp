from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

import app as itinerary_app


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "itinerary.example.json"


def configure_temp_data(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    backup_dir = data_dir / "backups"
    data_dir.mkdir()
    backup_dir.mkdir()
    target = data_dir / "itinerary.json"
    target.write_bytes(SOURCE.read_bytes())
    monkeypatch.setattr(itinerary_app, "DATA_DIR", data_dir)
    monkeypatch.setattr(itinerary_app, "BACKUP_DIR", backup_dir)
    monkeypatch.setattr(itinerary_app, "DATA_FILE", target)
    monkeypatch.setattr(itinerary_app, "EDIT_TOKEN", "")
    return target, backup_dir


def test_current_file_validates():
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    result = itinerary_app.validate_itinerary(data)
    assert result["errors"] == []
    assert result["warnings"] == []
    assert len(data["days"]) == 3
    assert any(event["start"] == "2027-01-02T09:00" and event["end"] == "2027-01-02T12:00" for event in data["events"])


def test_multiday_exact_minute_event_is_valid():
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    template = dict(data["events"][0])
    template.update({
        "id": "evt_test_60_hour_bus",
        "title": "Example overnight train",
        "category": "Travel",
        "start": "2027-01-02T22:30",
        "end": "2027-01-03T06:15",
        "visit_id": data["days"][1]["visit_id"],
        "location_id": data["days"][1]["location_id"],
        "from_location_id": data["days"][0]["location_id"],
        "to_location_id": data["days"][1]["location_id"],
        "transport_mode": "Train",
    })
    data["events"].append(template)
    result = itinerary_app.validate_itinerary(data)
    assert result["errors"] == []


def test_save_revision_conflict_and_backup(tmp_path, monkeypatch):
    target, backup_dir = configure_temp_data(tmp_path, monkeypatch)
    client = TestClient(itinerary_app.app)

    loaded = client.get("/api/itinerary").json()
    revision = loaded["revision"]
    itinerary = loaded["itinerary"]
    itinerary["metadata"]["description"] = "Changed in test"

    saved = client.put("/api/itinerary", json={"expected_revision": revision, "itinerary": itinerary})
    assert saved.status_code == 200
    new_revision = saved.json()["revision"]
    assert new_revision != revision
    assert json.loads(target.read_text(encoding="utf-8"))["metadata"]["description"] == "Changed in test"
    assert len(list(backup_dir.glob("itinerary_*.json"))) == 1

    conflict = client.put("/api/itinerary", json={"expected_revision": revision, "itinerary": itinerary})
    assert conflict.status_code == 409


def test_invalid_upload_rejected():
    client = TestClient(itinerary_app.app)
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    data["events"][0]["end"] = data["events"][0]["start"]
    response = client.post("/api/validate", json={"itinerary": data})
    body = response.json()
    assert body["valid"] is False
    assert any("end must be later" in error for error in body["errors"])
