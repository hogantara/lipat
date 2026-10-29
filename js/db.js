// Tiny IndexedDB layer. Stores: books, files (original blobs), marks, settings.
const DB_NAME = 'dogear';
const DB_VERSION = 2;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('content')) {
        db.createObjectStore('content', { keyPath: 'id' });
        // v1 kept sections inside the book record; move them out so the shelf loads light.
        if (ev.oldVersion >= 1) {
          const t = req.transaction;
          const books = t.objectStore('books'), content = t.objectStore('content');
          books.openCursor().onsuccess = (e) => {
            const c = e.target.result; if (!c) return;
            const b = c.value;
            if (b.sections) { content.put({ id: b.id, sections: b.sections }); delete b.sections; c.update(b); }
            c.continue();
          };
        }
      }
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('marks')) {
        const s = db.createObjectStore('marks', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqResult = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  // books ---------------------------------------------------------------
  // listBooks returns light metadata only; getBook also loads the parsed sections.
  async listBooks() { return tx('books', 'readonly', s => reqResult(s.getAll())).then(r => r || []); },
  async getBookMeta(id) { return tx('books', 'readonly', s => reqResult(s.get(id))); },
  async getBook(id) {
    const meta = await this.getBookMeta(id);
    if (!meta) return null;
    const c = await tx('content', 'readonly', s => reqResult(s.get(id)));
    return { ...meta, sections: (c && c.sections) || [] };
  },
  async putBook(book) {
    const { sections, ...meta } = book;
    await tx('books', 'readwrite', s => s.put(meta));
    if (sections) await tx('content', 'readwrite', s => s.put({ id: book.id, sections }));
  },
  async deleteBook(id) {
    await tx('books', 'readwrite', s => s.delete(id));
    await tx('content', 'readwrite', s => s.delete(id));
    await tx('files', 'readwrite', s => s.delete(id));
    const marks = await this.marksForBook(id);
    await tx('marks', 'readwrite', s => { marks.forEach(m => s.delete(m.id)); });
  },
  // read-modify-write in one transaction, so a book deleted meanwhile is never resurrected
  async updateBook(id, patch) {
    let out = null;
    await tx('books', 'readwrite', s => { const r = s.get(id); r.onsuccess = () => { const b = r.result; if (!b) return; Object.assign(b, patch); out = b; s.put(b); }; });
    return out;
  },
  // files ---------------------------------------------------------------
  async putFile(id, blob) { return tx('files', 'readwrite', s => s.put({ id, blob })); },
  async getFile(id) { return tx('files', 'readonly', s => reqResult(s.get(id))).then(r => r && r.blob); },
  // marks ---------------------------------------------------------------
  async listMarks() { return tx('marks', 'readonly', s => reqResult(s.getAll())).then(r => r || []); },
  async marksForBook(bookId) { return tx('marks', 'readonly', s => reqResult(s.index('bookId').getAll(bookId))).then(r => r || []); },
  async putMark(mark) { return tx('marks', 'readwrite', s => s.put(mark)); },
  async deleteMark(id) { return tx('marks', 'readwrite', s => s.delete(id)); },
  // settings ------------------------------------------------------------
  async getSetting(key, fallback) {
    const r = await tx('settings', 'readonly', s => reqResult(s.get(key)));
    return r ? r.value : fallback;
  },
  async setSetting(key, value) { return tx('settings', 'readwrite', s => s.put({ key, value })); },
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
