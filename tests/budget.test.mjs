import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { calculateBudget, decimalAdd, decimalMultiply, formatMoney, itemExpected, itemPaid } from '../static/budget.js';

const example = JSON.parse(await readFile(new URL('../data/itinerary.example.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);

test('exact decimal operations do not use binary floating point', () => {
  assert.equal(decimalAdd('0.1', '0.2'), '0.3');
  assert.equal(decimalMultiply('25.00', '5'), '125');
  assert.equal(formatMoney('1234.5', 'GBP'), 'GBP 1,234.50');
});

test('fixed, visit-day and visit-night expectations derive once', () => {
  const [rail, accommodation, food, , stay] = example.budget.cost_items;
  assert.equal(itemExpected(rail, example), '92');
  assert.equal(itemExpected(accommodation, example), '180');
  assert.equal(itemExpected(food, example), '50');
  assert.equal(itemExpected(stay, example), '150');
});

test('payments, partial payments and refunds produce coherent expected committed paid totals', () => {
  const itinerary = clone(example);
  const stay = itinerary.budget.cost_items.find(item => item.id === 'cost_paris_accommodation');
  assert.equal(itemPaid(stay), '60');
  stay.payments.push({ id: 'refund_test', kind: 'refund', amount: '10', date: '2027-01-20', note: 'Price adjustment' });
  const summary = calculateBudget(itinerary);
  assert.equal(itemPaid(summary.items.find(item => item.id === stay.id)), '50');
  assert.equal(summary.totals.expected, '437.72');
  assert.equal(summary.totals.committed, '375.8');
  assert.equal(summary.totals.paid, '264');
  assert.equal(summary.totals.expectedStillToSpend, '173.72');
  assert.equal(summary.totals.expectedUncommitted, '61.92');
  assert.equal(summary.totals.committedUnpaid, '111.8');
  assert.equal(summary.totals.headroom, '412.28');
});

test('missing FX is visible and never silently presented as a complete total', () => {
  const itinerary = clone(example);
  itinerary.budget.cost_items.find(item => item.currency === 'EUR').fx.rate_to_base = '';
  const summary = calculateBudget(itinerary);
  assert.equal(summary.totals.complete, false);
  assert.equal(summary.totals.missingFx.length, 1);
  assert.ok(summary.warnings.some(warning => warning.kind === 'missing_fx'));
});

test('category and visit totals are derived from the same base item totals', () => {
  const summary = calculateBudget(example);
  assert.equal(summary.categories.find(row => row.id === 'accommodation').expected, '283.8');
  assert.equal(summary.visits.find(row => row.id === 'paris_01').expected, '308.72');
  assert.equal(summary.visits.find(row => row.id === 'amsterdam_01').expected, '129');
});
