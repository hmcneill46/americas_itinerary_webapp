import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, validItinerarySnapshot, validSnapshot } from '../static/offline-store.js';
import { readFile } from 'node:fs/promises';

const itinerary = { schema_version: 8, metadata: { title: 'Demo' }, locations: {}, visits: [], days: [], events: [], bookings: [], budget: {} };
test('only a complete canonical-shaped itinerary can become an offline snapshot', () => {
  assert.equal(validItinerarySnapshot(itinerary), true);
  assert.equal(validItinerarySnapshot({ ...itinerary, budget: null }), false);
  const snapshot = createSnapshot({ itinerary, revision: 'abc', cachedAt: '2026-08-11T09:00:00.000Z', source: 'https://trip.example' });
  assert.equal(validSnapshot(snapshot), true);
  assert.equal(createSnapshot({ itinerary, revision: '' }), null);
});

test('service worker has a versioned shell allowlist and never handles API writes', async () => {
  const worker = await readFile(new URL('../static/sw.js', import.meta.url), 'utf8');
  assert.match(worker, /trip-planner-shell-v\d+/);
  assert.match(worker, /request\.method !== 'GET'/);
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(worker, /cache\.put\(request/);
});
