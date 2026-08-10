import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DEFAULT_CONFIG, loadMapConfig, normaliseMapConfig } from '../static/map-config.js';
import { buildTripMapModel, coordinatesForBounds, routeForDay, validCoordinates } from '../static/map-data.js';

const example = JSON.parse(await readFile(new URL('../data/itinerary.example.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);

test('canonical itinerary becomes ordered visits and schematic event routes', () => {
  const model = buildTripMapModel(example);
  assert.deepEqual(model.visits.map(visit => visit.name), ['London', 'Paris', 'Amsterdam']);
  assert.deepEqual(model.routes.map(route => route.eventId), ['evt_train_london_paris', 'evt_train_paris_amsterdam']);
  assert.ok(model.routes.every(route => route.geometryKind === 'schematic'));
  assert.ok(model.routes.every(route => route.geometry.type === 'LineString'));
  assert.equal(model.visits[1].bookingCount, 3);
  assert.deepEqual(model.visits[1].accommodation, ['Paris accommodation']);
  assert.equal(routeForDay(model, example, example.days[1]).eventId, 'evt_train_london_paris');
});

test('return visits remain distinct and receive deterministic marker offsets', () => {
  const itinerary = clone(example);
  itinerary.visits.push({
    ...clone(itinerary.visits[0]),
    id: 'london_02',
    order: 4,
    start_date: '2027-04-13',
    end_date: '2027-04-13',
    stay_start_date: '2027-04-13',
    stay_end_date: '2027-04-13',
    arrival_mode: 'Flight',
  });
  const model = buildTripMapModel(itinerary);
  const londonVisits = model.visits.filter(visit => visit.locationId === 'london');
  assert.deepEqual(londonVisits.map(visit => visit.id), ['london_01', 'london_02']);
  assert.deepEqual(londonVisits.map(visit => visit.duplicateIndex), [0, 1]);
  assert.ok(londonVisits.every(visit => visit.duplicateTotal === 2));
});

test('whole-trip bounds take the short way across the international date line', () => {
  const coordinates = coordinatesForBounds([[170, -17], [-170, -14], [175, -16]]);
  const longitudes = coordinates.map(point => point[0]);
  assert.ok(Math.max(...longitudes) - Math.min(...longitudes) <= 20);
  assert.deepEqual(coordinates.map(point => point[1]), [-17, -14, -16]);
});

test('home location supplies the first schematic leg when it is not a visit', () => {
  const itinerary = clone(example);
  itinerary.visits = itinerary.visits.slice(1).map((visit, index) => ({...visit, order:index + 1}));
  const model = buildTripMapModel(itinerary);
  assert.equal(model.routes[0].fromLocationId, 'london');
  assert.equal(model.routes[0].toLocationId, 'paris');
  assert.equal(model.routes[0].eventId, 'evt_train_london_paris');
  assert.ok(model.secondaryLocations.some(location => location.id === 'london'));
});

test('bad coordinates and incomplete travel data are skipped without throwing', () => {
  assert.equal(validCoordinates({ latitude: null, longitude: 4 }), false);
  assert.equal(validCoordinates({ latitude: 20, longitude: Number.NaN }), false);
  const itinerary = clone(example);
  itinerary.locations.amsterdam.latitude = null;
  itinerary.events[1].from_location_id = '';
  const model = buildTripMapModel(itinerary);
  assert.deepEqual(model.visits.map(visit => visit.id), ['london_01', 'paris_01']);
  assert.equal(model.routes.length, 1);
  assert.doesNotThrow(() => routeForDay(model, itinerary, itinerary.days[3]));
});

test('visit sequence supplies explicitly inferred schematic routes when travel events are incomplete', () => {
  const itinerary = clone(example);
  for (const event of itinerary.events) {
    if (event.category === 'Travel') {
      event.from_location_id = '';
      event.to_location_id = '';
    }
  }
  const model = buildTripMapModel(itinerary);
  assert.equal(model.routes.length, 2);
  assert.ok(model.routes.every(route => route.inferred && route.geometryKind === 'schematic'));
});

test('provider configuration falls back safely', async () => {
  assert.equal(normaliseMapConfig({ style_url: 'javascript:alert(1)' }).style_url, DEFAULT_CONFIG.style_url);
  const fallback = await loadMapConfig(async () => { throw new Error('offline'); });
  assert.deepEqual(fallback, DEFAULT_CONFIG);
  const configured = await loadMapConfig(async () => ({
    ok: true,
    json: async () => ({
      provider_name: 'Home tiles',
      style_url: '/static/maps/style.json',
      attribution: { text: 'Home data', url: 'https://example.test/licence' },
    }),
  }));
  assert.equal(configured.style_url, '/static/maps/style.json');
});

test('map popup rendering uses DOM text nodes, never raw itinerary HTML', async () => {
  const source = await readFile(new URL('../static/map-view.js', import.meta.url), 'utf8');
  assert.match(source, /\.setDOMContent\(/);
  assert.doesNotMatch(source, /\.setHTML\(|innerHTML\s*=/);
  const itinerary = clone(example);
  itinerary.locations.paris.name = '<img src=x onerror=alert(1)>';
  const model = buildTripMapModel(itinerary);
  assert.equal(model.visits[1].name, '<img src=x onerror=alert(1)>');
});
