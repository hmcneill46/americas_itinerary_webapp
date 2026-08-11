import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { bookingPlace, eventExactPlaces, placeCoordinates, placeReferences, travelLogisticsRows } from '../static/places.js';

const example = JSON.parse(await readFile(new URL('../data/itinerary.example.json', import.meta.url), 'utf8'));

test('place helpers resolve broad parents, exact endpoints, and safe missing coordinates', () => {
  const train = example.events.find(event => event.id === 'evt_train_london_paris');
  const places = eventExactPlaces(train, example);
  assert.equal(places.departure.name, 'London St Pancras International');
  assert.equal(places.departure.locationName, 'London');
  assert.deepEqual(places.departure.coordinates, [-0.1263, 51.5314]);
  assert.equal(places.arrival.id, 'paris_gare_du_nord');
  assert.equal(placeCoordinates(example.places.paris_demo_hotel), null);
  assert.equal(bookingPlace(example.bookings[1], example).id, 'paris_demo_hotel');
});

test('travel logistics and deletion references are deterministic', () => {
  const train = example.events.find(event => event.id === 'evt_train_london_paris');
  const rows = travelLogisticsRows(train);
  assert.ok(rows.some(row => row.label === 'Operator' && row.value === 'Example Rail'));
  assert.ok(rows.some(row => row.label === 'Arrive early' && row.value === '75 minutes'));
  const refs = placeReferences(example, 'paris_gare_du_nord');
  assert.equal(refs.events.length, 2);
  assert.equal(refs.bookings.length, 1);
  assert.equal(refs.count, 3);
});
