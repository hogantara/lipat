// Speech the natural voices have made, kept on the device (IndexedDB lipat-audio) so a chapter made once plays at once
// later: after closing the book, the app, or the phone. Opus keeps an hour of listening near 16 MB (see clip.js).
//
// Keys are "<book>|<voice>|<section>|<text hash>", so a chapter's sentences are one key range. Two stores: meta holds
// { dur, bytes, at } and is read a chapter at a time to know what is ready; clips holds the audio, read one sentence at
// a time just before it plays.
//
// So it never fills the device:
// - in the open book, speech more than a chapter behind the reader goes (behind(), called by speech.js);
// - a book not opened for two weeks, or gone from the shelf, loses its speech (tidy(), when the app starts);
// - all of it stays under the smaller of 300 MB and a tenth of the free space: past that the chapters made longest ago
//   go first, never the ones where the reader is (tidy(), and every hundred sentences made);
// - removing a book or a voice removes its speech, and Settings can clear it all.
import { clipBytes, clipSeconds } from './clip.js';

const CAP = 300e6, FREE_SHARE = 0.1, IDLE = 14 * 864e5;
let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('lipat-audio', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('clips'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = (stores, mode, fn) => idb().then(db => new Promise((res, rej) => {
  const t = db.transaction(stores, mode), out = fn(...stores.map(s => t.objectStore(s)));
  t.oncomplete = () => res(out && 'result' in out ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
}));
const range = (prefix) => IDBKeyRange.bound(prefix, prefix + '\uffff');

// FNV-1a of the sentence, with its length: the same words in the same voice are the same audio
export function textHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
export const chapterKey = (book, voice, si) => `${book}|${voice}|${si}|`;

let puts = 0;
export const audioStore = {
  gen: 0, // goes up whenever speech is deleted, so what callers know of the store is read again
  // what is made of a chapter: Map of text hash -> seconds
  async chapter(prefix) {
    const m = new Map();
    await tx(['meta'], 'readonly', (meta) => {
      const req = meta.openCursor(range(prefix));
      req.onsuccess = () => { const c = req.result; if (!c) return; m.set(c.key.slice(prefix.length), c.value.dur); c.continue(); };
    });
    return m;
  },
  get: (key) => tx(['clips'], 'readonly', (clips) => clips.get(key)),
  async put(key, clip, keep) {
    await tx(['meta', 'clips'], 'readwrite', (meta, clips) => {
      clips.put(clip, key);
      meta.put({ dur: clipSeconds(clip), bytes: clipBytes(clip), at: Date.now() }, key);
    });
    if (++puts % 100 === 1) this.tidy({ keep }).catch(() => {});
  },
  // delete every key that starts with prefix (a book), or whose voice starts with voice (a model)
  async forget({ prefix, voice }) {
    this.gen++;
    if (prefix) return tx(['meta', 'clips'], 'readwrite', (meta, clips) => { meta.delete(range(prefix)); clips.delete(range(prefix)); });
    const keys = await tx(['meta'], 'readonly', (meta) => meta.getAllKeys());
    const gone = keys.filter(k => k.split('|')[1].startsWith(voice));
    if (gone.length) await tx(['meta', 'clips'], 'readwrite', (meta, clips) => { for (const k of gone) { meta.delete(k); clips.delete(k); } });
  },
  // per chapter: Map of chapter key -> { book, si, bytes, at }, and the total bytes
  async _chapters() {
    const groups = new Map();
    let total = 0;
    await tx(['meta'], 'readonly', (meta) => {
      const req = meta.openCursor();
      req.onsuccess = () => {
        const c = req.result; if (!c) return;
        const p = c.key.slice(0, c.key.lastIndexOf('|') + 1);
        let g = groups.get(p);
        if (!g) { const [book, , si] = p.split('|'); groups.set(p, g = { book, si: Number(si), bytes: 0, at: 0 }); }
        g.bytes += c.value.bytes; g.at = Math.max(g.at, c.value.at); total += c.value.bytes;
        c.continue();
      };
    });
    return { groups, total };
  },
  // bytes of speech kept
  async size() { return (await this._chapters()).total; },
  async _cap() {
    let free = Infinity;
    try { const e = await navigator.storage.estimate(); if (e.quota) free = Math.max(0, e.quota - (e.usage || 0)); } catch {}
    return Math.min(CAP, free * FREE_SHARE);
  },
  // books: the shelf, [{ id, lastOpened, addedAt }] (without it, only the size rule); keep: chapter keys not to drop
  async tidy({ books = null, keep = [] } = {}) {
    const { groups, total } = await this._chapters(), now = Date.now();
    let left = total;
    const drop = [];
    if (books) {
      const shelf = new Map(books.map(b => [b.id, b.lastOpened || b.addedAt || 0]));
      for (const [p, g] of groups) {
        const opened = shelf.get(g.book);
        if (opened == null || now - opened > IDLE) { drop.push(p); left -= g.bytes; groups.delete(p); }
      }
    }
    const cap = await this._cap();
    if (left > cap) {
      for (const [p, g] of [...groups].filter(([p]) => !keep.includes(p)).sort((a, b) => a[1].at - b[1].at)) {
        if (left <= cap * 0.9) break;
        drop.push(p); left -= g.bytes;
      }
    }
    for (const p of drop) await this.forget({ prefix: p });
  },
  // the open book: drop every voice's speech for sections before si
  async behind(book, si) {
    const keys = await tx(['meta'], 'readonly', (meta) => meta.getAllKeys(range(book + '|')));
    const gone = keys.filter(k => Number(k.split('|')[2]) < si);
    if (gone.length) { this.gen++; await tx(['meta', 'clips'], 'readwrite', (meta, clips) => { for (const k of gone) { meta.delete(k); clips.delete(k); } }); }
    return gone.length;
  },
  async clear() { this.gen++; await tx(['meta', 'clips'], 'readwrite', (meta, clips) => { meta.clear(); clips.clear(); }); },
};
