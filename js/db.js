// Stockage local (IndexedDB) : tout reste sur le téléphone.
const DB_NAME = 'garde-robe';
const DB_VERSION = 2;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('weeks')) d.createObjectStore('weeks', { keyPath: 'weekStart' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('chat')) d.createObjectStore('chat', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && typeof r === 'object' && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction annulée'));
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', s => s.get(key)),
  all: (store) => run(store, 'readonly', s => s.getAll()),
  put: (store, value) => run(store, 'readwrite', s => s.put(value)),
  del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
  clear: (store) => run(store, 'readwrite', s => s.clear()),
  getKV: (key) => run('kv', 'readonly', s => s.get(key)),
  setKV: (key, value) => run('kv', 'readwrite', s => s.put(value, key)),
  putMany: (store, values) => run(store, 'readwrite', s => { values.forEach(v => s.put(v)); }),
};

export async function nextItemId() {
  const seq = ((await db.getKV('seq')) || 0) + 1;
  await db.setKV('seq', seq);
  return 'v' + seq;
}
