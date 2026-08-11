from __future__ import annotations

import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient

import app as itinerary_app
from trip_schema import CURRENT_SCHEMA_VERSION, migrate_to_current, validate_current_itinerary


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "itinerary.example.json"


def load_example() -> dict:
    return json.loads(SOURCE.read_text(encoding="utf-8"))


def legacy_v4_itinerary() -> tuple[dict, list]:
    data = load_example()
    row = [
        {"__date__": "2027-04-09"},
        "Train",
        "London to Paris",
        "Morning",
        "About 2h 30m",
        {"__date__": "2027-03-01"},
        True,
        "Flexible ticket",
        "High",
        "Keep a copy offline.",
        "LEGACY-DEMO-001",
        {"future_column": "must survive"},
    ]
    data["schema_version"] = 4
    data.pop("budget", None)
    data["bookings"] = [row]
    data["legacy_root_extension"] = {"keep": True}
    return data, row


def configure_temp_data(tmp_path, monkeypatch, source_data: dict | None = None):
    data_dir = tmp_path / "data"
    backup_dir = data_dir / "backups"
    data_dir.mkdir()
    backup_dir.mkdir()
    target = data_dir / "itinerary.json"
    if source_data is None:
        target.write_bytes(SOURCE.read_bytes())
    else:
        target.write_text(json.dumps(source_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    monkeypatch.setattr(itinerary_app, "DATA_DIR", data_dir)
    monkeypatch.setattr(itinerary_app, "BACKUP_DIR", backup_dir)
    monkeypatch.setattr(itinerary_app, "DATA_FILE", target)
    monkeypatch.setattr(itinerary_app, "EDIT_TOKEN", "")
    return target, backup_dir


def assert_invalid(data: dict, text: str) -> None:
    result = itinerary_app.validate_itinerary(data)
    assert result["errors"], result
    assert any(text in error for error in result["errors"]), result["errors"]


def test_example_is_canonical_current_schema_and_validates():
    data = load_example()
    result = validate_current_itinerary(data)
    assert data["schema_version"] == CURRENT_SCHEMA_VERSION
    assert result == {"errors": [], "warnings": []}
    assert len(data["days"]) == 5
    assert {booking["lifecycle"] for booking in data["bookings"]} >= {"ready_to_book", "booked", "cancelled", "not_researched"}
    assert any(event["start"] == "2027-04-11T15:00" and event["end"] == "2027-04-12T09:00" for event in data["events"])


def test_v4_booking_migration_is_deterministic_lossless_and_idempotent():
    legacy, row = legacy_v4_itinerary()
    untouched = copy.deepcopy(legacy)

    first, applied, source_version = migrate_to_current(legacy)
    second, second_applied, _ = migrate_to_current(first)
    repeated, _, _ = migrate_to_current(legacy)

    assert legacy == untouched
    assert source_version == 4
    assert applied == ["v4->v5", "v5->v6", "v6->v7"]
    assert second_applied == []
    assert first == second == repeated
    assert first["schema_version"] == 7
    assert first["budget"]["cost_items"] == []
    assert first["budget"]["base_currency"] == "GBP"
    assert first["legacy_root_extension"] == {"keep": True}
    booking = first["bookings"][0]
    assert booking["id"].startswith("booking_001_")
    assert booking["title"] == "London to Paris"
    assert booking["type"] == "Train"
    assert booking["status"] == "booked"
    assert booking["date"] == "2027-04-09"
    assert booking["booking_deadline"] == "2027-03-01"
    assert booking["legacy"]["positional_values"] == row
    assert booking["lifecycle"] == "booked"
    assert booking["timing"]["strategy"] == "unknown"
    assert validate_current_itinerary(first)["errors"] == []


def test_v5_budget_migration_is_deterministic_and_preserves_existing_content():
    legacy = load_example()
    legacy["schema_version"] = 5
    budget = legacy.pop("budget")
    legacy["legacy_extension"] = {"keep": ["me"]}

    migrated, applied, source_version = migrate_to_current(legacy)
    repeated, repeated_applied, _ = migrate_to_current(migrated)

    assert source_version == 5
    assert applied == ["v5->v6", "v6->v7"]
    assert repeated_applied == []
    assert migrated == repeated
    assert migrated["budget"]["base_currency"] == "GBP"
    assert migrated["budget"]["cost_items"] == []
    assert len(migrated["budget"]["categories"]) >= 10
    assert migrated["legacy_extension"] == {"keep": ["me"]}
    assert budget["cost_items"]  # The v5 input had no financial interpretation to infer.


def test_v6_booking_migration_is_conservative_and_links_existing_costs():
    legacy = load_example()
    legacy["schema_version"] = 6
    for booking in legacy["bookings"]:
        booking["status"] = {"ready_to_book": "planned", "booked": "booked", "cancelled": "cancelled"}.get(booking["lifecycle"], "planned")
        booking.pop("lifecycle", None)
        booking.pop("timing", None)
        booking.pop("cost_item_id", None)
    migrated, applied, source_version = migrate_to_current(legacy)
    repeated, repeated_applied, _ = migrate_to_current(migrated)
    assert source_version == 6
    assert applied == ["v6->v7"]
    assert repeated_applied == []
    assert migrated == repeated
    rail = next(booking for booking in migrated["bookings"] if booking["id"] == "booking_train_london_paris")
    assert rail["lifecycle"] == "booked"
    assert rail["timing"]["strategy"] == "unknown"
    assert rail["cost_item_id"] == "cost_rail_london_paris"
    assert validate_current_itinerary(migrated)["errors"] == []


def test_validate_endpoint_returns_migrated_document():
    legacy, _ = legacy_v4_itinerary()
    response = TestClient(itinerary_app.app).post("/api/validate", json={"itinerary": legacy})
    body = response.json()
    assert response.status_code == 200
    assert body["valid"] is True
    assert body["migrations"] == ["v4->v5", "v5->v6", "v6->v7"]
    assert body["itinerary"]["schema_version"] == 7
    assert isinstance(body["itinerary"]["bookings"][0], dict)


def test_get_migrates_legacy_file_in_memory_without_rewriting(tmp_path, monkeypatch):
    legacy, _ = legacy_v4_itinerary()
    target, _ = configure_temp_data(tmp_path, monkeypatch, legacy)
    original_bytes = target.read_bytes()

    response = TestClient(itinerary_app.app).get("/api/itinerary")
    body = response.json()

    assert response.status_code == 200
    assert body["migrations"] == ["v4->v5", "v5->v6", "v6->v7"]
    assert body["itinerary"]["schema_version"] == 7
    assert target.read_bytes() == original_bytes


def test_map_config_defaults_and_safe_overrides():
    default = itinerary_app.build_map_config({})
    assert default == {
        "provider_name": "OpenFreeMap",
        "style_url": "https://tiles.openfreemap.org/styles/positron",
        "attribution": {
            "text": "OpenFreeMap · OpenMapTiles · OpenStreetMap contributors",
            "url": "https://openfreemap.org/",
        },
    }

    custom = itinerary_app.build_map_config(
        {
            "TRIP_MAP_PROVIDER_NAME": "Home tiles",
            "TRIP_MAP_STYLE_URL": "/static/maps/style.json",
            "TRIP_MAP_ATTRIBUTION_TEXT": "Private map data",
            "TRIP_MAP_ATTRIBUTION_URL": "https://example.test/licence",
        }
    )
    assert custom["style_url"] == "/static/maps/style.json"
    assert custom["provider_name"] == "Home tiles"


def test_map_config_rejects_unsafe_urls(monkeypatch):
    with monkeypatch.context() as context:
        context.setenv("TRIP_MAP_STYLE_URL", "javascript:alert(1)")
        response = TestClient(itinerary_app.app).get("/api/map-config")
    assert response.status_code == 500
    assert "Invalid map configuration" in response.json()["detail"]


def test_vendored_maplibre_modules_have_browser_compatible_mime_type():
    response = TestClient(itinerary_app.app).get(
        "/static/vendor/maplibre-gl/maplibre-gl.mjs"
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/javascript")


def test_malformed_metadata_and_strict_booleans_are_rejected():
    data = load_example()
    data["metadata"] = None
    assert_invalid(data, "metadata")

    data = load_example()
    data["days"][0]["is_physical_location_day"] = "true"
    assert_invalid(data, "is_physical_location_day")


def test_invalid_coordinates_and_map_bounds_are_rejected():
    data = load_example()
    data["locations"]["paris"]["latitude"] = 95.0
    assert_invalid(data, "latitude")

    data = load_example()
    data["metadata"]["map_bounds"]["min_lon"] = 8.0
    data["metadata"]["map_bounds"]["max_lon"] = 6.0
    assert_invalid(data, "min_lon must be less than max_lon")

    data = load_example()
    data["metadata"]["map_bounds"]["max_lat"] = 51.0
    assert_invalid(data, "lies outside metadata.map_bounds")

    data = load_example()
    data["locations"]["paris"]["longitude"] = float("nan")
    assert_invalid(data, "standard JSON values")


def test_broken_references_are_rejected():
    data = load_example()
    data["events"][0]["visit_id"] = "missing_visit"
    assert_invalid(data, "references unknown visit")

    data = load_example()
    data["bookings"][0]["event_id"] = "missing_event"
    assert_invalid(data, "references unknown event")

    data = load_example()
    data["metadata"]["home_location_id"] = "missing_home"
    assert_invalid(data, "home_location_id")

    data = load_example()
    data["events"][0]["category"] = "Unknown category"
    assert_invalid(data, "references unknown category")

    data = load_example()
    data["events"][1]["id"] = data["events"][0]["id"]
    assert_invalid(data, "Duplicate event ID")


def test_malformed_and_zoned_timestamps_are_rejected():
    data = load_example()
    data["events"][0]["start"] = "2027-02-30T09:00"
    assert_invalid(data, "valid calendar date-time")

    data = load_example()
    data["events"][0]["start"] = "2027-04-08T09:00Z"
    assert_invalid(data, "floating local timestamp")

    data = load_example()
    data["events"][0]["end"] = data["events"][0]["start"]
    assert_invalid(data, "end must be later")


def test_multiday_exact_minute_event_is_valid():
    data = load_example()
    template = copy.deepcopy(data["events"][-1])
    template.update(
        {
            "id": "evt_test_overnight_train",
            "title": "Example overnight train",
            "category": "Travel",
            "start": "2027-04-11T22:30",
            "end": "2027-04-12T06:15",
            "visit_id": "amsterdam_01",
            "location_id": "amsterdam",
            "from_location_id": "paris",
            "to_location_id": "amsterdam",
            "transport_mode": "Train",
            "source_dates": ["2027-04-11", "2027-04-12"],
        }
    )
    data["events"].append(template)
    assert itinerary_app.validate_itinerary(data)["errors"] == []


def test_unsafe_category_colours_are_rejected_and_not_interpolated_into_html():
    data = load_example()
    data["metadata"]["category_colours"]["Activity"] = "#fff;background:url(javascript:alert(1))"
    assert_invalid(data, "six-digit hex")

    frontend = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    assert "style.backgroundColor = colourForCategory" in frontend
    assert "background:${colour}" not in frontend
    assert "style=\"background:${colourForCategory" not in frontend


def test_structured_booking_fields_and_references_are_validated():
    data = load_example()
    assert itinerary_app.validate_itinerary(data)["errors"] == []

    data = load_example()
    data["bookings"][0]["lifecycle"] = "maybe"
    assert_invalid(data, "bookings.0.lifecycle")

    data = load_example()
    data["bookings"][0]["provider"] = None
    assert_invalid(data, "bookings.0.provider")

    data = load_example()
    data["bookings"][0]["url"] = "javascript:alert(1)"
    assert_invalid(data, "absolute http(s) URL")

    data = load_example()
    data["bookings"][0]["timing"]["source_urls"] = ["javascript:alert(1)"]
    assert_invalid(data, "source_urls")

    data = load_example()
    data["bookings"][0]["cost_item_id"] = "missing_cost"
    assert_invalid(data, "unknown cost item")

    data = load_example()
    data["bookings"][0]["timing"]["lead_days"] = -1
    assert_invalid(data, "lead_days")

    data = load_example()
    data["bookings"][0]["cost_item_id"] = "cost_paris_museum"
    data["budget"]["cost_items"][3]["booking_id"] = "booking_paris_museum"
    assert_invalid(data, "does not agree with booking.cost_item_id")

    data = load_example()
    data["bookings"][0]["cost_item_id"] = "cost_rail_london_paris"
    data["budget"]["cost_items"][0]["booking_id"] = "booking_train_london_paris"
    data["budget"]["cost_items"][0]["committed_amount"] = "0"
    result = itinerary_app.validate_itinerary(data)
    assert result["errors"] == []
    assert any("linked cost item with no committed" in warning for warning in result["warnings"])


def test_budget_validation_references_money_and_warnings():
    data = load_example()
    assert itinerary_app.validate_itinerary(data)["errors"] == []

    data = load_example()
    data["budget"]["base_currency"] = "gbp"
    assert_invalid(data, "three-letter uppercase")

    data = load_example()
    data["budget"]["cost_items"][0]["expected"]["unit_amount"] = 92.0
    assert_invalid(data, "unit_amount")

    data = load_example()
    data["budget"]["cost_items"][0]["category_id"] = "missing"
    assert_invalid(data, "unknown financial category")

    data = load_example()
    data["budget"]["cost_items"][0]["payments"].append(copy.deepcopy(data["budget"]["cost_items"][0]["payments"][0]))
    assert_invalid(data, "Duplicate payment")

    data = load_example()
    data["budget"]["cost_items"][1]["fx"]["rate_to_base"] = ""
    result = itinerary_app.validate_itinerary(data)
    assert result["errors"] == []
    assert any("no FX rate" in warning for warning in result["warnings"])

    data = load_example()
    data["budget"]["cost_items"][0]["committed_amount"] = "500"
    result = itinerary_app.validate_itinerary(data)
    assert result["errors"] == []
    assert any("greater than its expected" in warning for warning in result["warnings"])

    data = load_example()
    data["budget"]["cost_items"][0]["visit_id"] = "deleted_visit"
    assert_invalid(data, "unknown visit")

    data = load_example()
    data["budget"]["cost_items"][0]["booking_id"] = "deleted_booking"
    assert_invalid(data, "unknown booking")

    data = load_example()
    data["budget"]["cost_items"][1]["currency"] = "EURO"
    assert_invalid(data, "three-letter uppercase")

    data = load_example()
    data["budget"]["cost_items"].append(copy.deepcopy(data["budget"]["cost_items"][0]))
    assert_invalid(data, "Duplicate cost item ID")


def test_save_requires_revision_and_rejects_stale_revision(tmp_path, monkeypatch):
    configure_temp_data(tmp_path, monkeypatch)
    client = TestClient(itinerary_app.app)
    itinerary = load_example()

    missing = client.put("/api/itinerary", json={"itinerary": itinerary})
    assert missing.status_code == 428

    loaded = client.get("/api/itinerary").json()
    revision = loaded["revision"]
    itinerary["metadata"]["description"] = "Changed in test"
    saved = client.put("/api/itinerary", json={"expected_revision": revision, "itinerary": itinerary})
    assert saved.status_code == 200
    assert saved.json()["revision"] != revision

    conflict = client.put("/api/itinerary", json={"expected_revision": revision, "itinerary": itinerary})
    assert conflict.status_code == 409


def test_budget_data_saves_and_reloads_with_exact_strings(tmp_path, monkeypatch):
    configure_temp_data(tmp_path, monkeypatch)
    client = TestClient(itinerary_app.app)
    loaded = client.get("/api/itinerary").json()
    itinerary = loaded["itinerary"]
    item = itinerary["budget"]["cost_items"][1]
    item["expected"]["unit_amount"] = "180.125"
    item["payments"].append({"id": "payment_precision", "kind": "payment", "amount": "0.125", "date": "2027-01-16", "note": "Exact test"})

    saved = client.put("/api/itinerary", json={"expected_revision": loaded["revision"], "itinerary": itinerary})
    assert saved.status_code == 200
    reloaded = client.get("/api/itinerary").json()["itinerary"]
    stored = next(item for item in reloaded["budget"]["cost_items"] if item["id"] == "cost_paris_accommodation")
    assert stored["expected"]["unit_amount"] == "180.125"
    assert stored["payments"][-1]["amount"] == "0.125"


def test_save_creates_exact_backup_and_rotates_after_success(tmp_path, monkeypatch):
    target, backup_dir = configure_temp_data(tmp_path, monkeypatch)
    monkeypatch.setattr(itinerary_app, "MAX_BACKUPS", 3)
    client = TestClient(itinerary_app.app)
    previous_bytes = target.read_bytes()

    for index in range(5):
        loaded = client.get("/api/itinerary").json()
        itinerary = loaded["itinerary"]
        itinerary["metadata"]["description"] = f"Save {index}"
        response = client.put(
            "/api/itinerary",
            json={"expected_revision": loaded["revision"], "itinerary": itinerary},
        )
        assert response.status_code == 200
        backups = list(backup_dir.glob("itinerary_*.json"))
        if index == 0:
            assert len(backups) == 1
            assert backups[0].read_bytes() == previous_bytes

    backups = list(backup_dir.glob("itinerary_*.json"))
    assert len(backups) == 3
    assert json.loads(target.read_text(encoding="utf-8"))["metadata"]["description"] == "Save 4"
    assert all(json.loads(path.read_text(encoding="utf-8"))["schema_version"] == CURRENT_SCHEMA_VERSION for path in backups)


def test_legacy_save_persists_current_schema_and_keeps_backup(tmp_path, monkeypatch):
    legacy, row = legacy_v4_itinerary()
    target, backup_dir = configure_temp_data(tmp_path, monkeypatch, legacy)
    original_bytes = target.read_bytes()
    client = TestClient(itinerary_app.app)
    loaded = client.get("/api/itinerary").json()

    response = client.put(
        "/api/itinerary",
        json={"expected_revision": loaded["revision"], "itinerary": loaded["itinerary"]},
    )

    assert response.status_code == 200
    saved = json.loads(target.read_text(encoding="utf-8"))
    assert saved["schema_version"] == CURRENT_SCHEMA_VERSION
    assert saved["bookings"][0]["legacy"]["positional_values"] == row
    backups = list(backup_dir.glob("itinerary_*.json"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == original_bytes


def test_invalid_migration_fails_safely():
    data = load_example()
    data["schema_version"] = 4
    data["bookings"] = ["not a booking row"]
    result = itinerary_app.validate_itinerary(data)
    assert result["itinerary"] is None
    assert any("bookings[0]" in error for error in result["errors"])

    data = load_example()
    data["schema_version"] = 999
    assert_invalid(data, "newer than this application supports")
