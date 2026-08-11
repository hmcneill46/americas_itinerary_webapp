# Itinerary JSON schema (version 7)

Version 7 is the canonical portable format used by Trip Planner. A document is UTF-8 JSON with a single root object. It is intended to be readable and editable by people and generative AI tools.

Do not add comments to JSON. Do not use `null` for defined fields: omit an optional field or use its documented empty value. Unknown extension fields are retained, but consumers should prefer the documented fields.

## Root object

All root fields are required, even when an array is empty.

```json
{
  "schema_version": 7,
  "metadata": {},
  "locations": {},
  "visits": [],
  "days": [],
  "events": [],
  "bookings": [],
  "budget": {}
}
```

- `schema_version` must be the integer `7`.
- `locations` is an object keyed by location ID. All other collections are arrays.
- `visits` and `days` must be non-empty. `events`, `bookings`, and `budget.cost_items` may be empty.

## IDs and references

IDs are case-sensitive strings of 1–128 characters. They must begin with a letter or number and may then contain letters, numbers, `.`, `_`, `:`, or `-`. Examples: `paris`, `paris_01`, `evt-train-001`.

Location object keys must exactly equal their inner `id`. Visit, event and booking IDs must be unique within their own collection. Reference fields must be either a valid existing ID or, where documented, the empty string.

## Metadata

Required fields:

- `title`: non-blank trip name.
- `start_date`, `end_date`: inclusive `YYYY-MM-DD` range.
- `home_location_id`: ID in `locations`; used as the route origin.
- `time_model`: exactly `"floating_local"`.
- `category_colours`: object mapping category names to strict six-digit hex colours such as `"#E58C47"`.
- `map_bounds`: numeric `min_lon`, `max_lon`, `min_lat`, `max_lat`. Longitude is in `[-180, 180]`, latitude in `[-90, 90]`, minima must be less than maxima, and every location must be inside the bounds.

The interactive map currently fits its camera from visit coordinates rather than using `map_bounds`. The validated bounds remain part of schema v7 for portability, compatibility and other consumers; keep them large enough to contain every location.

Optional string fields default to `""`: `description`, `time_model_note`, `created_from`, and `default_currency`. A non-empty `default_currency` is a three-letter uppercase code such as `EUR`; it is only a trip-level hint, not a budgeting model.

```json
"metadata": {
  "title": "European Rail Weekend",
  "description": "A short multi-country trip.",
  "start_date": "2027-04-08",
  "end_date": "2027-04-12",
  "home_location_id": "london",
  "time_model": "floating_local",
  "time_model_note": "Times are local wall-clock values.",
  "default_currency": "EUR",
  "category_colours": {
    "Travel": "#E58C47",
    "Accommodation": "#6C63A8",
    "Activity": "#7FB77E"
  },
  "map_bounds": {
    "min_lon": -1.5,
    "max_lon": 6.0,
    "min_lat": 48.0,
    "max_lat": 53.0
  }
}
```

Every event `category` must be a key in `category_colours`. Colour names, CSS expressions, alpha colours and shorthand hex values are rejected.

## Locations

Each location requires `id`, non-blank `name`, non-blank `country`, numeric finite `latitude`, and numeric finite `longitude`. Optional `timezone` and `notes` strings default to `""`. `timezone` is informational; timestamps are never converted through it.

```json
"paris": {
  "id": "paris",
  "name": "Paris",
  "country": "France",
  "latitude": 48.8566,
  "longitude": 2.3522,
  "timezone": "Europe/Paris",
  "notes": "First overnight stop."
}
```

Countries and location IDs are free text/IDs rather than a continent-specific list.

## Visits

A visit is one contiguous route block at one location.

Required fields are `id`, positive integer `order`, `location_id`, `start_date`, and `end_date`. Orders must be unique and contiguous from 1. Dates use `YYYY-MM-DD`, fall within the trip, and `end_date` cannot precede `start_date`.

Optional fields:

- `stay_start_date`, `stay_end_date`: either both blank/omitted or both set within the visit range.
- `arrival_mode`: `""`, `Flight`, `Road / bus`, `Ferry / boat`, `Train`, `Trek / walk`, `Mixed`, or `Local transfer`.
- `arrival_hours_estimate`: finite number at least zero; default `0`.
- `arrival_summary`, `notes`: strings; default `""`.

Each visit must own exactly one day record for every date from its start through end. This invariant is required by route reflow.

## Days

There must be exactly one day per calendar date in the inclusive metadata range, stored in date order. `day_number` is 1-based and must match its array position.

Required: `date`, `day_number`, `visit_id`, `location_id`, non-blank `country`, non-blank `base`, non-blank `summary`, and `confidence` (`Low`, `Medium`, or `High`). The day location must equal its visit location.

Optional: `notes` defaults to `""`; `is_physical_location_day` is a real JSON boolean and defaults to `false`.

## Events and floating local time

An event requires:

