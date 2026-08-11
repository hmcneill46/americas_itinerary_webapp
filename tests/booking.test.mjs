import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deriveBookingAction, groupBookings } from '../static/booking.js';
import { calculateBudget } from '../static/budget.js';

const example = JSON.parse(await readFile(new URL('../data/itinerary.example.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const booking = id => clone(example.bookings.find(item => item.id === id));

test('lead-time action date follows a moved associated event', () => {
  const itinerary = clone(example); const item = booking('booking_canal_activity');
  let action = deriveBookingAction(item, itinerary, '2027-04-01');
  assert.equal(action.recommendedDate, '2027-04-11');
  assert.equal(action.bucket, 'later');
  itinerary.events.find(event => event.id === item.event_id).start = '2027-04-16T10:30';
  action = deriveBookingAction(item, itinerary, '2027-04-01');
  assert.equal(action.recommendedDate, '2027-04-15');
});

test('deterministic today distinguishes soft overdue and missed hard deadlines', () => {
  const item = booking('booking_paris_museum');
  item.timing.strategy = 'lead_time'; item.timing.recommended_date = '2027-04-01'; item.timing.hard_deadline = '2027-04-03';
  let action = deriveBookingAction(item, example, '2027-04-02');
  assert.equal(action.overdue, true); assert.equal(action.deadlineMissed, false); assert.equal(action.bucket, 'urgent');
  action = deriveBookingAction(item, example, '2027-04-04');
  assert.equal(action.deadlineMissed, true); assert.ok(action.reasons.includes('Hard deadline has passed'));
});

test('before-departure, on-arrival, flexible and completed lifecycle groups remain distinct', () => {
  const items = [booking('booking_airport_transfer'), booking('booking_local_walking_tour'), booking('booking_cancelled_ferry'), booking('booking_train_london_paris')];
  const grouped = groupBookings(items, example, '2027-01-01');
  assert.deepEqual(Object.fromEntries(grouped.map(entry => [entry.booking.id, entry.action.bucket])), {
    booking_airport_transfer: 'before_departure', booking_local_walking_tour: 'on_arrival', booking_cancelled_ferry: 'secondary', booking_train_london_paris: 'booked',
  });
  assert.equal(deriveBookingAction(items[3], example, '2027-04-10').actionable, false);
});

test('budget links retain deposits and allow committed or paid amounts above earlier estimates', () => {
  const itinerary = clone(example); const cost = itinerary.budget.cost_items.find(item => item.id === 'cost_paris_museum');
  cost.committed_amount = '30'; cost.payments.push({ id: 'payment_more_than_estimate', kind: 'payment', amount: '35', date: '2027-02-01', note: 'Actual price changed' });
  const summary = calculateBudget(itinerary);
  const row = summary.items.find(item => item.id === cost.id);
  assert.equal(row.committed_amount, '30'); assert.equal(row.paidAmount, '35');
  assert.equal(row.expectedAmount, '22');
  assert.ok(summary.warnings.some(warning => warning.item?.id === cost.id));
});
