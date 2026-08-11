/* Pure schema-v9 place and travel-logistics helpers. */

export function placeById(itinerary, placeId) {
  return placeId ? itinerary?.places?.[placeId] || null : null;
}

export function placeCoordinates(place) {
  const coordinates = place?.coordinates;
  if (!coordinates || !Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)) return null;
  return [Number(coordinates.longitude), Number(coordinates.latitude)];
}

export function placeSummary(place, itinerary) {
  if (!place) return null;
  const location = itinerary?.locations?.[place.location_id] || null;
  return {
    id: place.id,
    name: place.name,
    type: place.type,
    address: place.address || '',
    website: place.website || '',
    notes: place.notes || '',
    locationId: place.location_id,
    locationName: location?.name || place.location_id,
    country: location?.country || '',
    coordinates: placeCoordinates(place),
  };
}

export function eventExactPlaces(event, itinerary) {
  return {
    venue: placeSummary(placeById(itinerary, event?.place_id), itinerary),
    departure: placeSummary(placeById(itinerary, event?.from_place_id), itinerary),
    arrival: placeSummary(placeById(itinerary, event?.to_place_id), itinerary),
  };
}

export function travelLogisticsRows(event) {
  const logistics = event?.travel_logistics || {};
  const rows = [];
  const add = (label, value) => { if (value) rows.push({ label, value: String(value) }); };
  add('Operator', logistics.operator);
  add('Service', logistics.service_number);
  add('Seat / berth', logistics.seat);
  add('Departure terminal', logistics.departure_terminal);
  add('Departure platform', logistics.departure_platform);
  add('Departure gate', logistics.departure_gate);
  add('Arrival terminal', logistics.arrival_terminal);
  add('Arrival platform', logistics.arrival_platform);
  add('Arrival gate', logistics.arrival_gate);
  if (Number(logistics.recommended_arrival_lead_minutes) > 0) add('Arrive early', `${logistics.recommended_arrival_lead_minutes} minutes`);
  add('Baggage', logistics.baggage_note);
  add('Instructions', logistics.instructions);
  return rows;
}

export function bookingPlace(booking, itinerary) {
  return placeSummary(placeById(itinerary, booking?.place_id), itinerary);
}

export function placeReferences(itinerary, placeId) {
  const events = (itinerary?.events || []).filter(event => [event.place_id, event.from_place_id, event.to_place_id].includes(placeId));
  const bookings = (itinerary?.bookings || []).filter(booking => booking.place_id === placeId);
  return { events, bookings, count: events.length + bookings.length };
}
