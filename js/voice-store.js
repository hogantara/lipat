// Where the speech workers keep their models: IndexedDB lipat-voice, one record per file, keyed "<model>/<file>".
// Each model sees and removes only its own files, so two voices can be on the device at once. Removing one also removes
// the files of its older versions (keys that start with its family name).

let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('lipat-voice', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = (mode, fn) => idb().then(db => new Promise((res, rej) => {
  const t = db.transaction('files', mode), req = fn(t.objectStore('files'));
  t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
}));

export function voiceStore(model, family = model) {
  const key = (f) => `${model}/${f}`;
  return {
    get: (f) => tx('readonly', s => s.get(key(f))),
    put: (f, buf) => tx('readwrite', s => s.put(buf, key(f))),
    // are all these files stored?
    async has(names) {
      try { const keys = await tx('readonly', s => s.getAllKeys()); return names.every(f => keys.includes(key(f))); } catch { return false; }
    },
    forget: () => tx('readwrite', s => s.delete(IDBKeyRange.bound(family, family + '\uffff'))),
  };
}

export async function sha256(buf) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
}
