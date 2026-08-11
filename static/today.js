import { calculateTodayMoney } from './budget.js?v=budget-v9';
import { deriveBookingAction } from './booking.js';
import { eventExactPlaces, placeSummary, placeById, travelLogisticsRows } from './places.js?v=places-v1';

const dateOf = value => String(value || '').slice(0, 10);
const minutes = value => {
  const match = String(value || '').match(/T(\d\d):(\d\d)/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
};

function bookingForEvent(event, itinerary, type = '') {
  return (itinerary.bookings || []).find(booking => booking.event_id === event?.id
    || (type && booking.type === type && booking.visit_id === event?.visit_id && booking.date === dateOf(event?.start))) || null;
}

export function deriveTonightContext(itinerary, today) {
  const event = (itinerary.events || []).find(candidate => candidate.category === 'Accommodation'
    && dateOf(candidate.start) <= today && dateOf(candidate.end) >= today) || null;
  const day = (itinerary.days || []).find(candidate => candidate.date === today);
  const booking = event ? bookingForEvent(event, itinerary, 'Accommodation') : (itinerary.bookings || []).find(candidate => candidate.type === 'Accommodation'
    && candidate.visit_id === day?.visit_id && (!candidate.date || candidate.date <= today)) || null;
  const place = placeSummary(placeById(itinerary, event?.place_id || booking?.place_id), itinerary);
  return { event, booking, place };
}

export function deriveNextTransportContext(itinerary, event) {
  if (!event || (!event.transport_mode && !['Travel', 'Hike'].includes(event.category))) return null;
  const booking = bookingForEvent(event, itinerary);
  return {
    event,
    booking,
    places: eventExactPlaces(event, itinerary),
    logistics: event.travel_logistics || {},
    logisticsRows: travelLogisticsRows(event),
  };
}

export function deriveToday(itinerary, now) {
  const today = dateOf(now);
  const nowMinutes = minutes(now);
  const day = itinerary.days.find(item => item.date === today);
  const events = itinerary.events.filter(event => dateOf(event.start) === today).sort((a, b) => minutes(a.start) - minutes(b.start));
  const active = events.find(event => !['missed', 'cancelled', 'skipped'].includes(event.outcome)
    && minutes(event.actual_start || event.start) <= nowMinutes && minutes(event.actual_end || event.end) >= nowMinutes);
  const next = events.find(event => !['completed', 'missed', 'cancelled', 'skipped'].includes(event.outcome)
    && minutes(event.actual_start || event.start) > nowMinutes);
  const visit = itinerary.visits.find(item => item.id === day?.visit_id);
  const tonight = deriveTonightContext(itinerary, today);
  const money = calculateTodayMoney(itinerary, today);
  const attention = itinerary.bookings.map(booking => ({ booking, action: deriveBookingAction(booking, itinerary, today) }))
    .filter(item => item.action.bucket === 'urgent').slice(0, 3);
  return {
    today, day, visit, events, active, next,
    accommodation: tonight.event,
    tonight,
    nextTransport: deriveNextTransportContext(itinerary, next),
    money,
    attention,
  };
}
