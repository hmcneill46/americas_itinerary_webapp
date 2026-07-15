'use strict';

const DAY_MS = 86_400_000;
const MAP_WIDTH = 1100;
const MAP_HEIGHT = 850;
const MODE_STYLES = {
  'Flight': { colour: '#D1495B', dash: '7 5' },
  'Road / bus': { colour: '#E58C47', dash: '' },
  'Ferry / boat': { colour: '#2A9D8F', dash: '3 4' },
  'Train': { colour: '#6C63A8', dash: '9 3 2 3' },
  'Trek / walk': { colour: '#3A7D44', dash: '2 3' },
  'Mixed': { colour: '#7A5CFA', dash: '6 3 2 3' },
  'Local transfer': { colour: '#7A8793', dash: '2 3' },
};

const state = {
  saved: null,
  draft: null,
  revision: null,
  dirty: false,
  editTokenRequired: false,
  activeTab: 'day',
  editTab: 'events',
  selectedDate: '',
  selectedEventId: null,
  editEventId: null,
  editVisitId: null,
  editLocationId: null,
  editDayDate: '',
  routeNeedsReflow: false,
  basemap: null,
  mapBuiltForSignature: '',
  mapView: { x: 0, y: 0, w: MAP_WIDTH, h: MAP_HEIGHT },
  mapOriginalView: { x: 0, y: 0, w: MAP_WIDTH, h: MAP_HEIGHT },
  mapPlaying: false,
  mapTimer: null,
  mapDrag: null,
};

const el = id => document.getElementById(id);
const deepClone = value => structuredClone(value);
const currentData = () => state.draft || state.saved;

function readSessionValue(key) {
  try { return sessionStorage.getItem(key); } catch { return ''; }
}
function writeSessionValue(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* Storage can be disabled in private or embedded contexts. */ }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'location';
}

function parseFloating(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return NaN;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] || 0),
  );
}

function parseDateKey(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function pad2(value) { return String(value).padStart(2, '0'); }

function formatFloating(ms, includeSeconds = false) {
  const d = new Date(ms);
  const base = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return includeSeconds ? `${base}:${pad2(d.getUTCSeconds())}` : base;
}

function formatDateKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDays(dateKey, amount) { return formatDateKey(parseDateKey(dateKey) + amount * DAY_MS); }
function daysBetween(a, b) { return Math.round((parseDateKey(b) - parseDateKey(a)) / DAY_MS); }
function shiftDateTime(value, days) { return formatFloating(parseFloating(value) + days * DAY_MS); }

function humanDate(dateKey, options = {}) {
  const ms = parseDateKey(dateKey);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: options.weekday ?? 'short', day: 'numeric', month: 'short', year: options.year === false ? undefined : 'numeric',
  }).format(new Date(ms));
}

function humanDateTime(value) {
  const ms = parseFloating(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));
}

function humanTime(value) {
  const d = new Date(parseFloating(value));
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function formatDuration(minutes) {
  const rounded = Math.round(minutes);
  const days = Math.floor(rounded / 1440);
  const hours = Math.floor((rounded % 1440) / 60);
  const mins = rounded % 60;
  const pieces = [];
  if (days) pieces.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) pieces.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (mins || !pieces.length) pieces.push(`${mins} minute${mins === 1 ? '' : 's'}`);
  return pieces.join(' ');
}

function eventDurationMinutes(event) { return (parseFloating(event.end) - parseFloating(event.start)) / 60_000; }
function visitDurationDays(visit) { return daysBetween(visit.start_date, visit.end_date) + 1; }
function getLocation(id, data = currentData()) { return data?.locations?.[id] || null; }
function getVisit(id, data = currentData()) { return data?.visits?.find(item => item.id === id) || null; }
function getDay(dateKey, data = currentData()) { return data?.days?.find(item => item.date === dateKey) || null; }
function sortedVisits(data = currentData()) { return [...(data?.visits || [])].sort((a, b) => Number(a.order) - Number(b.order)); }
function sortedEvents(data = currentData()) { return [...(data?.events || [])].sort((a, b) => parseFloating(a.start) - parseFloating(b.start) || parseFloating(a.end) - parseFloating(b.end)); }
function eventOverlapsDay(event, dateKey) {
  const start = parseDateKey(dateKey);
  const end = start + DAY_MS;
  return parseFloating(event.start) < end && parseFloating(event.end) > start;
}
function eventTouchesDate(event, dateKey) { return eventOverlapsDay(event, dateKey); }
function colourForCategory(category, data = currentData()) { return data?.metadata?.category_colours?.[category] || '#9BA8B1'; }

function contrastClass(hex) {
  const clean = String(hex).replace('#', '');
  if (clean.length !== 6) return 'dark-text';
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.53 ? 'light-text' : 'dark-text';
}

function toast(message, type = 'info', timeout = 3500) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  el('toast-container').appendChild(node);
  setTimeout(() => node.remove(), timeout);
}

function setSaveStatus(text, className = '') {
  const node = el('save-status');
  node.textContent = text;
  node.className = `status-pill ${className}`.trim();
}

function markDirty(reason = 'Unsaved changes') {
  state.dirty = true;
  el('save-button').disabled = false;
  el('cancel-button').disabled = false;
  el('draft-status').textContent = reason;
  el('draft-status').className = 'draft-status dirty';
  setSaveStatus('Draft changed', 'dirty');
}

function markClean() {
  state.dirty = false;
  state.routeNeedsReflow = false;
  el('save-button').disabled = true;
  el('cancel-button').disabled = true;
  el('draft-status').textContent = 'No unsaved changes';
  el('draft-status').className = 'draft-status';
  setSaveStatus('Saved', 'saved');
}

function generateId(prefix = 'evt') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

