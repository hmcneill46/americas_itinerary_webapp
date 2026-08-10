/* Portable, exact-decimal budget calculations. Values remain JSON strings; no float is authoritative. */

const DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

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

function emptyTotals() {
  return { expected: '0', committed: '0', paid: '0', expectedStillToSpend: '0', expectedUncommitted: '0', committedUnpaid: '0', complete: true, missingFx: [] };
}

function addBase(total, item, itinerary, baseCurrency) {
  const rate = itemBaseRate(item, baseCurrency);
  if (!rate) {
    total.complete = false;
    total.missingFx.push(item);
    return;
  }
  const expected = decimalMultiply(itemExpected(item, itinerary), rate);
  const committed = decimalMultiply(item.committed_amount, rate);
  const paid = decimalMultiply(itemPaid(item), rate);
  total.expected = decimalAdd(total.expected, expected);
  total.committed = decimalAdd(total.committed, committed);
  total.paid = decimalAdd(total.paid, paid);
  total.expectedStillToSpend = decimalAdd(total.expectedStillToSpend, decimalMax(decimalAdd(expected, decimalNegate(paid))));
  total.expectedUncommitted = decimalAdd(total.expectedUncommitted, decimalMax(decimalAdd(expected, decimalNegate(committed))));
  total.committedUnpaid = decimalAdd(total.committedUnpaid, decimalMax(decimalAdd(committed, decimalNegate(paid))));
}

export function calculateBudget(itinerary) {
  const budget = itinerary?.budget || { base_currency: 'USD', total_budget: '0', categories: [], cost_items: [] };
  const baseCurrency = budget.base_currency;
  const totals = emptyTotals();
  const enrichedItems = (budget.cost_items || []).map(item => {
    const expected = itemExpected(item, itinerary);
    const paid = itemPaid(item);
    const rate = itemBaseRate(item, baseCurrency);
    const base = rate ? {
      expected: decimalMultiply(expected, rate), committed: decimalMultiply(item.committed_amount, rate), paid: decimalMultiply(paid, rate),
    } : null;
    addBase(totals, item, itinerary, baseCurrency);
    return { ...item, expectedAmount: expected, paidAmount: paid, remainingAmount: decimalMax(decimalAdd(expected, decimalNegate(paid))), rateToBase: rate, base };
  });
  const categoryById = new Map((budget.categories || []).map(category => [category.id, category]));
  const visitById = new Map((itinerary.visits || []).map(visit => [visit.id, visit]));
  const byCategory = new Map(); const byVisit = new Map();
  for (const item of enrichedItems) {
    const itemVisit = visitById.get(item.visit_id);
    const visitLocation = itemVisit ? itinerary.locations?.[itemVisit.location_id] : null;
    const visitLabel = itemVisit ? `${visitLocation?.name || itemVisit.location_id} · Visit ${itemVisit.order}` : 'Whole trip';
    for (const [key, map, label] of [[item.category_id, byCategory, categoryById.get(item.category_id)?.name || item.category_id], [item.visit_id || 'trip', byVisit, visitLabel]]) {
      const row = map.get(key) || { id: key, label, expected: '0', committed: '0', paid: '0', incomplete: false, items: [] };
      row.items.push(item);
      if (!item.base) row.incomplete = true;
      else { row.expected = decimalAdd(row.expected, item.base.expected); row.committed = decimalAdd(row.committed, item.base.committed); row.paid = decimalAdd(row.paid, item.base.paid); }
      map.set(key, row);
    }
  }
  const warnings = [];
  for (const item of enrichedItems) {
    if (!item.rateToBase) warnings.push({ kind: 'missing_fx', item });
    if (decimalCompare(item.committed_amount, item.expectedAmount) > 0) warnings.push({ kind: 'committed_over_expected', item });
    if (decimalCompare(item.paidAmount, item.expectedAmount) > 0) warnings.push({ kind: 'paid_over_expected', item });
  }
  const headroom = totals.complete ? decimalAdd(budget.total_budget, decimalNegate(totals.expected)) : null;
  if (headroom && decimalCompare(headroom, '0') < 0) warnings.push({ kind: 'over_budget' });
  return { baseCurrency, totalBudget: budget.total_budget, totals: { ...totals, headroom }, items: enrichedItems, categories: [...byCategory.values()].sort((a, b) => decimalCompare(b.expected, a.expected)), visits: [...byVisit.values()].sort((a, b) => decimalCompare(b.expected, a.expected)), warnings };
}
