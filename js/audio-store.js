// Speech the natural voices have made, kept on the device (IndexedDB lipat-audio) so a chapter made once plays at once
// later: after closing the book, the app, or the phone. Opus keeps an hour of listening near 15 MB (see clip.js).
//
// Keys are "<book>|<voice>|<section>|<text hash>", so a chapter's sentences are one key range. Two stores: meta holds
// { dur, bytes, at } and is read a chapter at a time to know what is ready; clips holds the audio, read one sentence at
// a time just before it plays. When everything passes CAP, the chapters made longest ago go first, never the ones
// around where the reader is.
import { clipBytes, clipSeconds } from './clip.js';

const CAP = 400e6;
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
    if (++puts % 100 === 1) this.sweep(keep).catch(() => {});
  },
  // delete every key that starts with prefix (a book), or whose voice starts with voice (a model)
  async forget({ prefix, voice }) {
    if (prefix) return tx(['meta', 'clips'], 'readwrite', (meta, clips) => { meta.delete(range(prefix)); clips.delete(range(prefix)); });
    const keys = await tx(['meta'], 'readonly', (meta) => meta.getAllKeys());
    const gone = keys.filter(k => k.split('|')[1].startsWith(voice));
    if (gone.length) await tx(['meta', 'clips'], 'readwrite', (meta, clips) => { for (const k of gone) { meta.delete(k); clips.delete(k); } });
  },
  // keep: chapter prefixes not to drop
  async sweep(keep = []) {
    const groups = new Map();
    let total = 0;
    await tx(['meta'], 'readonly', (meta) => {
      const req = meta.openCursor();
      req.onsuccess = () => {
        const c = req.result; if (!c) return;
        const p = c.key.slice(0, c.key.lastIndexOf('|') + 1), g = groups.get(p) || { bytes: 0, at: 0 };
        g.bytes += c.value.bytes; g.at = Math.max(g.at, c.value.at); groups.set(p, g); total += c.value.bytes;
        c.continue();
      };
    });
    if (total <= CAP) return;
    for (const [p, g] of [...groups].filter(([p]) => !keep.includes(p)).sort((a, b) => a[1].at - b[1].at)) {
      if (total <= CAP * 0.9) break;
      await this.forget({ prefix: p }); total -= g.bytes;
    }
  },
};
