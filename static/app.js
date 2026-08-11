import { loadMapConfig } from './map-config.js?v=map-marker-anchor-1';
import { buildTripMapModel, routeForDay } from './map-data.js?v=map-marker-anchor-1';
import { TripMap } from './map-view.js?v=map-marker-anchor-1';
import { calculateBudget, decimalCompare, formatMoney, itemExpected, visitQuantity } from './budget.js?v=budget-v5';
import { deriveBookingAction, groupBookings } from './booking.js?v=booking-v1';
import { semanticDiff } from './import-diff.js?v=import-v1';

'use strict';

const DAY_MS = 86_400_000;
const SAFE_COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;
const TRANSPORT_MODES = ['Flight', 'Road / bus', 'Ferry / boat', 'Train', 'Trek / walk', 'Mixed', 'Local transfer'];

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
  mapController: null,
  mapInitialising: null,
  mapModel: null,
  pendingMapFocus: null,
  mapExpanded: false,
  budgetCategoryFilter: '',
  budgetSearch: '',
  costDialogItem: null,
  bookingStatusFilter: 'actionable',
  bookingTypeFilter: '',
  bookingDialogItem: null,
  importPreview: null,
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
function colourForCategory(category, data = currentData()) {
  const colour = data?.metadata?.category_colours?.[category];
  return SAFE_COLOUR_RE.test(colour || '') ? colour : '#9BA8B1';
}

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
  if (payload.migrations?.length) {
    toast(`Loaded and migrated ${payload.migrations.join(', ')} in memory. Save to persist schema v${payload.itinerary.schema_version}.`, 'info', 7000);
  }
  if (showToast) toast('Reloaded the saved itinerary.', 'success');
}

