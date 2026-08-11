# AI itinerary handoff

Trip Planner JSON is the AI interchange format. Export the saved trip or clearly-labelled current draft, attach it to an AI conversation, and ask for one complete JSON itinerary in return.

Import is deliberately safe: the server migrates and validates the selected JSON in memory, the app presents a semantic preview, **Apply changes to draft** replaces only the editable draft, and the normal revision-protected **Save** remains a separate action. Imported JSON never supplies a server revision.

Tell an AI to preserve `schema_version` and stable IDs when it changes existing entities; return JSON only, not a patch; retain floating-local event timestamps (`YYYY-MM-DDTHH:MM`, no `Z`/offset); and keep money/rates as exact decimal strings. Budget expected, committed, and paid are distinct. Booking lifecycle and booking timing are distinct.

Schema v9 deliberately separates broad route `locations` (cities, islands, parks and route stops) from exact `places` (hotels, stations, terminals, attractions, trailheads, restaurants and meeting points). Do not create a route Location for every venue. An event may use `place_id`, travel may refine its broad endpoints with `from_place_id`/`to_place_id`, and a Booking may use `place_id`. `travel_logistics` holds operator/service, seat, terminal/platform/gate, arrival lead, baggage notes and instructions; Booking provider and confirmation remain Booking data because a seller is not necessarily the operator.

An AI should leave unknown place references, coordinates and logistics blank rather than inventing precision. Place coordinates are omitted entirely when unknown. A Budget item's exact `expected.unit_amount` remains the point estimate used by totals; optional `planning_range` is a native-currency low/high unit range with restrained confidence and rationale. Do not manufacture a range merely because the field exists. Stored FX is the only home-currency conversion source.

`docs/itinerary-schema.md` is the detailed authoritative contract. Do not ask an AI to include payment-card data, passwords, or secrets in an itinerary. Exact addresses and booking references are private travel data; share exports only with services and people you trust.
