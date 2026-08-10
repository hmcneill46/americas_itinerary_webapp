const DEFAULT_CONFIG = Object.freeze({
  provider_name: 'OpenFreeMap',
  style_url: 'https://tiles.openfreemap.org/styles/positron',
  attribution: Object.freeze({
    text: 'OpenFreeMap · OpenMapTiles · OpenStreetMap contributors',
    url: 'https://openfreemap.org/',
  }),
});

function safeUrl(value, { allowLocal = false } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (allowLocal && trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? trimmed : null;
  } catch {
    return null;
  }
}

export function normaliseMapConfig(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CONFIG, attribution: { ...DEFAULT_CONFIG.attribution } };
  const styleUrl = safeUrl(value.style_url, { allowLocal: true });
  const attributionUrl = safeUrl(value.attribution?.url);
  const providerName = typeof value.provider_name === 'string' ? value.provider_name.trim() : '';
  const attributionText = typeof value.attribution?.text === 'string' ? value.attribution.text.trim() : '';
  if (!styleUrl || !attributionUrl || !providerName || !attributionText) {
    return { ...DEFAULT_CONFIG, attribution: { ...DEFAULT_CONFIG.attribution } };
  }
  return {
    provider_name: providerName.slice(0, 80),
    style_url: styleUrl,
    attribution: { text: attributionText.slice(0, 240), url: attributionUrl },
  };
}

export async function loadMapConfig(fetchImpl = fetch) {
  try {
    const response = await fetchImpl('/api/map-config', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Map configuration returned ${response.status}`);
    return normaliseMapConfig(await response.json());
  } catch {
    return normaliseMapConfig(DEFAULT_CONFIG);
  }
}

export { DEFAULT_CONFIG };