async function apiJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = body?.detail?.message || body?.detail || body?.errors?.join('\n') || String(body);
    const error = new Error(detail || `Request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function loadItinerary(showToast = false) {
  setSaveStatus('Loading');
  const payload = await apiJson('/api/itinerary');
  state.saved = payload.itinerary;
  state.draft = deepClone(payload.itinerary);
  state.revision = payload.revision;
  state.editTokenRequired = Boolean(payload.edit_token_required);
  state.selectedDate = state.selectedDate || payload.itinerary.metadata.start_date;
  state.editDayDate = state.editDayDate || state.selectedDate;
  state.mapView = { ...state.mapOriginalView };
  state.mapBuiltForSignature = '';
  state.selectedEventId = null;
  state.editEventId = null;
  state.editVisitId = sortedVisits(state.draft)[0]?.id || null;
  state.editLocationId = Object.keys(state.draft.locations)[0] || null;
  el('app-title').textContent = payload.itinerary.metadata.title;
  el('app-subtitle').textContent = `${humanDate(payload.itinerary.metadata.start_date)} – ${humanDate(payload.itinerary.metadata.end_date)} · ${payload.itinerary.days.length} days`;
  el('day-date').min = payload.itinerary.metadata.start_date;
  el('day-date').max = payload.itinerary.metadata.end_date;
  el('day-date').value = state.selectedDate;
  el('edit-day-date').min = payload.itinerary.metadata.start_date;
  el('edit-day-date').max = payload.itinerary.metadata.end_date;
  el('edit-day-date').value = state.editDayDate;
  el('token-label').classList.toggle('hidden', !state.editTokenRequired);
  const storedToken = readSessionValue('itinerary_edit_token');
  if (storedToken) el('edit-token').value = storedToken;
  markClean();
  renderEverything();
  if (showToast) toast('Reloaded the saved itinerary.', 'success');
}

function renderEverything() {
  populateCategoryControls();
  if (state.activeTab === 'day') {
    renderDayView();
    renderEventDetails();
  } else if (state.activeTab === 'map') {
    renderMap(true);
  } else if (state.activeTab === 'edit') {
    renderEditView();
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.view-panel').forEach(panel => panel.classList.toggle('active', panel.id === `view-${tab}`));
  if (tab === 'day') { renderDayView(); renderEventDetails(); }
  if (tab === 'map') renderMap(false);
  if (tab === 'edit') renderEditView();
}

function switchEditTab(tab) {
  state.editTab = tab;
  document.querySelectorAll('.edit-subtab').forEach(button => button.classList.toggle('active', button.dataset.editTab === tab));
  document.querySelectorAll('.edit-section').forEach(section => section.classList.toggle('active', section.id === `edit-${tab}`));
  renderEditView();
}

/* ---------------- Day bars ---------------- */
function populateCategoryControls() {
  const data = currentData();
  const categories = Object.keys(data.metadata.category_colours || {});
  const filter = el('category-filter');
  const existing = filter.value;
  filter.innerHTML = '<option value="">All categories</option>' + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  filter.value = categories.includes(existing) ? existing : '';
  const eventCategory = el('event-category');
  const selected = eventCategory.value;
  eventCategory.innerHTML = categories.map(category => `<option>${escapeHtml(category)}</option>`).join('');
  if (categories.includes(selected)) eventCategory.value = selected;
}

function assignLanes(pieces) {
  const laneEnds = [];
  for (const piece of pieces) {
    let lane = laneEnds.findIndex(end => end <= piece.startMinute);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(piece.endMinute); }
    else laneEnds[lane] = piece.endMinute;
    piece.lane = lane;
  }
  return Math.max(1, laneEnds.length);
}

function renderDayView() {
  const data = currentData();
  if (!data) return;
  const category = el('category-filter').value;
  const search = el('day-search').value.trim().toLowerCase();
  const compact = el('compact-days').checked;
  const events = sortedEvents(data);
  const html = [];

  for (const day of data.days) {
    const dayStart = parseDateKey(day.date);
    const dayEnd = dayStart + DAY_MS;
    const pieces = [];
    for (const event of events) {
      const eventStart = parseFloating(event.start);
      const eventEnd = parseFloating(event.end);
      if (eventStart >= dayEnd) break;
      if (eventEnd <= dayStart) continue;
      const searchable = `${event.title} ${event.notes || ''} ${(event.day_summaries || []).join(' ')} ${day.base} ${day.country} ${day.summary} ${day.notes || ''}`.toLowerCase();
      if (category && event.category !== category) continue;
      if (search && !searchable.includes(search)) continue;
      const pieceStart = Math.max(eventStart, dayStart);
      const pieceEnd = Math.min(eventEnd, dayEnd);
      pieces.push({
        event,
        startMinute: (pieceStart - dayStart) / 60_000,
        endMinute: (pieceEnd - dayStart) / 60_000,
      });
    }
    pieces.sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
    const laneCount = assignLanes(pieces);
    const barHeight = laneCount * 28 + 12;
    const eventHtml = pieces.map(piece => {
      const event = piece.event;
      const left = piece.startMinute / 1440 * 100;
      const width = Math.max((piece.endMinute - piece.startMinute) / 1440 * 100, 0.12);
      const colour = colourForCategory(event.category, data);
      const selected = event.id === state.selectedEventId;
      const label = width > 4 ? event.title : '';
      const title = `${event.title} · ${humanTime(formatFloating(dayStart + piece.startMinute * 60_000))}–${humanTime(formatFloating(dayStart + piece.endMinute * 60_000))}`;
      return `<button class="event-piece ${contrastClass(colour)} ${selected ? 'selected' : ''} ${event.locked ? 'locked' : ''}" data-event-id="${escapeHtml(event.id)}" style="left:${left}%;width:${width}%;top:${6 + piece.lane * 28}px;background:${colour}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
    }).join('');
    const notes = day.notes ? `<div class="day-notes-text">${escapeHtml(day.notes)}</div>` : '';
    html.push(`<article class="day-row ${compact ? 'compact' : ''} ${day.date === state.selectedDate ? 'target-day' : ''}" data-date="${day.date}">
      <div class="day-meta">
        <div class="day-meta-top"><div><div class="day-date">${humanDate(day.date, { year: false })}</div><div class="day-number-small">Day ${day.day_number}</div></div><span class="confidence-badge confidence-${day.confidence}">${day.confidence}</span></div>
        <div class="day-base">${escapeHtml(day.base)}</div><div class="day-country">${escapeHtml(day.country)}</div>
        <div class="day-summary-text">${escapeHtml(day.summary)}</div>${notes}
      </div>
      <div class="day-bar-wrap" style="height:${barHeight}px"><div class="day-bar-grid"></div>${eventHtml}</div>
    </article>`);
  }
  el('day-list').innerHTML = html.join('');
  el('day-list').querySelectorAll('.event-piece').forEach(piece => piece.addEventListener('click', () => selectEvent(piece.dataset.eventId)));
}