- `id`, non-blank `title`, and a `category` configured in metadata;
- `start` and `end` floating-local timestamps;
- valid `visit_id` and `location_id`, with the location matching the visit;
- `confidence`: `Low`, `Medium`, or `High`.

Optional fields default as follows:

- `from_location_id`, `to_location_id`, `transport_mode`, `notes`: `""`;
- `day_summaries`, `source_dates`: `[]`;
- `locked`: `false` (a JSON boolean, not `"false"`).

`from_location_id` and `to_location_id` may be blank or reference locations. `transport_mode` uses the same values as visit `arrival_mode`.

Timestamps use `YYYY-MM-DDTHH:MM` (optional seconds are accepted) with no `Z` and no offset:

```json
{
  "id": "evt_train_london_paris",
  "title": "Train to Paris",
  "category": "Travel",
  "start": "2027-04-09T08:30",
  "end": "2027-04-09T11:00",
  "visit_id": "paris_01",
  "location_id": "paris",
  "from_location_id": "london",
  "to_location_id": "paris",
  "transport_mode": "Train",
  "confidence": "High",
  "notes": "Times are illustrative.",
  "day_summaries": ["Travel to Paris."],
  "source_dates": ["2027-04-09"],
  "locked": true
}
```

`08:30` means 08:30 at the itinerary location. It must not be converted to the browser timezone. `end` must be later than `start`. Events may span midnight or multiple days but must stay within their visit and the overall trip. Each `source_dates` value must refer to a day in the document.

## Bookings

Bookings are first-class action planning records. Lifecycle says what has happened; `timing` says when to act and why. Do not use a manual numeric urgency score.

Required: stable `id`, non-blank `title`, non-blank free-text `type` (such as `Accommodation`, `Flight`, `Tour`, or a custom type), `lifecycle`, and `timing`.

- `lifecycle` is one of `not_researched`, `researching`, `ready_to_book`, `booked`, `cancelled`, or `not_required`.
- `event_id`, `visit_id`, `location_id`, and `cost_item_id` are blank or valid stable references. Visit/location references must agree. A cost link makes Budget the canonical source for expected, committed, and paid money.
- `date`, `booking_deadline`, `time`, `duration`, `details`, `provider`, `reference`, `notes` are optional retained practical fields. `url` is blank or an absolute `http`/`https` URL. Never store card details, passwords, or credentials.
- `timing.strategy` is `unknown`, `book_now`, `before_departure`, `lead_time`, `on_arrival`, or `flexible`. Use `recommended_date` for a fixed soft recommendation, or `lead_days` plus `anchor` (`event_start`, `visit_start`, or `trip_start`) for a date that moves with the itinerary. `hard_deadline` is a distinct provider deadline.
- Risk/value and advice fields use `unknown`, `low`, `medium`, or `high`: `sell_out_risk`, `price_rise_risk`, `flexibility_value`, and `confidence`. `rationale`, `last_researched_date`, and safe `source_urls` explain the advice.

```json
{
  "id": "booking_paris_stay",
  "title": "Paris accommodation",
  "type": "Accommodation",
  "lifecycle": "ready_to_book",
  "timing": {
    "strategy": "lead_time",
    "recommended_date": "",
    "lead_days": 30,
    "anchor": "event_start",
    "hard_deadline": "",
    "sell_out_risk": "high",
    "price_rise_risk": "low",
    "flexibility_value": "low",
    "rationale": "Limited capacity and fixed trek dates.",
    "confidence": "high",
    "last_researched_date": "2027-01-20",
    "source_urls": ["https://example.com/trek-advice"]
  },
  "date": "2027-04-09",
  "booking_deadline": "2027-02-15",
  "provider": "Example Hotel",
  "reference": "DEMO-STAY-001",
  "event_id": "evt_paris_checkin",
  "visit_id": "paris_01",
  "location_id": "paris",
  "cost_item_id": "cost_paris_accommodation",
  "legacy": {}
}
```

Booking lifecycle never invents money. `cost_item_id` and the reciprocal `budget.cost_items[].booking_id` may connect a reservation to money, but marking booked does not create a payment. A partial payment/deposit remains a Budget payment record; cancellation preserves it so refunds or lost money remain understandable.

## Budget and money

`budget` is required in schema v7. It is the only canonical place for trip financial data; do not add ad-hoc prices to events or bookings.

```json
"budget": {
  "base_currency": "GBP",
  "total_budget": "850.00",
  "categories": [
    {"id": "accommodation", "name": "Accommodation", "colour": "#6C63A8"}
  ],
  "cost_items": []
}
```

- `base_currency` is an ISO-style three-letter uppercase reporting currency. Dashboard totals are calculated in it.
- `total_budget` is an exact non-negative decimal string in `base_currency` (for example `"2500.00"`). Decimal strings, rather than JSON numbers, are authoritative for all money and rates. They avoid binary floating-point rounding and preserve the entered amount; do not use commas, currency symbols, exponent notation, or `null`.
- `categories` are independent from event categories. Each has a stable `id`, non-blank `name`, and safe six-digit hex `colour`. The migration supplies Accommodation, Long-distance Transport, Local Transport, Food & Drink, Activities & Tours, Treks / Expeditions, Visas & Admin, Insurance, Gear / Equipment, Communications, and Miscellaneous. Custom categories are allowed.

