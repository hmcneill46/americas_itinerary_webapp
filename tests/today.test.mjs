import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deriveToday } from '../static/today.js';
const data = JSON.parse(await readFile(new URL('../data/itinerary.example.json', import.meta.url), 'utf8'));
test('today derives active and next events from injected floating-local now', () => { const result = deriveToday(data, '2027-04-09T09:00'); assert.equal(result.today, '2027-04-09'); assert.ok(result.events.length); assert.ok(result.next || result.active); });
