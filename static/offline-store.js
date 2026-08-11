const DB_NAME = 'trip-planner-offline';
const STORE_NAME = 'snapshot';
const SNAPSHOT_KEY = 'server-confirmed-itinerary';

export function validItinerarySnapshot(value) {
  return Boolean(value && typeof value === 'object'
    && Number.isInteger(value.schema_version)
    && value.schema_version > 0
    && value.metadata && typeof value.metadata === 'object'
    && typeof value.metadata.title === 'string'
    && Array.isArray(value.visits)
    && Array.isArray(value.days)
    && Array.isArray(value.events)
    && Array.isArray(value.bookings)
    && value.locations && typeof value.locations === 'object'
    && (value.schema_version < 9 || (value.places && typeof value.places === 'object'))
    && value.budget && typeof value.budget === 'object');
}

export function createSnapshot({ itinerary, revision, cachedAt = new Date().toISOString(), source = globalThis.location?.origin || '' }) {
  if (!validItinerarySnapshot(itinerary) || typeof revision !== 'string' || !revision) return null;
  return { itinerary, revision, cachedAt, source, schemaVersion: itinerary.schema_version };
}

export function validSnapshot(value) {
  return Boolean(value && typeof value === 'object'
    && validItinerarySnapshot(value.itinerary)
    && typeof value.revision === 'string' && value.revision
    && typeof value.cachedAt === 'string' && !Number.isNaN(Date.parse(value.cachedAt))
    && value.schemaVersion === value.itinerary.schema_version);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable.')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open offline storage.'));
  });
}

async function withStore(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Offline storage request failed.'));
      transaction.onerror = () => reject(transaction.error || new Error('Offline storage transaction failed.'));
    });
  } finally { db.close(); }
}

export async function saveOfflineSnapshot(snapshot) {
  if (!validSnapshot(snapshot)) throw new Error('Refusing to store an invalid itinerary snapshot.');
  await withStore('readwrite', store => store.put(snapshot, SNAPSHOT_KEY));
}

export async function readOfflineSnapshot() {
  const snapshot = await withStore('readonly', store => store.get(SNAPSHOT_KEY));
  return validSnapshot(snapshot) ? snapshot : null;
}

export async function clearOfflineSnapshot() {
  await withStore('readwrite', store => store.delete(SNAPSHOT_KEY));
}

export const offlineStoreInfo = Object.freeze({ DB_NAME, STORE_NAME, SNAPSHOT_KEY });