function selectEvent(eventId, scroll = false) {
  state.selectedEventId = eventId;
  document.querySelectorAll('.event-piece').forEach(piece => {
    piece.classList.toggle('selected', piece.dataset.eventId === eventId);
    piece.classList.toggle('dimmed', Boolean(eventId) && piece.dataset.eventId !== eventId);
  });
  renderEventDetails();
  if (scroll) {
    const first = document.querySelector(`.event-piece[data-event-id="${CSS.escape(eventId)}"]`);
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function renderEventDetails() {
  const panel = el('event-details');
  const data = currentData();
  const event = data?.events?.find(item => item.id === state.selectedEventId);
  if (!event) {
    panel.innerHTML = `<div class="empty-details"><div class="empty-icon">↗</div><h2>Select part of a bar</h2><p>Click any event segment to highlight every part of that event, including pieces on other days.</p></div>`;
    return;
  }
  const location = getLocation(event.location_id, data);
  const from = getLocation(event.from_location_id, data);
  const to = getLocation(event.to_location_id, data);
  const visit = getVisit(event.visit_id, data);
  const duration = eventDurationMinutes(event);
  const firstDay = event.start.slice(0, 10);
  const lastInstant = parseFloating(event.end) - 1;
  const lastDay = formatDateKey(lastInstant);
  const spanDays = daysBetween(firstDay, lastDay) + 1;
  const summaries = (event.day_summaries || []).map(summary => `<li>${escapeHtml(summary)}</li>`).join('');
  panel.innerHTML = `<div class="details-card">
    <span class="details-category ${contrastClass(colourForCategory(event.category, data))}" style="background:${colourForCategory(event.category, data)}">${escapeHtml(event.category)}</span>
    <h2>${escapeHtml(event.title)}</h2>
    <div class="details-time"><strong>${humanDateTime(event.start)}</strong><span>until ${humanDateTime(event.end)}</span><span>${formatDuration(duration)}${spanDays > 1 ? ` across ${spanDays} calendar days` : ''}</span></div>
    <div class="details-grid">
      <div class="detail-box"><small>Location</small><strong>${escapeHtml(location?.name || '—')}</strong></div>
      <div class="detail-box"><small>Visit</small><strong>${escapeHtml(visit?.id || event.visit_id)}</strong></div>
      <div class="detail-box"><small>Confidence</small><strong>${escapeHtml(event.confidence)}</strong></div>
      <div class="detail-box"><small>Status</small><strong>${event.locked ? 'Locked / confirmed' : 'Planning draft'}</strong></div>
      ${event.transport_mode ? `<div class="detail-box"><small>Transport</small><strong>${escapeHtml(event.transport_mode)}</strong></div>` : ''}
      ${(from || to) ? `<div class="detail-box"><small>Route</small><strong>${escapeHtml(from?.name || '—')} → ${escapeHtml(to?.name || '—')}</strong></div>` : ''}
    </div>
    ${event.notes ? `<div class="details-section"><h3>Event and planning notes</h3><p>${escapeHtml(event.notes)}</p></div>` : ''}
    ${summaries ? `<div class="details-section"><h3>Daily context</h3><ul>${summaries}</ul></div>` : ''}
    <div class="details-section"><button id="details-edit-event" class="primary-button">Edit this event</button></div>
  </div>`;
  el('details-edit-event').addEventListener('click', () => {
    state.editEventId = event.id;
    switchTab('edit');
    switchEditTab('events');
    renderEventEditor();
  });
}

function jumpToDate(dateKey, behaviour = 'smooth') {
  const data = currentData();
  if (!data.days.some(day => day.date === dateKey)) return;
  state.selectedDate = dateKey;
  el('day-date').value = dateKey;
  renderDayView();
  document.querySelector(`.day-row[data-date="${dateKey}"]`)?.scrollIntoView({ block: 'center', behavior: behaviour });
}

/* ---------------- Map ---------------- */
function projectPoint(lon, lat, bounds) {
  return {
    x: (lon - bounds.min_lon) / (bounds.max_lon - bounds.min_lon) * MAP_WIDTH,
    y: (bounds.max_lat - lat) / (bounds.max_lat - bounds.min_lat) * MAP_HEIGHT,
  };
}

function geometryPaths(geometry, bounds) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.map(polygon => polygon.map(ring => ring.map(([lon, lat], index) => {
    const point = projectPoint(lon, lat, bounds);
    return `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }).join(' ') + ' Z').join(' '));
}

function mapSignature(data) {
  return JSON.stringify({ visits: data.visits, locations: data.locations, start: data.metadata.start_date, end: data.metadata.end_date });
}

async function ensureBasemap() {
  if (state.basemap) return;
  state.basemap = await fetch('/static/americas_basemap.geojson').then(response => response.json());
}

function visitForDay(day, data = currentData()) { return getVisit(day?.visit_id, data); }
function currentMapDay() { return currentData()?.days?.[Number(el('map-slider').value) - 1] || currentData()?.days?.[0]; }

function legPath(origin, destination, mode, bounds) {
  const p1 = projectPoint(origin.longitude, origin.latitude, bounds);
  const p2 = projectPoint(destination.longitude, destination.latitude, bounds);
  if (mode === 'Flight') {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.max(Math.hypot(dx, dy), 0.001);
    const cx = mx - dy / length * length * .14;
    const cy = my + dx / length * length * .14;
    return `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`;
  }
  return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
}

function mapRouteData(data = currentData()) {
  const visits = sortedVisits(data);
  return visits.map((visit, index) => {
    const location = getLocation(visit.location_id, data);
    const previous = index === 0 ? getLocation(data.metadata.home_location_id, data) : getLocation(visits[index - 1].location_id, data);
    return {
      ...visit,
      location,
      previous,
      durationDays: visitDurationDays(visit),
    };
  });
}

async function renderMap(forceBuild = false) {
  const data = currentData();
  if (!data) return;
  await ensureBasemap();
  const signature = mapSignature(data);
  if (forceBuild || state.mapBuiltForSignature !== signature) {
    buildMapSvg(data);
    state.mapBuiltForSignature = signature;
  }
  const slider = el('map-slider');
  slider.max = data.days.length;
  if (!slider.value || Number(slider.value) > data.days.length) slider.value = 1;
  updateMapDay(Number(slider.value));
}

function buildMapSvg(data) {
  const bounds = data.metadata.map_bounds;
  el('map-countries').innerHTML = state.basemap.features.map(feature => geometryPaths(feature.geometry, bounds).map(path => `<path class="map-country" d="${path}"></path>`).join('')).join('');
  const route = mapRouteData(data);
  const locationCounts = {};
  for (const item of route) locationCounts[item.location_id] = (locationCounts[item.location_id] || 0) + 1;
  const seen = {};
  route.forEach(item => {
    seen[item.location_id] = (seen[item.location_id] || 0) + 1;
    const total = locationCounts[item.location_id];
    const occurrence = seen[item.location_id];
    let lat = item.location.latitude;
    let lon = item.location.longitude;
    if (total > 1) {
      const angle = 2 * Math.PI * (occurrence - 1) / total;
      const radius = .22 + .07 * (occurrence - 1);
      lat += radius * Math.sin(angle);
      lon += radius * Math.cos(angle);
    }
    item.plot = { ...projectPoint(lon, lat, bounds), latitude: lat, longitude: lon };
  });
  const home = getLocation(data.metadata.home_location_id, data);
  const startPoint = projectPoint(home.longitude, home.latitude, bounds);
  const allNodes = [{
    id: 'home_start', order: 0, location_id: home.id, location: home, plot: { ...startPoint, latitude: home.latitude, longitude: home.longitude },
    durationDays: 0, start_date: data.metadata.start_date, end_date: data.metadata.start_date, arrival_mode: '', arrival_hours_estimate: 0,
  }, ...route];
  const legs = [];
  for (let index = 1; index < allNodes.length; index++) {
    const from = allNodes[index - 1];
    const to = allNodes[index];
    const style = MODE_STYLES[to.arrival_mode] || MODE_STYLES['Local transfer'];
    const width = Math.min(7, 1.4 + Math.log1p(Math.max(Number(to.arrival_hours_estimate) || 0, 0)) * .85);
    const origin = { longitude: from.plot.longitude, latitude: from.plot.latitude };
    const destination = { longitude: to.plot.longitude, latitude: to.plot.latitude };
    legs.push({ index, from, to, style, width });
    const dash = style.dash ? `stroke-dasharray="${style.dash}"` : '';
    el('map-legs').insertAdjacentHTML('beforeend', `<path class="map-leg future" data-leg-index="${index}" d="${legPath(origin, destination, to.arrival_mode, bounds)}" stroke="${style.colour}" stroke-width="${width}" ${dash}></path>`);
  }
  el('map-nodes').innerHTML = allNodes.map(node => {
    const baseRadius = Math.min(17, 6 + Math.sqrt(Math.max(node.durationDays, 0)) * 2.15);
    const label = node.order === 0 ? 'S' : node.order;
    return `<g class="map-node future" data-node-order="${node.order}" data-visit-id="${escapeHtml(node.id)}" transform="translate(${node.plot.x},${node.plot.y})"><g class="node-content"><circle r="${baseRadius}"></circle><text text-anchor="middle" dominant-baseline="central" font-size="${String(label).length > 1 ? 8 : 10}">${label}</text></g></g>`;
  }).join('');

  const tooltip = el('map-tooltip');
  const wrap = el('map-wrap');
  const showTooltip = (event, html) => {
    tooltip.innerHTML = html;
    tooltip.style.opacity = '1';
    const rect = wrap.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - rect.left + 8}px`;
    tooltip.style.top = `${event.clientY - rect.top + 8}px`;
  };
  document.querySelectorAll('.map-node').forEach(nodeElement => {
    const order = Number(nodeElement.dataset.nodeOrder);
    const node = allNodes.find(item => Number(item.order) === order);
    nodeElement.addEventListener('mouseenter', event => showTooltip(event, `<strong>${order === 0 ? 'Start' : `${order}.`} ${escapeHtml(node.location.name)}</strong><br>${escapeHtml(node.location.country)}<br>${escapeHtml(node.start_date)} to ${escapeHtml(node.end_date)}<br>${node.durationDays} itinerary day(s)`));
    nodeElement.addEventListener('mousemove', event => showTooltip(event, tooltip.innerHTML));
    nodeElement.addEventListener('mouseleave', () => { tooltip.style.opacity = 0; });
    nodeElement.addEventListener('click', () => {
      if (order > 0) {
        const dayIndex = data.days.findIndex(day => day.visit_id === node.id);
        if (dayIndex >= 0) { el('map-slider').value = dayIndex + 1; updateMapDay(dayIndex + 1); }
      }
    });
  });
  document.querySelectorAll('.map-leg').forEach(legElement => {
    const leg = legs.find(item => item.index === Number(legElement.dataset.legIndex));
    legElement.addEventListener('mouseenter', event => showTooltip(event, `<strong>${escapeHtml(leg.from.location.name)} → ${escapeHtml(leg.to.location.name)}</strong><br>${escapeHtml(leg.to.arrival_mode)} · ${Number(leg.to.arrival_hours_estimate || 0)} planned hour(s)<br>${escapeHtml(leg.to.arrival_summary || '')}`));
    legElement.addEventListener('mousemove', event => showTooltip(event, tooltip.innerHTML));
    legElement.addEventListener('mouseleave', () => { tooltip.style.opacity = 0; });
  });

  el('map-legend').innerHTML = Object.entries(MODE_STYLES).map(([mode, style]) => `<div class="map-legend-item"><span class="map-legend-line" style="border-color:${style.colour};${mode === 'Flight' ? 'border-top-style:dashed' : ''}"></span>${escapeHtml(mode)}</div>`).join('');
  el('map-route-list').innerHTML = route.map(item => `<button class="map-route-row" data-visit-id="${escapeHtml(item.id)}"><span class="map-route-number">${item.order}</span><span class="map-route-main"><strong>${escapeHtml(item.location.name)}</strong><small>${escapeHtml(item.start_date)} to ${escapeHtml(item.end_date)} · ${item.durationDays} day(s)</small></span><span class="map-route-mode">${escapeHtml(item.arrival_mode)}<strong>${Number(item.arrival_hours_estimate || 0)}h</strong></span></button>`).join('');
  el('map-route-list').querySelectorAll('.map-route-row').forEach(row => row.addEventListener('click', () => {
    const index = data.days.findIndex(day => day.visit_id === row.dataset.visitId);
    if (index >= 0) { el('map-slider').value = index + 1; updateMapDay(index + 1); }
  }));
  updateMapViewBox();
}

function updateMapDay(dayNumber) {
  const data = currentData();
  const day = data.days[Math.max(0, Math.min(data.days.length - 1, dayNumber - 1))];
  const visit = getVisit(day.visit_id, data);
  const location = getLocation(day.location_id, data);
  const route = sortedVisits(data);
  const currentOrder = Number(visit.order);
  const travelEvents = data.events.filter(event => eventOverlapsDay(event, day.date) && ['Travel', 'Hike'].includes(event.category) && event.to_location_id && event.from_location_id !== event.to_location_id);
  const activeTravel = travelEvents.sort((a, b) => eventDurationMinutes(b) - eventDurationMinutes(a))[0];
  el('map-slider').value = day.day_number;
  el('map-slider-label').textContent = `Day ${day.day_number} · ${humanDate(day.date, { year: false })}`;
  el('map-day-card').innerHTML = `<h2>${escapeHtml(location.name)}</h2><div class="map-date">${humanDate(day.date)} · Day ${day.day_number}</div><p>${escapeHtml(day.summary)}</p><div class="map-meta-grid"><div class="detail-box"><small>Base</small><strong>${escapeHtml(day.base)}</strong></div><div class="detail-box"><small>Status</small><strong>${activeTravel ? 'Travelling / arriving' : 'At location'}</strong></div><div class="detail-box"><small>Travel</small><strong>${escapeHtml(activeTravel?.transport_mode || '—')}</strong></div><div class="detail-box"><small>Exact scheduled time</small><strong>${activeTravel ? formatDuration(eventDurationMinutes(activeTravel)) : 'No major transfer'}</strong></div></div>`;
  document.querySelectorAll('.map-node').forEach(node => {
    const order = Number(node.dataset.nodeOrder);
    node.classList.remove('future', 'complete', 'current');
    node.classList.add(order < currentOrder ? 'complete' : order === currentOrder ? 'current' : 'future');
  });
  document.querySelectorAll('.map-leg').forEach(leg => {
    const order = Number(leg.dataset.legIndex);
    leg.classList.remove('future', 'complete', 'current');
    if (order < currentOrder) leg.classList.add('complete');
    else if (order === currentOrder && activeTravel) leg.classList.add('current');
    else leg.classList.add('future');
  });
  document.querySelectorAll('.map-route-row').forEach(row => row.classList.toggle('active', row.dataset.visitId === visit.id));
  document.querySelector('.map-route-row.active')?.scrollIntoView({ block: 'nearest' });
}

function updateMapViewBox() {
  const svg = el('route-map');
  const v = state.mapView;
  svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  // SVG contents normally become physically larger while zooming. Applying an
  // inverse scale keeps markers roughly constant on screen, with a very small
  // growth at close zoom levels so they remain easy to click without overlap.
  const inverseScale = Math.pow(v.w / MAP_WIDTH, 0.92);
  document.querySelectorAll('.node-content').forEach(node => node.setAttribute('transform', `scale(${inverseScale})`));
}

function fitMapToRoute() {
  const data = currentData();
  const bounds = data.metadata.map_bounds;
  const points = sortedVisits(data).map(visit => {
    const location = getLocation(visit.location_id, data);
    return projectPoint(location.longitude, location.latitude, bounds);
  });
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const pad = 55;
  state.mapView = { x: minX - pad, y: minY - pad, w: Math.max(160, maxX - minX + pad * 2), h: Math.max(120, maxY - minY + pad * 2) };
  updateMapViewBox();
}

/* ---------------- Edit view ---------------- */
function renderEditView() {
  if (!currentData()) return;
  if (state.editTab === 'events') renderEventEditor();
  if (state.editTab === 'route') renderRouteEditor();
  if (state.editTab === 'locations') renderLocationEditor();
}

function refreshSelectOptions(select, options, selected, allowBlank = false) {
  select.innerHTML = (allowBlank ? '<option value="">—</option>' : '') + options.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
  select.value = selected || '';
}

function renderEventEditor() {
  const data = state.draft;
  const query = el('event-search').value.trim().toLowerCase();
  const events = sortedEvents(data).filter(event => !query || `${event.title} ${event.category} ${event.start} ${event.notes || ''}`.toLowerCase().includes(query));
  el('event-list').innerHTML = events.map(event => `<button class="editor-list-item ${event.id === state.editEventId ? 'active' : ''}" data-event-id="${escapeHtml(event.id)}"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.category)} · ${humanDateTime(event.start)} → ${humanTime(event.end)}</small></button>`).join('');
  el('event-list').querySelectorAll('.editor-list-item').forEach(item => item.addEventListener('click', () => {
    state.editEventId = item.dataset.eventId;
    renderEventEditor();
  }));

  const event = data.events.find(item => item.id === state.editEventId);
  el('event-form-empty').classList.toggle('hidden', Boolean(event));
  el('event-form').classList.toggle('hidden', !event);
  if (!event) return;
  const locations = Object.values(data.locations).sort((a, b) => a.name.localeCompare(b.name)).map(location => ({ value: location.id, label: `${location.name} — ${location.country}` }));
  const visits = sortedVisits(data).map(visit => ({ value: visit.id, label: `${visit.order}. ${getLocation(visit.location_id, data)?.name || visit.id} (${visit.start_date})` }));
  const modes = Object.keys(MODE_STYLES).map(mode => ({ value: mode, label: mode }));
  el('event-id').value = event.id;
  el('event-title').value = event.title;
  el('event-category').value = event.category;
  el('event-confidence').value = event.confidence;
  el('event-start').value = event.start;
  el('event-end').value = event.end;
  refreshSelectOptions(el('event-visit'), visits, event.visit_id);
  refreshSelectOptions(el('event-location'), locations, event.location_id);
  refreshSelectOptions(el('event-from'), locations, event.from_location_id, true);
  refreshSelectOptions(el('event-to'), locations, event.to_location_id, true);
  refreshSelectOptions(el('event-mode'), modes, event.transport_mode, true);
  el('event-locked').checked = Boolean(event.locked);
  el('event-notes').value = event.notes || '';
}

function applyEventForm(eventObject = null) {
  const data = state.draft;
  const id = el('event-id').value;
  const event = eventObject || data.events.find(item => item.id === id);
  if (!event) return;
  const start = el('event-start').value;
  const end = el('event-end').value;
  if (!start || !end || parseFloating(end) <= parseFloating(start)) {
    toast('The end time must be later than the start time.', 'error');
    return;
  }
  Object.assign(event, {
    title: el('event-title').value.trim(),
    category: el('event-category').value,
    confidence: el('event-confidence').value,
    start,
    end,
    visit_id: el('event-visit').value,
    location_id: el('event-location').value,
    from_location_id: el('event-from').value,
    to_location_id: el('event-to').value,
    transport_mode: el('event-mode').value,
    locked: el('event-locked').checked,
    notes: el('event-notes').value.trim(),
  });
  markDirty(`Event changed: ${event.title}`);
  state.selectedEventId = event.id;
  state.mapBuiltForSignature = '';
  renderEventEditor();
}

function addEvent() {
  const data = state.draft;
  const day = getDay(state.selectedDate, data) || data.days[0];
  const event = {
    id: generateId('evt'), title: 'New event', category: 'Activity',
    start: `${day.date}T09:00`, end: `${day.date}T10:00`, visit_id: day.visit_id, location_id: day.location_id,
    from_location_id: '', to_location_id: '', transport_mode: '', confidence: day.confidence,
    notes: '', day_summaries: [day.summary], source_dates: [day.date], locked: false,
  };
  data.events.push(event);
  state.editEventId = event.id;
  markDirty('New event added');
  renderEventEditor();
}

function duplicateEvent() {
  const source = state.draft.events.find(item => item.id === state.editEventId);
  if (!source) return;
  const copy = deepClone(source);
  copy.id = generateId('evt');
  copy.title = `${copy.title} copy`;
  state.draft.events.push(copy);
  state.editEventId = copy.id;
  markDirty('Event duplicated');
  renderEventEditor();
}

function deleteEvent() {
  const event = state.draft.events.find(item => item.id === state.editEventId);
  if (!event || !confirm(`Delete “${event.title}”? This remains reversible until the main Save button is pressed.`)) return;
  state.draft.events = state.draft.events.filter(item => item.id !== event.id);
  state.editEventId = null;
  if (state.selectedEventId === event.id) state.selectedEventId = null;
  markDirty('Event deleted from draft');
  renderEverything();
}

function renderRouteEditor() {
  const data = state.draft;
  const visits = sortedVisits(data);
  if (!state.editVisitId || !visits.some(visit => visit.id === state.editVisitId)) state.editVisitId = visits[0]?.id;
  el('route-editor-list').innerHTML = visits.map((visit, index) => {
    const location = getLocation(visit.location_id, data);
    return `<div class="route-editor-row ${visit.id === state.editVisitId ? 'active' : ''}" data-visit-id="${escapeHtml(visit.id)}"><button class="route-editor-seq visit-select" title="Edit this stop">${index + 1}</button><button class="route-editor-main visit-select"><strong>${escapeHtml(location?.name || visit.location_id)}</strong><small>${visit.start_date} to ${visit.end_date} · ${visitDurationDays(visit)} day(s)</small></button><div class="route-move-buttons"><button class="secondary-button small move-up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="secondary-button small move-down" ${index === visits.length - 1 ? 'disabled' : ''}>↓</button></div></div>`;
  }).join('');
  el('route-editor-list').querySelectorAll('.route-editor-row').forEach(row => {
    row.querySelectorAll('.visit-select').forEach(button => button.addEventListener('click', () => { state.editVisitId = row.dataset.visitId; renderRouteEditor(); }));
    row.querySelector('.move-up').addEventListener('click', () => moveVisit(row.dataset.visitId, -1));
    row.querySelector('.move-down').addEventListener('click', () => moveVisit(row.dataset.visitId, 1));
  });
  renderVisitEditor();
  renderDayEditor();
}

function renderVisitEditor() {
  const data = state.draft;
  const visit = getVisit(state.editVisitId, data);
  if (!visit) { el('visit-editor').innerHTML = '<p>Select a route block.</p>'; return; }
  const locationOptions = Object.values(data.locations).sort((a, b) => a.name.localeCompare(b.name)).map(location => `<option value="${escapeHtml(location.id)}" ${location.id === visit.location_id ? 'selected' : ''}>${escapeHtml(location.name)} — ${escapeHtml(location.country)}</option>`).join('');
  const modeOptions = Object.keys(MODE_STYLES).map(mode => `<option ${mode === visit.arrival_mode ? 'selected' : ''}>${mode}</option>`).join('');
  el('visit-editor').innerHTML = `<div class="section-heading"><div><h2>Visit ${visit.order}: ${escapeHtml(getLocation(visit.location_id, data)?.name || visit.location_id)}</h2><p>${visit.start_date} to ${visit.end_date} · ${visitDurationDays(visit)} day(s)</p></div><div class="toolbar-group"><button id="visit-minus-day" class="secondary-button small">− 1 day</button><button id="visit-plus-day" class="secondary-button small">+ 1 day</button></div></div>
    <form id="visit-form" class="form-grid">
      <label class="span-2">Location<select id="visit-location">${locationOptions}</select></label>
      <label>Arrival mode<select id="visit-mode">${modeOptions}</select></label>
      <label>Estimated arrival hours<input id="visit-hours" type="number" min="0" step="0.1" value="${Number(visit.arrival_hours_estimate || 0)}"></label>
      <label class="span-2">Arrival summary<input id="visit-summary" value="${escapeHtml(visit.arrival_summary || '')}"></label>
      <label class="span-2">Notes<textarea id="visit-notes" rows="4">${escapeHtml(visit.notes || '')}</textarea></label>
      <div class="form-actions span-2"><button class="primary-button" type="submit">Apply visit changes</button></div>
    </form>`;
  el('visit-form').addEventListener('submit', event => {
    event.preventDefault();
    const oldLocation = visit.location_id;
    const newLocation = el('visit-location').value;
    visit.location_id = newLocation;
    visit.arrival_mode = el('visit-mode').value;
    visit.arrival_hours_estimate = Number(el('visit-hours').value || 0);
    visit.arrival_summary = el('visit-summary').value.trim();
    visit.notes = el('visit-notes').value.trim();
    if (oldLocation !== newLocation) {
      const location = getLocation(newLocation, data);
      data.days.filter(day => day.visit_id === visit.id).forEach(day => {
        day.location_id = newLocation; day.base = location.name; day.country = location.country;
      });
      data.events.filter(item => item.visit_id === visit.id).forEach(item => {
        item.location_id = newLocation;
        if (item.to_location_id === oldLocation || item.to_location_id === '') item.to_location_id = newLocation;
      });
    }
    markDirty('Visit details changed');
    state.mapBuiltForSignature = '';
    renderEverything();
  });
  el('visit-plus-day').addEventListener('click', () => adjustVisitDuration(visit.id, 1));
  el('visit-minus-day').addEventListener('click', () => adjustVisitDuration(visit.id, -1));
}

function moveVisit(visitId, delta) {
  const visits = sortedVisits(state.draft);
  const index = visits.findIndex(visit => visit.id === visitId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= visits.length) return;
  [visits[index], visits[target]] = [visits[target], visits[index]];
  visits.forEach((visit, order) => { visit.order = order + 1; });
  state.draft.visits = visits;
  state.routeNeedsReflow = true;
  markDirty('Route order changed — press Reflow dates before saving');
  el('validation-status').textContent = 'Route order changed; dates have not been reflowed yet.';
  el('validation-status').className = 'validation-status invalid';
  renderRouteEditor();
  state.mapBuiltForSignature = '';
  renderMap(true);
}

function reflowRouteDates() {
  const data = state.draft;
  const visits = sortedVisits(data);
  let cursor = data.metadata.start_date;
  let previousLocation = data.metadata.home_location_id;
  for (const visit of visits) {
    const oldStart = visit.start_date;
    const duration = visitDurationDays(visit);
    const delta = daysBetween(oldStart, cursor);
    const oldStayStart = visit.stay_start_date;
    const oldStayEnd = visit.stay_end_date;
    visit.start_date = cursor;
    visit.end_date = addDays(cursor, duration - 1);
    visit.stay_start_date = oldStayStart ? addDays(oldStayStart, delta) : cursor;
    visit.stay_end_date = oldStayEnd ? addDays(oldStayEnd, delta) : visit.end_date;
    data.days.filter(day => day.visit_id === visit.id).forEach(day => { day.date = addDays(day.date, delta); });
    data.events.filter(event => event.visit_id === visit.id).forEach(event => {
      event.start = shiftDateTime(event.start, delta);
      event.end = shiftDateTime(event.end, delta);
    });
    const crossLocationEvents = data.events.filter(event => event.visit_id === visit.id && ['Travel', 'Hike'].includes(event.category) && event.from_location_id !== event.to_location_id).sort((a, b) => parseFloating(a.start) - parseFloating(b.start));
    if (crossLocationEvents[0]) {
      crossLocationEvents[0].from_location_id = previousLocation;
      crossLocationEvents[0].to_location_id = visit.location_id;
      crossLocationEvents[0].transport_mode = visit.arrival_mode;
    }
    previousLocation = visit.location_id;
    cursor = addDays(visit.end_date, 1);
  }
  data.days.sort((a, b) => parseDateKey(a.date) - parseDateKey(b.date));
  data.days.forEach((day, index) => { day.day_number = index + 1; });
  data.metadata.end_date = data.days.at(-1).date;
  state.routeNeedsReflow = false;
  markDirty('Route dates reflowed; review and save when ready');
  el('validation-status').textContent = 'Route dates reflowed successfully.';
  el('validation-status').className = 'validation-status valid';
  state.mapBuiltForSignature = '';
  renderEverything();
}

function shiftLaterVisits(afterOrder, delta) {
  const data = state.draft;
  for (const visit of data.visits) {
    if (Number(visit.order) <= afterOrder) continue;
    visit.start_date = addDays(visit.start_date, delta);
    visit.end_date = addDays(visit.end_date, delta);
    if (visit.stay_start_date) visit.stay_start_date = addDays(visit.stay_start_date, delta);
    if (visit.stay_end_date) visit.stay_end_date = addDays(visit.stay_end_date, delta);
    data.days.filter(day => day.visit_id === visit.id).forEach(day => { day.date = addDays(day.date, delta); });
    data.events.filter(event => event.visit_id === visit.id).forEach(event => { event.start = shiftDateTime(event.start, delta); event.end = shiftDateTime(event.end, delta); });
  }
}

function flexibleEventsForDay(day, location) {
  const specs = [
    ['Sleep', 'Sleep', '00:00', '08:00'], ['Meal', 'Breakfast', '08:00', '09:00'],
    ['Activity', `Flexible time in ${location.name}`, '09:00', '13:00'], ['Meal', 'Lunch', '13:00', '14:00'],
    ['Activity', `Flexible time in ${location.name}`, '14:00', '18:00'], ['Rest', 'Rest', '18:00', '20:00'],
    ['Evening', 'Dinner / relaxed evening', '20:00', '22:00'], ['Sleep', 'Sleep', '22:00', '24:00'],
  ];
  return specs.map(([category, title, start, end]) => ({
    id: generateId('evt'), title, category,
    start: `${day.date}T${start === '24:00' ? '00:00' : start}`,
    end: end === '24:00' ? `${addDays(day.date, 1)}T00:00` : `${day.date}T${end}`,
    visit_id: day.visit_id, location_id: day.location_id, from_location_id: '', to_location_id: '', transport_mode: '',
    confidence: day.confidence, notes: 'Automatically added when the visit was extended.', day_summaries: [day.summary], source_dates: [day.date], locked: false,
  }));
}

function adjustVisitDuration(visitId, delta) {
  const data = state.draft;
  const visit = getVisit(visitId, data);
  if (!visit) return;
  const duration = visitDurationDays(visit);
  if (delta < 0 && duration <= 1) { toast('A visit must contain at least one day.', 'error'); return; }
  if (delta < 0 && !confirm(`Remove the last day of this visit and its events? Later dates will move one day earlier.`)) return;
  const oldEnd = visit.end_date;
  const location = getLocation(visit.location_id, data);
  if (delta > 0) {
    shiftLaterVisits(Number(visit.order), 1);
    visit.end_date = addDays(visit.end_date, 1);
    visit.stay_end_date = visit.end_date;
    const newDay = {
      date: visit.end_date, day_number: 0, visit_id: visit.id, location_id: visit.location_id,
      country: location.country, base: location.name, summary: `Flexible additional day in ${location.name}`,
      notes: 'Added in the website route editor.', confidence: 'High', is_physical_location_day: true,
    };
    data.days.push(newDay);
    data.events.push(...flexibleEventsForDay(newDay, location));
  } else {
    const removeStart = parseDateKey(oldEnd);
    const removeEnd = removeStart + DAY_MS;
    data.days = data.days.filter(day => !(day.visit_id === visit.id && day.date === oldEnd));
    const retained = [];
    for (const event of data.events) {
      if (event.visit_id !== visit.id) { retained.push(event); continue; }
      const start = parseFloating(event.start);
      const end = parseFloating(event.end);
      if (start >= removeStart && end <= removeEnd) continue;
      if (start < removeStart && end > removeStart && end <= removeEnd) { event.end = formatFloating(removeStart); retained.push(event); continue; }
      if (start < removeStart && end > removeEnd) { event.end = formatFloating(end - DAY_MS); retained.push(event); continue; }
      retained.push(event);
    }
    data.events = retained;
    visit.end_date = addDays(visit.end_date, -1);
    if (visit.stay_end_date > visit.end_date) visit.stay_end_date = visit.end_date;
    shiftLaterVisits(Number(visit.order), -1);
  }
  data.days.sort((a, b) => parseDateKey(a.date) - parseDateKey(b.date));
  data.days.forEach((day, index) => { day.day_number = index + 1; });
  data.metadata.end_date = data.days.at(-1).date;
  markDirty(delta > 0 ? 'Visit extended by one day' : 'Visit shortened by one day');
  state.mapBuiltForSignature = '';
  renderEverything();
}

function renderDayEditor() {
  const data = state.draft;
  if (!getDay(state.editDayDate, data)) state.editDayDate = data.metadata.start_date;
  const day = getDay(state.editDayDate, data);
  el('edit-day-date').value = state.editDayDate;
  el('day-base').value = day.base;
  el('day-country').value = day.country;
  el('day-confidence').value = day.confidence;
  el('day-physical').checked = Boolean(day.is_physical_location_day);
  el('day-summary').value = day.summary;
  el('day-notes').value = day.notes || '';
}

function renderLocationEditor() {
  const data = state.draft;
  const query = el('location-search').value.trim().toLowerCase();
  const locations = Object.values(data.locations).sort((a, b) => a.name.localeCompare(b.name)).filter(location => !query || `${location.name} ${location.country} ${location.id}`.toLowerCase().includes(query));
  el('location-list').innerHTML = locations.map(location => `<button class="editor-list-item ${location.id === state.editLocationId ? 'active' : ''}" data-location-id="${escapeHtml(location.id)}"><strong>${escapeHtml(location.name)}</strong><small>${escapeHtml(location.country)} · ${escapeHtml(location.id)}</small></button>`).join('');
  el('location-list').querySelectorAll('.editor-list-item').forEach(item => item.addEventListener('click', () => { state.editLocationId = item.dataset.locationId; renderLocationEditor(); }));
  const location = data.locations[state.editLocationId];
  el('location-form-empty').classList.toggle('hidden', Boolean(location));
  el('location-form').classList.toggle('hidden', !location);
  if (!location) return;
  el('location-id').value = location.id;
  el('location-id').readOnly = !location._new;
  el('location-name').value = location.name;
  el('location-country').value = location.country;
  el('location-timezone').value = location.timezone || '';
  el('location-latitude').value = location.latitude;
  el('location-longitude').value = location.longitude;
  el('location-notes').value = location.notes || '';
}

function addLocation() {
  let base = 'new_location';
  let id = base;
  let counter = 2;
  while (state.draft.locations[id]) id = `${base}_${counter++}`;
  state.draft.locations[id] = { id, name: 'New location', country: '', latitude: 0, longitude: 0, timezone: '', notes: '', _new: true };
  state.editLocationId = id;
  markDirty('New location added');
  renderLocationEditor();
}

function deleteLocation() {
  const id = state.editLocationId;
  const data = state.draft;
  const referenced = data.visits.some(visit => visit.location_id === id) || data.days.some(day => day.location_id === id) || data.events.some(event => [event.location_id, event.from_location_id, event.to_location_id].includes(id));
  if (referenced) { toast('This location is still referenced by the route, a day or an event.', 'error'); return; }
  if (!confirm(`Delete location “${data.locations[id]?.name}”?`)) return;
  delete data.locations[id];
  state.editLocationId = Object.keys(data.locations)[0] || null;
  markDirty('Location deleted');
  renderLocationEditor();
}

async function validateDraft(showDialog = true) {
  const result = await apiJson('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itinerary: state.draft }) });
  el('validation-status').textContent = result.valid ? `Valid${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}` : `${result.errors.length} validation error(s)`;
  el('validation-status').className = `validation-status ${result.valid ? 'valid' : 'invalid'}`;
  if (showDialog) showValidationDialog(result);
  return result;
}

function showValidationDialog(result) {
  const errors = result.errors?.length ? `<h3 class="validation-errors">Errors</h3><ul class="validation-list validation-errors">${result.errors.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="validation-errors">No errors.</p>';
  const warnings = result.warnings?.length ? `<h3 class="validation-warnings">Warnings</h3><ul class="validation-list validation-warnings">${result.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>No warnings.</p>';
  el('validation-dialog-content').innerHTML = errors + warnings;
  el('validation-dialog').showModal();
}

async function saveDraft() {
  if (state.routeNeedsReflow) { toast('Press Reflow dates before saving the reordered route.', 'error'); switchEditTab('route'); return; }
  const validation = await validateDraft(false);
  if (!validation.valid) { showValidationDialog(validation); return; }
  const token = el('edit-token').value;
  if (state.editTokenRequired) writeSessionValue('itinerary_edit_token', token);
  setSaveStatus('Saving');
  try {
    const result = await apiJson('/api/itinerary', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Itinerary-Token': token } : {}) },
      body: JSON.stringify({ expected_revision: state.revision, itinerary: state.draft }),
    });
    state.revision = result.revision;
    state.saved = deepClone(state.draft);
    markClean();
    renderEverything();
    toast('Itinerary saved. A server-side backup was also created.', 'success');
  } catch (error) {
    setSaveStatus('Save failed', 'error');
    if (error.status === 409) toast('The file changed elsewhere. Reload before trying again.', 'error', 6000);
    else toast(error.message, 'error', 6000);
  }
}

function cancelDraft() {
  if (state.dirty && !confirm('Discard every unsaved change in this edit session?')) return;
  state.draft = deepClone(state.saved);
  state.editEventId = null;
  state.selectedEventId = null;
  state.mapBuiltForSignature = '';
  markClean();
  renderEverything();
  toast('Unsaved changes discarded.', 'info');
}

function downloadDraft() {
  const blob = new Blob([JSON.stringify(state.draft, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'itinerary.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

async function uploadDraft(file) {
  if (!file) return;
  try {
    const uploaded = JSON.parse(await file.text());
    const result = await apiJson('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itinerary: uploaded }) });
    if (!result.valid) { showValidationDialog(result); toast('The uploaded file was not applied because validation failed.', 'error'); return; }
    state.draft = uploaded;
    state.editEventId = null;
    state.editVisitId = sortedVisits(uploaded)[0]?.id || null;
    state.editLocationId = Object.keys(uploaded.locations)[0] || null;
    state.selectedDate = uploaded.metadata.start_date;
    state.editDayDate = uploaded.metadata.start_date;
    state.mapBuiltForSignature = '';
    markDirty(`Uploaded ${file.name}; press Save to write it to the server`);
    renderEverything();
    if (result.warnings.length) showValidationDialog(result);
    toast('Uploaded file loaded into the draft. The saved file is unchanged.', 'success', 5500);
  } catch (error) {
    toast(`Could not upload the file: ${error.message}`, 'error', 6000);
  } finally {
    el('upload-input').value = '';
  }
}

/* ---------------- Event bindings ---------------- */
function bindEvents() {
  document.querySelectorAll('.tab-button').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  document.querySelectorAll('.edit-subtab').forEach(button => button.addEventListener('click', () => switchEditTab(button.dataset.editTab)));
  el('reload-button').addEventListener('click', () => { if (!state.dirty || confirm('Discard unsaved changes and reload from disk?')) loadItinerary(true).catch(handleFatal); });
  el('day-date').addEventListener('change', event => jumpToDate(event.target.value));
  el('day-prev').addEventListener('click', () => jumpToDate(addDays(state.selectedDate, -1)));
  el('day-next').addEventListener('click', () => jumpToDate(addDays(state.selectedDate, 1)));
  el('today-start-button').addEventListener('click', () => jumpToDate(currentData().metadata.start_date));
  el('day-search').addEventListener('input', renderDayView);
  el('category-filter').addEventListener('change', renderDayView);
  el('compact-days').addEventListener('change', renderDayView);

  el('map-slider').addEventListener('input', event => updateMapDay(Number(event.target.value)));
  el('map-prev').addEventListener('click', () => { el('map-slider').value = Math.max(1, Number(el('map-slider').value) - 1); updateMapDay(Number(el('map-slider').value)); });
  el('map-next').addEventListener('click', () => { el('map-slider').value = Math.min(currentData().days.length, Number(el('map-slider').value) + 1); updateMapDay(Number(el('map-slider').value)); });
  el('map-play').addEventListener('click', () => {
    state.mapPlaying = !state.mapPlaying;
    el('map-play').textContent = state.mapPlaying ? '❚❚ Pause' : '▶ Play';
    if (state.mapPlaying) state.mapTimer = setInterval(() => { let next = Number(el('map-slider').value) + 1; if (next > currentData().days.length) next = 1; el('map-slider').value = next; updateMapDay(next); }, 340);
    else clearInterval(state.mapTimer);
  });
  el('map-fit').addEventListener('click', fitMapToRoute);
  el('map-reset').addEventListener('click', () => { state.mapView = { ...state.mapOriginalView }; updateMapViewBox(); });
  const svg = el('route-map');
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    const scale = event.deltaY > 0 ? 1.14 : .86;
    const rect = svg.getBoundingClientRect();
    const v = state.mapView;
    const mx = v.x + (event.clientX - rect.left) / rect.width * v.w;
    const my = v.y + (event.clientY - rect.top) / rect.height * v.h;
    const newW = Math.min(MAP_WIDTH * 2.2, Math.max(90, v.w * scale));
    const newH = newW * MAP_HEIGHT / MAP_WIDTH;
    state.mapView = { x: mx - (mx - v.x) * newW / v.w, y: my - (my - v.y) * newH / v.h, w: newW, h: newH };
    updateMapViewBox();
  }, { passive: false });
  svg.addEventListener('pointerdown', event => { state.mapDrag = { x: event.clientX, y: event.clientY, viewX: state.mapView.x, viewY: state.mapView.y }; svg.classList.add('dragging'); svg.setPointerCapture(event.pointerId); });
  svg.addEventListener('pointermove', event => { if (!state.mapDrag) return; const rect = svg.getBoundingClientRect(); state.mapView.x = state.mapDrag.viewX - (event.clientX - state.mapDrag.x) / rect.width * state.mapView.w; state.mapView.y = state.mapDrag.viewY - (event.clientY - state.mapDrag.y) / rect.height * state.mapView.h; updateMapViewBox(); });
  const endDrag = () => { state.mapDrag = null; svg.classList.remove('dragging'); };
  svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);

  el('event-search').addEventListener('input', renderEventEditor);
  el('add-event').addEventListener('click', addEvent);
  el('event-form').addEventListener('submit', event => { event.preventDefault(); applyEventForm(); });
  el('duplicate-event').addEventListener('click', duplicateEvent);
  el('delete-event').addEventListener('click', deleteEvent);
  el('reflow-route').addEventListener('click', reflowRouteDates);
  el('edit-day-date').addEventListener('change', event => { state.editDayDate = event.target.value; renderDayEditor(); });
  el('edit-day-prev').addEventListener('click', () => { const candidate = addDays(state.editDayDate, -1); if (getDay(candidate, state.draft)) { state.editDayDate = candidate; renderDayEditor(); } });
  el('edit-day-next').addEventListener('click', () => { const candidate = addDays(state.editDayDate, 1); if (getDay(candidate, state.draft)) { state.editDayDate = candidate; renderDayEditor(); } });
  el('day-form').addEventListener('submit', event => {
    event.preventDefault();
    const day = getDay(state.editDayDate, state.draft);
    day.base = el('day-base').value.trim(); day.country = el('day-country').value.trim(); day.confidence = el('day-confidence').value;
    day.is_physical_location_day = el('day-physical').checked; day.summary = el('day-summary').value.trim(); day.notes = el('day-notes').value.trim();
    markDirty(`Day changed: ${day.date}`); renderDayView(); renderRouteEditor();
  });
  el('location-search').addEventListener('input', renderLocationEditor);
  el('add-location').addEventListener('click', addLocation);
  el('location-form').addEventListener('submit', event => {
    event.preventDefault();
    const currentId = state.editLocationId;
    const location = state.draft.locations[currentId];
    let newId = el('location-id').value.trim();
    if (location._new) {
      newId = slugify(newId);
      if (newId !== currentId && state.draft.locations[newId]) { toast('That location ID already exists.', 'error'); return; }
      if (newId !== currentId) { delete state.draft.locations[currentId]; location.id = newId; state.draft.locations[newId] = location; state.editLocationId = newId; }
      delete location._new;
    }
    location.name = el('location-name').value.trim(); location.country = el('location-country').value.trim();
    location.timezone = el('location-timezone').value.trim(); location.latitude = Number(el('location-latitude').value); location.longitude = Number(el('location-longitude').value); location.notes = el('location-notes').value.trim();
    markDirty(`Location changed: ${location.name}`); state.mapBuiltForSignature = ''; renderEverything(); switchEditTab('locations');
  });
  el('delete-location').addEventListener('click', deleteLocation);
  el('save-button').addEventListener('click', () => saveDraft().catch(error => toast(error.message, 'error')));
  el('cancel-button').addEventListener('click', cancelDraft);
  el('validate-button').addEventListener('click', () => validateDraft(true).catch(error => toast(error.message, 'error')));
  el('download-button').addEventListener('click', downloadDraft);
  el('upload-input').addEventListener('change', event => uploadDraft(event.target.files[0]));
  el('edit-token').addEventListener('input', event => writeSessionValue('itinerary_edit_token', event.target.value));
}

function handleFatal(error) {
  console.error(error);
  setSaveStatus('Load failed', 'error');
  document.querySelector('.main-area').innerHTML = `<div class="editor-empty"><h2>Could not load the itinerary</h2><p>${escapeHtml(error.message)}</p></div>`;
}

bindEvents();
loadItinerary().catch(handleFatal);
