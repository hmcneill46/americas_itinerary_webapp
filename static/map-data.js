import { placeCoordinates } from './places.js?v=places-v1';

const DAY_MS = 86_400_000;
const ROUTE_CATEGORIES = new Set(['Travel', 'Hike']);

function dateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

function floatingValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
  return match
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0))
    : NaN;
}

export function validCoordinates(location) {
  return Boolean(location)
    && Number.isFinite(location.latitude)
    && Number.isFinite(location.longitude)
    && location.latitude >= -90
    && location.latitude <= 90
    && location.longitude >= -180
    && location.longitude <= 180;
}

export function coordinatesForBounds(coordinates) {
  const points = (Array.isArray(coordinates) ? coordinates : [])
    .filter(point => Array.isArray(point) && point.length >= 2
      && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map(point => [Number(point[0]), Number(point[1])]);
  if (points.length < 2) return points;

  const longitudes = points.map(([longitude]) => ((longitude % 360) + 360) % 360).sort((a, b) => a - b);
  let largestGap = -1;
  let cut = longitudes[0];
  for (let index = 0; index < longitudes.length; index += 1) {
    const next = index === longitudes.length - 1 ? longitudes[0] + 360 : longitudes[index + 1];
    const gap = next - longitudes[index];
    if (gap > largestGap) {
      largestGap = gap;
      cut = next % 360;
    }
  }

  const unwrapped = points.map(([longitude, latitude]) => {
    let value = ((longitude % 360) + 360) % 360;
    if (value < cut) value += 360;
    return [value, latitude];
  });
  const minLongitude = Math.min(...unwrapped.map(point => point[0]));
  const maxLongitude = Math.max(...unwrapped.map(point => point[0]));
  const shift = Math.floor(((minLongitude + maxLongitude) / 2 + 180) / 360) * 360;
  return unwrapped.map(([longitude, latitude]) => [longitude - shift, latitude]);
}

function locationPoint(location) {
  return [Number(location.longitude), Number(location.latitude)];
}

function durationMinutes(event) {
  const start = floatingValue(event?.start);
  const end = floatingValue(event?.end);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 60_000) : null;
}

function nightCount(visit) {
  const start = dateValue(visit.stay_start_date || visit.start_date);
  const end = dateValue(visit.stay_end_date || visit.end_date);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / DAY_MS)) : null;
}

export function buildVisitPlanSummary(itinerary, visitId, limit = 6) {
  const events = (itinerary?.events || []).filter(event => event.visit_id === visitId).sort((a, b) => {
    const left = floatingValue(a.actual_start || a.start);
    const right = floatingValue(b.actual_start || b.start);
    return left - right || String(a.title).localeCompare(String(b.title));
  });
  const filler = /^(sleep|meal|admin)$/i;
  const notable = events.filter(event => event.transport_mode || !filler.test(event.category));
  const selected = (notable.length ? notable : events).slice(0, Math.max(0, limit));
  return {
    events: selected.map(event => ({
      id: event.id, title: event.title, category: event.category, transportMode: event.transport_mode || '',
      start: event.start, actualStart: event.actual_start || '', outcome: event.outcome || 'planned',
    })),
    totalCount: events.length,
    notableCount: notable.length,
    hiddenCount: Math.max(0, (notable.length ? notable.length : events.length) - selected.length),
  };
}

function schematicLine(from, to) {
  const origin = locationPoint(from);
  const destination = locationPoint(to);
  let destinationLongitude = destination[0];
  if (destinationLongitude - origin[0] > 180) destinationLongitude -= 360;
  if (destinationLongitude - origin[0] < -180) destinationLongitude += 360;
  return [origin, [destinationLongitude, destination[1]]];
}

function eventForLeg(events, fromId, toId, visitId) {
  return events
    .filter(event => ROUTE_CATEGORIES.has(event.category)
      && event.from_location_id === fromId
      && event.to_location_id === toId)
    .sort((a, b) => {
      const visitMatch = Number(b.visit_id === visitId) - Number(a.visit_id === visitId);
      return visitMatch || floatingValue(a.start) - floatingValue(b.start);
    })[0] || null;
}

