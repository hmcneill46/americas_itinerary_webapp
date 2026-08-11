import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { calculateBudget, calculateTodayMoney, decimalAdd, decimalMultiply, expectedForCalendarDate, formatMoney, itemExpected, itemPaid, paymentNetForCalendarDate } from '../static/budget.js';

const example = JSON.parse(await readFile(new URL('../data/itinerary.example.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);

function dailyItinerary() {
  return {
    metadata: { start_date: '2027-04-01', end_date: '2027-04-05' },
    locations: { alpha: { id: 'alpha', name: 'Alpha', country: 'One' } },
    visits: [{ id: 'visit_alpha', order: 1, location_id: 'alpha', start_date: '2027-04-01', end_date: '2027-04-05' }],
    events: [{ id: 'event_alpha', title: 'Museum', start: '2027-04-03T10:00', end: '2027-04-03T11:00' }],
    budget: { base_currency: 'GBP', total_budget: '500', categories: [{ id: 'food', name: 'Food' }, { id: 'activity', name: 'Activity' }], cost_items: [] },
  };
}

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

test('Today allocates visit days, visit nights and fixed event costs by calendar date', () => {
  const itinerary = dailyItinerary();
  const daily = { id: 'daily', name: 'Food', category_id: 'food', currency: 'GBP', expected: { unit_amount: '25', basis: 'per_day', quantity_source: 'visit_days', quantity: 0 }, committed_amount: '0', fx: {}, payments: [], visit_id: 'visit_alpha', event_id: '', start_date: '', end_date: '' };
  const nightly = { id: 'nightly', name: 'Hotel', category_id: 'food', currency: 'GBP', expected: { unit_amount: '40', basis: 'per_night', quantity_source: 'visit_nights', quantity: 0 }, committed_amount: '0', fx: {}, payments: [], visit_id: 'visit_alpha', event_id: '', start_date: '', end_date: '' };
  const fixed = { id: 'fixed', name: 'Museum', category_id: 'activity', currency: 'GBP', expected: { unit_amount: '12.5', basis: 'fixed', quantity_source: 'manual', quantity: 1 }, committed_amount: '0', fx: {}, payments: [], visit_id: '', event_id: 'event_alpha', start_date: '', end_date: '' };
  itinerary.budget.cost_items = [daily, nightly, fixed];
  assert.equal(expectedForCalendarDate(daily, itinerary, '2027-04-03'), '25');
  assert.equal(expectedForCalendarDate(nightly, itinerary, '2027-04-04'), '40');
  assert.equal(expectedForCalendarDate(nightly, itinerary, '2027-04-05'), null, 'checkout/end date has no night');
  assert.equal(expectedForCalendarDate(fixed, itinerary, '2027-04-03'), '12.5');
  assert.equal(expectedForCalendarDate(fixed, itinerary, '2027-04-04'), null);
  const today = calculateTodayMoney(itinerary, '2027-04-03');
  assert.equal(today.expected, '77.5');
  assert.equal(today.expectedComplete, true);
});

test('Today records only same-day payments, refunds and adjustments with exact decimal arithmetic', () => {
  const itinerary = dailyItinerary();
  const item = { id: 'daily', name: 'Food', category_id: 'food', currency: 'GBP', expected: { unit_amount: '25', basis: 'per_day', quantity_source: 'visit_days', quantity: 0 }, committed_amount: '0', fx: {}, visit_id: 'visit_alpha', event_id: '', start_date: '', end_date: '', payments: [
    { id: 'old', kind: 'payment', amount: '10', date: '2027-04-02' },
    { id: 'today_payment', kind: 'payment', amount: '0.1', date: '2027-04-03' },
    { id: 'today_refund', kind: 'refund', amount: '0.03', date: '2027-04-03' },
    { id: 'today_adjustment', kind: 'adjustment', amount: '-0.02', date: '2027-04-03' },
  ] };
  itinerary.budget.cost_items = [item];
  assert.equal(paymentNetForCalendarDate(item, '2027-04-03'), '0.05');
  const today = calculateTodayMoney(itinerary, '2027-04-03');
  assert.equal(today.expected, '25');
  assert.equal(today.recorded, '0.05');
  assert.equal(today.recordedItems.length, 1);
});

test('Today and Budget preserve incomplete FX explicitly until a rate is supplied', () => {
  const itinerary = dailyItinerary();
  const ars = { id: 'ars_food', name: 'Local food', category_id: 'food', currency: 'ARS', expected: { unit_amount: '25000', basis: 'per_day', quantity_source: 'visit_days', quantity: 0 }, committed_amount: '0', fx: { rate_to_base: '' }, payments: [{ id: 'ars_payment', kind: 'payment', amount: '5000', date: '2027-04-03' }], visit_id: 'visit_alpha', event_id: '', start_date: '', end_date: '' };
  itinerary.budget.cost_items = [ars];
  const today = calculateTodayMoney(itinerary, '2027-04-03');
  assert.equal(today.expectedComplete, false);
  assert.equal(today.recordedComplete, false);
  assert.equal(today.missingFx.length, 1);
  let budget = calculateBudget(itinerary);
  assert.equal(budget.totals.complete, false);
  assert.equal(budget.totals.headroom, null);
  assert.equal(budget.categories[0].incomplete, true);
  assert.equal(budget.categories[0].missingFxItems.length, 1);
  ars.fx.rate_to_base = '0.0007';
  budget = calculateBudget(itinerary);
  assert.equal(budget.totals.complete, true);
  assert.notEqual(budget.totals.headroom, null);
});
