import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveTripFlow, filteredEvents, normaliseCategorySelection, selectionAfterFilter,
  setCategoryVisibility, transportStyleKey,
} from '../static/timeline.js';

const itinerary = {
  metadata: { start_date: '2027-04-01', end_date: '2027-04-10' },
  locations: {
    a: { id: 'a', name: 'Alpha', country: 'One' },
    b: { id: 'b', name: 'Beta', country: 'Two' },
  },
  visits: [
    { id: 'visit_a_1', order: 1, location_id: 'a', start_date: '2027-04-01', end_date: '2027-04-05', arrival_mode: '', arrival_hours_estimate: 0 },
    { id: 'visit_b', order: 2, location_id: 'b', start_date: '2027-04-06', end_date: '2027-04-07', arrival_mode: 'Train', arrival_hours_estimate: 2 },
    { id: 'visit_a_2', order: 3, location_id: 'a', start_date: '2027-04-08', end_date: '2027-04-10', arrival_mode: 'Road / bus', arrival_hours_estimate: 8 },
  ],
  events: [{
    id: 'overnight', title: 'Overnight bus', category: 'Travel', transport_mode: 'Road / bus',
    from_location_id: 'b', to_location_id: 'a', start: '2027-04-07T22:00', end: '2027-04-08T06:00',
    actual_start: '', actual_end: '', outcome: 'planned',
  }],
};

test('multi-category filtering supports independent, all, none and reset selections', () => {
  const categories = ['Travel', 'Food', 'Activity'];
  const all = normaliseCategorySelection(categories, null);
  assert.deepEqual([...all], categories);
  const hiddenFood = setCategoryVisibility(all, 'Food', false);
  assert.deepEqual(filteredEvents([{ id: 't', category: 'Travel' }, { id: 'f', category: 'Food' }], hiddenFood).map(item => item.id), ['t']);
  assert.deepEqual([...normaliseCategorySelection(categories, new Set())], []);
  assert.deepEqual([...normaliseCategorySelection(categories, categories)], categories);
});

test('a selection is cleared only when its item becomes filtered out', () => {
  assert.equal(selectionAfterFilter('event-a', ['event-a', 'event-b']), 'event-a');
  assert.equal(selectionAfterFilter('event-a', ['event-b']), null);
  assert.equal(selectionAfterFilter(null, ['event-b']), null);
});

test('Trip Flow preserves long stays, repeated visits, countries and overnight travel', () => {
  const model = deriveTripFlow(itinerary);
  assert.equal(model.days, 10);
  assert.deepEqual(model.stays.map(item => item.visitId), ['visit_a_1', 'visit_b', 'visit_a_2']);
  assert.equal(model.stays[0].days, 5);
  assert.equal(model.stays[2].locationId, 'a');
  assert.deepEqual(model.countries.map(item => item.country), ['One', 'Two', 'One']);
  const overnight = model.travel.find(item => item.eventId === 'overnight');
  assert.equal(overnight.modeKey, 'bus');
  assert.ok(overnight.endMs > overnight.startMs);
  assert.equal(model.travel.some(item => item.id === 'arrival:visit_b' && item.estimated), true);
});

test('transport modes use a restrained stable style taxonomy', () => {
  assert.equal(transportStyleKey('Flight'), 'flight');
  assert.equal(transportStyleKey('Train'), 'train');
  assert.equal(transportStyleKey('Ferry / boat'), 'ferry');
  assert.equal(transportStyleKey('Trek / walk'), 'walk');
  assert.equal(transportStyleKey('Road / bus'), 'bus');
  assert.equal(transportStyleKey('Local transfer'), 'transfer');
});
