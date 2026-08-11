import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deriveToday } from '../static/today.js';
const data = JSON.parse(await readFile(new URL('../data/itinerary.example.json', import.meta.url), 'utf8'));
test('today derives active and next events from injected floating-local now', () => { const result = deriveToday(data, '2027-04-09T09:00'); assert.equal(result.today, '2027-04-09'); assert.ok(result.events.length); assert.ok(result.next || result.active); });

test('Today retains exact budget strings and flags applicable missing FX', () => {
  const itinerary = structuredClone(data);
  const item = itinerary.budget.cost_items.find(candidate => candidate.expected.basis === 'per_day');
  item.currency = 'ARS'; item.fx.rate_to_base = '';
  const result = deriveToday(itinerary, `${itinerary.visits.find(visit => visit.id === item.visit_id).start_date}T12:00`);
  assert.equal(typeof result.money.expected, 'string');
  assert.equal(result.money.expectedComplete, false);
  assert.equal(result.money.missingFx.some(entry => entry.item.id === item.id && entry.expected), true);
});

test('Today derives practical next-transport and tonight exact-place context', () => {
  const result = deriveToday(data, '2027-04-09T07:30');
  assert.equal(result.nextTransport.event.id, 'evt_train_london_paris');
  assert.equal(result.nextTransport.places.departure.id, 'london_st_pancras');
  assert.equal(result.nextTransport.places.arrival.id, 'paris_gare_du_nord');
  assert.equal(result.nextTransport.logistics.operator, 'Example Rail');
  assert.equal(result.tonight.place.id, 'paris_demo_hotel');
  assert.equal(result.tonight.booking.id, 'booking_paris_stay');
});
