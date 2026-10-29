// App shell: shelf, import, global marks view, settings, Google Drive sync, PWA plumbing.
import { db, uid } from './db.js';
import { parseFile } from './formats.js';
import { Reader, EMOJIS, DEFAULT_PREFS, applyPrefs, isMobile } from './reader.js';
import { Drive, DriveError } from './drive.js';
import { bookMarkdown, reactionMarkdown, indexMarkdown, allMarksMarkdown, safeName, REACTIONS } from './export.js';
import { GOOGLE_CLIENT_ID } from './config.js';
export const BUILD = '2026-10-29.3';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------ toast
let toastTimer = null;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button>${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { hideToast(); action.fn(); };
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2600);
}
function hideToast() { const t = $('#toast'); t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 250); }

// ------------------------------------------------------------ state
const state = { books: [], marks: [], prefs: { ...DEFAULT_PREFS }, libtab: 'shelf', markFilter: '', markBook: '', markQuery: '' };
const sync = { settings: { clientId: '', connected: false, folders: null, files: {}, dirty: [], lastSync: 0 }, drive: null, timer: null, busy: false, status: 'off', message: '' };
let reader = null;
const coverUrls = new Map();

function coverUrl(book) {
  if (!book.cover) return null;
  if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.cover));
  return coverUrls.get(book.id);
}
const PALETTE = ['#2f4a3d', '#3b4653', '#4a4742', '#52443b', '#36443a', '#3f3e4b', '#45524a', '#4b4b4b'];
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };

// chapter names for the Drive files: section heading, else the first TOC entry pointing at it
function sectionTitlesOf(sections, toc) {
  const t = Object.fromEntries(sections.map(s => [s.id, s.title || '']));
  for (const e of toc || []) if (e.sectionId && !t[e.sectionId] && e.title) t[e.sectionId] = e.title;
  return t;
}

// ------------------------------------------------------------ library
async function loadAll() {
  state.books = (await db.listBooks()).sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
  state.marks = await db.listMarks();
  renderShelf(); renderMarksTab(); updateMarksCount(); renderStorage();
}
function updateMarksCount() { $$('.marks-count').forEach(el => el.textContent = state.marks.length || ''); }

