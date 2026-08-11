/* Portable, exact-decimal budget calculations. Values remain JSON strings; no float is authoritative. */

const DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DAY_MS = 86_400_000;

function dateMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

function datesBetweenInclusive(start, end) {
  const startMs = dateMs(start); const endMs = dateMs(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? Math.round((endMs - startMs) / DAY_MS) + 1 : 0;
}

function dateWithinInclusive(value, start, end) { return Boolean(value && start && end && value >= start && value <= end); }

function costScope(item, itinerary, { preferEvent = false } = {}) {
  const event = (itinerary.events || []).find(candidate => candidate.id === item.event_id);
  if (preferEvent && event?.start) {
    const date = String(event.start).slice(0, 10);
    return { start: date, end: date, source: 'event' };
  }
  if (item.start_date || item.end_date) {
    const start = item.start_date || item.end_date;
    const end = item.end_date || item.start_date;
    return { start, end, source: 'item_dates' };
  }
  const visit = (itinerary.visits || []).find(candidate => candidate.id === item.visit_id);
  if (visit) return { start: visit.start_date, end: visit.end_date, source: 'visit' };
  if (event?.start) {
    const date = String(event.start).slice(0, 10);
    return { start: date, end: date, source: 'event' };
  }
  return null;
}

function parts(value) {
  const text = String(value ?? '0');
  if (!DECIMAL_RE.test(text)) throw new Error(`Invalid decimal amount: ${text}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  return { negative, digits: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function asText(negative, digits, scale) {
  const sign = negative && digits !== 0n ? '-' : '';
  const raw = digits.toString().padStart(scale + 1, '0');
  const whole = scale ? raw.slice(0, -scale) : raw;
  const fraction = scale ? raw.slice(-scale).replace(/0+$/, '') : '';
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function align(value, scale) {
  return value.digits * (10n ** BigInt(scale - value.scale)) * (value.negative ? -1n : 1n);
}

export function decimalAdd(...values) {
  const parsed = values.map(parts);
  const scale = Math.max(0, ...parsed.map(value => value.scale));
  const signed = parsed.reduce((sum, value) => sum + align(value, scale), 0n);
  return asText(signed < 0n, signed < 0n ? -signed : signed, scale);
}

export function decimalMultiply(left, right) {
  const a = parts(left); const b = parts(right);
  return asText(a.negative !== b.negative, a.digits * b.digits, a.scale + b.scale);
}

export function decimalCompare(left, right) {
  const a = parts(left); const b = parts(right); const scale = Math.max(a.scale, b.scale);
  const delta = align(a, scale) - align(b, scale);
  return delta === 0n ? 0 : delta > 0n ? 1 : -1;
}

export function decimalMax(value, minimum = '0') { return decimalCompare(value, minimum) < 0 ? minimum : value; }

export function decimalNegate(value) { return String(value) === '0' ? '0' : String(value).startsWith('-') ? String(value).slice(1) : `-${value}`; }

export function decimalFixed(value, fractionDigits = 2) {
  const parsed = parts(value); const raw = parsed.digits.toString().padStart(parsed.scale + 1, '0');
  const whole = parsed.scale ? raw.slice(0, -parsed.scale) : raw;
  const fraction = (parsed.scale ? raw.slice(-parsed.scale) : '').padEnd(fractionDigits, '0').slice(0, fractionDigits);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${parsed.negative && parsed.digits !== 0n ? '-' : ''}${grouped}${fractionDigits ? `.${fraction}` : ''}`;
}

export function formatMoney(value, currency) {
  return `${currency} ${decimalFixed(value)}`;
}

export function visitQuantity(item, itinerary) {
  if (item.expected.quantity_source === 'manual') return String(item.expected.quantity);
  const visit = (itinerary.visits || []).find(candidate => candidate.id === item.visit_id);
  if (!visit) return '0';
  const start = Date.parse(`${visit.start_date}T00:00:00Z`);
  const end = Date.parse(`${visit.end_date}T00:00:00Z`);
  const days = Math.max(0, Math.round((end - start) / 86_400_000) + 1);
  return String(item.expected.quantity_source === 'visit_nights' ? Math.max(0, days - 1) : days);
}

export function itemExpected(item, itinerary) { return decimalMultiply(item.expected.unit_amount, visitQuantity(item, itinerary)); }

export function itemPaid(item) {
  return (item.payments || []).reduce((total, payment) => decimalAdd(total, payment.kind === 'refund' ? decimalNegate(payment.amount) : payment.amount), '0');
}

export function itemBaseRate(item, baseCurrency) {
  if (item.currency === baseCurrency) return '1';
  return item.fx?.rate_to_base || '';
}

export function presentNativeAndHome(amount, item, baseCurrency) {
  const nativeCurrency = item?.currency || baseCurrency;
  const native = formatMoney(amount, nativeCurrency);
  if (nativeCurrency === baseCurrency) {
    return { native, home: native, homeAmount: String(amount), complete: true, text: native, needsFx: false };
  }
  if (decimalCompare(amount, '0') === 0) {
    const home = formatMoney('0', baseCurrency);
    return { native, home, homeAmount: '0', complete: true, text: `${native} · ≈ ${home}`, needsFx: false };
  }
  const rate = itemBaseRate(item, baseCurrency);
  if (!rate) {
    return { native, home: '', homeAmount: null, complete: false, text: `${native} · ${baseCurrency} unavailable — FX needed`, needsFx: true };
  }
  const homeAmount = decimalMultiply(amount, rate);
  const home = formatMoney(homeAmount, baseCurrency);
  return { native, home, homeAmount, complete: true, text: `${native} · ≈ ${home}`, needsFx: false };
}

export function itemPlanningRange(item, itinerary) {
  const range = item?.planning_range;
  if (!range?.low_unit_amount || !range?.high_unit_amount) return null;
  const quantity = visitQuantity(item, itinerary);
  return {
    lowUnitAmount: range.low_unit_amount,
    highUnitAmount: range.high_unit_amount,
    lowAmount: decimalMultiply(range.low_unit_amount, quantity),
    highAmount: decimalMultiply(range.high_unit_amount, quantity),
    quantity,
    confidence: range.confidence || 'unknown',
    note: range.note || '',
  };
}

export function presentNativeAndHomeRange(lowAmount, highAmount, item, baseCurrency) {
  const nativeCurrency = item?.currency || baseCurrency;
  const native = `${nativeCurrency} ${decimalFixed(lowAmount)}–${decimalFixed(highAmount)}`;
  if (nativeCurrency === baseCurrency) return { native, home: native, complete: true, text: native, needsFx: false };
  if (decimalCompare(lowAmount, '0') === 0 && decimalCompare(highAmount, '0') === 0) {
    const home = `${baseCurrency} ${decimalFixed('0')}–${decimalFixed('0')}`;
    return { native, home, complete: true, text: `${native} · ≈ ${home}`, needsFx: false };
  }
  const rate = itemBaseRate(item, baseCurrency);
  if (!rate) return { native, home: '', complete: false, text: `${native} · ${baseCurrency} unavailable — FX needed`, needsFx: true };
  const home = `${baseCurrency} ${decimalFixed(decimalMultiply(lowAmount, rate))}–${decimalFixed(decimalMultiply(highAmount, rate))}`;
  return { native, home, complete: true, text: `${native} · ≈ ${home}`, needsFx: false };
}

function previousRateNote(item, oldBaseCurrency) {
  if (item.currency === oldBaseCurrency) return '';
  const rate = item.fx?.rate_to_base;
  if (!rate) return '';
  const details = [
    `Previous planning rate to ${oldBaseCurrency}: ${rate}`,
    item.fx.as_of_date ? `as of ${item.fx.as_of_date}` : '',
    item.fx.source ? `source: ${item.fx.source}` : '',
  ].filter(Boolean).join(', ');
  return `${details}.`;
}

export function changeBudgetBaseCurrency(budget, newBaseCurrency) {
  const oldBaseCurrency = budget.base_currency;
  if (newBaseCurrency === oldBaseCurrency) return { budget: structuredClone(budget), invalidatedItemIds: [] };
  const next = structuredClone(budget);
  next.base_currency = newBaseCurrency;
  const invalidatedItemIds = [];
  next.cost_items = (next.cost_items || []).map(item => {
    const oldSnapshot = previousRateNote(item, oldBaseCurrency);
    const existingNote = item.fx?.note || '';
    const note = [existingNote, oldSnapshot].filter(Boolean).join(existingNote && oldSnapshot ? '\n' : '');
    if (item.currency === newBaseCurrency) {
      return { ...item, fx: { rate_to_base: '1', as_of_date: '', source: '', note } };
    }
    invalidatedItemIds.push(item.id);
    return { ...item, fx: { rate_to_base: '', as_of_date: '', source: '', note } };
  });
  return { budget: next, invalidatedItemIds };
}

/* A daily allocation is deliberately conservative. Per-day coverage is inclusive;
 * per-night coverage is start-inclusive/end-exclusive (checkout day has no night).
 * A manual quantity only becomes a day allocation when it exactly matches that
 * date range. Otherwise the full Budget remains authoritative and Today leaves
 * the item unallocated rather than inventing a daily split. */
export function expectedForCalendarDate(item, itinerary, date) {
  const basis = item.expected?.basis;
  if (basis === 'fixed' || basis === 'per_person' || basis === 'per_unit') {
    const scope = costScope(item, itinerary, { preferEvent: Boolean(item.event_id) });
    return scope && date === scope.start ? itemExpected(item, itinerary) : null;
  }
  if (basis !== 'per_day' && basis !== 'per_night') return null;
  const scope = costScope(item, itinerary);
  if (!scope) return null;
  const coveredUnits = basis === 'per_day' ? datesBetweenInclusive(scope.start, scope.end) : Math.max(0, datesBetweenInclusive(scope.start, scope.end) - 1);
  if (coveredUnits < 1 || decimalCompare(visitQuantity(item, itinerary), String(coveredUnits)) !== 0) return null;
  const applies = basis === 'per_day' ? dateWithinInclusive(date, scope.start, scope.end) : Boolean(date && date >= scope.start && date < scope.end);
  return applies ? item.expected.unit_amount : null;
}

export function paymentsForCalendarDate(item, date) {
  return (item.payments || []).filter(payment => payment.date === date);
}

export function paymentNetForCalendarDate(item, date) {
  return paymentsForCalendarDate(item, date).reduce((total, payment) => decimalAdd(total, payment.kind === 'refund' ? decimalNegate(payment.amount) : payment.amount), '0');
}

export function calculateTodayMoney(itinerary, date) {
  const budget = itinerary?.budget || { base_currency: 'USD', cost_items: [] };
  const baseCurrency = budget.base_currency;
  const missing = new Map();
  const result = {
    currency: baseCurrency, expected: '0', recorded: '0', expectedComplete: true, recordedComplete: true,
    expectedItems: [], recordedItems: [], missingFx: [],
  };
  const add = (kind, item, amount) => {
    if (decimalCompare(amount, '0') === 0) return;
    const rate = itemBaseRate(item, baseCurrency);
    if (!rate) {
      result[`${kind}Complete`] = false;
      const entry = missing.get(item.id) || { item, expected: false, recorded: false };
      entry[kind] = true; missing.set(item.id, entry);
      return;
    }
    result[kind] = decimalAdd(result[kind], decimalMultiply(amount, rate));
  };
  for (const item of budget.cost_items || []) {
    const expected = expectedForCalendarDate(item, itinerary, date);
    if (expected !== null) { result.expectedItems.push({ item, amount: expected }); add('expected', item, expected); }
    const recorded = paymentNetForCalendarDate(item, date);
    if (decimalCompare(recorded, '0') !== 0) { result.recordedItems.push({ item, amount: recorded }); add('recorded', item, recorded); }
  }
  result.missingFx = [...missing.values()];
  result.complete = result.expectedComplete && result.recordedComplete;
  return result;
}

const BUDGET_METRICS = ['expected', 'committed', 'paid', 'expectedStillToSpend', 'expectedUncommitted', 'committedUnpaid'];

function metricCompleteness() {
  return Object.fromEntries(BUDGET_METRICS.map(metric => [metric, { complete: true, missingFx: [] }]));
}

function emptyTotals() {
  return {
    expected: '0', committed: '0', paid: '0', expectedStillToSpend: '0', expectedUncommitted: '0', committedUnpaid: '0',
    completeness: metricCompleteness(), complete: true, missingFx: [],
  };
}

function itemMetricAmounts(item, itinerary) {
  const expected = itemExpected(item, itinerary);
  const committed = item.committed_amount;
  const paid = itemPaid(item);
  return {
    expected,
    committed,
    paid,
    expectedStillToSpend: decimalMax(decimalAdd(expected, decimalNegate(paid))),
    expectedUncommitted: decimalMax(decimalAdd(expected, decimalNegate(committed))),
    committedUnpaid: decimalMax(decimalAdd(committed, decimalNegate(paid))),
  };
}

function addBase(total, item, amounts, baseCurrency) {
  const rate = itemBaseRate(item, baseCurrency);
  for (const metric of BUDGET_METRICS) {
    const amount = amounts[metric];
    if (decimalCompare(amount, '0') === 0) continue;
    if (!rate) {
      const missing = total.completeness[metric].missingFx;
      if (!missing.some(candidate => candidate.id === item.id)) missing.push(item);
      continue;
    }
    total[metric] = decimalAdd(total[metric], decimalMultiply(amount, rate));
  }
  for (const metric of BUDGET_METRICS) total.completeness[metric].complete = total.completeness[metric].missingFx.length === 0;
  total.missingFx = [...new Map(BUDGET_METRICS.flatMap(metric => total.completeness[metric].missingFx).map(item => [item.id, item])).values()];
  total.complete = total.completeness.expected.complete;
}

export function calculateBudget(itinerary) {
  const budget = itinerary?.budget || { base_currency: 'USD', total_budget: '0', categories: [], cost_items: [] };
  const baseCurrency = budget.base_currency;
  const totals = emptyTotals();
  const enrichedItems = (budget.cost_items || []).map(item => {
    const amounts = itemMetricAmounts(item, itinerary);
    const rate = itemBaseRate(item, baseCurrency);
    const base = rate ? {
      expected: decimalMultiply(amounts.expected, rate), committed: decimalMultiply(amounts.committed, rate), paid: decimalMultiply(amounts.paid, rate),
    } : null;
    addBase(totals, item, amounts, baseCurrency);
    return { ...item, expectedAmount: amounts.expected, paidAmount: amounts.paid, remainingAmount: amounts.expectedStillToSpend, rateToBase: rate, base };
  });
  const categoryById = new Map((budget.categories || []).map(category => [category.id, category]));
  const visitById = new Map((itinerary.visits || []).map(visit => [visit.id, visit]));
  const byCategory = new Map(); const byVisit = new Map();
  for (const item of enrichedItems) {
    const itemVisit = visitById.get(item.visit_id);
    const visitLocation = itemVisit ? itinerary.locations?.[itemVisit.location_id] : null;
    const visitLabel = itemVisit ? `${visitLocation?.name || itemVisit.location_id} · Visit ${itemVisit.order}` : 'Whole trip';
    for (const [key, map, label] of [[item.category_id, byCategory, categoryById.get(item.category_id)?.name || item.category_id], [item.visit_id || 'trip', byVisit, visitLabel]]) {
      const row = map.get(key) || {
        id: key, label, expected: '0', committed: '0', paid: '0', expectedStillToSpend: '0', expectedUncommitted: '0', committedUnpaid: '0',
        completeness: metricCompleteness(), complete: true, missingFx: [], items: [],
      };
      row.items.push(item);
      addBase(row, item, itemMetricAmounts(item, itinerary), baseCurrency);
      map.set(key, row);
    }
  }
  const warnings = [];
  for (const item of enrichedItems) {
    if (totals.missingFx.some(candidate => candidate.id === item.id)) warnings.push({ kind: 'missing_fx', item });
    if (decimalCompare(item.committed_amount, item.expectedAmount) > 0) warnings.push({ kind: 'committed_over_expected', item });
    if (decimalCompare(item.paidAmount, item.expectedAmount) > 0) warnings.push({ kind: 'paid_over_expected', item });
  }
  const headroom = totals.completeness.expected.complete ? decimalAdd(budget.total_budget, decimalNegate(totals.expected)) : null;
  if (headroom && decimalCompare(headroom, '0') < 0) warnings.push({ kind: 'over_budget' });
  return { baseCurrency, totalBudget: budget.total_budget, totals: { ...totals, headroom }, items: enrichedItems, categories: [...byCategory.values()].sort((a, b) => decimalCompare(b.expected, a.expected)), visits: [...byVisit.values()].sort((a, b) => decimalCompare(b.expected, a.expected)), warnings };
}
