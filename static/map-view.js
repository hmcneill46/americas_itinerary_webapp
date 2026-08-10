import * as maplibregl from './vendor/maplibre-gl/maplibre-gl.mjs?v=6.3.0';
import { coordinatesForBounds } from './map-data.js';

const EMPTY_STYLE = Object.freeze({
  version: 8,
  sources: {},
  layers: [{ id: 'offline-background', type: 'background', paint: { 'background-color': '#e8edf0' } }],
});

const SOURCE_ROUTES = 'trip-routes';
const SOURCE_SECONDARY = 'trip-secondary-locations';
const LAYER_ROUTE_CASING = 'trip-route-casing';
const LAYER_ROUTE = 'trip-route';
const LAYER_ROUTE_SELECTED = 'trip-route-selected';
const LAYER_ROUTE_HIT = 'trip-route-hit';
const LAYER_SECONDARY = 'trip-secondary';
const LAYER_SECONDARY_HIT = 'trip-secondary-hit';

function featureCollection(features = []) {
  return { type: 'FeatureCollection', features };
}

function routeFeatures(model) {
  return featureCollection(model.routes.map(route => ({
    type: 'Feature',
    id: route.id,
    geometry: route.geometry,
    properties: {
      id: route.id,
      mode: route.mode,
      modeGroup: modeGroup(route.mode),
    },
  })));
}

function secondaryFeatures(model) {
  return featureCollection(model.secondaryLocations.map(location => ({
    type: 'Feature',
    id: location.id,
    geometry: { type: 'Point', coordinates: location.coordinates },
    properties: { id: location.id },
  })));
}

function modeGroup(mode) {
  const value = String(mode || '').toLowerCase();
  if (value.includes('flight') || value.includes('air')) return 'air';
  if (value.includes('train') || value.includes('rail')) return 'rail';
  if (value.includes('ferry') || value.includes('boat') || value.includes('water')) return 'water';
  if (value.includes('walk') || value.includes('trek') || value.includes('hike')) return 'walk';
  return 'surface';
}

function textNode(tag, text, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(text ?? '');
  return node;
}

function detailLine(label, value) {
  const row = document.createElement('div');
  row.className = 'trip-map-popup-row';
  row.append(textNode('span', label), textNode('strong', value));
  return row;
}

