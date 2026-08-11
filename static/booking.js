/* Pure booking timing derivation. Calendar dates deliberately use UTC helpers so
 * travel advice remains a floating calendar-date concept, not browser timezone time. */
const DAY_MS = 86_400_000;

function dateMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

export function addCalendarDays(date, amount) {
  const ms = dateMs(date);
  if (Number.isNaN(ms)) return '';
  const value = new Date(ms + amount * DAY_MS);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

export function calendarDaysBetween(from, to) {
  const a = dateMs(from); const b = dateMs(to);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / DAY_MS);
}

function anchorDate(booking, itinerary) {
  const timing = booking.timing || {};
  if (timing.anchor === 'trip_start') return itinerary.metadata?.start_date || '';
  if (timing.anchor === 'visit_start') return itinerary.visits?.find(visit => visit.id === booking.visit_id)?.start_date || '';
  const event = itinerary.events?.find(item => item.id === booking.event_id);
  if (event?.start) return event.start.slice(0, 10);
  return itinerary.visits?.find(visit => visit.id === booking.visit_id)?.start_date || itinerary.metadata?.start_date || '';
}

export function deriveBookingAction(booking, itinerary, today) {
  const timing = booking.timing || {};
  const lifecycle = booking.lifecycle || 'not_researched';
  const strategy = timing.strategy || 'unknown';
  const hardDeadline = timing.hard_deadline || '';
  const anchor = anchorDate(booking, itinerary);
  const recommendedDate = timing.recommended_date || (timing.lead_days > 0 && anchor ? addCalendarDays(anchor, -timing.lead_days) : '');
  const actionable = !['booked', 'cancelled', 'not_required'].includes(lifecycle);
  const deadlineDays = hardDeadline ? calendarDaysBetween(today, hardDeadline) : null;
  const recommendedDays = recommendedDate ? calendarDaysBetween(today, recommendedDate) : null;
  const deadlineMissed = deadlineDays !== null && deadlineDays < 0;
  const tripStarted = Boolean(itinerary.metadata?.start_date && today >= itinerary.metadata.start_date);
  const beforeDepartureOverdue = actionable && strategy === 'before_departure' && tripStarted;
  const overdue = (recommendedDays !== null && recommendedDays < 0) || beforeDepartureOverdue;

  let bucket = 'later';
  if (!actionable) bucket = lifecycle === 'booked' ? 'booked' : 'secondary';
  else if (strategy === 'book_now' || deadlineMissed || overdue) bucket = 'urgent';
  else if (strategy === 'before_departure') bucket = 'before_departure';
  else if (strategy === 'on_arrival') bucket = 'on_arrival';
  else if (strategy === 'flexible') bucket = 'later';
  else if (strategy === 'lead_time' && recommendedDays !== null && recommendedDays <= 7) bucket = 'shortly_before';
  else if (lifecycle === 'not_researched' || lifecycle === 'researching' || lifecycle === 'ready_to_book') bucket = 'later';

  let timingLabel = 'Timing not researched yet';
  if (strategy === 'book_now') timingLabel = 'Book now';
  else if (strategy === 'before_departure') timingLabel = beforeDepartureOverdue ? 'Overdue — trip has already started' : 'Book before departure';
  else if (strategy === 'on_arrival') timingLabel = 'Arrange on arrival';
  else if (strategy === 'flexible') timingLabel = 'Intentionally flexible';
  else if (recommendedDate) timingLabel = recommendedDays === 0 ? 'Recommended today' : recommendedDays !== null && recommendedDays > 0 ? `Recommended in ${recommendedDays} days` : `Recommended ${Math.abs(recommendedDays || 0)} days ago`;
  if (hardDeadline) timingLabel += ` · hard deadline ${hardDeadline}`;

  const reasons = [];
  if (deadlineMissed) reasons.push('Hard deadline has passed');
  if (beforeDepartureOverdue) reasons.push('Trip has already started; this was intended to be booked before departure.');
  else if (overdue) reasons.push('Recommended booking point has passed');
  if (timing.sell_out_risk === 'high') reasons.push('High sell-out risk');
  if (timing.price_rise_risk === 'high') reasons.push('High price-rise risk');
  if (strategy === 'flexible' || timing.flexibility_value === 'high') reasons.push('Flexibility is valuable');
  if (timing.rationale) reasons.push(timing.rationale);
  return { actionable, lifecycle, strategy, anchor, recommendedDate, hardDeadline, deadlineMissed, beforeDepartureOverdue, overdue, bucket, timingLabel, reasons, recommendedDays, deadlineDays };
}

export function groupBookings(bookings, itinerary, today) {
  return bookings.map(booking => ({ booking, action: deriveBookingAction(booking, itinerary, today) }))
    .sort((a, b) => {
      const order = { urgent: 0, before_departure: 1, shortly_before: 2, later: 3, on_arrival: 4, booked: 5, secondary: 6 };
      return order[a.action.bucket] - order[b.action.bucket]
        || (a.action.recommendedDate || '9999-12-31').localeCompare(b.action.recommendedDate || '9999-12-31')
        || a.booking.title.localeCompare(b.booking.title);
    });
}
