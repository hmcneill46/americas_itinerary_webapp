import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { calculateBudget, calculateTodayMoney, changeBudgetBaseCurrency, decimalAdd, decimalMultiply, expectedForCalendarDate, formatMoney, itemExpected, itemPaid, itemPlanningRange, paymentNetForCalendarDate, presentNativeAndHome, presentNativeAndHomeRange } from '../static/budget.js';

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

test('native and home money presentation is exact, concise, and honest about missing FX', () => {
  const foreign = { currency: 'PEN', fx: { rate_to_base: '0.21' } };
  assert.deepEqual(presentNativeAndHome('180', foreign, 'GBP'), {
    native: 'PEN 180.00', home: 'GBP 37.80', homeAmount: '37.8', complete: true,
    text: 'PEN 180.00 · ≈ GBP 37.80', needsFx: false,
  });
  assert.equal(presentNativeAndHome('42', { currency: 'GBP', fx: {} }, 'GBP').text, 'GBP 42.00');
  assert.equal(presentNativeAndHome('50000', { currency: 'ARS', fx: {} }, 'GBP').text, 'ARS 50,000.00 · GBP unavailable — FX needed');
  const zero = presentNativeAndHome('0', { currency: 'ARS', fx: {} }, 'GBP');
  assert.equal(zero.complete, true);
  assert.equal(zero.text, 'ARS 0.00 · ≈ GBP 0.00');
  assert.equal(decimalMultiply('180', '0.21'), '37.8');
});

test('changing home currency clears old target-specific rates without changing native money', () => {
  const itinerary = dailyItinerary();
  itinerary.budget.cost_items = [
    { id: 'gbp', name: 'Rail', category_id: 'activity', currency: 'GBP', expected: { unit_amount: '100', basis: 'fixed', quantity_source: 'manual', quantity: 1 }, committed_amount: '90', payments: [{ id: 'p1', kind: 'payment', amount: '20', date: '2027-04-01' }], fx: { rate_to_base: '1', as_of_date: '', source: '', note: '' } },
    { id: 'eur', name: 'Stay', category_id: 'activity', currency: 'EUR', expected: { unit_amount: '200', basis: 'fixed', quantity_source: 'manual', quantity: 1 }, committed_amount: '200', payments: [], fx: { rate_to_base: '0.86', as_of_date: '2027-03-01', source: 'manual', note: 'Planning snapshot.' } },
    { id: 'usd', name: 'Tour', category_id: 'activity', currency: 'USD', expected: { unit_amount: '50', basis: 'fixed', quantity_source: 'manual', quantity: 1 }, committed_amount: '0', payments: [], fx: { rate_to_base: '0.78', as_of_date: '2027-03-02', source: 'manual', note: '' } },
  ];
  const changed = changeBudgetBaseCurrency(itinerary.budget, 'USD');
  const [gbp, eur, usd] = changed.budget.cost_items;
  assert.equal(changed.budget.base_currency, 'USD');
  assert.deepEqual([gbp.expected.unit_amount, gbp.committed_amount, gbp.payments[0].amount], ['100', '90', '20']);
  assert.equal(gbp.fx.rate_to_base, '', 'old home-currency amount now needs a GBP to USD rate');
  assert.equal(eur.fx.rate_to_base, '');
  assert.match(eur.fx.note, /Previous planning rate to GBP: 0\.86, as of 2027-03-01, source: manual\./);
  assert.equal(usd.fx.rate_to_base, '1', 'items native to the new home currency have an exact unit rate');
  assert.match(usd.fx.note, /Previous planning rate to GBP: 0\.78/);
  assert.equal(presentNativeAndHome('50', usd, 'USD').text, 'USD 50.00');
  assert.equal(presentNativeAndHome('200', eur, 'USD').needsFx, true);
  assert.deepEqual(itinerary.budget.cost_items.map(item => item.fx.rate_to_base), ['1', '0.86', '0.78'], 'source Budget is not mutated');
});

