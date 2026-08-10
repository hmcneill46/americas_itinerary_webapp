"""Typed itinerary schema, validation, and deterministic migrations."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from datetime import date, datetime, time, timedelta
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

CURRENT_SCHEMA_VERSION = 5
OLDEST_SUPPORTED_SCHEMA_VERSION = 4

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
ALLOWED_BOOKING_STATUSES = {"planned", "booked", "cancelled"}

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
COLOUR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LOCAL_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$")


class MigrationError(ValueError):
    """Raised when an itinerary cannot be migrated without guessing or data loss."""


class SchemaModel(BaseModel):
    """Base model that validates known fields while retaining extensions."""

    model_config = ConfigDict(extra="allow", strict=True, validate_default=True)


def _required_text(value: str, field_name: str) -> str:
    if not value.strip():
        raise ValueError(f"{field_name} must not be blank")
    return value


def _date_string(value: str, field_name: str, *, allow_blank: bool = False) -> str:
    if allow_blank and value == "":
        return value
    if not DATE_RE.fullmatch(value):
        raise ValueError(f"{field_name} must use YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} is not a valid calendar date") from exc
    return value


def _local_datetime_string(value: str, field_name: str) -> str:
    if not LOCAL_DATETIME_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a floating local timestamp such as 2027-04-08T09:30")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} is not a valid calendar date-time") from exc
    if parsed.tzinfo is not None:
        raise ValueError(f"{field_name} must not include Z or a UTC offset")
    return value


def _identifier(value: str, field_name: str) -> str:
    if not ID_RE.fullmatch(value):
        raise ValueError(
            f"{field_name} must be 1-128 characters using letters, numbers, dot, underscore, colon or hyphen"
        )
    return value


class MapBounds(SchemaModel):
    min_lon: float = Field(ge=-180, le=180)
    max_lon: float = Field(ge=-180, le=180)
    min_lat: float = Field(ge=-90, le=90)
    max_lat: float = Field(ge=-90, le=90)

    @field_validator("min_lon", "max_lon", "min_lat", "max_lat")
    @classmethod
    def finite_values(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("map bound must be finite")
        return value


class Metadata(SchemaModel):
    title: str
    description: str = ""
    start_date: str
    end_date: str
    home_location_id: str
    time_model: Literal["floating_local"]
    time_model_note: str = ""
    default_currency: str = ""
    category_colours: dict[str, str]
    map_bounds: MapBounds
    created_from: str = ""

    @field_validator("title")
    @classmethod
    def title_required(cls, value: str) -> str:
        return _required_text(value, "title")

    @field_validator("start_date", "end_date")
    @classmethod
    def valid_dates(cls, value: str, info: Any) -> str:
        return _date_string(value, info.field_name)

    @field_validator("home_location_id")
    @classmethod
    def valid_home_id(cls, value: str) -> str:
        return _identifier(value, "home_location_id")

    @field_validator("default_currency")
    @classmethod
    def valid_default_currency(cls, value: str) -> str:
        if value and not re.fullmatch(r"[A-Z]{3}", value):
            raise ValueError("default_currency must be blank or a three-letter uppercase currency code")
        return value

    @field_validator("category_colours")
    @classmethod
    def valid_category_colours(cls, value: dict[str, str]) -> dict[str, str]:
        if not value:
            raise ValueError("category_colours must contain at least one category")
        for category, colour in value.items():
            _required_text(category, "category name")
            if not COLOUR_RE.fullmatch(colour):
                raise ValueError(f"colour for {category!r} must be a six-digit hex value such as #3A7D44")
        return value


class Location(SchemaModel):
    id: str
    name: str
    country: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    timezone: str = ""
    notes: str = ""

    @field_validator("id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return _identifier(value, "id")

    @field_validator("name", "country")
    @classmethod
    def required_fields(cls, value: str, info: Any) -> str:
        return _required_text(value, info.field_name)

    @field_validator("latitude", "longitude")
    @classmethod
    def finite_coordinates(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("coordinate must be finite")
        return value


class Visit(SchemaModel):
    id: str
    order: int = Field(ge=1)
    location_id: str
    start_date: str
    end_date: str
    stay_start_date: str = ""
    stay_end_date: str = ""
    arrival_mode: Literal[
        "", "Flight", "Road / bus", "Ferry / boat", "Train", "Trek / walk", "Mixed", "Local transfer"
    ] = ""
    arrival_hours_estimate: float = Field(default=0, ge=0)
    arrival_summary: str = ""
    notes: str = ""

    @field_validator("id", "location_id")
    @classmethod
    def valid_ids(cls, value: str, info: Any) -> str:
        return _identifier(value, info.field_name)

    @field_validator("start_date", "end_date")
    @classmethod
    def valid_dates(cls, value: str, info: Any) -> str:
        return _date_string(value, info.field_name)

    @field_validator("stay_start_date", "stay_end_date")
    @classmethod
    def valid_optional_dates(cls, value: str, info: Any) -> str:
        return _date_string(value, info.field_name, allow_blank=True)

    @field_validator("arrival_hours_estimate")
    @classmethod
    def finite_duration(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("arrival_hours_estimate must be finite")
        return value


class Day(SchemaModel):
    date: str
    day_number: int = Field(ge=1)
    visit_id: str
    location_id: str
    country: str
    base: str
    summary: str
    confidence: Literal["Low", "Medium", "High"]
    notes: str = ""
    is_physical_location_day: bool = False

    @field_validator("date")
    @classmethod
    def valid_date(cls, value: str) -> str:
        return _date_string(value, "date")

    @field_validator("visit_id", "location_id")
    @classmethod
    def valid_ids(cls, value: str, info: Any) -> str:
        return _identifier(value, info.field_name)

    @field_validator("country", "base", "summary")
    @classmethod
    def required_fields(cls, value: str, info: Any) -> str:
        return _required_text(value, info.field_name)


class Event(SchemaModel):
    id: str
    title: str
    category: str
    start: str
    end: str
    visit_id: str
    location_id: str
    from_location_id: str = ""
    to_location_id: str = ""
    transport_mode: Literal[
        "", "Flight", "Road / bus", "Ferry / boat", "Train", "Trek / walk", "Mixed", "Local transfer"
    ] = ""
    confidence: Literal["Low", "Medium", "High"]
    notes: str = ""
    day_summaries: list[str] = Field(default_factory=list)
    source_dates: list[str] = Field(default_factory=list)
    locked: bool = False

    @field_validator("id", "visit_id", "location_id")
    @classmethod
    def valid_required_ids(cls, value: str, info: Any) -> str:
        return _identifier(value, info.field_name)

    @field_validator("from_location_id", "to_location_id")
    @classmethod
    def valid_optional_ids(cls, value: str, info: Any) -> str:
        return value if value == "" else _identifier(value, info.field_name)

    @field_validator("title", "category")
    @classmethod
    def required_fields(cls, value: str, info: Any) -> str:
        return _required_text(value, info.field_name)

    @field_validator("start", "end")
    @classmethod
    def valid_timestamps(cls, value: str, info: Any) -> str:
        return _local_datetime_string(value, info.field_name)

    @field_validator("source_dates")
    @classmethod
    def valid_source_dates(cls, values: list[str]) -> list[str]:
        for value in values:
            _date_string(value, "source_dates item")
        return values


class Booking(SchemaModel):
    id: str
    title: str
    type: str
    status: Literal["planned", "booked", "cancelled"] = "planned"
    urgency: Literal["", "Low", "Medium", "High"] = ""
    date: str = ""
    time: str = ""
    duration: str = ""
    booking_deadline: str = ""
    details: str = ""
    provider: str = ""
    reference: str = ""
    url: str = ""
    notes: str = ""
    event_id: str = ""
    visit_id: str = ""
    location_id: str = ""
    legacy: dict[str, Any] = Field(default_factory=dict)

    @field_validator("id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return _identifier(value, "id")

    @field_validator("title", "type")
    @classmethod
    def required_fields(cls, value: str, info: Any) -> str:
        return _required_text(value, info.field_name)

    @field_validator("date", "booking_deadline")
    @classmethod
    def valid_optional_dates(cls, value: str, info: Any) -> str:
        return _date_string(value, info.field_name, allow_blank=True)

    @field_validator("event_id", "visit_id", "location_id")
    @classmethod
    def valid_optional_ids(cls, value: str, info: Any) -> str:
        return value if value == "" else _identifier(value, info.field_name)

    @field_validator("url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        if value:
            parsed = urlparse(value)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError("url must be blank or an absolute http(s) URL")
        return value


class ItineraryV5(SchemaModel):
    schema_version: Literal[5]
    metadata: Metadata
    locations: dict[str, Location]
    visits: list[Visit]
    days: list[Day]
    events: list[Event]
    bookings: list[Booking]


def _format_pydantic_errors(exc: ValidationError) -> list[str]:
    errors: list[str] = []
    for item in exc.errors(include_url=False):
        path = ".".join(str(part) for part in item["loc"])
        message = item["msg"]
        errors.append(f"{path}: {message}" if path else message)
    return errors


def _parse_date(value: str) -> date:
    return date.fromisoformat(value)


def _parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _duplicate_errors(values: list[str], label: str) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return [f"Duplicate {label} ID: {value}." for value in sorted(duplicates)]


def _cross_record_errors(model: ItineraryV5) -> list[str]:
    errors: list[str] = []
    metadata = model.metadata
    start_date = _parse_date(metadata.start_date)
    end_date = _parse_date(metadata.end_date)
    if end_date < start_date:
        errors.append("metadata.end_date must not be earlier than metadata.start_date.")

    bounds = metadata.map_bounds
    if bounds.min_lon >= bounds.max_lon:
        errors.append("metadata.map_bounds.min_lon must be less than max_lon.")
    if bounds.min_lat >= bounds.max_lat:
        errors.append("metadata.map_bounds.min_lat must be less than max_lat.")

    location_ids = set(model.locations)
    if metadata.home_location_id not in location_ids:
        errors.append("metadata.home_location_id must reference a location in locations.")
    for key, location in model.locations.items():
        if key != location.id:
            errors.append(f"locations.{key}.id must match its object key.")
        if not (bounds.min_lon <= location.longitude <= bounds.max_lon):
            errors.append(f"locations.{key}.longitude lies outside metadata.map_bounds.")
        if not (bounds.min_lat <= location.latitude <= bounds.max_lat):
            errors.append(f"locations.{key}.latitude lies outside metadata.map_bounds.")

    errors.extend(_duplicate_errors([visit.id for visit in model.visits], "visit"))
    errors.extend(_duplicate_errors([event.id for event in model.events], "event"))
    errors.extend(_duplicate_errors([booking.id for booking in model.bookings], "booking"))
    visit_ids = {visit.id for visit in model.visits}
    event_ids = {event.id for event in model.events}

    orders = [visit.order for visit in model.visits]
    if sorted(orders) != list(range(1, len(model.visits) + 1)):
        errors.append("visits.order values must be unique and contiguous from 1.")

    visit_by_id = {visit.id: visit for visit in model.visits}
    for index, visit in enumerate(model.visits):
        path = f"visits[{index}]"
        visit_start = _parse_date(visit.start_date)
        visit_end = _parse_date(visit.end_date)
        if visit.location_id not in location_ids:
            errors.append(f"{path}.location_id references unknown location {visit.location_id!r}.")
        if visit_end < visit_start:
            errors.append(f"{path}.end_date must not be earlier than start_date.")
        if visit_start < start_date or visit_end > end_date:
            errors.append(f"{path} lies outside the metadata date range.")
        if bool(visit.stay_start_date) != bool(visit.stay_end_date):
            errors.append(f"{path}.stay_start_date and stay_end_date must either both be set or both be blank.")
        if visit.stay_start_date and visit.stay_end_date:
            stay_start = _parse_date(visit.stay_start_date)
            stay_end = _parse_date(visit.stay_end_date)
            if not visit_start <= stay_start <= stay_end <= visit_end:
                errors.append(f"{path} stay dates must be ordered within the visit date range.")

    expected_day_count = (end_date - start_date).days + 1 if end_date >= start_date else 0
    if len(model.days) != expected_day_count:
        errors.append(f"days must contain exactly {expected_day_count} entries for the metadata date range.")
    day_dates: set[str] = set()
    days_by_visit: dict[str, set[str]] = {visit_id: set() for visit_id in visit_ids}
    for index, day_row in enumerate(model.days):
        path = f"days[{index}]"
        expected_date = (start_date + timedelta(days=index)).isoformat()
        if day_row.date != expected_date:
            errors.append(f"{path}.date must be {expected_date}.")
        if day_row.day_number != index + 1:
            errors.append(f"{path}.day_number must be {index + 1}.")
        if day_row.date in day_dates:
            errors.append(f"Duplicate day date: {day_row.date}.")
        day_dates.add(day_row.date)
        visit = visit_by_id.get(day_row.visit_id)
        if not visit:
            errors.append(f"{path}.visit_id references unknown visit {day_row.visit_id!r}.")
        else:
            days_by_visit[visit.id].add(day_row.date)
            if day_row.location_id != visit.location_id:
                errors.append(f"{path}.location_id must match its visit location.")
            if not visit.start_date <= day_row.date <= visit.end_date:
                errors.append(f"{path}.date lies outside its visit date range.")
        if day_row.location_id not in location_ids:
            errors.append(f"{path}.location_id references unknown location {day_row.location_id!r}.")

    for index, visit in enumerate(model.visits):
        expected_dates = {
            (date.fromisoformat(visit.start_date) + timedelta(days=offset)).isoformat()
            for offset in range((date.fromisoformat(visit.end_date) - date.fromisoformat(visit.start_date)).days + 1)
        }
        if days_by_visit.get(visit.id, set()) != expected_dates:
            errors.append(f"visits[{index}] must own exactly one day record for every date in its range.")

    category_names = set(metadata.category_colours)
    lower_bound = datetime.combine(start_date, time.min)
    upper_bound = datetime.combine(end_date + timedelta(days=1), time.min)
    for index, event in enumerate(model.events):
        path = f"events[{index}]"
        start = _parse_datetime(event.start)
        end = _parse_datetime(event.end)
        if event.category not in category_names:
            errors.append(f"{path}.category references unknown category {event.category!r}.")
        if end <= start:
            errors.append(f"{path}.end must be later than start.")
        if start < lower_bound or end > upper_bound:
            errors.append(f"{path} lies outside the itinerary date range.")
        visit = visit_by_id.get(event.visit_id)
        if not visit:
            errors.append(f"{path}.visit_id references unknown visit {event.visit_id!r}.")
        else:
            visit_start = datetime.combine(_parse_date(visit.start_date), time.min)
            visit_end = datetime.combine(_parse_date(visit.end_date) + timedelta(days=1), time.min)
            if start < visit_start or end > visit_end:
                errors.append(f"{path} lies outside its visit date range.")
            if event.location_id != visit.location_id:
                errors.append(f"{path}.location_id must match its visit location.")
        if event.location_id not in location_ids:
            errors.append(f"{path}.location_id references unknown location {event.location_id!r}.")
        for field_name in ("from_location_id", "to_location_id"):
            reference = getattr(event, field_name)
            if reference and reference not in location_ids:
                errors.append(f"{path}.{field_name} references unknown location {reference!r}.")
        for source_date in event.source_dates:
            if source_date not in day_dates:
                errors.append(f"{path}.source_dates contains date {source_date!r} outside days.")

    for index, booking in enumerate(model.bookings):
        path = f"bookings[{index}]"
        if booking.event_id and booking.event_id not in event_ids:
            errors.append(f"{path}.event_id references unknown event {booking.event_id!r}.")
        if booking.visit_id and booking.visit_id not in visit_ids:
            errors.append(f"{path}.visit_id references unknown visit {booking.visit_id!r}.")
        if booking.location_id and booking.location_id not in location_ids:
            errors.append(f"{path}.location_id references unknown location {booking.location_id!r}.")
        if booking.visit_id and booking.location_id:
            visit = visit_by_id.get(booking.visit_id)
            if visit and visit.location_id != booking.location_id:
                errors.append(f"{path}.location_id must match its referenced visit location.")

    return list(dict.fromkeys(errors))


def validate_current_itinerary(data: Any) -> dict[str, list[str]]:
    """Validate schema v5 without mutating or normalising the supplied document."""

    if not isinstance(data, dict):
        return {"errors": ["The itinerary must be a JSON object."], "warnings": []}
    try:
        json.dumps(data, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        return {"errors": [f"The itinerary must contain only standard JSON values: {exc}"], "warnings": []}
    try:
        model = ItineraryV5.model_validate(data)
    except ValidationError as exc:
        return {"errors": _format_pydantic_errors(exc), "warnings": []}
    return {"errors": _cross_record_errors(model), "warnings": []}


def _legacy_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict) and set(value) == {"__date__"}:
        return str(value["__date__"])
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _legacy_value(values: list[Any], index: int) -> Any:
    return values[index] if index < len(values) else None


def _stable_booking_id(index: int, value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()[:10]
    return f"booking_{index + 1:03d}_{digest}"


def _migrate_booking_row(value: Any, index: int) -> dict[str, Any]:
    stable_id = _stable_booking_id(index, value)
    if isinstance(value, list):
        raw_status = _legacy_value(value, 6)
        status = "booked" if raw_status is True else "cancelled" if raw_status == "cancelled" else "planned"
        urgency = _legacy_text(_legacy_value(value, 8))
        if urgency not in {"", "Low", "Medium", "High"}:
            urgency = ""
        booking_type = _legacy_text(_legacy_value(value, 1)).strip() or "Other"
        title = _legacy_text(_legacy_value(value, 2)).strip() or booking_type
        return {
            "id": stable_id,
            "title": title,
            "type": booking_type,
            "status": status,
            "urgency": urgency,
            "date": _legacy_text(_legacy_value(value, 0)),
            "time": _legacy_text(_legacy_value(value, 3)),
            "duration": _legacy_text(_legacy_value(value, 4)),
            "booking_deadline": _legacy_text(_legacy_value(value, 5)),
            "details": _legacy_text(_legacy_value(value, 7)),
            "provider": "",
            "reference": _legacy_text(_legacy_value(value, 10)),
            "url": "",
            "notes": _legacy_text(_legacy_value(value, 9)),
            "event_id": "",
            "visit_id": "",
            "location_id": "",
            "legacy": {"source_schema_version": 4, "positional_values": copy.deepcopy(value)},
        }
    if isinstance(value, dict):
        original = copy.deepcopy(value)
        booking_type = _legacy_text(value.get("type", value.get("kind", value.get("category", "Other")))).strip() or "Other"
        title = _legacy_text(value.get("title", value.get("item", value.get("name", booking_type)))).strip() or booking_type
        raw_status = value.get("status", "booked" if value.get("booked") is True else "planned")
        status = raw_status if raw_status in ALLOWED_BOOKING_STATUSES else "planned"
        urgency = value.get("urgency", value.get("priority", ""))
        urgency = urgency if urgency in {"", "Low", "Medium", "High"} else ""
        return {
            "id": value.get("id") if isinstance(value.get("id"), str) and ID_RE.fullmatch(value["id"]) else stable_id,
            "title": title,
            "type": booking_type,
            "status": status,
            "urgency": urgency,
            "date": _legacy_text(value.get("date", "")),
            "time": _legacy_text(value.get("time", "")),
            "duration": _legacy_text(value.get("duration", "")),
            "booking_deadline": _legacy_text(value.get("booking_deadline", value.get("book_by", ""))),
            "details": _legacy_text(value.get("details", "")),
            "provider": _legacy_text(value.get("provider", "")),
            "reference": _legacy_text(value.get("reference", "")),
            "url": _legacy_text(value.get("url", "")),
            "notes": _legacy_text(value.get("notes", "")),
            "event_id": _legacy_text(value.get("event_id", "")),
            "visit_id": _legacy_text(value.get("visit_id", "")),
            "location_id": _legacy_text(value.get("location_id", "")),
            "legacy": {"source_schema_version": 4, "object": original},
        }
    raise MigrationError(f"bookings[{index}] must be an array or object in schema version 4")


def migrate_v4_to_v5(data: dict[str, Any]) -> dict[str, Any]:
    """Convert legacy booking rows to named objects and retain every source value."""

    migrated = copy.deepcopy(data)
    bookings = migrated.get("bookings")
    if not isinstance(bookings, list):
        raise MigrationError("bookings must be an array in schema version 4")
    migrated["bookings"] = [_migrate_booking_row(value, index) for index, value in enumerate(bookings)]
    migrated["schema_version"] = 5
    return migrated


MIGRATIONS = {4: migrate_v4_to_v5}


def migrate_to_current(data: Any) -> tuple[dict[str, Any], list[str], int]:
    """Return a migrated copy, migration labels, and the original schema version."""

    if not isinstance(data, dict):
        raise MigrationError("The itinerary must be a JSON object.")
    version = data.get("schema_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise MigrationError("schema_version must be an integer.")
    if version < OLDEST_SUPPORTED_SCHEMA_VERSION:
        raise MigrationError(
            f"schema_version {version} is too old; the oldest supported version is {OLDEST_SUPPORTED_SCHEMA_VERSION}."
        )
    if version > CURRENT_SCHEMA_VERSION:
        raise MigrationError(
            f"schema_version {version} is newer than this application supports ({CURRENT_SCHEMA_VERSION})."
        )

    original_version = version
    migrated = copy.deepcopy(data)
    applied: list[str] = []
    while version < CURRENT_SCHEMA_VERSION:
        migration = MIGRATIONS.get(version)
        if migration is None:
            raise MigrationError(f"No migration is available from schema_version {version}.")
        migrated = migration(migrated)
        next_version = migrated.get("schema_version")
        if next_version != version + 1:
            raise MigrationError(f"Migration from schema_version {version} did not produce version {version + 1}.")
        applied.append(f"v{version}->v{next_version}")
        version = next_version
    return migrated, applied, original_version