function renderEverything() {
  populateCategoryControls();
  if (state.activeTab === 'day') {
    renderDayView();
    renderEventDetails();
  } else if (state.activeTab === 'map') {
    renderMap(true);
  } else if (state.activeTab === 'budget') {
    renderBudget();
  } else if (state.activeTab === 'bookings') {
    renderBookings();
  } else if (state.activeTab === 'handoff') {
    renderHandoff();
  } else if (state.activeTab === 'edit') {
    renderEditView();
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.view-panel').forEach(panel => panel.classList.toggle('active', panel.id === `view-${tab}`));
  window.scrollTo(0, 0);
  if (tab === 'day') { renderDayView(); renderEventDetails(); }
  if (tab === 'map') renderMap(false);
  if (tab === 'budget') renderBudget();
  if (tab === 'bookings') renderBookings();
  if (tab === 'handoff') renderHandoff();
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
      return `<button class="event-piece ${contrastClass(colour)} ${selected ? 'selected' : ''} ${event.locked ? 'locked' : ''}" data-event-id="${escapeHtml(event.id)}" style="left:${left}%;width:${width}%;top:${6 + piece.lane * 28}px" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
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
  el('day-list').querySelectorAll('.event-piece').forEach(piece => {
    const event = data.events.find(item => item.id === piece.dataset.eventId);
    piece.style.backgroundColor = colourForCategory(event?.category, data);
  });
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
    <span class="details-category ${contrastClass(colourForCategory(event.category, data))}">${escapeHtml(event.category)}</span>
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
    <div class="details-section details-actions">
      <button id="details-edit-event" class="primary-button">Edit this event</button>
      ${(from && to && from.id !== to.id) ? '<button id="details-show-map" class="secondary-button">Show route on map</button>' : ''}
    </div>
  </div>`;
  panel.querySelector('.details-category').style.backgroundColor = colourForCategory(event.category, data);
  el('details-edit-event').addEventListener('click', () => {
    state.editEventId = event.id;
    switchTab('edit');
    switchEditTab('events');
    renderEventEditor();
  });
  el('details-show-map')?.addEventListener('click', () => {
    state.selectedDate = event.start.slice(0, 10);
    state.pendingMapFocus = { type: 'route', id: event.id };
    switchTab('map');
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
function appendMapDetail(parent, label, value) {
  const box = document.createElement('div');
  box.className = 'detail-box';
  const caption = document.createElement('small');
  caption.textContent = label;
  const content = document.createElement('strong');
  content.textContent = String(value ?? '—');
  box.append(caption, content);
  parent.append(box);
}

function mapHeading(title, subtitle, description = '') {
  const fragment = document.createDocumentFragment();
  const heading = document.createElement('h2');
  heading.textContent = title;
  const date = document.createElement('div');
  date.className = 'map-date';
  date.textContent = subtitle;
  fragment.append(heading, date);
  if (description) {
    const paragraph = document.createElement('p');
    paragraph.textContent = description;
    fragment.append(paragraph);
  }
  return fragment;
}

function renderMapRouteList(model) {
  const list = el('map-route-list');
  list.replaceChildren();
  for (const visit of model.visits) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'map-route-row';
    row.dataset.visitId = visit.id;
    const number = document.createElement('span');
    number.className = 'map-route-number';
    number.textContent = visit.order;
    const main = document.createElement('span');
    main.className = 'map-route-main';
    const name = document.createElement('strong');
    name.textContent = visit.name;
    const dates = document.createElement('small');
    dates.textContent = visit.startDate === visit.endDate ? visit.startDate : `${visit.startDate} to ${visit.endDate}`;
    main.append(name, dates);
    const meta = document.createElement('span');
    meta.className = 'map-route-mode';
    meta.textContent = visit.country;
    if (visit.duplicateTotal > 1) {
      const repeat = document.createElement('strong');
      repeat.textContent = `Visit ${visit.duplicateIndex + 1}/${visit.duplicateTotal}`;
      meta.append(repeat);
    }
    row.append(number, main, meta);
    row.addEventListener('click', () => {
      selectMapVisit(visit);
      state.mapController?.focusVisit(visit.id);
    });
    list.append(row);
  }
}

function renderMapDayCard(day, route) {
  const data = currentData();
  const location = getLocation(day.location_id, data);
  const panel = el('map-day-card');
  panel.replaceChildren(mapHeading(location.name, `${humanDate(day.date)} · Day ${day.day_number}`, day.summary));
  const grid = document.createElement('div');
  grid.className = 'map-meta-grid';
  appendMapDetail(grid, 'Base', day.base);
  appendMapDetail(grid, 'Status', route ? 'Travelling / arriving' : 'At location');
  appendMapDetail(grid, 'Travel', route?.mode || '—');
  appendMapDetail(grid, 'Route geometry', route ? 'Schematic / approximate' : 'No major transfer');
  panel.append(grid);
  const actions = document.createElement('div');
  actions.className = 'map-card-actions';
  const focus = document.createElement('button');
  focus.type = 'button';
  focus.className = 'secondary-button';
  focus.textContent = 'Focus this day';
  focus.addEventListener('click', () => route ? state.mapController?.focusRoute(route.id) : state.mapController?.focusVisit(day.visit_id));
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'secondary-button';
  open.textContent = 'Open day bars';
  open.addEventListener('click', () => { switchTab('day'); jumpToDate(day.date); });
  actions.append(focus, open);
  panel.append(actions);
}

function renderMapVisitCard(visit) {
  const panel = el('map-day-card');
  panel.replaceChildren(mapHeading(`${visit.order}. ${visit.name}`, `${visit.country} · ${visit.startDate} to ${visit.endDate}`, visit.notes));
  const grid = document.createElement('div');
  grid.className = 'map-meta-grid';
  appendMapDetail(grid, 'Stay', visit.nights === null ? '—' : `${visit.nights} night${visit.nights === 1 ? '' : 's'}`);
  appendMapDetail(grid, 'Plans', `${visit.eventCount} event${visit.eventCount === 1 ? '' : 's'}`);
  appendMapDetail(grid, 'Bookings', visit.bookingCount);
  appendMapDetail(grid, 'Accommodation', visit.accommodation.join(', ') || 'Not linked');
  panel.append(grid);
  if (visit.duplicateTotal > 1) {
    const repeat = document.createElement('p');
    repeat.className = 'map-context-note';
    repeat.textContent = `This is visit ${visit.duplicateIndex + 1} of ${visit.duplicateTotal} at the same location.`;
    panel.append(repeat);
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'secondary-button map-open-button';
  open.textContent = 'Open first day of visit';
  open.addEventListener('click', () => { switchTab('day'); jumpToDate(visit.startDate); });
  panel.append(open);
}

function renderMapRouteCard(route) {
  const panel = el('map-day-card');
  panel.replaceChildren(mapHeading(route.title, `${route.fromName} → ${route.toName}`, route.notes));
  const grid = document.createElement('div');
  grid.className = 'map-meta-grid';
  appendMapDetail(grid, 'Mode', route.mode);
  appendMapDetail(grid, 'Geometry', 'Schematic / approximate');
  appendMapDetail(grid, 'Departure', route.start?.replace('T', ' ') || 'Not scheduled');
  appendMapDetail(grid, 'Arrival', route.end?.replace('T', ' ') || 'Not scheduled');
  panel.append(grid);
  const note = document.createElement('p');
  note.className = 'map-context-note';
  note.textContent = 'The dashed line connects known endpoints; it is not the actual road, rail, air, or walking alignment.';
  panel.append(note);
  if (route.eventId) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'secondary-button map-open-button';
    open.textContent = 'Open travel event';
    open.addEventListener('click', () => {
      const event = currentData().events.find(item => item.id === route.eventId);
      if (!event) return;
      state.selectedDate = event.start.slice(0, 10);
      state.selectedEventId = event.id;
      switchTab('day');
      selectEvent(event.id, true);
    });
    panel.append(open);
  }
}

function selectMapVisit(visit) {
  const data = currentData();
  const dayIndex = data.days.findIndex(day => day.visit_id === visit.id);
  if (dayIndex >= 0) {
    updateMapDay(dayIndex + 1);
  }
  state.mapController?.setSelection({ visitId: visit.id, routeId: null });
  renderMapVisitCard(visit);
  document.querySelectorAll('.map-route-row').forEach(row => row.classList.toggle('active', row.dataset.visitId === visit.id));
}

function selectMapRoute(route) {
  if (route.start) state.selectedDate = route.start.slice(0, 10);
  const dayIndex = currentData().days.findIndex(day => day.date === state.selectedDate);
  if (dayIndex >= 0) updateMapDay(dayIndex + 1);
  state.mapController?.setSelection({ visitId: route.visitId, routeId: route.id });
  renderMapRouteCard(route);
}

async function ensureTripMap() {
  if (state.mapController) return state.mapController;
  if (state.mapInitialising) return state.mapInitialising;
  state.mapInitialising = (async () => {
    const config = await loadMapConfig();
    state.mapController = new TripMap({
      container: el('trip-map'),
      statusElement: el('map-status'),
      config,
      onVisitSelect: selectMapVisit,
      onRouteSelect: selectMapRoute,
      onSecondarySelect: location => {
        const panel = el('map-day-card');
        panel.replaceChildren(mapHeading(location.name, `${location.country} · Secondary itinerary location`, 'Referenced by an event but not used as a primary visit destination.'));
      },
    });
    return state.mapController;
  })();
  try {
    return await state.mapInitialising;
  } finally {
    state.mapInitialising = null;
  }
}

async function renderMap() {
  const data = currentData();
  if (!data) return;
  state.mapModel = buildTripMapModel(data);
  renderMapRouteList(state.mapModel);
  const slider = el('map-slider');
  slider.max = Math.max(1, data.days.length);
  const selectedIndex = data.days.findIndex(day => day.date === state.selectedDate);
  slider.value = selectedIndex >= 0 ? selectedIndex + 1 : Math.min(Number(slider.value) || 1, data.days.length);
  try {
    const controller = await ensureTripMap();
    controller.updateModel(state.mapModel);
    updateMapDay(Number(slider.value));
    requestAnimationFrame(() => controller.resize());
    const pending = state.pendingMapFocus;
    state.pendingMapFocus = null;
    if (pending?.type === 'route') controller.focusRoute(pending.id);
    if (pending?.type === 'visit') controller.focusVisit(pending.id);
  } catch {
    el('map-status').hidden = false;
    el('map-status').className = 'map-status error';
    el('map-status').textContent = 'The interactive map could not start. The itinerary and route list remain available.';
  }
}

function updateMapDay(dayNumber) {
  const data = currentData();
  if (!data?.days?.length) return;
  const index = Math.max(0, Math.min(data.days.length - 1, dayNumber - 1));
  const day = data.days[index];
  const visit = getVisit(day.visit_id, data);
  const route = routeForDay(state.mapModel || buildTripMapModel(data), data, day);
  state.selectedDate = day.date;
  el('map-slider').value = index + 1;
  el('map-slider-label').textContent = `Day ${day.day_number} · ${humanDate(day.date, { year: false })}`;
  renderMapDayCard(day, route);
  state.mapController?.setSelection({ visitId: visit.id, routeId: route?.id || null });
  document.querySelectorAll('.map-route-row').forEach(row => row.classList.toggle('active', row.dataset.visitId === visit.id));
  if (window.matchMedia('(min-width: 1051px)').matches) {
    document.querySelector('.map-route-row.active')?.scrollIntoView({ block: 'nearest' });
  }
}

function toggleMapExpanded(force = !state.mapExpanded) {
  state.mapExpanded = Boolean(force);
  document.body.classList.toggle('map-expanded-open', state.mapExpanded);
  el('view-map').classList.toggle('map-expanded', state.mapExpanded);
  el('map-expand').textContent = state.mapExpanded ? 'Close expanded map' : 'Expand map';
  el('map-expand').setAttribute('aria-pressed', String(state.mapExpanded));
  requestAnimationFrame(() => state.mapController?.resize());
}

/* ---------------- Budget ---------------- */
function budgetReference(item, data) {
  if (item.visit_id) {
    const visit = getVisit(item.visit_id, data); const location = visit && getLocation(visit.location_id, data);
    return visit ? `${location?.name || visit.location_id} · Visit ${visit.order}` : item.visit_id;
  }
  if (item.location_id) return getLocation(item.location_id, data)?.name || item.location_id;
  return 'Whole trip';
}

function budgetBarWidth(value, maximum) {
  if (!maximum || decimalCompare(maximum, '0') <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(value) / Number(maximum)) * 100));
}

function budgetRow(row, currency, kind) {
  const incomplete = row.incomplete ? ' · FX needed' : '';
  return `<button class="budget-breakdown-row" data-budget-filter-kind="${kind}" data-budget-filter-id="${escapeHtml(row.id)}"><span><strong>${escapeHtml(row.label)}</strong><small>${row.items.length} item${row.items.length === 1 ? '' : 's'}${incomplete}</small></span><span class="amount">${formatMoney(row.expected, currency)}</span></button>`;
}

function renderBudget() {
  const data = currentData(); if (!data?.budget) return;
  const summary = calculateBudget(data); const { totals, baseCurrency } = summary;
  el('budget-toolbar-note').textContent = `Reporting in ${baseCurrency}`;
  const completeNote = totals.complete ? 'All items have a stored rate.' : `${totals.missingFx.length} item${totals.missingFx.length === 1 ? '' : 's'} need FX.`;
  const headroom = totals.headroom === null ? 'Needs FX' : formatMoney(totals.headroom, baseCurrency);
  const cards = [
    ['Trip budget', formatMoney(summary.totalBudget, baseCurrency), completeNote, 'emphasis'],
    ['Expected total', formatMoney(totals.expected, baseCurrency), totals.complete ? 'Current estimate' : 'Partial — FX missing', ''],
    ['Committed', formatMoney(totals.committed, baseCurrency), 'Reservations and obligations', ''],
    ['Paid / spent', formatMoney(totals.paid, baseCurrency), 'Payments less refunds', ''],
    ['Expected still to spend', formatMoney(totals.expectedStillToSpend, baseCurrency), 'Expected less paid', ''],
    ['Expected, not committed', formatMoney(totals.expectedUncommitted, baseCurrency), 'Flexible estimate', ''],
    ['Committed, not paid', formatMoney(totals.committedUnpaid, baseCurrency), 'Balances still due', ''],
    ['Budget headroom', headroom, totals.headroom !== null && decimalCompare(totals.headroom, '0') < 0 ? 'Over budget' : 'Budget less expected', 'emphasis'],
  ].map(([label, value, note, className]) => `<article class="budget-card ${className}"><small>${label}</small><strong>${value}</strong><p>${note}</p></article>`).join('');
  const max = summary.totalBudget;
  const expectedWidth = budgetBarWidth(totals.expected, max); const committedWidth = budgetBarWidth(totals.committed, max); const paidWidth = budgetBarWidth(totals.paid, max);
  const warnings = summary.warnings.length ? `<div class="budget-warning"><strong>Check budget data:</strong> ${summary.warnings.slice(0, 3).map(warning => warning.kind === 'missing_fx' ? `${escapeHtml(warning.item.name)} needs an FX rate.` : warning.kind === 'over_budget' ? 'Expected cost exceeds the trip budget.' : `${escapeHtml(warning.item.name)} needs a value review.`).join(' ')}</div>` : '';
  const filterText = state.budgetSearch.trim().toLowerCase();
  const displayed = summary.items.filter(item => (!state.budgetCategoryFilter || item.category_id === state.budgetCategoryFilter || item.visit_id === state.budgetCategoryFilter) && (!filterText || `${item.name} ${item.notes} ${budgetReference(item, data)}`.toLowerCase().includes(filterText)));
  const categoryOptions = data.budget.categories.map(category => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join('');
  const items = displayed.length ? displayed.map(item => {
    const category = data.budget.categories.find(candidate => candidate.id === item.category_id);
    const baseAmount = item.base ? formatMoney(item.base.expected, baseCurrency) : 'FX needed';
    const native = `${formatMoney(item.expectedAmount, item.currency)} expected`;
    const paid = `${formatMoney(item.paidAmount, item.currency)} paid`;
    const quantity = visitQuantity(item, data);
    const basis = item.expected.basis === 'fixed' ? 'Fixed' : `${formatMoney(item.expected.unit_amount, item.currency)} ${item.expected.basis.replace('_', ' ')} × ${quantity} = ${formatMoney(item.expectedAmount, item.currency)}`;
    return `<article class="budget-item"><div class="budget-item-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(budgetReference(item, data))} · ${escapeHtml(native)} · ${escapeHtml(basis)}</small><span class="budget-item-tag">${escapeHtml(category?.name || item.category_id)}</span></div><div class="budget-amount-stack"><span>Base expected</span><strong>${baseAmount}</strong></div><div class="budget-amount-stack"><span>Committed / paid</span><strong>${formatMoney(item.committed_amount, item.currency)} / ${escapeHtml(paid)}</strong></div><div class="budget-item-actions"><button class="secondary-button small" data-edit-cost="${escapeHtml(item.id)}">Edit</button></div></article>`;
  }).join('') : '<div class="budget-empty">No cost items match this filter. Add an estimate or record a quick expense.</div>';
  el('budget-content').innerHTML = `<section class="budget-summary-grid">${cards}</section><section class="budget-coverage"><div class="budget-coverage-head"><strong>Expected, committed and paid against the trip budget</strong><span>${completeNote}</span></div><div class="budget-track" aria-label="Budget coverage"><span class="expected" style="width:${expectedWidth}%"></span><span class="committed" style="width:${committedWidth}%"></span><span class="paid" style="width:${paidWidth}%"></span></div><div class="budget-key"><span class="expected"><i></i>Expected ${formatMoney(totals.expected, baseCurrency)}</span><span class="committed"><i></i>Committed ${formatMoney(totals.committed, baseCurrency)}</span><span class="paid"><i></i>Paid ${formatMoney(totals.paid, baseCurrency)}</span></div></section>${warnings}<section class="budget-grid"><article class="budget-section"><h2>Where the expected cost goes</h2><p>Tap a category to filter the underlying items.</p><div class="budget-breakdown">${summary.categories.map(row => budgetRow(row, baseCurrency, 'category')).join('') || '<div class="budget-empty">No cost items yet.</div>'}</div></article><article class="budget-section"><h2>By visit and whole-trip costs</h2><p>Repeated visits stay separate.</p><div class="budget-breakdown">${summary.visits.map(row => budgetRow(row, baseCurrency, 'visit')).join('') || '<div class="budget-empty">No visit-linked costs yet.</div>'}</div></article></section><section class="budget-section budget-items-section"><div class="budget-items-toolbar"><div><h2>Cost items</h2><p>Expected, commitment and payment history in one place.</p></div><input id="budget-search" type="search" value="${escapeHtml(state.budgetSearch)}" placeholder="Search costs or places"><select id="budget-category-filter"><option value="">All categories and visits</option>${categoryOptions}</select></div><div id="budget-items" class="budget-items">${items}</div></section>`;
  el('budget-category-filter').value = data.budget.categories.some(category => category.id === state.budgetCategoryFilter) ? state.budgetCategoryFilter : '';
  el('budget-search').addEventListener('input', event => { state.budgetSearch = event.target.value; renderBudget(); });
  el('budget-category-filter').addEventListener('change', event => { state.budgetCategoryFilter = event.target.value; renderBudget(); });
  document.querySelectorAll('[data-budget-filter-id]').forEach(button => button.addEventListener('click', () => { state.budgetCategoryFilter = button.dataset.budgetFilterId; state.budgetSearch = ''; renderBudget(); document.querySelector('.budget-items-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
  document.querySelectorAll('[data-edit-cost]').forEach(button => button.addEventListener('click', () => openCostDialog(data.budget.cost_items.find(item => item.id === button.dataset.editCost))));
}

function budgetOptions(items, selected, blankLabel = '—') { return `<option value="">${blankLabel}</option>${items.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}`; }

function renderCostPayments() {
  const item = state.costDialogItem;
  el('cost-payments-list').innerHTML = item.payments.length ? item.payments.map(payment => `<div class="payment-row"><span><strong>${escapeHtml(payment.kind)}</strong> · ${escapeHtml(payment.date || 'No date')}<small>${escapeHtml(payment.note || '')}</small></span><span>${escapeHtml(formatMoney(payment.amount, item.currency))} <button type="button" class="linkish-button" data-remove-payment="${escapeHtml(payment.id)}">Remove</button></span></div>`).join('') : '<div class="payment-row"><span><small>No payments recorded yet.</small></span></div>';
  document.querySelectorAll('[data-remove-payment]').forEach(button => button.addEventListener('click', () => { item.payments = item.payments.filter(payment => payment.id !== button.dataset.removePayment); renderCostPayments(); }));
}

function updateCostExpectedPreview() {
  const unit = el('cost-unit-amount').value || '0'; const basis = el('cost-basis').value; const source = el('cost-quantity-source').value; const quantity = source === 'manual' ? el('cost-quantity').value || '0' : 'derived from selected visit';
  try { el('cost-expected-preview').textContent = basis === 'fixed' ? `Expected total: ${formatMoney(unit, el('cost-currency').value.toUpperCase() || '???')}` : `Expected: ${formatMoney(unit, el('cost-currency').value.toUpperCase() || '???')} × ${quantity}`; } catch { el('cost-expected-preview').textContent = 'Enter an exact decimal amount.'; }
}

function openCostDialog(existing = null) {
  const data = currentData(); const budget = data.budget;
  state.costDialogItem = deepClone(existing || { id: '', name: '', category_id: budget.categories[0]?.id || 'miscellaneous', currency: budget.base_currency, expected: { unit_amount: '', basis: 'fixed', quantity_source: 'manual', quantity: 1 }, committed_amount: '0', fx: { rate_to_base: budget.base_currency === 'USD' ? '1' : '', as_of_date: '', source: '', note: '' }, payments: [], visit_id: '', event_id: '', booking_id: '', location_id: '', start_date: '', end_date: '', notes: '' });
  const item = state.costDialogItem;
  el('cost-dialog-title').textContent = existing ? 'Edit cost item' : 'Add cost item';
  el('cost-id').value = item.id; el('cost-name').value = item.name; el('cost-currency').value = item.currency; el('cost-unit-amount').value = item.expected.unit_amount; el('cost-basis').value = item.expected.basis; el('cost-quantity-source').value = item.expected.quantity_source; el('cost-quantity').value = item.expected.quantity; el('cost-committed').value = item.committed_amount; el('cost-fx-rate').value = item.fx.rate_to_base; el('cost-fx-date').value = item.fx.as_of_date; el('cost-fx-source').value = item.fx.source; el('cost-notes').value = item.notes; el('cost-start-date').value = item.start_date; el('cost-end-date').value = item.end_date;
  refreshSelectOptions(el('cost-category'), budget.categories.map(category => ({ value: category.id, label: category.name })), item.category_id);
  el('cost-visit').innerHTML = budgetOptions(sortedVisits(data).map(visit => ({ id: visit.id, label: `Visit ${visit.order} · ${getLocation(visit.location_id, data)?.name || visit.location_id}` })), item.visit_id); el('cost-event').innerHTML = budgetOptions(sortedEvents(data).map(event => ({ id: event.id, label: event.title })), item.event_id); el('cost-booking').innerHTML = budgetOptions(data.bookings.map(booking => ({ id: booking.id, label: booking.title })), item.booking_id); el('cost-location').innerHTML = budgetOptions(Object.values(data.locations).map(location => ({ id: location.id, label: `${location.name} · ${location.country}` })), item.location_id);
  el('delete-cost-button').hidden = !existing; el('cost-quantity').disabled = item.expected.quantity_source !== 'manual';
  renderCostPayments(); updateCostExpectedPreview(); el('cost-dialog').showModal();
}

function applyCostDialog() {
  const item = state.costDialogItem; const data = state.draft; const source = el('cost-quantity-source').value; const basis = el('cost-basis').value;
  item.id = el('cost-id').value || generateId('cost'); item.name = el('cost-name').value.trim(); item.category_id = el('cost-category').value; item.currency = el('cost-currency').value.trim().toUpperCase(); item.expected = { unit_amount: el('cost-unit-amount').value.trim(), basis, quantity_source: basis === 'fixed' ? 'manual' : source, quantity: basis === 'fixed' ? 1 : source === 'manual' ? Number(el('cost-quantity').value) : 0 }; item.committed_amount = el('cost-committed').value.trim() || '0'; item.fx = { rate_to_base: el('cost-fx-rate').value.trim(), as_of_date: el('cost-fx-date').value, source: el('cost-fx-source').value.trim(), note: item.fx.note || '' }; item.visit_id = el('cost-visit').value; item.event_id = el('cost-event').value; item.booking_id = el('cost-booking').value; item.location_id = el('cost-location').value; item.start_date = el('cost-start-date').value; item.end_date = el('cost-end-date').value; item.notes = el('cost-notes').value.trim();
  const index = data.budget.cost_items.findIndex(candidate => candidate.id === item.id); if (index === -1) data.budget.cost_items.push(item); else data.budget.cost_items[index] = item;
  el('cost-dialog').close(); markDirty(`Budget cost changed: ${item.name || 'new item'}`); renderBudget();
}

function addDialogPayment() {
  const amount = el('payment-amount').value.trim(); if (!amount) { toast('Enter a payment amount first.', 'error'); return; }
  state.costDialogItem.currency = el('cost-currency').value.trim().toUpperCase() || state.costDialogItem.currency;
  state.costDialogItem.payments.push({ id: generateId('payment'), kind: el('payment-kind').value, amount, date: el('payment-date').value, note: el('payment-note').value.trim() }); el('payment-amount').value = ''; el('payment-note').value = ''; renderCostPayments();
}

function recordQuickExpense() {
  const data = state.draft; const amount = el('quick-expense-amount').value.trim(); const currency = el('quick-expense-currency').value.trim().toUpperCase(); const visitId = el('quick-expense-visit').value; const visit = getVisit(visitId, data);
  const item = { id: generateId('cost'), name: el('quick-expense-name').value.trim(), category_id: el('quick-expense-category').value, currency, expected: { unit_amount: amount, basis: 'fixed', quantity_source: 'manual', quantity: 1 }, committed_amount: '0', fx: { rate_to_base: currency === data.budget.base_currency ? '1' : '', as_of_date: el('quick-expense-date').value, source: '', note: '' }, payments: [{ id: generateId('payment'), kind: 'payment', amount, date: el('quick-expense-date').value, note: el('quick-expense-note').value.trim() }], visit_id: visitId, event_id: '', booking_id: '', location_id: visit?.location_id || '', start_date: el('quick-expense-date').value, end_date: el('quick-expense-date').value, notes: 'Quick actual expense.' };
  data.budget.cost_items.push(item); el('quick-expense-dialog').close(); markDirty(`Recorded expense: ${item.name}`); renderBudget();
}

function openBudgetSettings() {
  const budget = currentData().budget;
  el('budget-base-currency').value = budget.base_currency;
  el('budget-total-budget').value = budget.total_budget;
  el('budget-settings-dialog').showModal();
}

function applyBudgetSettings() {
  const budget = state.draft.budget;
  budget.base_currency = el('budget-base-currency').value.trim().toUpperCase();
  budget.total_budget = el('budget-total-budget').value.trim();
  el('budget-settings-dialog').close(); markDirty('Budget settings changed'); renderBudget();
}

/* ---------------- Bookings ---------------- */
function bookingToday() { return formatDateKey(Date.now()); }
function bookingReference(booking, data) {
  const visit = getVisit(booking.visit_id, data); const location = getLocation(booking.location_id || visit?.location_id, data);
  return [location?.name, visit ? `Visit ${visit.order}` : '', booking.date ? humanDate(booking.date, { year: false }) : ''].filter(Boolean).join(' · ') || 'Whole trip';
}
function bookingCost(booking, data) {
  return data.budget.cost_items.find(item => item.id === booking.cost_item_id || item.booking_id === booking.id) || null;
}
function bookingGroupTitle(bucket) {
  return ({ urgent: ['Book now', 'Recommended now or overdue'], before_departure: ['Before departure', 'Resolve before the trip starts'], shortly_before: ['Book shortly before', 'Timing follows the trip date'], later: ['Book later', 'Not due yet or still researching'], on_arrival: ['On arrival', 'Intentionally left local and flexible'], booked: ['Booked', 'Confirmed reservations'], secondary: ['Cancelled / not required', 'Kept for history'] })[bucket];
}
function bookingCard({ booking, action }, data) {
  const cost = bookingCost(booking, data); const currency = cost?.currency; const financial = cost ? `<div class="booking-finance"><span>Expected <strong>${formatMoney(itemExpected(cost, data), currency)}</strong></span><span>Committed <strong>${formatMoney(cost.committed_amount, currency)}</strong></span><span>Paid <strong>${formatMoney(calculateBudget(data).items.find(item => item.id === cost.id)?.paidAmount || '0', currency)}</strong></span></div>` : '';
  const reasons = action.reasons.length ? action.reasons.slice(0, 2).map(reason => `<span class="booking-reason">${escapeHtml(reason)}</span>`).join('') : '<span class="booking-reason subdued">No timing advice recorded</span>';
  const actionButton = action.actionable ? `<button class="primary-button small" data-booking-confirm="${escapeHtml(booking.id)}">${booking.lifecycle === 'ready_to_book' ? 'Mark booked' : 'Update'}</button>` : '';
  const safeUrl = /^https?:\/\//i.test(booking.url || '') ? `<a class="linkish-button" href="${escapeHtml(booking.url)}" target="_blank" rel="noopener noreferrer">Provider ↗</a>` : '';
  return `<article class="booking-card ${action.bucket}"><div class="booking-card-main"><div class="booking-card-heading"><div><span class="booking-type">${escapeHtml(booking.type)}</span><h3>${escapeHtml(booking.title)}</h3><p>${escapeHtml(bookingReference(booking, data))}</p></div><span class="booking-lifecycle ${escapeHtml(booking.lifecycle)}">${escapeHtml(booking.lifecycle.replaceAll('_', ' '))}</span></div><div class="booking-timing"><strong>${escapeHtml(action.timingLabel)}</strong><div>${reasons}</div></div>${financial}</div><div class="booking-card-actions">${actionButton}<button class="secondary-button small" data-edit-booking="${escapeHtml(booking.id)}">Details</button>${safeUrl}</div></article>`;
}
function renderBookings() {
  const data = currentData(); if (!data) return;
  const today = bookingToday(); const groups = groupBookings(data.bookings, data, today);
  const types = [...new Set(data.bookings.map(booking => booking.type))].sort();
  const filtered = groups.filter(({ booking, action }) => (!state.bookingStatusFilter || (state.bookingStatusFilter === 'actionable' ? action.actionable : booking.lifecycle === state.bookingStatusFilter)) && (!state.bookingTypeFilter || booking.type === state.bookingTypeFilter));
  const order = ['urgent', 'before_departure', 'shortly_before', 'later', 'on_arrival', 'booked', 'secondary'];
  const sections = order.map(bucket => {
    const entries = filtered.filter(entry => entry.action.bucket === bucket); if (!entries.length) return '';
    const [title, note] = bookingGroupTitle(bucket);
    return `<section class="booking-section ${bucket}"><div class="booking-section-heading"><div><h2>${title}</h2><p>${note}</p></div><span>${entries.length}</span></div><div class="booking-list">${entries.map(entry => bookingCard(entry, data)).join('')}</div></section>`;
  }).join('') || '<div class="budget-empty">No bookings match this view. Add a booking when there is something to research or reserve.</div>';
  el('booking-today-note').textContent = `Action dates calculated for ${humanDate(today)}`;
  el('bookings-content').innerHTML = `<section class="booking-intro"><div><h2>What needs attention?</h2><p>Timing is based on the itinerary and stored research advice—not a manual priority score.</p></div><div class="booking-filters"><select id="booking-status-filter" aria-label="Booking status"><option value="actionable">Actionable first</option><option value="">All lifecycle states</option><option value="not_researched">Not researched</option><option value="researching">Researching</option><option value="ready_to_book">Ready to book</option><option value="booked">Booked</option><option value="cancelled">Cancelled</option><option value="not_required">Not required</option></select><select id="booking-type-filter" aria-label="Booking type"><option value="">All booking types</option>${types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('')}</select></div></section>${sections}`;
  el('booking-status-filter').value = state.bookingStatusFilter; el('booking-type-filter').value = state.bookingTypeFilter;
  el('booking-status-filter').addEventListener('change', event => { state.bookingStatusFilter = event.target.value; renderBookings(); });
  el('booking-type-filter').addEventListener('change', event => { state.bookingTypeFilter = event.target.value; renderBookings(); });
  document.querySelectorAll('[data-edit-booking]').forEach(button => button.addEventListener('click', () => openBookingDialog(data.bookings.find(item => item.id === button.dataset.editBooking))));
  document.querySelectorAll('[data-booking-confirm]').forEach(button => button.addEventListener('click', () => openBookingDialog(data.bookings.find(item => item.id === button.dataset.bookingConfirm), true)));
}
function defaultBooking(data) { return { id: '', title: '', type: 'Other', lifecycle: 'not_researched', timing: { strategy: 'unknown', recommended_date: '', lead_days: 0, anchor: 'event_start', hard_deadline: '', sell_out_risk: 'unknown', price_rise_risk: 'unknown', flexibility_value: 'unknown', rationale: '', confidence: 'unknown', last_researched_date: '', source_urls: [] }, date: '', time: '', duration: '', booking_deadline: '', details: '', provider: '', reference: '', url: '', notes: '', event_id: '', visit_id: '', location_id: '', cost_item_id: '', legacy: {} }; }
function openBookingDialog(existing = null, markBooked = false) {
  const data = currentData(); const booking = state.bookingDialogItem = deepClone(existing || defaultBooking(data)); const timing = booking.timing;
  el('booking-dialog-title').textContent = markBooked ? 'Confirm booking' : existing ? 'Edit booking' : 'Add booking';
  for (const [id, value] of Object.entries({ 'booking-id': booking.id, 'booking-title': booking.title, 'booking-type': booking.type, 'booking-date': booking.date, 'booking-provider': booking.provider, 'booking-url': booking.url, 'booking-reference': booking.reference, 'booking-notes': booking.notes, 'booking-strategy': timing.strategy, 'booking-recommended-date': timing.recommended_date, 'booking-lead-days': timing.lead_days || '', 'booking-anchor': timing.anchor, 'booking-hard-deadline': timing.hard_deadline, 'booking-sellout-risk': timing.sell_out_risk, 'booking-price-risk': timing.price_rise_risk, 'booking-flexibility': timing.flexibility_value, 'booking-rationale': timing.rationale, 'booking-confidence': timing.confidence, 'booking-researched-date': timing.last_researched_date, 'booking-sources': timing.source_urls.join('\n') })) el(id).value = value;
  refreshSelectOptions(el('booking-lifecycle'), ['not_researched', 'researching', 'ready_to_book', 'booked', 'cancelled', 'not_required'].map(value => ({ value, label: value.replaceAll('_', ' ') })), markBooked ? 'booked' : booking.lifecycle);
  el('booking-visit').innerHTML = budgetOptions(sortedVisits(data).map(visit => ({ id: visit.id, label: `Visit ${visit.order} · ${getLocation(visit.location_id, data)?.name || visit.location_id}` })), booking.visit_id);
  el('booking-event').innerHTML = budgetOptions(sortedEvents(data).map(event => ({ id: event.id, label: event.title })), booking.event_id);
  el('booking-location').innerHTML = budgetOptions(Object.values(data.locations).map(location => ({ id: location.id, label: `${location.name} · ${location.country}` })), booking.location_id);
  el('booking-cost').innerHTML = budgetOptions(data.budget.cost_items.map(item => ({ id: item.id, label: `${item.name} · ${formatMoney(itemExpected(item, data), item.currency)}` })), booking.cost_item_id || data.budget.cost_items.find(item => item.booking_id === booking.id)?.id || '');
  const cost = bookingCost(booking, data); el('booking-committed').value = cost?.committed_amount || ''; el('booking-deposit').value = ''; el('booking-payment-date').value = bookingToday();
  el('booking-finance-fieldset').hidden = false; el('booking-dialog').showModal();
}
function applyBookingDialog() {
  const data = state.draft; const booking = state.bookingDialogItem; const sourceUrls = el('booking-sources').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  Object.assign(booking, { id: el('booking-id').value || generateId('booking'), title: el('booking-title').value.trim(), type: el('booking-type').value.trim(), lifecycle: el('booking-lifecycle').value, date: el('booking-date').value, provider: el('booking-provider').value.trim(), url: el('booking-url').value.trim(), reference: el('booking-reference').value.trim(), notes: el('booking-notes').value.trim(), visit_id: el('booking-visit').value, event_id: el('booking-event').value, location_id: el('booking-location').value, cost_item_id: el('booking-cost').value, timing: { strategy: el('booking-strategy').value, recommended_date: el('booking-recommended-date').value, lead_days: Number(el('booking-lead-days').value || 0), anchor: el('booking-anchor').value, hard_deadline: el('booking-hard-deadline').value, sell_out_risk: el('booking-sellout-risk').value, price_rise_risk: el('booking-price-risk').value, flexibility_value: el('booking-flexibility').value, rationale: el('booking-rationale').value.trim(), confidence: el('booking-confidence').value, last_researched_date: el('booking-researched-date').value, source_urls: sourceUrls } });
  const linked = data.budget.cost_items.find(item => item.id === booking.cost_item_id); if (linked) { linked.booking_id = booking.id; const committed = el('booking-committed').value.trim(); if (booking.lifecycle === 'booked' && committed) linked.committed_amount = committed; const deposit = el('booking-deposit').value.trim(); if (deposit) linked.payments.push({ id: generateId('payment'), kind: 'payment', amount: deposit, date: el('booking-payment-date').value, note: 'Recorded while confirming booking.' }); }
  const index = data.bookings.findIndex(item => item.id === booking.id); if (index < 0) data.bookings.push(booking); else data.bookings[index] = booking;
  el('booking-dialog').close(); markDirty(`Booking changed: ${booking.title || 'new booking'}`); renderBookings();
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
  const modes = TRANSPORT_MODES.map(mode => ({ value: mode, label: mode }));
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
  const modeOptions = TRANSPORT_MODES.map(mode => `<option ${mode === visit.arrival_mode ? 'selected' : ''}>${mode}</option>`).join('');
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
    state.draft = deepClone(result.itinerary);
    state.saved = deepClone(result.itinerary);
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

/* ---------------- AI handoff / safe import ---------------- */
const AI_HANDOFF_TEXT = `You are modifying a Trip Planner itinerary JSON document. Return one complete valid JSON document only (not a patch or Markdown). Preserve schema_version and stable IDs whenever an entity is modified. Keep event timestamps as floating local YYYY-MM-DDTHH:MM values with no Z or UTC offset. Keep exact money and FX values as decimal strings. Preserve expected, committed and paid as distinct Budget concepts; booking lifecycle and booking timing are distinct. Do not add secrets, card data, or javascript: URLs.`;
function renderHandoff() {
  const data=currentData(); const summary=calculateBudget(data); const dirty=state.dirty ? 'Current draft has unsaved changes.' : 'Current draft matches the saved trip.';
  el('handoff-content').innerHTML=`<section class="handoff-hero"><div><h2>AI import & export</h2><p>Trip Planner JSON is the safe interchange format. Importing validates and previews changes before it touches your draft.</p></div><span class="booking-reason">${escapeHtml(dirty)}</span></section><section class="handoff-grid"><article class="budget-section"><h2>Export for planning help</h2><p>Download the precise version you intend to share.</p><div class="handoff-actions"><a class="secondary-button link-button" href="/api/download" download="itinerary.json">Download saved trip</a><button id="handoff-download-draft" class="secondary-button">Export current draft</button><button id="copy-ai-instructions" class="primary-button">Copy AI instructions</button></div></article><article class="budget-section"><h2>Import an updated trip</h2><p>JSON is migrated and validated on this home server, then compared with the current draft. It is never saved automatically.</p><label class="upload-button primary-button">Choose JSON to preview<input id="handoff-import-input" type="file" accept="application/json,.json"></label><small class="handoff-meta">${data.metadata.title} · ${data.visits.length} visits · ${data.events.length} events · ${data.bookings.length} bookings · expected ${escapeHtml(formatMoney(summary.totals.expected,summary.baseCurrency))}</small></article></section>`;
  el('handoff-download-draft').addEventListener('click', downloadDraft); el('copy-ai-instructions').addEventListener('click', async()=>{ try { await navigator.clipboard.writeText(AI_HANDOFF_TEXT); toast('AI instructions copied.', 'success'); } catch { toast('Copy is unavailable in this browser. Use the instructions shown in the AI handoff guide.', 'error'); } }); el('handoff-import-input').addEventListener('change',event=>previewImport(event.target.files[0]));
}
function importChangeRow(item) { return `<article class="import-change ${escapeHtml(item.importance)}"><span class="import-kind">${escapeHtml(item.kind)}</span><div><strong>${escapeHtml(item.label)}</strong>${item.before||item.after?`<p>${escapeHtml(item.before||'—')} <b>→</b> ${escapeHtml(item.after||'—')}</p>`:''}</div></article>`; }
function showImportPreview(prepared, filename) {
  const diff=semanticDiff(currentData(),prepared.itinerary); state.importPreview={itinerary:prepared.itinerary,diff,filename}; const groups=[['overview','Overview'],['schedule','Schedule'],['bookings','Bookings'],['budget','Budget'],['places','Places']].filter(([key])=>diff.grouped[key]?.length);
  const body=diff.total===0?'<div class="import-empty"><h3>No itinerary changes detected.</h3><p>The imported canonical trip matches your current draft. There is nothing to apply.</p></div>':`<div class="import-impact"><strong>${diff.total} change${diff.total===1?'':'s'} detected</strong>${diff.replacement?'<p class="budget-warning"><strong>Large replacement:</strong> most current visits differ. Check this is the intended trip before applying.</p>':''}<p>Imported: ${escapeHtml(prepared.itinerary.metadata.title)} · ${escapeHtml(prepared.itinerary.metadata.start_date)} → ${escapeHtml(prepared.itinerary.metadata.end_date)} · ${prepared.itinerary.visits.length} visits</p></div>${groups.map(([key,label])=>`<details class="import-group" open><summary>${label} <span>${diff.grouped[key].length}</span></summary><div>${diff.grouped[key].map(importChangeRow).join('')}</div></details>`).join('')}`;
  const migration=prepared.migrations.length?`<div class="budget-warning"><strong>Migrated in memory:</strong> ${escapeHtml(prepared.migrations.join(', '))}. Saving later persists schema v${prepared.itinerary.schema_version}.</div>`:''; const warnings=prepared.warnings.length?`<div class="budget-warning"><strong>Warnings:</strong> ${prepared.warnings.slice(0,4).map(escapeHtml).join(' ')}</div>`:'';
  el('import-preview-content').innerHTML=`${migration}${warnings}${body}`; el('apply-import-button').disabled=diff.total===0; el('apply-import-button').textContent=diff.replacement?'Apply replacement to draft':'Apply changes to draft'; el('import-preview-dialog').showModal();
}
async function previewImport(file) {
  if(!file) return; if(file.size>2*1024*1024){ toast('That JSON file is larger than the 2 MiB import limit.', 'error'); return; }
  try { const raw=await file.text(); const parsed=JSON.parse(raw); const prepared=await apiJson('/api/import-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itinerary:parsed})}); if(!prepared.valid){ showValidationDialog(prepared); toast('The import is invalid and cannot be applied.', 'error'); return; } showImportPreview(prepared,file.name); } catch(error) { toast(`Could not preview import: ${error.message}`, 'error',6000); } finally { const input=el('handoff-import-input')||el('upload-input'); if(input) input.value=''; }
}
function applyImportedDraft() { const preview=state.importPreview; if(!preview) return; state.draft=deepClone(preview.itinerary); state.selectedDate=state.draft.metadata.start_date; state.editDayDate=state.selectedDate; state.editEventId=null; state.importPreview=null; el('import-preview-dialog').close(); markDirty(`Imported ${preview.filename || 'itinerary'} applied to draft; save separately to persist it`); renderEverything(); switchTab('handoff'); toast('Imported itinerary is now your draft. Save it separately when ready.', 'success',6000); }

async function uploadDraft(file) {
  await previewImport(file);
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
  el('map-fit').addEventListener('click', () => state.mapController?.fitTrip());
  el('map-focus-day').addEventListener('click', () => {
    const data = currentData();
    const day = data.days[Number(el('map-slider').value) - 1];
    const route = routeForDay(state.mapModel || buildTripMapModel(data), data, day);
    if (route) state.mapController?.focusRoute(route.id);
    else state.mapController?.focusVisit(day.visit_id);
  });
  el('map-expand').addEventListener('click', () => toggleMapExpanded());
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.mapExpanded) toggleMapExpanded(false); });

  el('add-cost-button').addEventListener('click', () => openCostDialog());
  el('budget-settings-button').addEventListener('click', openBudgetSettings);
  el('quick-expense-button').addEventListener('click', () => {
    const data = currentData();
    el('quick-expense-name').value = ''; el('quick-expense-amount').value = ''; el('quick-expense-currency').value = data.budget.base_currency; el('quick-expense-date').value = state.selectedDate || data.metadata.start_date; el('quick-expense-note').value = '';
    refreshSelectOptions(el('quick-expense-category'), data.budget.categories.map(category => ({ value: category.id, label: category.name })), data.budget.categories.find(category => category.id === 'local_transport')?.id || data.budget.categories[0]?.id);
    el('quick-expense-visit').innerHTML = budgetOptions(sortedVisits(data).map(visit => ({ id: visit.id, label: `Visit ${visit.order} · ${getLocation(visit.location_id, data)?.name || visit.location_id}` })), '');
    el('quick-expense-dialog').showModal();
  });
  el('close-cost-dialog').addEventListener('click', () => el('cost-dialog').close());
  el('cancel-cost-button').addEventListener('click', () => el('cost-dialog').close());
  el('delete-cost-button').addEventListener('click', () => { const item = state.costDialogItem; if (!item || !confirm(`Delete ${item.name}?`)) return; state.draft.budget.cost_items = state.draft.budget.cost_items.filter(candidate => candidate.id !== item.id); el('cost-dialog').close(); markDirty(`Deleted budget cost: ${item.name}`); renderBudget(); });
  el('cost-form').addEventListener('submit', event => { event.preventDefault(); applyCostDialog(); });
  el('add-payment-button').addEventListener('click', addDialogPayment);
  ['cost-unit-amount', 'cost-basis', 'cost-quantity-source', 'cost-quantity', 'cost-currency'].forEach(id => el(id).addEventListener('input', () => { el('cost-quantity').disabled = el('cost-quantity-source').value !== 'manual' || el('cost-basis').value === 'fixed'; updateCostExpectedPreview(); }));
  el('quick-expense-form').addEventListener('submit', event => { event.preventDefault(); recordQuickExpense(); });
  el('close-quick-expense-dialog').addEventListener('click', () => el('quick-expense-dialog').close());
  el('cancel-quick-expense-button').addEventListener('click', () => el('quick-expense-dialog').close());
  el('budget-settings-form').addEventListener('submit', event => { event.preventDefault(); applyBudgetSettings(); });
  el('close-budget-settings-dialog').addEventListener('click', () => el('budget-settings-dialog').close());
  el('cancel-budget-settings-button').addEventListener('click', () => el('budget-settings-dialog').close());

  el('add-booking-button').addEventListener('click', () => openBookingDialog());
  el('close-booking-dialog').addEventListener('click', () => el('booking-dialog').close());
  el('cancel-booking-button').addEventListener('click', () => el('booking-dialog').close());
  el('booking-form').addEventListener('submit', event => { event.preventDefault(); applyBookingDialog(); });

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
    markDirty(`Location changed: ${location.name}`); renderEverything(); switchEditTab('locations');
  });
  el('delete-location').addEventListener('click', deleteLocation);
  el('save-button').addEventListener('click', () => saveDraft().catch(error => toast(error.message, 'error')));
  el('cancel-button').addEventListener('click', cancelDraft);
  el('validate-button').addEventListener('click', () => validateDraft(true).catch(error => toast(error.message, 'error')));
  el('download-button').addEventListener('click', downloadDraft);
  el('upload-input').addEventListener('change', event => uploadDraft(event.target.files[0]));
  el('close-import-preview').addEventListener('click', () => el('import-preview-dialog').close());
  el('cancel-import-preview').addEventListener('click', () => el('import-preview-dialog').close());
  el('apply-import-button').addEventListener('click', applyImportedDraft);
  el('edit-token').addEventListener('input', event => writeSessionValue('itinerary_edit_token', event.target.value));
}

function handleFatal(error) {
  console.error(error);
  setSaveStatus('Load failed', 'error');
  document.querySelector('.main-area').innerHTML = `<div class="editor-empty"><h2>Could not load the itinerary</h2><p>${escapeHtml(error.message)}</p></div>`;
}

bindEvents();
loadItinerary().catch(handleFatal);