function coverHtml(b) {
  const url = coverUrl(b);
  return url ? `<img src="${url}" alt="">` : `<div class="gen" style="background:${hue(b.title)}"><i>${esc(b.author || b.format)}</i><b>${esc(b.title)}</b></div>`;
}
function renderResume() {
  const el = $('#resume');
  const b = state.books.filter(x => x.lastOpened && (x.progress?.pct || 0) > 0.005 && (x.progress?.pct || 0) < 0.995).sort((x, y) => y.lastOpened - x.lastOpened)[0];
  if (!b) { el.innerHTML = ''; return; }
  const pct = Math.round(b.progress.pct * 100);
  el.innerHTML = `<button class="resume" data-id="${b.id}">
    <div class="cover">${coverHtml(b)}</div>
    <div class="resume-body">
      <span class="resume-kicker">Continue reading</span>
      <span class="resume-title">${esc(b.title)}</span>
      <span class="resume-sub">${b.author ? esc(b.author) + ', ' : ''}${pct}% read</span>
      <div class="resume-bar"><i style="width:${pct}%"></i></div>
    </div>
    <span class="btn primary desktop-only">Continue</span>
  </button>`;
  el.querySelector('.resume').onclick = () => openBook(b.id);
}
function renderShelf() {
  const shelf = $('#shelf');
  $('#shelf-empty').hidden = state.books.length > 0;
  renderResume();
  $('#shelf-head').hidden = !state.books.length;
  $('#shelf-count').textContent = state.books.length ? `${state.books.length} book${state.books.length === 1 ? '' : 's'}` : '';
  shelf.innerHTML = state.books.map(b => {
    const pct = Math.round((b.progress?.pct || 0) * 100);
    const n = state.marks.filter(m => m.bookId === b.id).length;
    return `<div class="book" data-id="${b.id}" role="button" tabindex="0">
      <div class="cover">${coverHtml(b)}${pct > 0 ? `<div class="prog"><i style="width:${pct}%"></i></div>` : ''}</div>
      <div class="book-title">${esc(b.title)}</div>
      <div class="book-sub"><span class="fmt">${b.format}</span>${n ? `<span>${n} mark${n === 1 ? '' : 's'}</span>` : ''}${pct > 0 ? `<span>${pct}%</span>` : ''}</div>
      <button class="book-x" title="Remove from shelf" aria-label="Remove"><i class="ph ph-x" aria-hidden="true"></i></button>
    </div>`;
  }).join('');
}
$('#shelf').addEventListener('click', async (ev) => {
  const x = ev.target.closest('.book-x');
  const card = ev.target.closest('.book');
  if (!card) return;
  const id = card.dataset.id;
  if (x) { ev.stopPropagation(); return removeBook(id); }
  if (card.classList.contains('show-x')) { card.classList.remove('show-x'); return; }
  openBook(id);
});
$('#shelf').addEventListener('keydown', (ev) => { const card = ev.target.closest('.book'); if (card && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openBook(card.dataset.id); } });
// long-press on a cover reveals "remove" on touch screens
let pressT = null;
$('#shelf').addEventListener('touchstart', (ev) => { const card = ev.target.closest('.book'); if (!card) return; pressT = setTimeout(() => { $$('.book.show-x').forEach(c => c.classList.remove('show-x')); card.classList.add('show-x'); if (navigator.vibrate) navigator.vibrate(10); }, 550); }, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach(t => $('#shelf').addEventListener(t, () => clearTimeout(pressT), { passive: true }));
$('#shelf').addEventListener('contextmenu', (ev) => { const card = ev.target.closest('.book'); if (card && isMobile()) ev.preventDefault(); });

async function removeBook(id) {
  const b = state.books.find(x => x.id === id);
  const n = state.marks.filter(m => m.bookId === id).length;
  if (!confirm(`Remove “${b.title}” from the shelf?${n ? `\nThis also removes ${n} mark${n === 1 ? '' : 's'} here (the Drive file stays).` : ''}`)) return;
  await db.deleteBook(id);
  await loadAll();
  toast('Removed');
}

async function openBook(id) {
  const book = await db.getBook(id);
  if (!book) return;
  book.coverUrl = coverUrl(book);
  book.sectionTitles = sectionTitlesOf(book.sections, book.toc); db.updateBook(id, { sectionTitles: book.sectionTitles });
  $('#view-library').hidden = true;
  await reader.open(book);
}

// ------------------------------------------------------------ import
async function importFiles(files) {
  files = Array.from(files).filter(f => f.size > 0);
  if (!files.length) return;
  const prog = $('#import-progress'), txt = $('#import-text');
  prog.hidden = false;
  let ok = 0, lastId = null;
  for (const f of files) {
    try {
      txt.textContent = files.length > 1 ? `Reading ${f.name}` : 'Reading';
      const parsed = await parseFile(f, (msg) => { txt.textContent = (files.length > 1 ? f.name + ': ' : '') + msg; });
      const id = uid();
      for (const s of parsed.sections) s.words = (s.html.replace(/<[^>]+>/g, ' ').match(/\S+/g) || []).length;
      const book = {
        id, title: parsed.title, author: parsed.author, format: parsed.format, cover: parsed.cover, sections: parsed.sections, toc: parsed.toc,
        sectionTitles: sectionTitlesOf(parsed.sections, parsed.toc),
        pageCount: parsed.pageCount, isScanned: !!parsed.isScanned, words: parsed.sections.reduce((n, s) => n + s.words, 0),
        addedAt: Date.now(), lastOpened: 0, progress: null, fileName: f.name, size: f.size,
      };
      await db.putBook(book);
      if (parsed.format === 'pdf') await db.putFile(id, f);
      ok++; lastId = id;
      if (files.length > 1) await loadAll();
    } catch (e) {
      console.error(e);
      toast(`Couldn't read ${f.name}`);
    }
  }
  prog.hidden = true;
  await loadAll();
  if (ok === 1 && files.length === 1 && lastId) openBook(lastId);
  else if (ok) toast(`Added ${ok} book${ok === 1 ? '' : 's'}`);
}
$('#file-input').addEventListener('change', (ev) => { importFiles(ev.target.files); ev.target.value = ''; });
const pickFiles = () => $('#file-input').click();
$('#btn-add').onclick = pickFiles;
$('#btn-add-empty').onclick = pickFiles;
$('.tabbar [data-act="add"]').onclick = pickFiles;

let dragDepth = 0;
window.addEventListener('dragenter', (ev) => { if (!ev.dataTransfer?.types?.includes('Files')) return; dragDepth++; $('#drop-overlay').hidden = false; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
window.addEventListener('dragover', (ev) => { ev.preventDefault(); });
window.addEventListener('drop', (ev) => { ev.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true; if (ev.dataTransfer?.files?.length) importFiles(ev.dataTransfer.files); });

// ------------------------------------------------------------ library tabs
$$('[data-libtab]').forEach(b => b.onclick = () => showLibTab(b.dataset.libtab));
function showLibTab(t) {
  state.libtab = t;
  $$('[data-libtab]').forEach(b => b.classList.toggle('is-active', b.dataset.libtab === t));
  $$('.libtab').forEach(p => p.classList.toggle('is-active', p.id === 'libtab-' + t));
  $('#lib-title').textContent = !isMobile() || t === 'shelf' ? 'Dogear' : t === 'marks' ? 'Marks' : 'Settings';
  if (t === 'marks') renderMarksTab();
  if (t === 'settings') renderDriveStatus();
}

// ------------------------------------------------------------ marks tab
$('#marks-emoji-filter').innerHTML = `<button data-f="" class="is-active" title="All"><i class="ph ph-asterisk" aria-hidden="true"></i></button>` + EMOJIS.map(x => `<button data-f="${x.e}" title="${x.label}">${x.e}</button>`).join('') + `<button data-f="bm" title="Bookmarks"><i class="ph-fill ph-bookmark-simple" aria-hidden="true"></i></button>`;
$('#marks-emoji-filter').onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; state.markFilter = b.dataset.f; $$('#marks-emoji-filter button').forEach(x => x.classList.toggle('is-active', x === b)); renderMarksTab(); };
$('#marks-search').oninput = (ev) => { state.markQuery = ev.target.value.trim().toLowerCase(); renderMarksTab(); };
$('#marks-book-filter').onchange = (ev) => { state.markBook = ev.target.value; renderMarksTab(); };

function filteredMarks() {
  let list = state.marks.slice();
  if (state.markFilter === 'bm') list = list.filter(m => m.type === 'bookmark');
  else if (state.markFilter) list = list.filter(m => m.emoji === state.markFilter);
  if (state.markBook) list = list.filter(m => m.bookId === state.markBook);
  if (state.markQuery) list = list.filter(m => (m.text + ' ' + (m.note || '')).toLowerCase().includes(state.markQuery));
  return list;
}
function markOrder(m) {
  const si = Number(String(m.sectionId || 's0').slice(1)) || 0;
  return si * 1e7 + (m.type === 'bookmark' ? (m.blockIndex || 0) * 1e3 : (m.start || 0));
}
function renderMarksTab() {
  const bookById = Object.fromEntries(state.books.map(b => [b.id, b]));
  $$('#marks-emoji-filter button').forEach(b => {
    const k = b.dataset.f;
    const n = k === '' ? state.marks.length : k === 'bm' ? state.marks.filter(m => m.type === 'bookmark').length : state.marks.filter(m => m.emoji === k).length;
    let badge = b.querySelector('.n'); if (!badge) { badge = document.createElement('span'); badge.className = 'n'; b.appendChild(badge); }
    badge.textContent = n || ''; badge.hidden = !n;
  });
  const sel = $('#marks-book-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All books</option>' + state.books.filter(b => state.marks.some(m => m.bookId === b.id)).map(b => `<option value="${b.id}">${esc(b.title)}</option>`).join('');
  sel.value = cur;
  const list = filteredMarks();
  $('#marks-empty').hidden = state.marks.length > 0;
  const wrap = $('#marks-list');
  if (!list.length) { wrap.innerHTML = state.marks.length ? '<div class="no-match">No marks match.</div>' : ''; return; }
  const groups = new Map();
  for (const m of list) { if (!groups.has(m.bookId)) groups.set(m.bookId, []); groups.get(m.bookId).push(m); }
  const order = Array.from(groups.keys()).sort((a, b) => (bookById[b]?.lastOpened || 0) - (bookById[a]?.lastOpened || 0));
  wrap.innerHTML = order.map(bid => {
    const b = bookById[bid]; const ms = groups.get(bid).sort((x, y) => markOrder(x) - markOrder(y));
    return `<div class="mgroup"><h3>${esc(b?.title || 'Unknown book')} <small>${ms.length}</small></h3>` + ms.map(m => `
      <button class="mcard ${m.type === 'bookmark' ? 'bm' : ''}" data-id="${m.id}">
        <span class="em">${m.type === 'bookmark' ? '<i class="ph-fill ph-bookmark-simple" aria-hidden="true"></i>' : (m.emoji || '<i class="ph ph-note-pencil" aria-hidden="true"></i>')}</span>
        <span class="q">${esc(m.text)}</span>
        ${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}
        <span class="meta">${m.page ? `<span>p. ${m.page}</span>` : ''}<span>${new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span></span>
      </button>`).join('') + '</div>';
  }).join('');
}
$('#marks-list').addEventListener('click', async (ev) => {
  const card = ev.target.closest('.mcard'); if (!card) return;
  const m = state.marks.find(x => x.id === card.dataset.id); if (!m) return;
  await openBook(m.bookId);
  setTimeout(() => reader.gotoMark(m, true), 150);
});

// download everything as one Markdown file
$('#btn-export').onclick = async () => {
  if (!state.marks.length) { toast('Nothing to export'); return; }
  const titles = {};
  for (const b of state.books) if (b.sectionTitles) titles[b.id] = b.sectionTitles;
  const md = allMarksMarkdown(state.books, state.marks, titles);
  const blob = new Blob([md], { type: 'text/markdown' });
  const file = new File([blob], 'dogear-marks.md', { type: 'text/markdown' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && isMobile()) { try { await navigator.share({ files: [file], title: 'Dogear marks' }); return; } catch {} }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dogear-marks.md'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

// ------------------------------------------------------------ theme
$('#btn-theme').onclick = () => {
  const order = ['paper', 'sepia', 'mist', 'night'];
  state.prefs.theme = order[(order.indexOf(state.prefs.theme) + 1) % order.length];
  applyPrefs(state.prefs); db.setSetting('prefs', state.prefs);
};
document.addEventListener('keydown', (ev) => {
  if (!$('#view-reader').hidden) return;
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (ev.key === 't' || ev.key === 'T') $('#btn-theme').click();
  if (ev.key === 'o' || ev.key === 'O') pickFiles();
});

// ------------------------------------------------------------ Google Drive sync
const DRIVE_FOLDER = 'Dogear';
function setSyncStatus(status, message = '') {
  sync.status = status; sync.message = message; renderDriveStatus();
}
function renderDriveStatus() {
  const el = $('#drive-status'), s = sync.settings;
  const connect = $('#btn-drive-connect'), now = $('#btn-drive-sync'), off = $('#btn-drive-disconnect');
  $('#origin-hint').textContent = location.origin;
  if ($('#drive-client-id').value !== s.clientId) $('#drive-client-id').value = s.clientId;
  let cls = '', text = '';
  if (!s.clientId) { text = 'Not set up yet. Open Setup below.'; }
  else if (!s.connected) { text = 'Not connected.'; }
  else if (sync.status === 'busy') { cls = 'busy'; text = sync.message || 'Syncing…'; }
  else if (sync.status === 'error') { cls = 'err'; text = sync.message || 'Sync failed.'; }
  else if (sync.status === 'auth') { cls = 'err'; text = 'Google asked to sign in again. Tap “Sync now”.'; }
  else { cls = 'ok'; text = s.lastSync ? `Synced ${timeAgo(s.lastSync)}${s.dirty.length ? `, ${s.dirty.length} book${s.dirty.length === 1 ? '' : 's'} pending` : ''}` : 'Connected. Nothing synced yet.'; }
  el.className = 'drive-status ' + cls;
  el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
  connect.hidden = !s.clientId || s.connected;
  connect.disabled = !s.clientId;
  now.hidden = !s.connected; off.hidden = !s.connected;
  $('#drive-setup').open = !s.clientId;
}
const timeAgo = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString(); };
async function saveSyncSettings() { await db.setSetting('drive', sync.settings); }

$('#drive-client-id').addEventListener('change', async (ev) => {
  sync.settings.clientId = ev.target.value.trim();
  sync.drive = sync.settings.clientId ? new Drive(sync.settings.clientId) : null;
  await saveSyncSettings(); renderDriveStatus();
});
$('#btn-drive-connect').onclick = async () => {
  if (!sync.drive) return;
  try {
    setSyncStatus('busy', 'Signing in…');
    await sync.drive.token({ interactive: true });
    sync.settings.connected = true; sync.settings.dirty = state.books.filter(b => state.marks.some(m => m.bookId === b.id)).map(b => b.id);
    await saveSyncSettings();
    toast('Google Drive connected');
    await syncDrive({ force: true });
  } catch (e) { setSyncStatus('error', e.message || 'Sign-in failed'); }
};
$('#btn-drive-sync').onclick = () => syncDrive({ force: true, interactive: true });
$('#btn-drive-disconnect').onclick = async () => {
  if (!confirm('Disconnect Google Drive? Files already in Drive stay there.')) return;
  sync.drive?.forget();
  sync.settings.connected = false; sync.settings.folders = null; sync.settings.files = {}; sync.settings.dirty = [];
  await saveSyncSettings(); setSyncStatus('off');
};

function markDirty(bookId) {
  if (!bookId) return;
  if (!sync.settings.dirty.includes(bookId)) sync.settings.dirty.push(bookId);
  saveSyncSettings();
  if (sync.settings.connected) { clearTimeout(sync.timer); sync.timer = setTimeout(() => syncDrive(), 15000); }
  renderDriveStatus();
}
window.addEventListener('online', () => { if (sync.settings.connected && sync.settings.dirty.length) syncDrive(); });

async function syncDrive({ force = false, interactive = false } = {}) {
  const s = sync.settings;
  if (!sync.drive || !s.connected || sync.busy) return;
  if (!navigator.onLine) { setSyncStatus('error', 'Offline. Will sync when back online.'); return; }
  if (!force && !s.dirty.length) return;
  sync.busy = true;
  try {
    setSyncStatus('busy', 'Syncing…');
    if (!sync.drive.hasToken) await sync.drive.token({ interactive });
    // folders
    if (!s.folders) {
      const root = await sync.drive.ensureFolder(DRIVE_FOLDER);
      s.folders = { root, books: await sync.drive.ensureFolder('Books', root), reactions: await sync.drive.ensureFolder('By reaction', root) };
      await saveSyncSettings();
    }
    const booksById = Object.fromEntries(state.books.map(b => [b.id, b]));
    const dirtyIds = force ? state.books.filter(b => state.marks.some(m => m.bookId === b.id)).map(b => b.id) : s.dirty.slice();
    let n = 0;
    for (const id of dirtyIds) {
      const b = booksById[id]; if (!b) { s.dirty = s.dirty.filter(x => x !== id); continue; }
      const marks = state.marks.filter(m => m.bookId === id);
      setSyncStatus('busy', `Writing ${b.title}…`);
      let titles = b.sectionTitles;
      if (!titles || Object.values(titles).some(t => !t)) { const full = await db.getBook(id); titles = sectionTitlesOf(full.sections, full.toc); await db.updateBook(id, { sectionTitles: titles }); }
      const fid = await sync.drive.upsertMarkdown({ name: safeName(b.title) + '.md', parentId: s.folders.books, content: bookMarkdown(b, marks, titles), props: { key: 'dogearBookId', value: id }, fileId: s.files[id] });
      s.files[id] = fid; s.dirty = s.dirty.filter(x => x !== id); n++;
      await saveSyncSettings();
    }
    setSyncStatus('busy', 'Updating reaction files…');
    for (const r of [...REACTIONS.map(r => ({ key: r.e, name: `${r.e} ${r.label}.md` })), { key: 'bm', name: '🔖 Bookmarks.md' }]) {
      const fid = await sync.drive.upsertMarkdown({ name: r.name, parentId: s.folders.reactions, content: reactionMarkdown(r.key, booksById, state.marks), props: { key: 'dogearReaction', value: r.key }, fileId: s.files['r:' + r.key] });
      s.files['r:' + r.key] = fid;
    }
    const idx = await sync.drive.upsertMarkdown({ name: 'Index.md', parentId: s.folders.root, content: indexMarkdown(state.books, state.marks), props: { key: 'dogearIndex', value: '1' }, fileId: s.files['index'] });
    s.files['index'] = idx;
    s.lastSync = Date.now();
    await saveSyncSettings();
    setSyncStatus('ok');
    if (force) toast(`Drive updated, ${n} book${n === 1 ? '' : 's'}`);
  } catch (e) {
    console.warn('sync', e);
    if (e instanceof DriveError && (e.code === 'auth' || /popup|access_denied|no_token|cancel/i.test(e.code))) {
      if (e.code === 'http404' || e.code === 'http403') { s.folders = null; }
      setSyncStatus('auth');
    } else if (e instanceof DriveError && e.code === 'http404') { s.folders = null; s.files = {}; await saveSyncSettings(); setSyncStatus('error', 'Drive folder moved. Tap Sync now to recreate it.'); }
    else setSyncStatus('error', e.message || 'Sync failed');
  } finally { sync.busy = false; renderDriveStatus(); }
}

// ------------------------------------------------------------ PWA: install, share inbox, file handlers
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#btn-install').hidden = false; });
$('#btn-install').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#btn-install').hidden = true; };
async function drainInbox() {
  if (!('caches' in window)) return;
  try {
    const inbox = await caches.open('dogear-inbox');
    const keys = await inbox.keys();
    const files = [];
    for (const req of keys) {
      const res = await inbox.match(req);
      const name = decodeURIComponent(res.headers.get('X-Name') || req.url.split('/').pop().replace(/^\d+-/, ''));
      files.push(new File([await res.blob()], name, { type: res.headers.get('Content-Type') || '' }));
      await inbox.delete(req);
    }
    if (files.length) importFiles(files);
  } catch {}
}
if ('launchQueue' in window) window.launchQueue.setConsumer(async (p) => { if (p.files?.length) importFiles(await Promise.all(p.files.map(h => h.getFile()))); });
function renderStorage() {
  $('#build-info').textContent = 'Dogear build ' + BUILD;
  const el = $('#storage-info');
  const n = state.books.length;
  el.textContent = `${n} book${n === 1 ? '' : 's'} and ${state.marks.length} mark${state.marks.length === 1 ? '' : 's'} stored in this browser.`;
  if (navigator.storage?.estimate) navigator.storage.estimate().then(e => { if (e.usage) el.textContent += ` ${(e.usage / 1048576).toFixed(1)} MB used.`; });
}

// ------------------------------------------------------------ boot
(async function boot() {
  const saved = await db.getSetting('prefs', null);
  if (saved) Object.assign(state.prefs, saved);
  applyPrefs(state.prefs);
  const ds = await db.getSetting('drive', null);
  if (ds) Object.assign(sync.settings, ds);
  if (!sync.settings.clientId && GOOGLE_CLIENT_ID) sync.settings.clientId = GOOGLE_CLIENT_ID;
  if (sync.settings.clientId) sync.drive = new Drive(sync.settings.clientId);
  reader = new Reader({
    prefs: state.prefs,
    toast,
    onBack: async () => { $('#view-library').hidden = false; await loadAll(); if (sync.settings.connected && sync.settings.dirty.length) syncDrive(); },
    onMarksChanged: async (bookId) => { state.marks = await db.listMarks(); updateMarksCount(); markDirty(bookId); },
  });
  await loadAll();
  renderDriveStatus();
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('nosw')) navigator.serviceWorker.register('sw.js').catch(() => {});
  drainInbox();
  if (sync.settings.connected && sync.settings.dirty.length && sync.drive?.hasToken) syncDrive();
})();

window.dogear = { importFiles, openBook, loadAll, syncDrive, get state() { return state; }, get reader() { return reader; }, get sync() { return sync; } };