### Cost items

Each `cost_items` object has a stable `id`, non-blank `name`, `category_id`, native `currency`, one `expected` pricing basis, `committed_amount`, an FX snapshot, payment history, and optional references.

```json
{
  "id": "cost_paris_food",
  "name": "Paris food allowance",
  "category_id": "food_drink",
  "currency": "EUR",
  "expected": {
    "unit_amount": "25.00",
    "basis": "per_day",
    "quantity_source": "visit_days",
    "quantity": 0
  },
  "committed_amount": "0",
  "fx": {"rate_to_base": "0.86", "as_of_date": "2027-01-15", "source": "Manual planning rate", "note": ""},
  "payments": [],
  "visit_id": "paris_01",
  "event_id": "",
  "booking_id": "",
  "location_id": "paris",
  "start_date": "2027-04-09",
  "end_date": "2027-04-10",
  "notes": "Flexible estimate."
}
```

- `currency` is always the item's original/native currency; it is never replaced by its base equivalent.
- `expected.unit_amount` is a non-negative exact decimal string. `basis` is `fixed`, `per_day`, `per_night`, `per_person`, or `per_unit`. A fixed item always uses manual quantity `1`.
- `quantity_source` is `manual`, `visit_days`, or `visit_nights`. Derived sources require `visit_id` and use `quantity: 0`; the app derives inclusive visit days or inclusive days minus one nights. Manual quantities are positive integers for non-fixed bases.
- `committed_amount` is a non-negative native-currency decimal: the known obligation, not a second estimate. It may differ from expected when a price changes.
- `fx.rate_to_base` is the stored number of base-currency units per one native-currency unit. For a foreign currency it is required before that item can contribute to complete base totals. `as_of_date`, `source`, and `note` explain the snapshot. Base-currency items use rate `"1"` or a blank rate. No live FX lookup is performed.
- Optional `visit_id`, `event_id`, `booking_id`, and `location_id` must refer to existing objects and agree with each other when they overlap. `start_date` and `end_date` are optional in-trip dates. Use blank strings for absent optional references/dates, never `null`.

Expected, committed, and paid are calculated rather than independently stored totals:

- **Expected** = `unit_amount × derived/manual quantity`.
- **Committed** = `committed_amount`.
- **Paid** = payments plus signed adjustments minus refunds.

Thus a `"500"` unbooked trek has committed `"0"`; a `"460"` booked trek with a `"100"` deposit has committed `"460"` and paid `"100"`. Updating an expected price never erases payment history.

### Payments, deposits, refunds, and corrections

Payments belong inside their cost item and are all in that item's native currency:

```json
"payments": [
  {"id": "payment_trek_deposit", "kind": "payment", "amount": "100.00", "date": "2027-04-01", "note": "Deposit"},
  {"id": "refund_trek", "kind": "refund", "amount": "20.00", "date": "2027-04-04", "note": "Partial refund"}
]
```

`kind` is `payment`, `refund`, or `adjustment`. Payment/refund amounts are non-negative; an adjustment may be signed for a deliberate correction. IDs are unique within the item. This is a lightweight personal-trip history, not double-entry accounting.

## Versioning and migration

The application currently accepts versions 4, 5, 6, and 7. Validation and import first make a deep copy, apply every migration in sequence, then run normal v7 validation. Migration never mutates the supplied object.

For v4, each positional booking row becomes a v5 booking object with a deterministic ID. The old positions map to `date`, `type`, `title`, `time`, `duration`, `booking_deadline`, status input, `details`, `urgency`, `notes`, and `reference`. The complete original row is also retained under `legacy.positional_values`, so ambiguous or extra values are not lost. The subsequent v5→v6 migration adds a deterministic empty budget: default categories, base currency from `metadata.default_currency` (or `USD` when blank), and no inferred cost items. It never guesses prices from bookings.

The v6→v7 migration maps the former lifecycle (`planned`, `booked`, `cancelled`) to `ready_to_book`, `booked`, or `cancelled`, adds neutral unknown timing advice, carries forward the old booking deadline as a hard deadline, and fills the reciprocal cost link when it is already unambiguous. It does not claim research, risk, or timing advice that was not present.

`GET /api/itinerary` may return an old saved file as migrated v7 data plus a `migrations` list. The original file is not rewritten merely by loading. `POST /api/validate` returns the migrated canonical document in `itinerary`; browser upload places that document only in the draft. A revision-protected save persists v7.

Files newer than the supported version, older than v4, or unable to migrate safely are rejected. Applying migration to v5 again makes no changes.

See `data/itinerary.example.json` for a complete public-safe canonical document.
