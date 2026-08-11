import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  clipFloatingIntervalToDay, derivePlacesTravelDays, filteredEvents, normaliseCategorySelection,
  normaliseScheduleMode, selectionAfterFilter, setCategoryVisibility, transportStyleKey,
} from '../static/timeline.js';

const day = date => ({ date, base: '', country: '', summary: '', notes: '', confidence: 'High', day_number: 1, is_physical_location_day: true });
const itinerary = {
  schema_version: 8,
  metadata: { start_date: '2027-04-01', end_date: '2027-04-10' },
  locations: {
    a: { id: 'a', name: 'Alpha', country: 'One' },
    b: { id: 'b', name: 'Beta', country: 'Two' },
  },
  days: Array.from({ length: 10 }, (_, index) => day(`2027-04-${String(index + 1).padStart(2, '0')}`)),
  visits: [
    { id: 'visit_a_1', order: 1, location_id: 'a', start_date: '2027-04-01', end_date: '2027-04-05', arrival_mode: '', arrival_hours_estimate: 0 },
    { id: 'visit_b', order: 2, location_id: 'b', start_date: '2027-04-06', end_date: '2027-04-07', arrival_mode: 'Train', arrival_hours_estimate: 2 },
    { id: 'visit_a_2', order: 3, location_id: 'a', start_date: '2027-04-08', end_date: '2027-04-10', arrival_mode: 'Road / bus', arrival_hours_estimate: 8 },
  ],
  events: [
    {
      id: 'overnight', title: 'Overnight bus', category: 'Travel', transport_mode: 'Road / bus', visit_id: 'visit_a_2',
      from_location_id: 'b', to_location_id: 'a', start: '2027-04-07T22:00', end: '2027-04-08T06:00',
      actual_start: '', actual_end: '', outcome: 'completed',
    },
    {
      id: 'long_trek', title: 'Multi-day trek', category: 'Travel', transport_mode: 'Trek / walk', visit_id: 'visit_a_1',
      from_location_id: 'b', to_location_id: 'a', start: '2027-04-03T10:00', end: '2027-04-05T12:00',
      actual_start: '2027-04-03T11:00', actual_end: '2027-04-05T13:30', outcome: 'delayed',
    },
  ],
};

test('multi-category filtering supports independent, all, none and reset selections', () => {
  const categories = ['Travel', 'Food', 'Activity'];
  const all = normaliseCategorySelection(categories, null);
  assert.deepEqual([...all], categories);
  const hiddenFood = setCategoryVisibility(all, 'Food', false);
  assert.deepEqual(filteredEvents([{ id: 't', category: 'Travel' }, { id: 'f', category: 'Food' }], hiddenFood).map(item => item.id), ['t']);
  assert.deepEqual([...normaliseCategorySelection(categories, new Set())], []);
  assert.deepEqual([...normaliseCategorySelection(categories, categories)], categories);
});

test('selection clears only when an Events filter hides its item', () => {
  assert.equal(selectionAfterFilter('event-a', ['event-a', 'event-b']), 'event-a');
  assert.equal(selectionAfterFilter('event-a', ['event-b']), null);
  assert.equal(selectionAfterFilter(null, ['event-b']), null);
});

test('Schedule mode normalisation keeps local UI state out of arbitrary values', () => {
  assert.equal(normaliseScheduleMode('places'), 'places');
  assert.equal(normaliseScheduleMode('events'), 'events');
  assert.equal(normaliseScheduleMode('anything-else'), 'events');
});

test('Places & travel expands long and repeated visits into truthful day rows', () => {
  const model = derivePlacesTravelDays(itinerary);
  assert.equal(model.stays.find(item => item.id === 'stay:visit_a_1').days, 5);
  assert.equal(model.days['2027-04-01'].presence[0].itemId, 'stay:visit_a_1');
  assert.equal(model.days['2027-04-01'].presence[0].endMinute, 1440);
  assert.equal(model.days['2027-04-08'].presence.at(-1).itemId, 'stay:visit_a_2');
  assert.deepEqual(model.stays.map(item => `${item.name}:${item.country}`), ['Alpha:One', 'Beta:Two', 'Alpha:One']);
});

test('Places & travel does not present a non-physical transit day as a full location stay', () => {
  const transitItinerary = structuredClone(itinerary);
  transitItinerary.days.find(entry => entry.date === '2027-04-04').is_physical_location_day = false;
  transitItinerary.days.find(entry => entry.date === '2027-04-04').base = 'In transit';
  const model = derivePlacesTravelDays(transitItinerary);
  assert.equal(model.days['2027-04-03'].presence.some(piece => model.items.get(piece.itemId).kind === 'stay'), true, 'normal physical time retains location presence');
  assert.deepEqual(model.days['2027-04-04'].presence.map(piece => [model.items.get(piece.itemId).kind, piece.startMinute, piece.endMinute]), [['travel', 0, 1440]], 'explicit multi-day travel owns the full transit day');
});

