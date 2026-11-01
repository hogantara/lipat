// The natural voice's storage on this device (IndexedDB 'lipat-voice'), shared by the page and the speech worker.
//   files: the model, one record per file, keyed `${model}/${file}`.
//   audio: prepared speech, one Ogg Opus file per sentence, by sentence key (see ReadAloud._key).
//   meta:  per sentence key { book, dur, size, at }, so questions about what is ready never read the audio itself.
//   books: book id -> when its audio was last made or played, to drop the least recently used first.

export const AUDIO_CAP = 1024 * 1024 * 1024; // about sixty hours of speech

let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('lipat-voice', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta').createIndex('book', 'book');
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books');
    };
    // another tab or the worker moved to a newer version: let it, and reopen next time
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
    r.onerror = () => { dbp = null; rej(r.error); };
    r.onblocked = () => {};
  });
  return dbp;
}
// One transaction. fn gets the stores and returns a request, or an object with a result getter read when it completes.
export const tx = (stores, mode, fn) => idb().then(db => new Promise((res, rej) => {
  const t = db.transaction(stores, mode), out = fn(...[].concat(stores).map(n => t.objectStore(n)));
  t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
}));
const collect = (init) => ({ value: init, get result() { return this.value; } });

export const getFile = (k) => tx('files', 'readonly', s => s.get(k));
export const putFile = (k, buf) => tx('files', 'readwrite', s => s.put(buf, k));
export const fileKeys = () => tx('files', 'readonly', s => s.getAllKeys());

export const getAudio = (k) => tx('audio', 'readonly', s => s.get(k));
export const hasAudio = (k) => tx('meta', 'readonly', s => s.getKey(k)).then(Boolean);
export async function putAudio(k, book, ogg, dur) {
  const at = Date.now();
  await tx(['audio', 'meta', 'books'], 'readwrite', (a, m, b) => { a.put(ogg, k); m.put({ book, dur, size: ogg.byteLength, at }, k); return b.put(at, book); });
}
export const touchBook = (book) => tx('books', 'readwrite', s => s.put(Date.now(), book)).catch(() => {});

// seconds of speech stored under each key, 0 when it isn't
export function durations(keys) {
  return tx('meta', 'readonly', s => {
    const out = collect(new Array(keys.length).fill(0));
    keys.forEach((k, i) => { const r = s.get(k); r.onsuccess = () => { if (r.result) out.value[i] = r.result.dur; }; });
    return out;
  });
}
// bytes stored in all, and bytes and seconds for one book
export function usage(book) {
  return tx('meta', 'readonly', s => {
    const out = collect({ bytes: 0, book: 0, seconds: 0 }), c = s.openCursor();
    c.onsuccess = () => {
      const r = c.result; if (!r) return;
      out.value.bytes += r.value.size;
      if (r.value.book === book) { out.value.book += r.value.size; out.value.seconds += r.value.dur; }
      r.continue();
    };
    return out;
  });
}
// a book's prepared speech, or all of it (book null)
export function forgetAudio(book) {
  return tx(['audio', 'meta', 'books'], 'readwrite', (a, m, b) => {
    if (book == null) { a.clear(); m.clear(); return b.clear(); }
    const c = m.index('book').openKeyCursor(IDBKeyRange.only(book));
    c.onsuccess = () => { const r = c.result; if (!r) return; a.delete(r.primaryKey); m.delete(r.primaryKey); r.continue(); };
    return b.delete(book);
  });
}
// Over the cap: drop whole books, least recently used first, never `keep`.
export async function evict(keep, cap = AUDIO_CAP) {
  for (let i = 0; i < 50 && (await usage(keep)).bytes > cap; i++) {
    const books = await tx('books', 'readonly', s => {
      const out = collect([]), c = s.openCursor();
      c.onsuccess = () => { const r = c.result; if (r) { out.value.push([r.key, r.value]); r.continue(); } };
      return out;
    });
    const old = books.filter(([b]) => b !== keep).sort((x, y) => x[1] - y[1])[0];
    if (!old) return;
    await forgetAudio(old[0]);
  }
}
export const forgetAll = () => tx(['files', 'audio', 'meta', 'books'], 'readwrite', (f, a, m, b) => { f.clear(); a.clear(); m.clear(); return b.clear(); });
