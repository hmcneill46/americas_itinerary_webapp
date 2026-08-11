"""Typed itinerary schema, validation, and deterministic migrations."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from decimal import Decimal, InvalidOperation
from datetime import date, datetime, time, timedelta
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

CURRENT_SCHEMA_VERSION = 8
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
MONEY_RE = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?$")

DEFAULT_FINANCIAL_CATEGORIES = (
    ("accommodation", "Accommodation", "#6C63A8"),
    ("long_distance_transport", "Long-distance Transport", "#E58C47"),
    ("local_transport", "Local Transport", "#527284"),
    ("food_drink", "Food & Drink", "#D58F52"),
    ("activities_tours", "Activities & Tours", "#7FB77E"),
    ("treks_expeditions", "Treks / Expeditions", "#498C8A"),
    ("visas_admin", "Visas & Admin", "#E8C547"),
    ("insurance", "Insurance", "#607D8B"),
    ("gear_equipment", "Gear / Equipment", "#8064A2"),
    ("communications", "Communications", "#4C8DA8"),
    ("miscellaneous", "Miscellaneous", "#8A7C70"),
)


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


def _local_datetime_string(value: str, field_name: str, allow_blank: bool = False) -> str:
    if allow_blank and value == "":
        return value
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


def _currency_code(value: str, field_name: str) -> str:
    if not re.fullmatch(r"[A-Z]{3}", value):
        raise ValueError(f"{field_name} must be a three-letter uppercase currency code")
    return value


def _money(value: str, field_name: str, *, allow_negative: bool = True) -> str:
    if not MONEY_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be an exact decimal string such as 25.00")
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"{field_name} must be a valid decimal amount") from exc
    if not parsed.is_finite():
        raise ValueError(f"{field_name} must be finite")
    if not allow_negative and parsed < 0:
        raise ValueError(f"{field_name} must not be negative")
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
    outcome: Literal["planned", "completed", "delayed", "missed", "cancelled", "skipped", "replaced"] = "planned"
    actual_start: str = ""
    actual_end: str = ""
    outcome_note: str = ""
    replaces_event_id: str = ""

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

    @field_validator("start", "end", "actual_start", "actual_end")
    @classmethod
    def valid_timestamps(cls, value: str, info: Any) -> str:
        return _local_datetime_string(value, info.field_name, allow_blank=info.field_name.startswith("actual_"))

    @field_validator("replaces_event_id")
    @classmethod
    def valid_replaces_id(cls, value: str) -> str:
        return value if value == "" else _identifier(value, "replaces_event_id")

    @model_validator(mode="after")
    def valid_actual_range(self) -> "Event":
        if self.actual_start and self.actual_end and _parse_datetime(self.actual_end) < _parse_datetime(self.actual_start):
            raise ValueError("actual_end must not be earlier than actual_start")
        return self

    @field_validator("source_dates")
    @classmethod
    def valid_source_dates(cls, values: list[str]) -> list[str]:
        for value in values:
            _date_string(value, "source_dates item")
        return values


class BookingTiming(SchemaModel):
    """Structured, explainable advice about *when* to act on a booking."""

    strategy: Literal["unknown", "book_now", "before_departure", "lead_time", "on_arrival", "flexible"] = "unknown"
    recommended_date: str = ""
    lead_days: int = Field(default=0, ge=0, le=3650)
    anchor: Literal["event_start", "visit_start", "trip_start"] = "event_start"
    hard_deadline: str = ""
    sell_out_risk: Literal["unknown", "low", "medium", "high"] = "unknown"
    price_rise_risk: Literal["unknown", "low", "medium", "high"] = "unknown"
    flexibility_value: Literal["unknown", "low", "medium", "high"] = "unknown"
    rationale: str = ""
    confidence: Literal["unknown", "low", "medium", "high"] = "unknown"
    last_researched_date: str = ""
    source_urls: list[str] = Field(default_factory=list)

    @field_validator("recommended_date", "hard_deadline", "last_researched_date")
    @classmethod
    def valid_optional_dates(cls, value: str, info: Any) -> str:
        return _date_string(value, info.field_name, allow_blank=True)

    @field_validator("source_urls")
    @classmethod
    def valid_source_urls(cls, values: list[str]) -> list[str]:
        for value in values:
            parsed = urlparse(value)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError("source_urls items must be absolute http(s) URLs")
        return values


class Booking(SchemaModel):
    id: str
    title: str
    type: str
    lifecycle: Literal["not_researched", "researching", "ready_to_book", "booked", "cancelled", "not_required"] = "not_researched"
    timing: BookingTiming = Field(default_factory=BookingTiming)
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
    cost_item_id: str = ""
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

    @field_validator("event_id", "visit_id", "location_id", "cost_item_id")
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


class FinancialCategory(SchemaModel):
    id: str
    name: str
    colour: str

    @field_validator("id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return _identifier(value, "financial category id")

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        return _required_text(value, "financial category name")

    @field_validator("colour")
    @classmethod
    def valid_colour(cls, value: str) -> str:
        if not COLOUR_RE.fullmatch(value):
            raise ValueError("financial category colour must be a six-digit hex value such as #3A7D44")
        return value


class CostExpectation(SchemaModel):
    """One unit price and a small, explicit quantity basis; never a stored total."""

    unit_amount: str
    basis: Literal["fixed", "per_day", "per_night", "per_person", "per_unit"] = "fixed"
    quantity_source: Literal["manual", "visit_days", "visit_nights"] = "manual"
    quantity: int = Field(default=1, ge=0)

    @field_validator("unit_amount")
    @classmethod
    def valid_unit_amount(cls, value: str) -> str:
        return _money(value, "expected.unit_amount", allow_negative=False)

    @model_validator(mode="after")
    def valid_basis_quantity(self) -> "CostExpectation":
        if self.basis == "fixed" and (self.quantity_source != "manual" or self.quantity != 1):
            raise ValueError("fixed expected costs must use manual quantity 1")
        if self.quantity_source != "manual" and self.quantity != 0:
            raise ValueError("derived visit quantities must use quantity 0")
        if self.basis in {"per_day", "per_night"} and self.quantity_source == "manual" and self.quantity < 1:
            raise ValueError("manual daily/nightly quantities must be at least 1")
        if self.basis in {"per_person", "per_unit"} and self.quantity_source != "manual":
            raise ValueError("per-person and per-unit costs require a manual quantity")
        if self.basis in {"per_person", "per_unit"} and self.quantity < 1:
            raise ValueError("manual quantities must be at least 1")
        return self


class FxSnapshot(SchemaModel):
    """Stored native-to-base rate; blank means the item cannot yet be totalled in base currency."""

    rate_to_base: str = ""
    as_of_date: str = ""
    source: str = ""
    note: str = ""

    @field_validator("rate_to_base")
    @classmethod
    def valid_rate(cls, value: str) -> str:
        if value == "":
            return value
        _money(value, "fx.rate_to_base", allow_negative=False)
        if Decimal(value) <= 0:
            raise ValueError("fx.rate_to_base must be greater than zero")
        return value

    @field_validator("as_of_date")
    @classmethod
    def valid_as_of_date(cls, value: str) -> str:
        return _date_string(value, "fx.as_of_date", allow_blank=True)


class CostPayment(SchemaModel):
    id: str
    kind: Literal["payment", "refund", "adjustment"] = "payment"
    amount: str
    date: str = ""
    note: str = ""

    @field_validator("id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return _identifier(value, "payment id")

    @field_validator("amount")
    @classmethod
    def valid_amount(cls, value: str) -> str:
        return _money(value, "payment amount")

    @field_validator("date")
    @classmethod
    def valid_date(cls, value: str) -> str:
        return _date_string(value, "payment date", allow_blank=True)

    @model_validator(mode="after")
    def valid_kind_amount(self) -> "CostPayment":
        if self.kind in {"payment", "refund"} and Decimal(self.amount) < 0:
            raise ValueError("payment and refund amounts must not be negative; use adjustment for a signed correction")
        return self


class CostItem(SchemaModel):
    id: str
    name: str
    category_id: str
    currency: str
    expected: CostExpectation
    committed_amount: str = "0"
    fx: FxSnapshot = Field(default_factory=FxSnapshot)
    payments: list[CostPayment] = Field(default_factory=list)
    visit_id: str = ""
    event_id: str = ""
    booking_id: str = ""
    location_id: str = ""
    start_date: str = ""
    end_date: str = ""
    notes: str = ""

    @field_validator("id", "category_id")
    @classmethod
    def valid_ids(cls, value: str, info: Any) -> str:
        return _identifier(value, info.field_name)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        return _required_text(value, "cost item name")

    @field_validator("currency")
    @classmethod
    def valid_currency(cls, value: str) -> str:
        return _currency_code(value, "currency")

    @field_validator("committed_amount")
    @classmethod
    def valid_committed(cls, value: str) -> str:
        return _money(value, "committed_amount", allow_negative=False)

    @field_validator("visit_id", "event_id", "booking_id", "location_id")
    @classmethod
    def valid_optional_ids(cls, value: str, info: Any) -> str:
        return value if value == "" else _identifier(value, info.field_name)

    @field_validator("start_date", "end_date")
    @classmethod
    def valid_optional_dates(cls, value: str, info: Any) -> str:
        return _date_string(value, info.field_name, allow_blank=True)


class Budget(SchemaModel):
    base_currency: str
    total_budget: str = "0"
    categories: list[FinancialCategory]
    cost_items: list[CostItem] = Field(default_factory=list)

    @field_validator("base_currency")
    @classmethod
    def valid_base_currency(cls, value: str) -> str:
        return _currency_code(value, "budget.base_currency")

    @field_validator("total_budget")
    @classmethod
    def valid_total_budget(cls, value: str) -> str:
        return _money(value, "budget.total_budget", allow_negative=False)


class ItineraryV5(SchemaModel):
    schema_version: Literal[5]
    metadata: Metadata
    locations: dict[str, Location]
    visits: list[Visit]
    days: list[Day]
    events: list[Event]
    bookings: list[Booking]


class ItineraryV6(SchemaModel):
    schema_version: Literal[6]
    metadata: Metadata
    locations: dict[str, Location]
    visits: list[Visit]
    days: list[Day]
    events: list[Event]
    bookings: list[Booking]
    budget: Budget


class ItineraryV7(SchemaModel):
    schema_version: Literal[7]
    metadata: Metadata
    locations: dict[str, Location]
    visits: list[Visit]
    days: list[Day]
    events: list[Event]
    bookings: list[Booking]
    budget: Budget

class ItineraryV8(ItineraryV7):
    schema_version: Literal[8]


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


def _cost_quantity(item: CostItem, visit_by_id: dict[str, Visit]) -> Decimal:
    if item.expected.quantity_source == "manual":
        return Decimal(item.expected.quantity)
    visit = visit_by_id[item.visit_id]
    days = (date.fromisoformat(visit.end_date) - date.fromisoformat(visit.start_date)).days + 1
    return Decimal(days if item.expected.quantity_source == "visit_days" else max(0, days - 1))


def _cost_expected_amount(item: CostItem, visit_by_id: dict[str, Visit]) -> Decimal:
    return Decimal(item.expected.unit_amount) * _cost_quantity(item, visit_by_id)


def _cost_paid_amount(item: CostItem) -> Decimal:
    total = Decimal("0")
    for payment in item.payments:
        amount = Decimal(payment.amount)
        total += -amount if payment.kind == "refund" else amount
    return total


def _cross_record_errors(model: ItineraryV6 | ItineraryV7 | ItineraryV8) -> list[str]:
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
        if event.replaces_event_id:
            if event.replaces_event_id == event.id:
                errors.append(f"{path}.replaces_event_id must not reference itself.")
            elif event.replaces_event_id not in event_ids:
                errors.append(f"{path}.replaces_event_id references unknown event {event.replaces_event_id!r}.")

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

    budget = model.budget
    category_ids = [category.id for category in budget.categories]
    errors.extend(_duplicate_errors(category_ids, "financial category"))
    if not budget.categories:
        errors.append("budget.categories must contain at least one financial category.")
    cost_item_ids = [item.id for item in budget.cost_items]
    errors.extend(_duplicate_errors(cost_item_ids, "cost item"))
    booking_ids = {booking.id for booking in model.bookings}
    cost_item_id_set = set(cost_item_ids)
    for index, booking in enumerate(model.bookings):
        path = f"bookings[{index}]"
        if booking.cost_item_id and booking.cost_item_id not in cost_item_id_set:
            errors.append(f"{path}.cost_item_id references unknown cost item {booking.cost_item_id!r}.")
    category_id_set = set(category_ids)
    for index, item in enumerate(budget.cost_items):
        path = f"budget.cost_items[{index}]"
        if item.category_id not in category_id_set:
            errors.append(f"{path}.category_id references unknown financial category {item.category_id!r}.")
        if item.visit_id and item.visit_id not in visit_ids:
            errors.append(f"{path}.visit_id references unknown visit {item.visit_id!r}.")
        if item.event_id and item.event_id not in event_ids:
            errors.append(f"{path}.event_id references unknown event {item.event_id!r}.")
        if item.booking_id and item.booking_id not in booking_ids:
            errors.append(f"{path}.booking_id references unknown booking {item.booking_id!r}.")
        if item.location_id and item.location_id not in location_ids:
            errors.append(f"{path}.location_id references unknown location {item.location_id!r}.")
        if item.visit_id:
            visit = visit_by_id.get(item.visit_id)
            if visit and item.location_id and item.location_id != visit.location_id:
                errors.append(f"{path}.location_id must match its referenced visit location.")
        if item.event_id:
            event = next((event for event in model.events if event.id == item.event_id), None)
            if event and item.visit_id and item.visit_id != event.visit_id:
                errors.append(f"{path}.visit_id must match its referenced event visit.")
            if event and item.location_id and item.location_id != event.location_id:
                errors.append(f"{path}.location_id must match its referenced event location.")
        if item.booking_id:
            booking = next((booking for booking in model.bookings if booking.id == item.booking_id), None)
            if booking and item.visit_id and booking.visit_id and item.visit_id != booking.visit_id:
                errors.append(f"{path}.visit_id must match its referenced booking visit.")
            if booking and item.event_id and booking.event_id and item.event_id != booking.event_id:
                errors.append(f"{path}.event_id must match its referenced booking event.")
            if booking and booking.cost_item_id and booking.cost_item_id != item.id:
                errors.append(f"{path}.booking_id does not agree with booking.cost_item_id.")
        if item.expected.quantity_source != "manual" and not item.visit_id:
            errors.append(f"{path}.expected.quantity_source requires visit_id.")
        if item.start_date and not (metadata.start_date <= item.start_date <= metadata.end_date):
            errors.append(f"{path}.start_date lies outside the itinerary date range.")
        if item.end_date and not (metadata.start_date <= item.end_date <= metadata.end_date):
            errors.append(f"{path}.end_date lies outside the itinerary date range.")
        if item.start_date and item.end_date and item.end_date < item.start_date:
            errors.append(f"{path}.end_date must not be earlier than start_date.")
        payment_ids = [payment.id for payment in item.payments]
        errors.extend(_duplicate_errors(payment_ids, f"payment in cost item {item.id}"))

    return list(dict.fromkeys(errors))


def _budget_warnings(model: ItineraryV6 | ItineraryV7) -> list[str]:
    warnings: list[str] = []
    visit_by_id = {visit.id: visit for visit in model.visits}
    expected_total = Decimal("0")
    all_expected_have_fx = True
    for item in model.budget.cost_items:
        expected = _cost_expected_amount(item, visit_by_id)
        committed = Decimal(item.committed_amount)
        paid = _cost_paid_amount(item)
        if committed > expected:
            warnings.append(f"Cost item {item.id!r} has committed amount greater than its expected cost.")
        if paid > expected:
            warnings.append(f"Cost item {item.id!r} has paid amount greater than its expected cost.")
        if item.currency == model.budget.base_currency:
            expected_total += expected
        elif item.fx.rate_to_base:
            expected_total += expected * Decimal(item.fx.rate_to_base)
        else:
            all_expected_have_fx = False
            warnings.append(f"Cost item {item.id!r} is in {item.currency} and has no FX rate to {model.budget.base_currency}.")
        if item.booking_id:
            booking = next((booking for booking in model.bookings if booking.id == item.booking_id), None)
            if booking and booking.lifecycle == "booked" and committed == 0:
                warnings.append(f"Booked booking {item.booking_id!r} has a linked cost item with no committed amount.")
    cost_by_id = {item.id: item for item in model.budget.cost_items}
    for booking in model.bookings:
        if booking.lifecycle == "booked" and booking.cost_item_id:
            linked_cost = cost_by_id.get(booking.cost_item_id)
            if linked_cost and Decimal(linked_cost.committed_amount) == 0:
                warnings.append(f"Booked booking {booking.id!r} has a linked cost item with no committed amount.")
    if all_expected_have_fx and expected_total > Decimal(model.budget.total_budget):
        warnings.append("Expected trip cost exceeds the total trip budget.")
    return list(dict.fromkeys(warnings))


def validate_current_itinerary(data: Any) -> dict[str, list[str]]:
    """Validate canonical schema v7 without mutating or normalising the supplied document."""

    if not isinstance(data, dict):
        return {"errors": ["The itinerary must be a JSON object."], "warnings": []}
    try:
        json.dumps(data, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        return {"errors": [f"The itinerary must contain only standard JSON values: {exc}"], "warnings": []}
    try:
        model = ItineraryV8.model_validate(data)
    except ValidationError as exc:
        return {"errors": _format_pydantic_errors(exc), "warnings": []}
    errors = _cross_record_errors(model)
    return {"errors": errors, "warnings": [] if errors else _budget_warnings(model)}


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


def default_budget(base_currency: str) -> dict[str, Any]:
    """The deterministic, intentionally empty starting point for schema v6 finance."""

    return {
        "base_currency": base_currency,
        "total_budget": "0",
        "categories": [
            {"id": category_id, "name": name, "colour": colour}
            for category_id, name, colour in DEFAULT_FINANCIAL_CATEGORIES
        ],
        "cost_items": [],
    }


def migrate_v5_to_v6(data: dict[str, Any]) -> dict[str, Any]:
    """Add the explicit financial foundation without inferring prices from bookings."""

    migrated = copy.deepcopy(data)
    metadata = migrated.get("metadata")
    if not isinstance(metadata, dict):
        raise MigrationError("metadata must be an object in schema version 5")
    default_currency = metadata.get("default_currency", "")
    base_currency = default_currency if isinstance(default_currency, str) and re.fullmatch(r"[A-Z]{3}", default_currency) else "USD"
    migrated["budget"] = default_budget(base_currency)
    migrated["schema_version"] = 6
    return migrated


def migrate_v6_to_v7(data: dict[str, Any]) -> dict[str, Any]:
    """Add neutral booking lifecycle/timing fields without inventing travel advice."""

    migrated = copy.deepcopy(data)
    bookings = migrated.get("bookings")
    if not isinstance(bookings, list):
        raise MigrationError("bookings must be an array in schema version 6")
    lifecycle_by_status = {"planned": "ready_to_book", "booked": "booked", "cancelled": "cancelled"}
    cost_items = migrated.get("budget", {}).get("cost_items", []) if isinstance(migrated.get("budget"), dict) else []
    cost_by_booking = {
        item.get("booking_id"): item.get("id")
        for item in cost_items
        if isinstance(item, dict) and isinstance(item.get("booking_id"), str) and isinstance(item.get("id"), str)
    }
    for index, booking in enumerate(bookings):
        if not isinstance(booking, dict):
            raise MigrationError(f"bookings[{index}] must be an object in schema version 6")
        old_status = booking.get("status", "planned")
        booking["lifecycle"] = lifecycle_by_status.get(old_status, "not_researched")
        booking["timing"] = {
            "strategy": "unknown",
            "recommended_date": "",
            "lead_days": 0,
            "anchor": "event_start",
            "hard_deadline": booking.get("booking_deadline", "") if isinstance(booking.get("booking_deadline", ""), str) else "",
            "sell_out_risk": "unknown",
            "price_rise_risk": "unknown",
            "flexibility_value": "unknown",
            "rationale": "",
            "confidence": "unknown",
            "last_researched_date": "",
            "source_urls": [],
        }
        booking["cost_item_id"] = cost_by_booking.get(booking.get("id"), "")
    migrated["schema_version"] = 7
    return migrated


def migrate_v7_to_v8(data: dict[str, Any]) -> dict[str, Any]:
    """Add neutral real-world event fields; never infer what actually happened."""
    migrated = copy.deepcopy(data)
    if not isinstance(migrated.get("events"), list):
        raise MigrationError("events must be an array in schema version 7")
    for event in migrated["events"]:
        if not isinstance(event, dict):
            raise MigrationError("events must contain objects in schema version 7")
        event.update({"outcome": "planned", "actual_start": "", "actual_end": "", "outcome_note": "", "replaces_event_id": ""})
    migrated["schema_version"] = 8
    return migrated

MIGRATIONS = {4: migrate_v4_to_v5, 5: migrate_v5_to_v6, 6: migrate_v6_to_v7, 7: migrate_v7_to_v8}


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
