# AI itinerary handoff

Trip Planner JSON is the AI interchange format. Export the saved trip or clearly-labelled current draft, attach it to an AI conversation, and ask for one complete JSON itinerary in return.

Import is deliberately safe: the server migrates and validates the selected JSON in memory, the app presents a semantic preview, **Apply changes to draft** replaces only the editable draft, and the normal revision-protected **Save** remains a separate action. Imported JSON never supplies a server revision.

Tell an AI to preserve `schema_version` and stable IDs when it changes existing entities; return JSON only, not a patch; retain floating-local event timestamps (`YYYY-MM-DDTHH:MM`, no `Z`/offset); and keep money/rates as exact decimal strings. Budget expected, committed, and paid are distinct. Booking lifecycle and booking timing are distinct.

`docs/itinerary-schema.md` is the detailed authoritative contract. Do not ask an AI to include payment-card data, passwords, or secrets in an itinerary.