function countLabel(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function buildVisitPopup(visit) {
  const content = document.createElement('div');
  content.className = 'trip-map-popup';
  const heading = textNode('h3', `${visit.order}. ${visit.name}`);
  const subheading = textNode('p', visit.country, 'trip-map-popup-place');
  content.append(heading, subheading);
  content.append(detailLine('Visit', visit.startDate === visit.endDate ? visit.startDate : `${visit.startDate} – ${visit.endDate}`));
  if (visit.nights !== null) content.append(detailLine('Stay', `${visit.nights} night${visit.nights === 1 ? '' : 's'}`));
  content.append(detailLine('Plans', `${countLabel(visit.eventCount, 'event')} · ${countLabel(visit.bookingCount, 'booking')}`));
  if (visit.accommodation.length) content.append(detailLine('Accommodation', visit.accommodation.join(', ')));
  if (visit.duplicateTotal > 1) content.append(detailLine('Return visit', `${visit.duplicateIndex + 1} of ${visit.duplicateTotal} here`));
  return content;
}

export function buildRoutePopup(route) {
  const content = document.createElement('div');
  content.className = 'trip-map-popup';
  content.append(textNode('p', 'Schematic connection', 'trip-map-popup-kicker'));
  content.append(textNode('h3', route.title));
  content.append(detailLine('Route', `${route.fromName} → ${route.toName}`));
  content.append(detailLine('Mode', route.mode));
  if (route.start && route.end) content.append(detailLine('Local time', `${route.start.replace('T', ' ')} – ${route.end.replace('T', ' ')}`));
  if (route.durationMinutes !== null) {
    const hours = Math.floor(route.durationMinutes / 60);
    const minutes = route.durationMinutes % 60;
    content.append(detailLine('Duration', `${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m` : ''}`.trim()));
  }
  content.append(textNode('p', 'Dashed geometry is an approximate link, not a road or rail alignment.', 'trip-map-popup-note'));
  return content;
}

class SafeAttributionControl {
  constructor(config) { this.config = config; }

  onAdd() {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-attrib trip-map-attribution';
    const addLink = (label, href) => {
      const link = document.createElement('a');
      link.textContent = label;
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      this.container.append(link);
    };
    if (this.config.provider_name === 'OpenFreeMap') {
      addLink('© OpenFreeMap', 'https://openfreemap.org/');
      this.container.append(' · ');
      addLink('© OpenMapTiles', 'https://openmaptiles.org/');
      this.container.append(' · ');
      addLink('© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright');
    } else {
      addLink(this.config.attribution.text, this.config.attribution.url);
    }
    return this.container;
  }

  onRemove() { this.container?.remove(); }
}

export class TripMap {
  constructor({ container, statusElement, config, onVisitSelect, onRouteSelect, onSecondarySelect }) {
    this.container = container;
    this.statusElement = statusElement;
    this.config = config;
    this.onVisitSelect = onVisitSelect;
    this.onRouteSelect = onRouteSelect;
    this.onSecondarySelect = onSecondarySelect;
    this.model = { visits: [], routes: [], secondaryLocations: [], coordinates: [] };
    this.markers = new Map();
    this.modelSignature = '';
    this.styleReady = false;
    this.fallbackActive = false;
    this.hasInitialFit = false;
    this.selectedVisitId = null;
    this.selectedRouteId = null;
    this.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '320px', offset: 18 });

    try {
      this.createMap(config.style_url, config);
    } catch (error) {
      this.showStatus('Interactive map unavailable in this browser. The itinerary remains usable.', 'error');
      throw error;
    }

    this.resizeObserver = new ResizeObserver(() => this.map.resize());
    this.resizeObserver.observe(container);
    this.styleTimer = window.setTimeout(() => {
      if (!this.styleReady) this.activateFallback();
    }, 12_000);
  }

  createMap(style, attributionConfig) {
    const map = new maplibregl.Map({
        container: this.container,
        style,
        center: [0, 20],
        zoom: 1.5,
        minZoom: 1,
        maxZoom: 18,
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
        touchPitch: false,
        renderWorldCopies: true,
      });
    this.map = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');
    map.addControl(new SafeAttributionControl(attributionConfig), 'bottom-right');
    map.on('style.load', () => this.handleStyleLoad());
    map.on('error', event => this.handleMapError(event));
    this.bindLayerInteractions(map);
    return map;
  }

  handleStyleLoad() {
    window.clearTimeout(this.styleTimer);
    this.styleReady = true;
    this.installTripLayers();
    this.syncSources();
    this.syncMarkers();
    this.applySelection();
    if (!this.hasInitialFit && this.model.coordinates.length) {
      this.fitTrip({ animate: false });
      this.hasInitialFit = true;
    }
    if (!this.fallbackActive) this.hideStatus();
  }

  handleMapError() {
    if (!this.styleReady) {
      this.activateFallback();
      return;
    }
    if (!this.fallbackActive) {
      this.showStatus('Some basemap resources could not load. Trip markers and routes remain available.', 'warning');
    }
  }

  activateFallback() {
    if (this.fallbackActive) return;
    this.fallbackActive = true;
    this.styleReady = false;
    this.showStatus('Basemap unavailable — showing the trip on a plain map. Roads and place labels need a network connection.', 'warning');
    try {
      const camera = { center: this.map.getCenter(), zoom: this.map.getZoom(), bearing: 0, pitch: 0 };
      for (const marker of this.markers.values()) marker.remove();
      this.markers.clear();
      this.popup.remove();
      this.map.remove();
      this.createMap(EMPTY_STYLE, {
        provider_name: 'MapLibre',
        attribution: { text: 'MapLibre', url: 'https://maplibre.org/' },
      });
      this.map.jumpTo(camera);
    } catch {
      this.showStatus('Map rendering unavailable. Use the route list alongside the itinerary.', 'error');
    }
  }

  showStatus(message, kind) {
    this.statusElement.textContent = message;
    this.statusElement.className = `map-status ${kind}`;
    this.statusElement.hidden = false;
  }

  hideStatus() {
    this.statusElement.hidden = true;
    this.statusElement.textContent = '';
    this.statusElement.className = 'map-status';
  }

  installTripLayers() {
    if (!this.map.getSource(SOURCE_ROUTES)) {
      this.map.addSource(SOURCE_ROUTES, { type: 'geojson', data: featureCollection() });
      this.map.addLayer({
        id: LAYER_ROUTE_CASING,
        type: 'line',
        source: SOURCE_ROUTES,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fffdf8', 'line-width': 7, 'line-opacity': 0.88 },
      });
      this.map.addLayer({
        id: LAYER_ROUTE,
        type: 'line',
        source: SOURCE_ROUTES,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'modeGroup'], 'air', '#c85662', 'rail', '#625e9d', 'water', '#25877e', 'walk', '#477f54', '#c87535'],
          'line-width': 4,
          'line-opacity': 0.86,
          'line-dasharray': [2, 2],
        },
      });
      this.map.addLayer({
        id: LAYER_ROUTE_SELECTED,
        type: 'line',
        source: SOURCE_ROUTES,
        filter: ['==', ['get', 'id'], ''],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#16324f', 'line-width': 8, 'line-opacity': 0.35 },
      });
      this.map.addLayer({
        id: LAYER_ROUTE_HIT,
        type: 'line',
        source: SOURCE_ROUTES,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#000000', 'line-width': 22, 'line-opacity': 0.01 },
      });
    }
    if (!this.map.getSource(SOURCE_SECONDARY)) {
      this.map.addSource(SOURCE_SECONDARY, { type: 'geojson', data: featureCollection() });
      this.map.addLayer({
        id: LAYER_SECONDARY,
        type: 'circle',
        source: SOURCE_SECONDARY,
        paint: {
          'circle-radius': 5,
          'circle-color': '#fffdf8',
          'circle-stroke-color': '#527284',
          'circle-stroke-width': 2,
          'circle-opacity': 0.9,
        },
      });
      this.map.addLayer({
        id: LAYER_SECONDARY_HIT,
        type: 'circle',
        source: SOURCE_SECONDARY,
        paint: { 'circle-radius': 15, 'circle-opacity': 0 },
      });
    }
  }

  bindLayerInteractions(map) {
    map.on('click', LAYER_ROUTE_HIT, event => {
      const id = event.features?.[0]?.properties?.id;
      const route = this.model.routes.find(item => item.id === id);
      if (!route) return;
      this.setSelection({ visitId: route.visitId, routeId: route.id });
      this.popup.setLngLat(event.lngLat).setDOMContent(buildRoutePopup(route)).addTo(this.map);
      this.onRouteSelect?.(route);
    });
    map.on('click', LAYER_SECONDARY_HIT, event => {
      const id = event.features?.[0]?.properties?.id;
      const location = this.model.secondaryLocations.find(item => item.id === id);
      if (!location) return;
      const content = document.createElement('div');
      content.className = 'trip-map-popup';
      content.append(textNode('h3', location.name), textNode('p', location.country, 'trip-map-popup-place'));
      this.popup.setLngLat(location.coordinates).setDOMContent(content).addTo(this.map);
      this.onSecondarySelect?.(location);
    });
    for (const layer of [LAYER_ROUTE_HIT, LAYER_SECONDARY_HIT]) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
  }

  updateModel(model) {
    const signature = JSON.stringify(model);
    this.model = model;
    if (signature === this.modelSignature) return;
    this.modelSignature = signature;
    if (this.styleReady) {
      this.syncSources();
      this.syncMarkers();
      this.applySelection();
    }
  }

  syncSources() {
    this.map.getSource(SOURCE_ROUTES)?.setData(routeFeatures(this.model));
    this.map.getSource(SOURCE_SECONDARY)?.setData(secondaryFeatures(this.model));
  }

  syncMarkers() {
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
    for (const visit of this.model.visits) {
      const markerElement = document.createElement('button');
      markerElement.type = 'button';
      markerElement.className = 'trip-marker';
      markerElement.dataset.visitId = visit.id;
      markerElement.setAttribute('aria-label', `${visit.order}. ${visit.name}, ${visit.country}`);
      markerElement.textContent = String(visit.order);
      if (visit.duplicateTotal > 1) {
        const badge = textNode('span', visit.duplicateIndex + 1, 'trip-marker-repeat');
        badge.setAttribute('aria-hidden', 'true');
        markerElement.append(badge);
      }
      const angle = visit.duplicateTotal > 1 ? (visit.duplicateIndex / visit.duplicateTotal) * Math.PI * 2 - Math.PI / 2 : 0;
      const radius = visit.duplicateTotal > 1 ? 19 : 0;
      const offset = [Math.cos(angle) * radius, Math.sin(angle) * radius];
      const marker = new maplibregl.Marker({ element: markerElement, anchor: 'center', offset })
        .setLngLat(visit.coordinates)
        .addTo(this.map);
      markerElement.addEventListener('click', event => {
        event.stopPropagation();
        this.setSelection({ visitId: visit.id, routeId: null });
        this.popup.setLngLat(visit.coordinates).setDOMContent(buildVisitPopup(visit)).addTo(this.map);
        this.onVisitSelect?.(visit);
      });
      this.markers.set(visit.id, marker);
    }
  }

  setSelection({ visitId = null, routeId = null }) {
    this.selectedVisitId = visitId;
    this.selectedRouteId = routeId;
    this.applySelection();
  }

  applySelection() {
    for (const [visitId, marker] of this.markers) {
      marker.getElement().classList.toggle('selected', visitId === this.selectedVisitId);
    }
    if (this.styleReady && this.map.getLayer(LAYER_ROUTE_SELECTED)) {
      this.map.setFilter(LAYER_ROUTE_SELECTED, ['==', ['get', 'id'], this.selectedRouteId || '']);
    }
  }

  focusVisit(visitId) {
    const visit = this.model.visits.find(item => item.id === visitId);
    if (!visit) return false;
    this.hasInitialFit = true;
    this.setSelection({ visitId, routeId: null });
    this.map.easeTo({ center: visit.coordinates, zoom: Math.max(this.map.getZoom(), 9), duration: 700 });
    return true;
  }

  focusRoute(routeId) {
    const route = this.model.routes.find(item => item.id === routeId || item.eventId === routeId);
    if (!route) return false;
    this.hasInitialFit = true;
    this.setSelection({ visitId: route.visitId, routeId: route.id });
    const bounds = new maplibregl.LngLatBounds();
    route.geometry.coordinates.forEach(coordinate => bounds.extend(coordinate));
    this.map.fitBounds(bounds, { padding: 90, maxZoom: 10, duration: 700 });
    return true;
  }

  fitTrip({ animate = true } = {}) {
    if (!this.model.coordinates.length) return false;
    this.hasInitialFit = true;
    if (this.model.coordinates.length === 1) {
      this.map.easeTo({ center: this.model.coordinates[0], zoom: 9, duration: animate ? 700 : 0 });
      return true;
    }
    const bounds = new maplibregl.LngLatBounds();
    coordinatesForBounds(this.model.coordinates).forEach(coordinate => bounds.extend(coordinate));
    this.map.fitBounds(bounds, { padding: 70, maxZoom: 10, duration: animate ? 700 : 0 });
    return true;
  }

  resize() { this.map.resize(); }

  destroy() {
    window.clearTimeout(this.styleTimer);
    this.resizeObserver?.disconnect();
    for (const marker of this.markers.values()) marker.remove();
    this.popup.remove();
    this.map.remove();
  }
}
