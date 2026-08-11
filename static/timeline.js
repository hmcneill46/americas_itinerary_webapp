const DAY_MS = 86_400_000;

function dateMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

function floatingMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0)) : NaN;
}

function dateKey(ms) {
  const date = new Date(ms);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function normaliseScheduleMode(value) {
  return value === 'places' ? 'places' : 'events';
}

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

export function clipFloatingIntervalToDay(start, end, day) {
  const startMs = floatingMs(start); const endMs = floatingMs(end); const dayStart = dateMs(day);
  if (![startMs, endMs, dayStart].every(Number.isFinite) || endMs <= startMs) return null;
  const dayEnd = dayStart + DAY_MS;
  if (startMs >= dayEnd || endMs <= dayStart) return null;
  return {
    startMinute: (Math.max(startMs, dayStart) - dayStart) / 60_000,
    endMinute: (Math.min(endMs, dayEnd) - dayStart) / 60_000,
  };
}

function explicitTravelItems(itinerary) {
  const locations = itinerary.locations || {};
  return (itinerary.events || []).filter(event => {
    return event.transport_mode && event.from_location_id && event.to_location_id
      && event.from_location_id !== event.to_location_id
      && locations[event.from_location_id] && locations[event.to_location_id];
  }).map(event => {
    let displayStart = event.actual_start || event.start;
    let displayEnd = event.actual_end || event.end;
    if (!(floatingMs(displayEnd) > floatingMs(displayStart))) {
      displayStart = event.start; displayEnd = event.end;
    }
    return {
      id: `travel:${event.id}`, kind: 'travel', eventId: event.id, visitId: event.visit_id || '',
      mode: event.transport_mode, modeKey: transportStyleKey(event.transport_mode), title: event.title,
      fromLocationId: event.from_location_id, toLocationId: event.to_location_id,
      from: locations[event.from_location_id].name, to: locations[event.to_location_id].name,
      start: event.start, end: event.end, actualStart: event.actual_start || '', actualEnd: event.actual_end || '',
      displayStart, displayEnd, outcome: event.outcome || 'planned', timed: true, estimatedDurationHours: null,
    };
  }).filter(item => floatingMs(item.displayEnd) > floatingMs(item.displayStart));
}

export function derivePlacesTravelDays(itinerary) {
  const days = Object.fromEntries((itinerary?.days || []).map(day => [day.date, { stays: [], travel: [], untimedTravel: [], transit: [], day }]));
  const locations = itinerary?.locations || {};
  const visits = [...(itinerary?.visits || [])].sort((a, b) => Number(a.order) - Number(b.order));
  const stays = visits.map(visit => {
    const location = locations[visit.location_id] || {};
    const startMs = dateMs(visit.start_date); const endMs = dateMs(visit.end_date);
    const item = {
      id: `stay:${visit.id}`, kind: 'stay', visitId: visit.id, order: Number(visit.order), locationId: visit.location_id,
      name: location.name || visit.location_id, country: location.country || '', start: visit.start_date, end: visit.end_date,
      days: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(1, Math.round((endMs - startMs) / DAY_MS) + 1) : 1,
    };
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      for (let cursor = startMs; cursor <= endMs; cursor += DAY_MS) {
        const date = dateKey(cursor);
        if (days[date]?.day?.is_physical_location_day) days[date].stays.push({ itemId: item.id, startMinute: 0, endMinute: 1440 });
      }
    }
    return item;
  });

  const travel = explicitTravelItems(itinerary);
  for (const item of travel) {
    for (const date of Object.keys(days)) {
      const clip = clipFloatingIntervalToDay(item.displayStart, item.displayEnd, date);
      if (clip) days[date].travel.push({ itemId: item.id, ...clip });
    }
  }

  for (let index = 1; index < visits.length; index += 1) {
    const visit = visits[index]; const previous = visits[index - 1];
    if (!visit.arrival_mode || !days[visit.start_date]) continue;
    const targetMs = dateMs(visit.start_date);
    const hasExplicit = travel.some(item => item.toLocationId === visit.location_id
      && Math.abs(floatingMs(item.end) - targetMs) <= DAY_MS * 2);
    if (hasExplicit) continue;
    const item = {
      id: `arrival:${visit.id}`, kind: 'travel', eventId: '', visitId: visit.id,
      mode: visit.arrival_mode, modeKey: transportStyleKey(visit.arrival_mode), title: visit.arrival_summary || visit.arrival_mode,
      fromLocationId: previous.location_id, toLocationId: visit.location_id,
      from: locations[previous.location_id]?.name || previous.location_id,
      to: locations[visit.location_id]?.name || visit.location_id,
      start: '', end: '', actualStart: '', actualEnd: '', displayStart: '', displayEnd: '', outcome: 'planned', timed: false,
      estimatedDurationHours: Number(visit.arrival_hours_estimate) > 0 ? Number(visit.arrival_hours_estimate) : null,
    };
    travel.push(item); days[visit.start_date].untimedTravel.push({ itemId: item.id });
  }

  const transit = [];
  for (const [date, entry] of Object.entries(days)) {
    if (entry.day?.is_physical_location_day) continue;
    const item = {
      id: `transit:${date}`, kind: 'transit', date, title: 'In transit',
      base: entry.day?.base || '', country: entry.day?.country || '', summary: entry.day?.summary || '',
      visitId: entry.day?.visit_id || '', locationId: entry.day?.location_id || '',
    };
    transit.push(item); entry.transit.push({ itemId: item.id });
  }
  const items = new Map([...stays, ...travel, ...transit].map(item => [item.id, item]));
  return { days, stays, travel, transit, items };
}
