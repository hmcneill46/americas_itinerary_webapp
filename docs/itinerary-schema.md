# Itinerary JSON schema (version 5)

Version 5 is the canonical portable format used by Trip Planner. A document is UTF-8 JSON with a single root object. It is intended to be readable and editable by people and generative AI tools.

Do not add comments to JSON. Do not use `null` for defined fields: omit an optional field or use its documented empty value. Unknown extension fields are retained, but consumers should prefer the documented fields.

## Root object

All root fields are required, even when an array is empty.

```json
{
  "schema_version": 5,
  "metadata": {},
  "locations": {},
  "visits": [],
  "days": [],
  "events": [],
  "bookings": []
}
```

- `schema_version` must be the integer `5`.
- `locations` is an object keyed by location ID. All other collections are arrays.
- `visits` and `days` must be non-empty. `events` and `bookings` may be empty.

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

Version 5 bookings are named objects, never positional arrays. This is a modest foundation rather than the future full booking or budget model.

Required: stable `id`, non-blank `title`, and non-blank free-text `type` (for example `Transport`, `Accommodation`, or `Activity`).

Optional fields and empty defaults:

- `status`: `planned` (default), `booked`, or `cancelled`.
- `urgency`: `""`, `Low`, `Medium`, or `High`.
- `date`, `booking_deadline`: blank or `YYYY-MM-DD`.
- `time`, `duration`, `details`, `provider`, `reference`, `notes`: strings.
- `url`: blank or an absolute `http`/`https` URL.
- `event_id`, `visit_id`, `location_id`: blank or valid references. A booking with both visit and location references must use the visit's location.
- `legacy`: object reserved for exact source values retained by migrations; normally `{}` in new data.

```json
{
  "id": "booking_paris_stay",
  "title": "Paris accommodation",
  "type": "Accommodation",
  "status": "booked",
  "urgency": "Medium",
  "date": "2027-04-09",
  "booking_deadline": "2027-02-15",
  "provider": "Example Hotel",
  "reference": "DEMO-STAY-001",
  "event_id": "evt_paris_checkin",
  "visit_id": "paris_01",
  "location_id": "paris",
  "legacy": {}
}
```

Do not invent monetary fields yet. A later schema version will introduce the comprehensive budget and booking model with its own migration.

## Versioning and migration

The application currently accepts versions 4 and 5. Validation and import first make a deep copy, apply every migration in sequence, then run normal v5 validation. Migration never mutates the supplied object.

For v4, each positional booking row becomes a v5 booking object with a deterministic ID. The old positions map to `date`, `type`, `title`, `time`, `duration`, `booking_deadline`, status input, `details`, `urgency`, `notes`, and `reference`. The complete original row is also retained under `legacy.positional_values`, so ambiguous or extra values are not lost.

`GET /api/itinerary` may return an old saved file as migrated v5 data plus a `migrations` list. The original file is not rewritten merely by loading. `POST /api/validate` returns the migrated canonical document in `itinerary`; browser upload places that document only in the draft. A revision-protected save persists v5.

Files newer than the supported version, older than v4, or unable to migrate safely are rejected. Applying migration to v5 again makes no changes.

See `data/itinerary.example.json` for a complete public-safe canonical document.
