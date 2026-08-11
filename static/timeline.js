const DAY_MS = 86_400_000;

function dateMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

function floatingMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0)) : NaN;
}

const clamp = value => Math.max(0, Math.min(1, value));

export function normaliseCategorySelection(categories, selected) {
  const allowed = new Set(categories || []);
  if (selected == null) return new Set(allowed);
  return new Set([...selected].filter(category => allowed.has(category)));
}

export function setCategoryVisibility(selected, category, visible) {
  const next = new Set(selected || []);
  if (visible) next.add(category); else next.delete(category);
  return next;
}

export function filteredEvents(events, selectedCategories) {
  const selected = selectedCategories instanceof Set ? selectedCategories : new Set(selectedCategories || []);
  return (events || []).filter(event => selected.has(event.category));
}

export function selectionAfterFilter(selectedId, visibleIds) {
  return selectedId && new Set(visibleIds || []).has(selectedId) ? selectedId : null;
}

export function transportStyleKey(mode) {
  const value = String(mode || '').toLowerCase();
  if (value.includes('flight')) return 'flight';
  if (value.includes('train') || value.includes('rail')) return 'train';
  if (value.includes('ferry') || value.includes('boat')) return 'ferry';
  if (value.includes('trek') || value.includes('walk') || value.includes('hike')) return 'walk';
  if (value.includes('road') || value.includes('bus') || value.includes('coach')) return 'bus';
  if (value.includes('car') || value.includes('transfer')) return 'transfer';
  return 'mixed';
}

export function deriveTripFlow(itinerary) {
  const tripStart = dateMs(itinerary?.metadata?.start_date);
  const tripEnd = dateMs(itinerary?.metadata?.end_date) + DAY_MS;
  if (!Number.isFinite(tripStart) || !Number.isFinite(tripEnd) || tripEnd <= tripStart) {
    return { startMs: 0, endMs: 0, durationMs: 0, days: 0, stays: [], travel: [], countries: [] };
  }
  const durationMs = tripEnd - tripStart;
  const locations = itinerary.locations || {};
  const visits = [...(itinerary.visits || [])].sort((a, b) => Number(a.order) - Number(b.order));
  const stays = visits.map(visit => {
    const startMs = dateMs(visit.start_date);
    const endMs = dateMs(visit.end_date) + DAY_MS;
    const location = locations[visit.location_id] || {};
    return {
      id: `stay:${visit.id}`, kind: 'stay', visitId: visit.id, order: Number(visit.order),
      locationId: visit.location_id, name: location.name || visit.location_id,
      country: location.country || '', start: visit.start_date, end: visit.end_date,
      startMs, endMs, left: clamp((startMs - tripStart) / durationMs),
      width: Math.max(0, (endMs - startMs) / durationMs),
      days: Math.max(1, Math.round((endMs - startMs) / DAY_MS)),
    };
  });

  const travel = (itinerary.events || []).filter(event => {
    return event.transport_mode && event.from_location_id && event.to_location_id
      && event.from_location_id !== event.to_location_id
      && locations[event.from_location_id] && locations[event.to_location_id];
  }).map(event => {
    const startMs = floatingMs(event.actual_start || event.start);
    const endMs = floatingMs(event.actual_end || event.end);
    return {
      id: `travel:${event.id}`, kind: 'travel', eventId: event.id,
      mode: event.transport_mode, modeKey: transportStyleKey(event.transport_mode),
      title: event.title, fromLocationId: event.from_location_id, toLocationId: event.to_location_id,
      from: locations[event.from_location_id].name, to: locations[event.to_location_id].name,
      start: event.start, end: event.end, actualStart: event.actual_start || '', actualEnd: event.actual_end || '',
      outcome: event.outcome || 'planned', startMs, endMs,
      left: clamp((startMs - tripStart) / durationMs),
      width: Math.max(0, (endMs - startMs) / durationMs), estimated: false,
    };
  }).filter(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  for (let index = 1; index < visits.length; index += 1) {
    const visit = visits[index]; const previous = visits[index - 1];
    if (!visit.arrival_mode || !(Number(visit.arrival_hours_estimate) > 0)) continue;
    const hasExplicit = travel.some(item => item.toLocationId === visit.location_id
      && Math.abs(item.endMs - dateMs(visit.start_date)) <= DAY_MS * 2);
    if (hasExplicit) continue;
    const endMs = dateMs(visit.start_date) + 12 * 3_600_000;
    const startMs = endMs - Number(visit.arrival_hours_estimate) * 3_600_000;
    travel.push({
      id: `arrival:${visit.id}`, kind: 'travel', eventId: '', visitId: visit.id,
      mode: visit.arrival_mode, modeKey: transportStyleKey(visit.arrival_mode), title: visit.arrival_summary || visit.arrival_mode,
      fromLocationId: previous.location_id, toLocationId: visit.location_id,
      from: locations[previous.location_id]?.name || previous.location_id,
      to: locations[visit.location_id]?.name || visit.location_id,
      start: '', end: '', actualStart: '', actualEnd: '', outcome: 'planned', startMs, endMs,
      left: clamp((startMs - tripStart) / durationMs), width: Math.max(0, (endMs - startMs) / durationMs), estimated: true,
    });
  }
  travel.sort((a, b) => a.startMs - b.startMs);

  const countries = [];
  for (const stay of stays) {
    const previous = countries.at(-1);
    if (previous && previous.country === stay.country && previous.endMs >= stay.startMs) {
      previous.endMs = Math.max(previous.endMs, stay.endMs);
      previous.width = (previous.endMs - previous.startMs) / durationMs;
    } else countries.push({
      id: `country:${stay.order}`, country: stay.country, startMs: stay.startMs, endMs: stay.endMs,
      left: stay.left, width: stay.width,
    });
  }
  return { startMs: tripStart, endMs: tripEnd, durationMs, days: Math.round(durationMs / DAY_MS), stays, travel, countries };
}