test('overnight and multi-day travel clip across each 24-hour row using actual times', () => {
  const model = derivePlacesTravelDays(itinerary);
  const overnightDay1 = model.days['2027-04-07'].presence.find(piece => piece.itemId === 'travel:overnight');
  const overnightDay2 = model.days['2027-04-08'].presence.find(piece => piece.itemId === 'travel:overnight');
  assert.deepEqual([overnightDay1.startMinute, overnightDay1.endMinute], [1320, 1440]);
  assert.deepEqual([overnightDay2.startMinute, overnightDay2.endMinute], [0, 360]);
  const trek = model.travel.find(item => item.id === 'travel:long_trek');
  assert.equal(trek.outcome, 'delayed');
  assert.equal(trek.displayStart, '2027-04-03T11:00');
  assert.equal(model.days['2027-04-03'].presence.find(piece => piece.itemId === trek.id).startMinute, 660);
  assert.equal(model.days['2027-04-04'].presence.find(piece => piece.itemId === trek.id).endMinute, 1440);
  assert.equal(model.days['2027-04-05'].presence.find(piece => piece.itemId === trek.id).endMinute, 810);
});

test('fallback arrival context remains untimed and never invents a clock position', () => {
  const model = derivePlacesTravelDays(itinerary);
  const fallback = model.travel.find(item => item.id === 'arrival:visit_b');
  assert.equal(fallback.timed, false);
  assert.equal(fallback.displayStart, '');
  assert.equal(fallback.displayEnd, '');
  assert.equal(fallback.estimatedDurationHours, 2);
  assert.deepEqual(model.days['2027-04-06'].untimedTravel, [{ itemId: 'arrival:visit_b' }]);
  const uncertain = model.items.get(model.days['2027-04-06'].presence[0].itemId);
  assert.equal(uncertain.kind, 'unknown_transition');
  assert.deepEqual([model.days['2027-04-06'].presence[0].startMinute, model.days['2027-04-06'].presence[0].endMinute], [0, 1440]);
  assert.match(uncertain.summary, /travel timing not recorded/);
  assert.equal(model.travel.some(item => item.id === 'arrival:visit_a_2'), false, 'nearby explicit travel supersedes a fallback cue');
});

function linearItinerary(events) {
  return {
    schema_version: 8,
    metadata: { start_date: '2027-05-01', end_date: '2027-05-03' },
    locations: {
      a: { id: 'a', name: 'Alpha', country: 'One' },
      b: { id: 'b', name: 'Beta', country: 'Two' },
      c: { id: 'c', name: 'Gamma', country: 'Three' },
    },
    days: ['2027-05-01', '2027-05-02', '2027-05-03'].map((date, index) => ({ ...day(date), day_number: index + 1, visit_id: index ? 'visit_b' : 'visit_a' })),
    visits: [
      { id: 'visit_a', order: 1, location_id: 'a', start_date: '2027-05-01', end_date: '2027-05-02', arrival_mode: '', arrival_hours_estimate: 0 },
      { id: 'visit_b', order: 2, location_id: 'b', start_date: '2027-05-02', end_date: '2027-05-03', arrival_mode: '', arrival_hours_estimate: 0 },
      { id: 'visit_c', order: 3, location_id: 'c', start_date: '2027-05-02', end_date: '2027-05-03', arrival_mode: '', arrival_hours_estimate: 0 },
    ],
    events,
  };
}

const leg = (id, from, to, start, end, extra = {}) => ({
  id, title: id, category: 'Travel', transport_mode: 'Train', visit_id: `visit_${to}`,
  from_location_id: from, to_location_id: to, start, end, actual_start: '', actual_end: '', outcome: 'planned', ...extra,
});

test('a timed transition produces one non-overlapping A to travel to B presence sequence', () => {
  const model = derivePlacesTravelDays(linearItinerary([leg('a_b', 'a', 'b', '2027-05-02T10:00', '2027-05-02T14:00')]));
  const pieces = model.days['2027-05-02'].presence;
  assert.deepEqual(pieces.map(piece => [model.items.get(piece.itemId).kind, model.items.get(piece.itemId).name || model.items.get(piece.itemId).from, piece.startMinute, piece.endMinute]), [
    ['stay', 'Alpha', 0, 600], ['travel', 'Alpha', 600, 840], ['stay', 'Beta', 840, 1440],
  ]);
});

test('multiple coherent travel legs preserve physical continuity and actual delayed times', () => {
  const events = [
    leg('a_b', 'a', 'b', '2027-05-02T10:00', '2027-05-02T14:00', { actual_start: '2027-05-02T11:00', actual_end: '2027-05-02T15:00', outcome: 'delayed' }),
    leg('b_c', 'b', 'c', '2027-05-02T17:00', '2027-05-02T19:00'),
  ];
  const model = derivePlacesTravelDays(linearItinerary(events));
  assert.deepEqual(model.days['2027-05-02'].presence.map(piece => [piece.itemId, piece.startMinute, piece.endMinute]), [
    ['stay:visit_a', 0, 660], ['travel:a_b', 660, 900], ['stay:visit_b', 900, 1020], ['travel:b_c', 1020, 1140], ['stay:visit_c', 1140, 1440],
  ]);
  assert.equal(model.items.get('travel:a_b').outcome, 'delayed');
});