function routeRecord({ id, order, from, to, event, visit, inferred }) {
  const mode = event?.transport_mode || visit?.arrival_mode || 'Unspecified';
  return {
    id,
    order,
    eventId: event?.id || null,
    visitId: visit?.id || event?.visit_id || null,
    fromLocationId: from.id,
    toLocationId: to.id,
    fromPlaceId: event?.from_place_id || '',
    toPlaceId: event?.to_place_id || '',
    fromName: from.name,
    toName: to.name,
    mode,
    title: event?.title || visit?.arrival_summary || `${from.name} to ${to.name}`,
    start: event?.start || null,
    end: event?.end || null,
    durationMinutes: event ? durationMinutes(event) : Number.isFinite(visit?.arrival_hours_estimate) ? Math.round(visit.arrival_hours_estimate * 60) : null,
    notes: event?.notes || visit?.arrival_summary || '',
    geometryKind: 'schematic',
    inferred,
    geometry: { type: 'LineString', coordinates: schematicLine(from, to) },
  };
}

export function buildTripMapModel(itinerary) {
  const locations = itinerary?.locations && typeof itinerary.locations === 'object' ? itinerary.locations : {};
  const visits = Array.isArray(itinerary?.visits) ? [...itinerary.visits].sort((a, b) => Number(a.order) - Number(b.order)) : [];
  const events = Array.isArray(itinerary?.events) ? itinerary.events : [];
  const bookings = Array.isArray(itinerary?.bookings) ? itinerary.bookings : [];
  const places = itinerary?.places && typeof itinerary.places === 'object' ? itinerary.places : {};
  const mappedVisits = [];
  const visitLocationCounts = new Map();

  for (const visit of visits) {
    const location = locations[visit.location_id];
    if (!validCoordinates(location)) continue;
    visitLocationCounts.set(visit.location_id, (visitLocationCounts.get(visit.location_id) || 0) + 1);
  }
  const seenLocations = new Map();
  for (const visit of visits) {
    const location = locations[visit.location_id];
    if (!validCoordinates(location)) continue;
    const duplicateIndex = seenLocations.get(visit.location_id) || 0;
    seenLocations.set(visit.location_id, duplicateIndex + 1);
    const visitEvents = events.filter(event => event.visit_id === visit.id);
    const visitBookings = bookings.filter(booking => booking.visit_id === visit.id || (booking.location_id === visit.location_id && booking.date >= visit.start_date && booking.date <= visit.end_date));
    const accommodation = visitBookings.filter(booking => booking.type === 'Accommodation').map(booking => booking.title);
    mappedVisits.push({
      id: visit.id,
      order: Number(visit.order),
      locationId: location.id,
      name: location.name,
      country: location.country,
      coordinates: locationPoint(location),
      startDate: visit.start_date,
      endDate: visit.end_date,
      nights: nightCount(visit),
      notes: visit.notes || '',
      eventCount: visitEvents.length,
      bookingCount: visitBookings.length,
      accommodation,
      duplicateIndex,
      duplicateTotal: visitLocationCounts.get(visit.location_id) || 1,
    });
  }

  const routes = [];
  const representedEventIds = new Set();
  const home = locations[itinerary?.metadata?.home_location_id];
  for (let index = 0; index < mappedVisits.length; index += 1) {
    const previousVisit = index > 0 ? mappedVisits[index - 1] : null;
    const visit = visits.find(item => item.id === mappedVisits[index].id);
    const from = previousVisit ? locations[previousVisit.locationId] : home;
    const to = locations[mappedVisits[index].locationId];
    if (!validCoordinates(from) || !validCoordinates(to) || from.id === to.id) continue;
    const event = eventForLeg(events, from.id, to.id, visit.id);
    if (event) representedEventIds.add(event.id);
    routes.push(routeRecord({
      id: event ? `event:${event.id}` : `visit:${visit.id}`,
      order: routes.length + 1,
      from,
      to,
      event,
      visit,
      inferred: !event,
    }));
  }

  for (const event of events) {
    if (!ROUTE_CATEGORIES.has(event.category) || representedEventIds.has(event.id)) continue;
    const from = locations[event.from_location_id];
    const to = locations[event.to_location_id];
    if (!validCoordinates(from) || !validCoordinates(to) || from.id === to.id) continue;
    routes.push(routeRecord({
      id: `event:${event.id}`,
      order: routes.length + 1,
      from,
      to,
      event,
      visit: visits.find(item => item.id === event.visit_id) || null,
      inferred: false,
    }));
  }

  const visitedLocationIds = new Set(mappedVisits.map(visit => visit.locationId));
  const referencedLocationIds = new Set();
  for (const event of events) {
    for (const id of [event.location_id, event.from_location_id, event.to_location_id]) {
      if (id && !visitedLocationIds.has(id)) referencedLocationIds.add(id);
    }
  }
  if (validCoordinates(home) && !visitedLocationIds.has(home.id) && routes.some(route => route.fromLocationId === home.id || route.toLocationId === home.id)) {
    referencedLocationIds.add(home.id);
  }
  const secondaryLocations = [...referencedLocationIds]
    .map(id => locations[id])
    .filter(validCoordinates)
    .map(location => ({
      id: location.id,
      name: location.name,
      country: location.country,
      coordinates: locationPoint(location),
    }));

  const exactPlaces = Object.values(places).map(place => {
    const coordinates = placeCoordinates(place);
    if (!coordinates) return null;
    const placeEvents = events.filter(event => [event.place_id, event.from_place_id, event.to_place_id].includes(place.id));
    const placeBookings = bookings.filter(booking => booking.place_id === place.id);
    const visitIds = new Set([
      ...placeEvents.map(event => event.visit_id),
      ...placeBookings.map(booking => booking.visit_id),
      ...visits.filter(visit => visit.location_id === place.location_id
        && (placeEvents.some(event => event.start.slice(0, 10) >= visit.start_date && event.start.slice(0, 10) <= visit.end_date)
          || placeBookings.some(booking => booking.date && booking.date >= visit.start_date && booking.date <= visit.end_date))).map(visit => visit.id),
    ].filter(Boolean));
    const location = locations[place.location_id];
    return {
      id: place.id, name: place.name, type: place.type, address: place.address || '', website: place.website || '', notes: place.notes || '',
      locationId: place.location_id, locationName: location?.name || place.location_id, country: location?.country || '', coordinates,
      visitIds: [...visitIds], eventIds: placeEvents.map(event => event.id), bookingIds: placeBookings.map(booking => booking.id),
    };
  }).filter(Boolean);

  return {
    visits: mappedVisits,
    routes,
    secondaryLocations,
    exactPlaces,
    coordinates: [
      ...mappedVisits.map(visit => visit.coordinates),
      ...secondaryLocations.map(location => location.coordinates),
    ],
  };
}