test('fixed, visit-day and visit-night expectations derive once', () => {
  const [rail, accommodation, food, , stay] = example.budget.cost_items;
  assert.equal(itemExpected(rail, example), '92');
  assert.equal(itemExpected(accommodation, example), '180');
  assert.equal(itemExpected(food, example), '50');
  assert.equal(itemExpected(stay, example), '150');
});

test('planning ranges scale with the same exact quantity as point estimates', () => {
  const food = example.budget.cost_items.find(item => item.id === 'cost_paris_food');
  const range = itemPlanningRange(food, example);
  assert.deepEqual(range, {
    lowUnitAmount: '20.00', highUnitAmount: '35.00', lowAmount: '40', highAmount: '70', quantity: '2',
    confidence: 'medium', note: 'Daily food spend depends on how often meals are self-catered.',
  });
  assert.equal(presentNativeAndHomeRange(range.lowAmount, range.highAmount, food, 'GBP').text, 'EUR 40.00–70.00 · ≈ GBP 34.40–60.20');
  const missing = structuredClone(food); missing.fx.rate_to_base = '';
  assert.equal(presentNativeAndHomeRange('20', '35', missing, 'GBP').text, 'EUR 20.00–35.00 · GBP unavailable — FX needed');
  assert.equal(presentNativeAndHomeRange('0', '0', missing, 'GBP').complete, true);
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
  assert.equal(budget.categories[0].completeness.expected.complete, false);
  assert.equal(budget.categories[0].completeness.expected.missingFx.length, 1);
  ars.fx.rate_to_base = '0.0007';
  budget = calculateBudget(itinerary);
  assert.equal(budget.totals.complete, true);
  assert.notEqual(budget.totals.headroom, null);
});

test('Budget tracks FX completeness per metric and ignores zero contributions', () => {
  const itinerary = dailyItinerary();
  const item = { id: 'ars_estimate', name: 'Unbooked local activity', category_id: 'activity', currency: 'ARS', expected: { unit_amount: '50000', basis: 'fixed', quantity_source: 'manual', quantity: 1 }, committed_amount: '0', fx: { rate_to_base: '' }, payments: [], visit_id: '', event_id: '', start_date: '2027-04-03', end_date: '' };
  itinerary.budget.cost_items = [item];
  let summary = calculateBudget(itinerary);
  const completeness = summary.totals.completeness;
  assert.equal(completeness.expected.complete, false);
  assert.equal(completeness.expectedStillToSpend.complete, false);
  assert.equal(completeness.expectedUncommitted.complete, false);
  assert.equal(completeness.committed.complete, true);
  assert.equal(completeness.paid.complete, true);
  assert.equal(completeness.committedUnpaid.complete, true);
  assert.equal(summary.totals.headroom, null);
  assert.equal(summary.categories[0].completeness.expected.complete, false);

  item.committed_amount = '20000';
  summary = calculateBudget(itinerary);
  assert.equal(summary.totals.completeness.committed.complete, false);
  assert.equal(summary.totals.completeness.committedUnpaid.complete, false);

  item.payments.push({ id: 'paid', kind: 'payment', amount: '20000', date: '2027-04-03' });
  summary = calculateBudget(itinerary);
  assert.equal(summary.totals.completeness.paid.complete, false);
  assert.equal(summary.totals.completeness.committedUnpaid.complete, true, 'equal committed and paid has zero unpaid contribution');

  item.committed_amount = '50000';
  item.payments[0].amount = '50000';
  summary = calculateBudget(itinerary);
  assert.equal(summary.totals.completeness.expectedStillToSpend.complete, true, 'fully paid expectation has zero remaining contribution');
  assert.equal(summary.totals.completeness.committedUnpaid.complete, true);

  item.fx.rate_to_base = '0.0003';
  summary = calculateBudget(itinerary);
  for (const metric of Object.values(summary.totals.completeness)) assert.equal(metric.complete, true);
  assert.equal(summary.totals.expected, '15');
  assert.notEqual(summary.totals.headroom, null);
});