test('contradictory or overlapping legs produce warnings without overlapping primary pieces', () => {
  const events = [
    leg('a_b', 'a', 'b', '2027-05-02T10:00', '2027-05-02T14:00'),
    leg('c_a_overlap', 'c', 'a', '2027-05-02T13:00', '2027-05-02T15:00'),
    leg('c_a_gap', 'c', 'a', '2027-05-02T16:00', '2027-05-02T18:00'),
  ];
  const model = derivePlacesTravelDays(linearItinerary(events));
  const entry = model.days['2027-05-02'];
  assert.ok(entry.conflicts.some(conflict => conflict.kind === 'overlap'));
  assert.ok(entry.conflicts.some(conflict => conflict.kind === 'continuity'));
  const sorted = [...entry.presence].sort((a, b) => a.startMinute - b.startMinute);
  for (let index = 1; index < sorted.length; index += 1) assert.ok(sorted[index - 1].endMinute <= sorted[index].startMinute);
  assert.ok(sorted.some(piece => model.items.get(piece.itemId).kind === 'unknown_transition'));
});

test('missed and cancelled legs remain historical cues and do not move the physical timeline', () => {
  const events = [
    leg('missed_a_b', 'a', 'b', '2027-05-02T10:00', '2027-05-02T12:00', { outcome: 'missed' }),
    leg('replacement_a_b', 'a', 'b', '2027-05-02T14:00', '2027-05-02T16:00', { outcome: 'completed' }),
  ];
  let model = derivePlacesTravelDays(linearItinerary(events));
  const entry = model.days['2027-05-02'];
  assert.deepEqual(entry.presence.map(piece => [piece.itemId, piece.startMinute, piece.endMinute]), [
    ['stay:visit_a', 0, 840], ['travel:replacement_a_b', 840, 960], ['stay:visit_b', 960, 1440],
  ]);
  assert.deepEqual(entry.disruptedTravel.map(piece => piece.itemId), ['travel:missed_a_b']);
  assert.equal(entry.conflicts.length, 0);

  model = derivePlacesTravelDays(linearItinerary([leg('cancelled_a_b', 'a', 'b', '2027-05-02T10:00', '2027-05-02T12:00', { outcome: 'cancelled' })]));
  assert.deepEqual(model.days['2027-05-02'].presence.map(piece => [piece.itemId, piece.startMinute, piece.endMinute]), [['stay:visit_a', 0, 1440]]);
  assert.deepEqual(model.days['2027-05-02'].disruptedTravel.map(piece => piece.itemId), ['travel:cancelled_a_b']);
});

test('shared interval clipping rejects invalid ranges and handles a day boundary', () => {
  assert.deepEqual(clipFloatingIntervalToDay('2027-04-01T23:30', '2027-04-02T01:00', '2027-04-02'), { startMinute: 0, endMinute: 60 });
  assert.equal(clipFloatingIntervalToDay('bad', '2027-04-02T01:00', '2027-04-02'), null);
});

test('transport modes use a restrained stable style taxonomy', () => {
  assert.equal(transportStyleKey('Flight'), 'flight');
  assert.equal(transportStyleKey('Train'), 'train');
  assert.equal(transportStyleKey('Ferry / boat'), 'ferry');
  assert.equal(transportStyleKey('Trek / walk'), 'walk');
  assert.equal(transportStyleKey('Road / bus'), 'bus');
  assert.equal(transportStyleKey('Local transfer'), 'transfer');
});

test('obsolete whole-trip Trip Flow UI is removed, filters use a phone dialog, and schema remains v8', async () => {
  const [html, app, timeline, styles, example] = await Promise.all([
    readFile(new URL('../static/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../static/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../static/timeline.js', import.meta.url), 'utf8'),
    readFile(new URL('../static/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../data/itinerary.example.json', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(html, /data-tab="flow"|id="view-flow"/);
  assert.doesNotMatch(app + timeline, /deriveTripFlow|renderTripFlow/);
  assert.match(html, /<dialog id="schedule-filter-dialog"/);
  assert.match(app, /schedule-filter-dialog[^]*showModal\(\)/);
  assert.match(app, /window\.visualViewport/);
  assert.match(styles, /html, body \{[^}]*overflow-x: clip/);
  assert.match(styles, /@media \(max-width: 720px\)[^]*\.filter-popover \{ display: none !important; \}/);
  assert.equal(JSON.parse(example).schema_version, 8);
});