export function contextualExactPlaces(model, { visitId = '', routeId = '', placeId = '' } = {}) {
  const route = (model?.routes || []).find(item => item.id === routeId || item.eventId === routeId);
  const endpointIds = new Set([route?.fromPlaceId, route?.toPlaceId, placeId].filter(Boolean));
  return (model?.exactPlaces || []).filter(place => endpointIds.has(place.id) || (visitId && place.visitIds.includes(visitId)));
}

export function buildLocationMarkerGroups(model) {
  const groups = new Map();
  for (const visit of model?.visits || []) {
    if (!Array.isArray(visit.coordinates) || visit.coordinates.length < 2) continue;
    const group = groups.get(visit.locationId) || {
      locationId: visit.locationId,
      coordinates: [Number(visit.coordinates[0]), Number(visit.coordinates[1])],
      name: visit.name,
      country: visit.country,
      visits: [],
    };
    group.visits.push(visit);
    groups.set(visit.locationId, group);
  }
  return [...groups.values()]
    .map(group => ({ ...group, visits: [...group.visits].sort((a, b) => a.order - b.order) }))
    .sort((a, b) => a.visits[0].order - b.visits[0].order);
}

export function routeForDay(model, itinerary, day) {
  if (!day) return null;
  const travel = (itinerary.events || [])
    .filter(event => ROUTE_CATEGORIES.has(event.category)
      && event.start.slice(0, 10) <= day.date
      && event.end.slice(0, 10) >= day.date)
    .sort((a, b) => (durationMinutes(b) || 0) - (durationMinutes(a) || 0))[0];
  if (travel) return model.routes.find(route => route.eventId === travel.id) || null;
  return null;
}
