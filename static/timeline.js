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
  const days = Object.fromEntries((itinerary?.days || []).map(day => [day.date, { presence: [], untimedTravel: [], disruptedTravel: [], conflicts: [], day }]));
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
    return item;
  });

  const travel = explicitTravelItems(itinerary);

  for (let index = 1; index < visits.length; index += 1) {
    const visit = visits[index]; const previous = visits[index - 1];
    if (!visit.arrival_mode || !days[visit.start_date]) continue;
    const targetMs = dateMs(visit.start_date);
    const hasExplicit = travel.some(item => !['missed', 'cancelled', 'skipped'].includes(item.outcome) && item.toLocationId === visit.location_id
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
    transit.push(item);
  }

  const stayFor = (locationId, date) => {
    const exact = stays.find(item => item.locationId === locationId && item.start <= date && item.end >= date);
    if (exact) return exact;
    return [...stays].sort((a, b) => {
      const aDistance = Math.min(Math.abs(dateMs(a.start) - dateMs(date)), Math.abs(dateMs(a.end) - dateMs(date)));
      const bDistance = Math.min(Math.abs(dateMs(b.start) - dateMs(date)), Math.abs(dateMs(b.end) - dateMs(date)));
      return aDistance - bDistance || a.order - b.order;
    }).find(item => item.locationId === locationId) || null;
  };
  const transitByDate = new Map(transit.map(item => [item.date, item]));
  const uncertainty = [];
  for (const [date, entry] of Object.entries(days)) {
    const allClips = travel.filter(item => item.timed).map(item => {
      const clip = clipFloatingIntervalToDay(item.displayStart, item.displayEnd, date);
      return clip ? { item, ...clip } : null;
    }).filter(Boolean).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
    const clips = allClips.filter(clip => !['missed', 'cancelled', 'skipped'].includes(clip.item.outcome));
    entry.disruptedTravel = allClips.filter(clip => ['missed', 'cancelled', 'skipped'].includes(clip.item.outcome))
      .map(clip => ({ itemId: clip.item.id, startMinute: clip.startMinute, endMinute: clip.endMinute }));
    const untimed = entry.untimedTravel.map(piece => travel.find(item => item.id === piece.itemId)).filter(Boolean);
    if (untimed.length) {
      const source = untimed[0];
      const item = {
        id: `unknown:${date}:${source.id}`, kind: 'unknown_transition', date, visitId: source.visitId,
        title: 'Transition timing unknown', from: source.from, to: source.to, mode: source.mode,
        sourceItemId: source.id, summary: `${source.from} → ${source.to} · travel timing not recorded`,
      };
      uncertainty.push(item); entry.presence.push({ itemId: item.id, kind: item.kind, startMinute: 0, endMinute: 1440 });
      continue;
    }
    if (!clips.length) {
      if (entry.disruptedTravel.length) {
        const disrupted = travel.find(item => item.id === entry.disruptedTravel[0].itemId);
        const origin = stayFor(disrupted?.fromLocationId, date);
        if (origin) entry.presence.push({ itemId: origin.id, kind: 'stay', startMinute: 0, endMinute: 1440 });
        else {
          const item = transitByDate.get(date) || {
            id: `unknown:${date}:disrupted`, kind: 'unknown_transition', date, visitId: disrupted?.visitId || '',
            title: 'Location after disruption unknown', from: disrupted?.from || '', to: disrupted?.to || '', mode: disrupted?.mode || '',
            sourceItemId: disrupted?.id || '', summary: 'The recorded journey did not happen and no replacement location is established.',
          };
          if (!transitByDate.has(date)) uncertainty.push(item);
          entry.presence.push({ itemId: item.id, kind: item.kind, startMinute: 0, endMinute: 1440 });
        }
        continue;
      }
      if (!entry.day?.is_physical_location_day) {
        const item = transitByDate.get(date);
        entry.presence.push({ itemId: item.id, kind: item.kind, startMinute: 0, endMinute: 1440 });
        continue;
      }
      const visit = visits.find(candidate => candidate.id === entry.day?.visit_id)
        || visits.find(candidate => candidate.start_date <= date && candidate.end_date >= date);
      const stay = visit ? stays.find(candidate => candidate.visitId === visit.id) : null;
      if (stay) entry.presence.push({ itemId: stay.id, kind: 'stay', startMinute: 0, endMinute: 1440 });
      continue;
    }

    let cursor = 0;
    let currentLocationId = clips[0].item.fromLocationId;
    for (const clip of clips) {
      if (clip.startMinute < cursor) {
        entry.conflicts.push({ kind: 'overlap', itemId: clip.item.id, message: 'Travel events overlap on this day.' });
        continue;
      }
      if (clip.item.fromLocationId !== currentLocationId) {
        entry.conflicts.push({ kind: 'continuity', itemId: clip.item.id, message: `Travel continuity is unclear before ${clip.item.title}.` });
        if (clip.startMinute > cursor) {
          const item = {
            id: `unknown:${date}:${cursor}:${clip.item.id}`, kind: 'unknown_transition', date, visitId: clip.item.visitId,
            title: 'Travel timeline conflict', from: locations[currentLocationId]?.name || '', to: clip.item.from,
            mode: '', sourceItemId: clip.item.id, summary: 'Location continuity is not recorded for this period.',
          };
          uncertainty.push(item); entry.presence.push({ itemId: item.id, kind: item.kind, startMinute: cursor, endMinute: clip.startMinute });
        }
      } else if (clip.startMinute > cursor) {
        const stay = stayFor(currentLocationId, date);
        if (stay) entry.presence.push({ itemId: stay.id, kind: 'stay', startMinute: cursor, endMinute: clip.startMinute });
      }
      entry.presence.push({ itemId: clip.item.id, kind: 'travel', startMinute: clip.startMinute, endMinute: clip.endMinute });
      cursor = clip.endMinute;
      currentLocationId = clip.item.toLocationId;
    }
    if (cursor < 1440) {
      const stay = stayFor(currentLocationId, date);
      if (stay) entry.presence.push({ itemId: stay.id, kind: 'stay', startMinute: cursor, endMinute: 1440 });
      else {
        const item = {
          id: `unknown:${date}:${cursor}:end`, kind: 'unknown_transition', date, visitId: '', title: 'Location not recorded',
          from: locations[currentLocationId]?.name || '', to: '', mode: '', sourceItemId: '', summary: 'The physical location after this journey is not linked to a visit.',
        };
        uncertainty.push(item); entry.presence.push({ itemId: item.id, kind: item.kind, startMinute: cursor, endMinute: 1440 });
      }
    }
  }
  const items = new Map([...stays, ...travel, ...transit, ...uncertainty].map(item => [item.id, item]));
  return { days, stays, travel, transit, items };
}
