// The reading surface: rendering, position, typography, marks (reactions / notes / bookmarks),
// contents panel, in-book search, PDF original-layout mode.
import { db, uid } from './db.js';
import { getPdfjs } from './formats.js';

export const EMOJIS = [
  { e: '💡', label: 'Aha' },
  { e: '❤️', label: 'Love' },
  { e: '🤔', label: 'Hmm' },
  { e: '😮', label: 'Whoa' },
  { e: '😤', label: 'Nope' },
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const isMobile = () => window.innerWidth < 760;
const isTouch = () => matchMedia('(pointer: coarse)').matches;
// rAF never fires in a hidden tab; don't let opening a book hang on it.
const nextFrame = () => new Promise(r => { let done = false; const go = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(go); setTimeout(go, 60); });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DEFAULT_PREFS = { size: 19, font: 'serif', lh: '1.65', measure: '36', theme: 'paper', align: 'left' };

export function applyPrefs(prefs) {
  const r = document.documentElement.style;
  r.setProperty('--rd-size', prefs.size + 'px');
  r.setProperty('--rd-font', `var(--font-${prefs.font})`);
  r.setProperty('--rd-lh', prefs.lh);
  r.setProperty('--rd-measure', prefs.measure + 'em');
  r.setProperty('--rd-align', prefs.align);
  document.body.dataset.theme = prefs.theme;
}

export class Reader {
  constructor({ onBack, onMarksChanged, toast, prefs }) {
    this.onBack = onBack; this.onMarksChanged = onMarksChanged; this.toast = toast;
    this.prefs = prefs;
    this.view = $('#view-reader');
    this.scroller = $('#rd-scroller');
    this.content = $('#rd-content');
    this.pagesEl = $('#rd-pages');
    this.bubble = $('#sel-bubble');
    this.editor = $('#mark-editor');
    this.panel = $('#panel');
    this.typePop = $('#type-pop');
    this.slider = $('#rd-slider');
    this.book = null; this.marks = []; this.sectionEls = new Map(); this.textCache = new Map();
    this.pageMode = false; this.pdf = null; this.zoom = 1; this.pageObserver = null;
    this.editingMark = null; this.lastScroll = 0; this.saveTimer = null; this.pending = null; this.pendingEls = null;
    this._wire();
  }

  // ------------------------------------------------------------ wiring
  _wire() {
    this.scrim = $('#scrim');
    this.view.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]'); if (!b) return;
      switch (b.dataset.act) {
        case 'back': this.close(); break;
        case 'contents': this.togglePanel('toc'); break;
        case 'marks': this.togglePanel('marks'); break;
        case 'search': this.togglePanel('search', true); break;
        case 'bookmark': this.toggleBookmark(); break;
        case 'type': this.togglePop(); break;
        case 'layout': this.setPageMode(!this.pageMode); break;
      }
    });
    this.scrim.addEventListener('click', () => { this.togglePanel(null); this.typePop.hidden = true; this.closeEditor(); this._syncScrim(); });
    // swipe down on a sheet handle closes it
    $$('.sheet-handle', this.view).forEach(h => {
      let y0 = null;
      h.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
      h.addEventListener('touchmove', (e) => { if (y0 !== null && e.touches[0].clientY - y0 > 50) { y0 = null; this.togglePanel(null); this.typePop.hidden = true; this.closeEditor(); this._syncScrim(); } }, { passive: true });
    });
    $('.panel-close', this.panel).onclick = () => this.togglePanel(null);
    $$('.panel-tabs .tab', this.panel).forEach(b => b.onclick = () => this.showPanelTab(b.dataset.ptab));

    // emoji rows
    const rows = [$('.emoji-row', this.bubble), $('.emoji-row', this.editor)];
    rows.forEach(row => { row.innerHTML = EMOJIS.map(x => `<button data-emoji="${x.e}" data-label="${x.label}" title="${x.label}">${x.e}</button>`).join(''); });
    $('.emoji-row', this.bubble).onclick = (ev) => { const b = ev.target.closest('button'); if (b) this.keepSelection(b.dataset.emoji); };
    $('.bubble-note', this.bubble).onclick = () => this.keepSelection(null, true);
    $('.bubble-copy', this.bubble).onclick = async () => { const t = this.pending ? this.pending.text : window.getSelection().toString().trim(); try { await navigator.clipboard.writeText(t); this.toast('Copied'); } catch { this.toast('Copy blocked by browser'); } window.getSelection().removeAllRanges(); this.hideBubble(); };
    $('.emoji-row', this.editor).onclick = (ev) => {
      const b = ev.target.closest('button'); if (!b || !this.editingMark) return;
      const m = this.editingMark;
      m.emoji = m.emoji === b.dataset.emoji ? null : b.dataset.emoji;
      this._syncEditorEmoji(); this.saveMark(m);
    };
    $('.me-note', this.editor).oninput = (ev) => { if (this.editingMark) { this.editingMark.note = ev.target.value; this._queueSaveMark(this.editingMark); } };
    $('.me-done', this.editor).onclick = () => this.closeEditor();
    $('.me-delete', this.editor).onclick = () => { const m = this.editingMark; this.closeEditor(); if (m) this.deleteMark(m); };

    // selection
    document.addEventListener('selectionchange', () => {
      this._onSelectionChange();
      if (isTouch()) { clearTimeout(this._selT); this._selT = setTimeout(() => this._onSelectionChange(true), 500); }
    });
    this.scroller.addEventListener('mouseup', () => setTimeout(() => this._onSelectionChange(true), 10));
    // On touch, Chrome's own selection toolbar and Touch to Search ride on the native selection.
    // So the moment the finger lifts we take the range ourselves, drop the native selection, paint a
    // provisional highlight and show only our bubble. Drag to extend before lifting; tap away to cancel.
    this.scroller.addEventListener('touchend', () => setTimeout(() => this._takeSelection(), 0));
    if (isTouch()) this._wireTouchSelection();
    this.scroller.addEventListener('scroll', () => { if (this.pending) this._positionBubble(this._pendingRects()); }, { passive: true });

    // clicks in content
    this.content.addEventListener('click', (ev) => {
      if (Date.now() - (this._selEndAt || 0) < 500) { ev.preventDefault(); return; }
      const mark = ev.target.closest('mark.hl');
      if (mark && mark.classList.contains('pending')) { ev.preventDefault(); return; }
      if (this.pending) { ev.preventDefault(); this.hideBubble(); return; }
      if (mark) { ev.preventDefault(); const m = this.marks.find(x => x.id === mark.dataset.id); if (m) this.openEditor(m, mark); return; }
      const a = ev.target.closest('a[data-epub-target]');
      if (a) { ev.preventDefault(); this.gotoEpubTarget(a.dataset.epubTarget); return; }
      if (ev.target.closest('a')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (this.editor.hidden && this.bubble.hidden) this._toggleChrome();
    });

    // scroll
    this.scroller.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this.slider.addEventListener('input', () => { const max = this.scroller.scrollHeight - this.scroller.clientHeight; this.scroller.scrollTop = (this.slider.value / 1000) * max; });

    // outside clicks close popovers
    this.view.addEventListener('mousedown', (ev) => {
      if (!this.typePop.hidden && !ev.target.closest('#type-pop, [data-act="type"]')) this.typePop.hidden = true;
      if (!this.editor.hidden && !ev.target.closest('#mark-editor, mark.hl')) this.closeEditor();
      if (!this.panel.hidden && !ev.target.closest('#panel, .rd-top, .rd-bottom') && isMobile()) this.togglePanel(null);
      setTimeout(() => this._syncScrim(), 0);
    });

    // type settings
    const fs = $('#font-size');
    fs.oninput = () => this.setPref('size', Number(fs.value));
    $$('.step', this.typePop).forEach(b => b.onclick = () => this.setPref('size', clamp(this.prefs.size + Number(b.dataset.font), 14, 34)));
    const segs = { 'font-family': 'font', 'line-height': 'lh', 'measure': 'measure', 'theme-seg': 'theme', 'justify': 'align' };
    for (const [id, key] of Object.entries(segs)) {
      $('#' + id).onclick = (ev) => { const b = ev.target.closest('button'); if (b) this.setPref(key, b.dataset.v); };
    }
    this._syncTypeUI();

    // search
    const si = $('#search-input');
    let st = null;
    si.oninput = () => { clearTimeout(st); st = setTimeout(() => this.search(si.value), 180); };
    si.onkeydown = (ev) => { if (ev.key === 'Enter') { const first = $('#search-results button'); if (first) first.click(); } };
    $('#panel-emoji-filter').innerHTML = `<button data-f="" class="is-active" title="All"><i class="ph ph-asterisk" aria-hidden="true"></i></button>` + EMOJIS.map(x => `<button data-f="${x.e}" title="${x.label}">${x.e}</button>`).join('') + `<button data-f="bm" title="Bookmarks"><i class="ph-fill ph-bookmark-simple" aria-hidden="true"></i></button>`;
    $('#panel-emoji-filter').onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; $$('#panel-emoji-filter button').forEach(x => x.classList.toggle('is-active', x === b)); this.markFilter = b.dataset.f; this.renderMarksList(); };
    this.markFilter = '';

    // keyboard
    document.addEventListener('keydown', (ev) => this._onKey(ev));
    window.addEventListener('resize', () => { this.hideBubble(); if (this.pageMode) this._layoutPages(); });
  }

  // ------------------------------------------------------------ open / close
  async open(book) {
    this.book = book;
    this.view.hidden = false;
    $('#rd-loading').hidden = false;
    $('#rd-book-title').textContent = book.title;
    $('#rd-chapter').textContent = '';
    document.body.classList.remove('chrome-hidden');
    this.closeEditor(); this.hideBubble(); this.panel.hidden = true; this.typePop.hidden = true;
    this.marks = await db.marksForBook(book.id);
    this.textCache.clear();
    await nextFrame();
    this._render();
    $$('[data-act="layout"]', this.view).forEach(b => { b.hidden = book.format !== 'pdf'; b.classList.remove('is-on'); });
    this.pageMode = false; this.pagesEl.hidden = true; this.content.hidden = false;
    this._removeZoomCtl();
    this.renderToc(); this.renderMarksList();
    await nextFrame();
    this._restorePosition();
    $('#rd-loading').hidden = true;
    if (book.isScanned) { this.toast('No text layer in this PDF. Showing pages instead.'); this.setPageMode(true); }
    this._onScroll();
    this.scroller.focus({ preventScroll: true });
    db.updateBook(book.id, { lastOpened: Date.now() });
  }

  close() {
    this._savePosition(true);
    this.view.hidden = true;
    this.content.innerHTML = ''; this.pagesEl.innerHTML = '';
    this.sectionEls.clear(); this.book = null; this.pdf = null;
    this.onBack();
  }

  _render() {
    const book = this.book;
    const parts = [];
    const first = book.sections[0];
    const ownCover = first && /<img/i.test(first.html) && first.html.replace(/<[^>]+>/g, '').trim().length < 80;
    if (book.coverUrl && book.format !== 'pdf' && !ownCover) parts.push(`<div class="cover-page"><img src="${book.coverUrl}" alt=""></div>`);
    if (book.format === 'pdf' || book.format === 'txt') parts.push(`<div class="title-block"><h1>${esc(book.title)}</h1>${book.author ? `<p>${esc(book.author)}</p>` : ''}</div>`);
    for (const s of book.sections) parts.push(`<section data-sid="${s.id}">${s.html}</section>`);
    this.content.innerHTML = parts.join('');
    this.sectionEls.clear();
    $$('section[data-sid]', this.content).forEach(el => this.sectionEls.set(el.dataset.sid, el));
    // words for time estimate
    this.totalWords = book.sections.reduce((n, s) => n + (s.words || 0), 0);
    if (!this.totalWords) {
      this.totalWords = 0;
      for (const [sid, el] of this.sectionEls) { const w = el.textContent.split(/\s+/).filter(Boolean).length; this.totalWords += w; }
    }
    for (const m of this.marks) this._paintMark(m);
    this.content.dataset.align = this.prefs.align;
  }

  // ------------------------------------------------------------ position
  _visibleAnchor() {
    // first block whose bottom is below the top of the viewport (+ header offset)
    const top = this.scroller.getBoundingClientRect().top + 70;
    for (const [sid, el] of this.sectionEls) {
      const r = el.getBoundingClientRect();
      if (r.bottom < top) continue;
      const blocks = Array.from(el.children);
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i].getBoundingClientRect();
        if (b.bottom >= top && b.height > 0) {
          const frac = clamp((top - b.top) / b.height, 0, 1);
          return { sectionId: sid, blockIndex: i, frac, el: blocks[i] };
        }
      }
      return { sectionId: sid, blockIndex: 0, frac: 0, el: blocks[0] };
    }
    return null;
  }
  _scrollToAnchor(a, behavior = 'auto') {
    if (!a) return;
    this._progScrollAt = Date.now();
    const el = this.sectionEls.get(a.sectionId); if (!el) return;
    const block = el.children[a.blockIndex] || el;
    const y = block.offsetTop + (a.frac || 0) * block.offsetHeight - 70;
    this.scroller.scrollTo({ top: Math.max(0, y), behavior });
  }
  _savePosition(now = false) {
    if (!this.book) return;
    clearTimeout(this.saveTimer);
    const run = () => {
      if (!this.book) return;
      const a = this.pageMode ? null : this._visibleAnchor();
      const max = this.scroller.scrollHeight - this.scroller.clientHeight;
      const pct = max > 0 ? this.scroller.scrollTop / max : 0;
      const patch = { progress: { ...(a ? { sectionId: a.sectionId, blockIndex: a.blockIndex, frac: a.frac } : this.book.progress || {}), pct: this.pageMode ? (this.book.progress?.pct || 0) : pct, page: this.currentPage || null } };
      Object.assign(this.book, patch);
      db.updateBook(this.book.id, patch);
    };
    if (now) run(); else this.saveTimer = setTimeout(run, 400);
  }
  _restorePosition() {
    const p = this.book.progress;
    if (p && p.sectionId) this._scrollToAnchor(p);
    else this.scroller.scrollTop = 0;
  }

  // ------------------------------------------------------------ scroll / chrome
  _onScroll() {
    if (!this.book) return;
    const st = this.scroller.scrollTop;
    const max = this.scroller.scrollHeight - this.scroller.clientHeight;
    this.slider.value = max > 0 ? Math.round((st / max) * 1000) : 0;
    const dy = st - this.lastScroll;
    const programmatic = Date.now() - (this._progScrollAt || 0) < 900;
    if (Math.abs(dy) > 6 && !programmatic) {
      this._downAcc = dy > 0 ? (this._downAcc || 0) + dy : 0;
      if (dy > 0 && st > 120 && this._downAcc > 60 && this.bubble.hidden && this.editor.hidden) document.body.classList.add('chrome-hidden');
      else if (dy < 0) document.body.classList.remove('chrome-hidden');
    }
    this.lastScroll = st;
    if (!this.pending) this.bubble.hidden = true;
    this._updateMeta();
    this._savePosition();
  }
  _toggleChrome() { document.body.classList.toggle('chrome-hidden'); }
  _updateMeta() {
    const posEl = $('#rd-pos'), leftEl = $('#rd-left');
    const max = this.scroller.scrollHeight - this.scroller.clientHeight;
    const pct = max > 0 ? this.scroller.scrollTop / max : 1;
    if (this.pageMode) {
      posEl.textContent = `Page ${this.currentPage || 1} of ${this.book.pageCount}`;
      leftEl.textContent = '';
      return;
    }
    // chapter + page
    const a = this._visibleAnchor();
    let chapter = '';
    if (a) {
      const sec = this.book.sections.find(s => s.id === a.sectionId);
      chapter = sec?.title || '';
      $$('#toc-list li').forEach(li => li.classList.toggle('is-current', li.dataset.sid === a.sectionId));
      if (this.book.format === 'pdf') {
        const top = this.scroller.getBoundingClientRect().top + 70;
        let page = this.book.sections.find(s => s.id === a.sectionId)?.startPage || 1;
        for (const pg of $$('.pg', this.sectionEls.get(a.sectionId))) { if (pg.getBoundingClientRect().top <= top + 4) page = Number(pg.dataset.page); else break; }
        this.currentPage = page;
      }
    }
    $('#rd-chapter').textContent = chapter;
    if (this.book.format === 'pdf' && this.currentPage) posEl.textContent = `Page ${this.currentPage} of ${this.book.pageCount}`;
    else posEl.textContent = `${Math.round(pct * 100)}%`;
    const wordsLeft = Math.round(this.totalWords * (1 - pct));
    const mins = Math.round(wordsLeft / 230);
    leftEl.textContent = mins > 0 ? (mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min left` : `${mins} min left`) : '';
  }

  // ------------------------------------------------------------ prefs
  setPref(key, value) {
    this.prefs[key] = value;
    applyPrefs(this.prefs);
    this.content.dataset.align = this.prefs.align;
    this._syncTypeUI();
    db.setSetting('prefs', this.prefs);
    // keep the reader anchored on the same block
    if (this._anchorBeforePref) clearTimeout(this._anchorBeforePref.t);
    const a = this._lastAnchor || this._visibleAnchor();
    this._lastAnchor = a;
    requestAnimationFrame(() => { this._scrollToAnchor(a); this._anchorBeforePref = { t: setTimeout(() => { this._lastAnchor = null; }, 500) }; });
  }
  _syncTypeUI() {
    $('#font-size').value = this.prefs.size;
    const map = { 'font-family': 'font', 'line-height': 'lh', 'measure': 'measure', 'theme-seg': 'theme', 'justify': 'align' };
    for (const [id, key] of Object.entries(map)) $$('#' + id + ' button').forEach(b => b.classList.toggle('is-active', b.dataset.v === String(this.prefs[key])));
  }
  togglePop() { this.typePop.hidden = !this.typePop.hidden; if (!this.typePop.hidden) { this.panel.hidden = true; this.closeEditor(); } this._syncScrim(); }
  _syncScrim() { this.scrim.hidden = !isMobile() || (this.panel.hidden && this.typePop.hidden && this.editor.hidden); }

  // ------------------------------------------------------------ panel
  togglePanel(tab, focusSearch = false) {
    if (tab === null || (!this.panel.hidden && this.activeTab === tab)) { this.panel.hidden = true; this._syncScrim(); return; }
    this.panel.hidden = false; this.typePop.hidden = true; this.closeEditor();
    this.showPanelTab(tab);
    this._syncScrim();
    if (focusSearch) { const si = $('#search-input'); si.focus(); si.select(); }
  }
  showPanelTab(tab) {
    this.activeTab = tab;
    $$('.panel-tabs .tab', this.panel).forEach(b => b.classList.toggle('is-active', b.dataset.ptab === tab));
    $$('.ptab', this.panel).forEach(p => p.classList.toggle('is-active', p.dataset.ptab === tab));
    if (tab === 'marks') this.renderMarksList();
    if (tab === 'toc') { const cur = $('#toc-list li.is-current'); if (cur) cur.scrollIntoView({ block: 'center' }); }
  }
  renderToc() {
    const ul = $('#toc-list');
    const toc = this.book.toc || [];
    if (!toc.length) { ul.innerHTML = '<li class="empty-note">No table of contents in this book.</li>'; return; }
    ul.innerHTML = toc.map((t, i) => `<li data-depth="${Math.min(t.depth || 0, 3)}" data-sid="${t.sectionId}"><button data-i="${i}">${esc(t.title) || 'Untitled'}${t.page ? `<span class="muted">${t.page}</span>` : ''}</button></li>`).join('');
    ul.onclick = (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      const t = toc[Number(b.dataset.i)];
      this.gotoSection(t.sectionId, t.anchor);
      if (isMobile()) this.togglePanel(null);
    };
  }
  gotoSection(sid, anchor, behavior = 'smooth') {
    if (this.pageMode) this.setPageMode(false);
    const el = this.sectionEls.get(sid); if (!el) return;
    this._progScrollAt = Date.now();
    let target = el;
    if (anchor) { const a = el.querySelector(`#${CSS.escape(anchor)}`) || el.querySelector(`[name="${CSS.escape(anchor)}"]`); if (a) target = a; }
    const y = target.offsetTop - 70;
    this.scroller.scrollTo({ top: Math.max(0, y), behavior });
    document.body.classList.remove('chrome-hidden');
  }
  gotoEpubTarget(t) {
    const [path, hash] = t.split('#');
    const sec = this.book.sections.find(s => s.path === path);
    if (sec) this.gotoSection(sec.id, hash || null);
  }
  gotoPage(n, behavior = 'auto') {
    this._progScrollAt = Date.now();
    if (this.pageMode) { const w = this.pagesEl.querySelector(`[data-page="${n}"]`); if (w) this.scroller.scrollTo({ top: w.offsetTop - 60, behavior }); return; }
    let el = this.content.querySelector(`#pg${n}`);
    for (let k = n - 1; !el && k >= 1 && k >= n - 20; k--) el = this.content.querySelector(`#pg${k}`);
    if (el) this.scroller.scrollTo({ top: el.offsetTop - 70, behavior });
  }

  // ------------------------------------------------------------ search
  _sectionText(sid) {
    if (!this.textCache.has(sid)) this.textCache.set(sid, this.sectionEls.get(sid).textContent);
    return this.textCache.get(sid);
  }
  search(q) {
    const ul = $('#search-results'), sum = $('#search-summary');
    this._clearSearchHits();
    q = q.trim();
    if (q.length < 2) { ul.innerHTML = ''; sum.textContent = ''; return; }
    const needle = q.toLowerCase();
    const hits = [];
    for (const s of this.book.sections) {
      const text = this._sectionText(s.id); const low = text.toLowerCase();
      let i = 0;
      while ((i = low.indexOf(needle, i)) !== -1 && hits.length < 200) {
        hits.push({ sid: s.id, start: i, end: i + q.length, ctx: text.slice(Math.max(0, i - 60), i), after: text.slice(i + q.length, i + q.length + 70), title: s.title });
        i += q.length;
      }
    }
    sum.textContent = hits.length ? `${hits.length}${hits.length >= 200 ? '+' : ''} result${hits.length === 1 ? '' : 's'}` : 'No results';
    ul.innerHTML = hits.map((h, i) => `<li><button data-i="${i}">${h.title ? `<small>${esc(h.title)}</small>` : ''}…${esc(h.ctx)}<b>${esc(q)}</b>${esc(h.after)}…</button></li>`).join('');
    ul.onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; this._showHit(hits[Number(b.dataset.i)]); if (isMobile()) this.togglePanel(null); };
  }
  _clearSearchHits() { $$('.search-hit', this.content).forEach(el => { const p = el.parentNode; p.replaceChild(document.createTextNode(el.textContent), el); p.normalize(); }); }
  _showHit(h) {
    if (this.pageMode) this.setPageMode(false);
    this._clearSearchHits();
    const el = this.sectionEls.get(h.sid);
    const wrapped = wrapTextRange(el, h.start, h.end, () => { const s = document.createElement('span'); s.className = 'search-hit'; return s; });
    this._progScrollAt = Date.now();
    if (wrapped[0]) { this.scroller.scrollTo({ top: wrapped[0].offsetTop - this.scroller.clientHeight / 3, behavior: 'smooth' }); }
    document.body.classList.remove('chrome-hidden');
  }

  // ------------------------------------------------------------ selection -> bubble
  _onSelectionChange(force = false) {
    if (!this.book || this.pageMode) return;
    const sel = window.getSelection();
    if (this.pending && (!sel || sel.isCollapsed)) return;
    if (!sel || sel.isCollapsed || !sel.rangeCount) { this.bubble.hidden = true; return; }
    const range = sel.getRangeAt(0);
    if (!this.content.contains(range.commonAncestorContainer)) { this.bubble.hidden = true; return; }
    if (!range.toString().trim()) { this.bubble.hidden = true; return; }
    // only show once the mouse is released (mouseup/touchend call with force)
    if (!force && this.bubble.hidden) return;
    this._positionBubble(range.getClientRects().length ? range.getClientRects() : [range.getBoundingClientRect()]);
  }
  _positionBubble(rects) {
    if (!rects || !rects.length) return;
    const r = rects[0], last = rects[rects.length - 1];
    const vr = this.view.getBoundingClientRect();
    this.bubble.hidden = false;
    const bw = this.bubble.offsetWidth, bh = this.bubble.offsetHeight;
    let x = clamp((r.left + r.right) / 2 - vr.left - bw / 2, 8, vr.width - bw - 8);
    let y = r.top - vr.top - bh - 10;
    if (isTouch() || y < 56) y = last.bottom - vr.top + 12;
    if (y + bh > vr.height - 8) y = Math.max(8, r.top - vr.top - bh - 10);
    this.bubble.style.left = x + 'px'; this.bubble.style.top = y + 'px';
    document.body.classList.remove('chrome-hidden');
  }

  // Touch: Dogear runs the selection itself. The reading surface has user-select: none on coarse
  // pointers, so Chrome never starts a native selection (and never shows its toolbar or Touch to
  // Search). Long-press picks the word under the finger, dragging extends by whole words, lifting
  // shows the bubble. Everything is tracked as character offsets inside the section, which stay
  // valid while the provisional <mark> splits and re-joins text nodes underneath.
  _wireTouchSelection() {
    const c = this.content;
    let t0 = null, timer = null, selecting = false, anchor = null, raf = 0, lastPt = null;
    const pt = (ev) => ev.touches[0] || ev.changedTouches[0];
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener('touchstart', (ev) => {
      if (ev.touches.length !== 1 || this.pageMode) return;
      const p = pt(ev); t0 = { x: p.clientX, y: p.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => {
        const at = this._offsetAt(t0.x, t0.y); if (!at) return;
        const w = this._wordAround(at.secEl, at.off); if (!w) return;
        selecting = true; anchor = { ...at, ...w };
        this.hideBubble();
        this._setPending(anchor.sid, w.start, w.end, anchor.node);
        if (navigator.vibrate) navigator.vibrate(12);
      }, 420);
    }, { passive: true });
    c.addEventListener('touchmove', (ev) => {
      const p = pt(ev);
      if (!selecting) { if (t0 && Math.hypot(p.clientX - t0.x, p.clientY - t0.y) > 8) clearTimeout(timer); return; }
      ev.preventDefault();
      lastPt = { x: p.clientX, y: p.clientY };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const at = this._offsetAt(lastPt.x, lastPt.y); if (!at || at.sid !== anchor.sid) return;
        const w = this._wordAround(at.secEl, at.off) || { start: at.off, end: at.off };
        this._setPending(anchor.sid, Math.min(anchor.start, w.start), Math.max(anchor.end, w.end), anchor.node);
      });
    }, { passive: false });
    const end = () => {
      clearTimeout(timer); timer = null; t0 = null;
      if (!selecting) return;
      selecting = false; anchor = null; this._selEndAt = Date.now();
      if (this.pending) { this._positionBubble(this._pendingRects()); document.body.classList.remove('chrome-hidden'); }
    };
    c.addEventListener('touchend', end, { passive: true });
    c.addEventListener('touchcancel', end, { passive: true });
  }
  _offsetAt(x, y) {
    let node, offset;
    if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; offset = r.startOffset; }
    else if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x, y); if (!c) return null; node = c.offsetNode; offset = c.offset; }
    else return null;
    if (!node || node.nodeType !== 3) return null;
    const el = node.parentNode; if (!this.content.contains(el)) return null;
    const secEl = el.closest('section[data-sid]'); if (!secEl) return null;
    const pre = document.createRange(); pre.selectNodeContents(secEl); pre.setEnd(node, offset);
    return { sid: secEl.dataset.sid, secEl, node, off: pre.toString().length };
  }
  _wordAround(secEl, off) {
    const t = secEl.textContent;
    const w = (ch) => !!ch && /[\p{L}\p{N}\u2019'-]/u.test(ch);
    let s = off, e = off;
    while (s > 0 && w(t[s - 1])) s--;
    while (e < t.length && w(t[e])) e++;
    return s < e ? { start: s, end: e } : null;
  }
  _setPending(sid, start, end, node) {
    if (this.pending && this.pending.sectionId === sid && this.pending.start === start && this.pending.end === end) return;
    const secEl = this.sectionEls.get(sid); if (!secEl) return;
    const raw = secEl.textContent.slice(start, end);
    const lead = raw.length - raw.trimStart().length, clean = raw.trim();
    if (!clean) return;
    this._clearPending();
    this.pending = { sectionId: sid, start: start + lead, end: start + lead + clean.length, text: clean.replace(/\s+/g, ' '), page: node ? this._pageAtNode(node) : null };
    this.pendingEls = wrapTextRange(secEl, this.pending.start, this.pending.end, () => { const mk = document.createElement('mark'); mk.className = 'hl pending'; mk.dataset.emoji = ''; mk.dataset.note = '0'; return mk; });
  }

  // Take a native selection into a provisional highlight (touch only; fallback if one exists).
  _takeSelection() {
    if (!this.book || this.pageMode) return;
    if (!isTouch()) { this._onSelectionChange(true); return; }
    const loc = this._selectionToMark();
    if (!loc) return;
    this.hideBubble();
    this.pending = loc;
    const el = this.sectionEls.get(loc.sectionId);
    this.pendingEls = wrapTextRange(el, loc.start, loc.end, () => { const mk = document.createElement('mark'); mk.className = 'hl pending'; mk.dataset.emoji = ''; mk.dataset.note = '0'; return mk; });
    window.getSelection().removeAllRanges();
    this._positionBubble(this._pendingRects());
    document.body.classList.remove('chrome-hidden');
  }
  _pendingRects() {
    const els = this.pendingEls || []; if (!els.length) return [];
    const a = els[0].getClientRects(), b = els[els.length - 1].getClientRects();
    return [a[0] || els[0].getBoundingClientRect(), b[b.length - 1] || els[els.length - 1].getBoundingClientRect()];
  }
  _clearPending() {
    if (!this.pending) return;
    for (const mk of this.pendingEls || []) { const p = mk.parentNode; if (!p) continue; while (mk.firstChild) p.insertBefore(mk.firstChild, mk); p.removeChild(mk); p.normalize(); }
    this.pending = null; this.pendingEls = null;
  }
  hideBubble() { this.bubble.hidden = true; this._clearPending(); }

  _selectionToMark() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    return this._rangeToLoc(sel.getRangeAt(0));
  }
  _rangeToLoc(range) {
    let node = range.startContainer;
    const secEl = (node.nodeType === 1 ? node : node.parentNode).closest('section[data-sid]');
    if (!secEl) return null;
    const pre = document.createRange(); pre.selectNodeContents(secEl); pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    // clamp end to this section
    const inner = range.cloneRange();
    if (!secEl.contains(range.endContainer)) inner.setEnd(secEl, secEl.childNodes.length);
    const text = inner.toString();
    const trimmedLead = text.length - text.trimStart().length;
    const clean = text.trim();
    if (!clean) return null;
    return { sectionId: secEl.dataset.sid, start: start + trimmedLead, end: start + trimmedLead + clean.length, text: clean.replace(/\s+/g, ' '), page: this._pageAtNode(range.startContainer) };
  }
  _pageAtNode(node) {
    if (this.book.format !== 'pdf') return null;
    const el = node.nodeType === 1 ? node : node.parentNode;
    const sec = el.closest('section');
    let page = null;
    for (const pg of $$('.pg', sec)) { if (pg.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) page = Number(pg.dataset.page); else break; }
    return page || this.book.sections.find(s => s.id === sec.dataset.sid)?.startPage || null;
  }

  async keepSelection(emoji, openNote = false) {
    const loc = this.pending || this._selectionToMark();
    if (!loc) return;
    const mark = { id: uid(), bookId: this.book.id, type: 'highlight', emoji, note: '', createdAt: Date.now(), ...loc };
    window.getSelection().removeAllRanges();
    this.hideBubble();
    this.marks.push(mark);
    await db.putMark(mark);
    const els = this._paintMark(mark);
    this.onMarksChanged(this.book && this.book.id);
    this.renderMarksList();
    if (openNote) this.openEditor(mark, els[0], true);
    else this.toast(`${emoji} Kept`, { label: 'Add note', fn: () => this.openEditor(mark, els[0], true) });
  }
  _paintMark(m) {
    const el = this.sectionEls.get(m.sectionId); if (!el) return [];
    if (m.type === 'bookmark') {
      const block = el.children[m.blockIndex]; if (block) { block.classList.add('bm-anchor'); block.dataset.bm = m.id; }
      return block ? [block] : [];
    }
    const els = wrapTextRange(el, m.start, m.end, () => {
      const mk = document.createElement('mark'); mk.className = 'hl'; mk.dataset.id = m.id;
      mk.dataset.emoji = m.emoji || ''; mk.dataset.note = m.note ? '1' : '0'; return mk;
    });
    if (els.length) els[els.length - 1].classList.add('last');
    return els;
  }
  _unpaintMark(m) {
    if (m.type === 'bookmark') { const b = this.content.querySelector(`[data-bm="${m.id}"]`); if (b) { b.classList.remove('bm-anchor'); delete b.dataset.bm; } return; }
    $$(`mark.hl[data-id="${m.id}"]`, this.content).forEach(mk => { const p = mk.parentNode; while (mk.firstChild) p.insertBefore(mk.firstChild, mk); p.removeChild(mk); p.normalize(); });
  }
  _refreshMarkEls(m) {
    $$(`mark.hl[data-id="${m.id}"]`, this.content).forEach(mk => { mk.dataset.emoji = m.emoji || ''; mk.dataset.note = m.note ? '1' : '0'; });
  }
  async saveMark(m) { this._refreshMarkEls(m); await db.putMark(m); this.onMarksChanged(this.book && this.book.id); this.renderMarksList(); }
  _queueSaveMark(m) { clearTimeout(this._mst); this._mst = setTimeout(() => this.saveMark(m), 300); }
  async deleteMark(m) {
    this._unpaintMark(m);
    this.marks = this.marks.filter(x => x.id !== m.id);
    await db.deleteMark(m.id);
    this.onMarksChanged(this.book && this.book.id); this.renderMarksList();
    this.toast('Removed', { label: 'Undo', fn: async () => { this.marks.push(m); await db.putMark(m); this._paintMark(m); this.onMarksChanged(this.book && this.book.id); this.renderMarksList(); } });
  }

  // ------------------------------------------------------------ editor
  openEditor(m, anchorEl, focusNote = false) {
    this.editingMark = m;
    this.hideBubble();
    $('.me-quote', this.editor).textContent = m.text;
    $('.me-quote', this.editor).hidden = m.type === 'bookmark' && !m.text;
    $('.me-note', this.editor).value = m.note || '';
    this._syncEditorEmoji();
    this.editor.hidden = false;
    $$('mark.hl.is-active', this.content).forEach(x => x.classList.remove('is-active'));
    $$(`mark.hl[data-id="${m.id}"]`, this.content).forEach(x => x.classList.add('is-active'));
    // position (desktop: popover near the mark; mobile: bottom sheet via CSS)
    if (isMobile()) { this.editor.style.left = ''; this.editor.style.top = ''; this.panel.hidden = true; this.typePop.hidden = true; }
    else {
      const vr = this.view.getBoundingClientRect();
      const r = anchorEl ? anchorEl.getBoundingClientRect() : { left: vr.width / 2, right: vr.width / 2, top: vr.height / 2, bottom: vr.height / 2 };
      const ew = this.editor.offsetWidth, eh = this.editor.offsetHeight;
      let x = clamp((r.left + r.right) / 2 - vr.left - ew / 2, 8, vr.width - ew - 8);
      let y = r.bottom - vr.top + 10;
      if (y + eh > vr.height - 8) y = Math.max(56, r.top - vr.top - eh - 10);
      this.editor.style.left = x + 'px'; this.editor.style.top = y + 'px';
    }
    this._syncScrim();
    if (focusNote) setTimeout(() => $('.me-note', this.editor).focus(), 30);
  }
  _syncEditorEmoji() { const m = this.editingMark; $$('.emoji-row button', this.editor).forEach(b => b.classList.toggle('is-active', !!m && b.dataset.emoji === m.emoji)); }
  closeEditor() {
    if (this.editor.hidden) return;
    const m = this.editingMark;
    if (m) { clearTimeout(this._mst); this.saveMark(m); }
    this.editor.hidden = true; this.editingMark = null;
    $$('mark.hl.is-active', this.content).forEach(x => x.classList.remove('is-active'));
    this._syncScrim();
  }

  // ------------------------------------------------------------ bookmarks
  async toggleBookmark() {
    if (this.pageMode) { this.toast('Switch to reading view to bookmark.'); return; }
    const a = this._visibleAnchor(); if (!a) return;
    const existing = this.marks.find(m => m.type === 'bookmark' && m.sectionId === a.sectionId && m.blockIndex === a.blockIndex);
    if (existing) { await this.deleteMark(existing); return; }
    const snippet = (a.el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const m = { id: uid(), bookId: this.book.id, type: 'bookmark', emoji: null, note: '', createdAt: Date.now(), sectionId: a.sectionId, blockIndex: a.blockIndex, text: snippet, page: this.currentPage || null };
    this.marks.push(m);
    await db.putMark(m);
    this._paintMark(m);
    this.onMarksChanged(this.book && this.book.id); this.renderMarksList();
    this.toast('Bookmarked', { label: 'Add note', fn: () => this.openEditor(m, a.el, true) });
    $$('[data-act="bookmark"]', this.view).forEach(btn => { btn.classList.add('is-on'); setTimeout(() => btn.classList.remove('is-on'), 900); });
  }

  // ------------------------------------------------------------ marks list (panel)
  renderMarksList() {
    const ul = $('#book-marks-list');
    const f = this.markFilter || '';
    let list = this.marks.slice().sort((a, b) => this._markOrder(a) - this._markOrder(b));
    if (f === 'bm') list = list.filter(m => m.type === 'bookmark');
    else if (f) list = list.filter(m => m.emoji === f);
    $$('#panel-emoji-filter button').forEach(b => { const k = b.dataset.f; const n = k === '' ? this.marks.length : k === 'bm' ? this.marks.filter(m => m.type === 'bookmark').length : this.marks.filter(m => m.emoji === k).length; b.title = `${b.title.split(' (')[0]} (${n})`; });
    if (!list.length) { ul.innerHTML = `<li class="empty-note">${this.marks.length ? 'Nothing with that reaction yet.' : 'Select text and tap a reaction to keep it.'}</li>`; return; }
    ul.innerHTML = list.map(m => `<li class="${m.type === 'bookmark' ? 'bm' : ''}"><button data-id="${m.id}"><span class="em">${m.type === 'bookmark' ? '<i class="ph-fill ph-bookmark-simple" aria-hidden="true"></i>' : (m.emoji || '<i class="ph ph-note-pencil" aria-hidden="true"></i>')}</span><span class="q">${esc(m.text)}</span>${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}</button></li>`).join('');
    ul.onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; this.gotoMark(this.marks.find(m => m.id === b.dataset.id)); if (isMobile()) this.togglePanel(null); };
  }
  _markOrder(m) {
    const si = Number(String(m.sectionId || 's0').slice(1)) || 0;
    return si * 1e7 + (m.type === 'bookmark' ? m.blockIndex * 1e3 : m.start);
  }
  gotoMark(m, openEditor = false) {
    if (!m) return;
    if (this.pageMode) this.setPageMode(false);
    let el = m.type === 'bookmark' ? this.content.querySelector(`[data-bm="${m.id}"]`) : this.content.querySelector(`mark.hl[data-id="${m.id}"]`);
    if (!el) { const sec = this.sectionEls.get(m.sectionId); el = sec ? (sec.children[m.blockIndex] || sec) : null; }
    if (!el) return;
    this._progScrollAt = Date.now();
    this.scroller.scrollTo({ top: el.offsetTop - this.scroller.clientHeight / 3, behavior: 'smooth' });
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1700);
    document.body.classList.remove('chrome-hidden');
    if (openEditor) setTimeout(() => this.openEditor(m, el), 450);
  }

  // ------------------------------------------------------------ PDF page mode
  async setPageMode(on) {
    if (this.book.format !== 'pdf' || on === this.pageMode) return;
    const page = this.currentPage || 1;
    this.pageMode = on;
    $$('[data-act="layout"]', this.view).forEach(b => b.classList.toggle('is-on', on));
    this.hideBubble(); this.closeEditor();
    if (on) {
      $('#rd-loading').hidden = false;
      if (!this.pdf) {
        const pdfjs = await getPdfjs();
        const blob = await db.getFile(this.book.id);
        this.pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
      }
      this.content.hidden = true; this.pagesEl.hidden = false;
      await this._layoutPages();
      this._addZoomCtl();
      $('#rd-loading').hidden = true;
      this.gotoPage(page);
      document.body.classList.remove('chrome-hidden');
      this.toast('Original layout. Reactions and notes live in the reading view.');
    } else {
      this.pagesEl.hidden = true; this.content.hidden = false; this.pagesEl.innerHTML = '';
      if (this.pageObserver) this.pageObserver.disconnect();
      this._removeZoomCtl();
      this.gotoPage(page);
    }
    this._updateMeta();
  }
  async _layoutPages() {
    if (!this.pdf) return;
    const keepPage = this.currentPage || 1;
    this.pagesEl.innerHTML = '';
    if (this.pageObserver) this.pageObserver.disconnect();
    const first = await this.pdf.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const avail = Math.min(this.scroller.clientWidth - 32, 900);
    const scale = (avail / base.width) * this.zoom;
    const wraps = [];
    for (let i = 1; i <= this.pdf.numPages; i++) {
      const w = document.createElement('div'); w.className = 'pgwrap'; w.dataset.page = i;
      const c = document.createElement('canvas');
      c.style.width = Math.round(base.width * scale) + 'px'; c.style.height = Math.round(base.height * scale) + 'px';
      w.appendChild(c);
      const n = document.createElement('div'); n.className = 'pgnum'; n.textContent = i; w.appendChild(n);
      this.pagesEl.appendChild(w); wraps.push(w);
    }
    this.pageObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const w = e.target;
        if (e.isIntersecting) { this._renderPage(Number(w.dataset.page), w, scale); if (e.intersectionRatio > 0.3) this.currentPage = Number(w.dataset.page); }
      }
      this._updateMeta();
    }, { root: this.scroller, rootMargin: '600px 0px', threshold: [0, 0.3, 0.6] });
    wraps.forEach(w => this.pageObserver.observe(w));
    this.currentPage = keepPage;
  }
  async _renderPage(n, wrap, scale) {
    if (wrap.dataset.rendered === String(scale)) return;
    wrap.dataset.rendered = String(scale);
    const page = await this.pdf.getPage(n);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: scale * dpr });
    const c = wrap.querySelector('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
  _addZoomCtl() {
    this._removeZoomCtl();
    const z = document.createElement('div'); z.className = 'zoom-ctl'; z.id = 'zoom-ctl';
    z.innerHTML = '<button title="Zoom out">−</button><button title="Zoom in">+</button>';
    const [out, inn] = z.querySelectorAll('button');
    out.onclick = () => { this.zoom = clamp(this.zoom - 0.2, 0.5, 3); this._layoutPages().then(() => this.gotoPage(this.currentPage)); };
    inn.onclick = () => { this.zoom = clamp(this.zoom + 0.2, 0.5, 3); this._layoutPages().then(() => this.gotoPage(this.currentPage)); };
    this.view.appendChild(z);
  }
  _removeZoomCtl() { const z = $('#zoom-ctl'); if (z) z.remove(); }

  // ------------------------------------------------------------ keys
  _onKey(ev) {
    if (!this.book || this.view.hidden) return;
    const tag = (ev.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || ev.target.isContentEditable;
    if (ev.key === 'Escape') {
      if (!this.editor.hidden) { this.closeEditor(); return; }
      if (!this.typePop.hidden) { this.typePop.hidden = true; this._syncScrim(); return; }
      if (!this.panel.hidden) { this.togglePanel(null); return; }
      if (!this.bubble.hidden) { this.hideBubble(); window.getSelection().removeAllRanges(); return; }
      this.close(); return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f') { ev.preventDefault(); this.togglePanel('search', true); return; }
    if (typing) return;
    if (!this.bubble.hidden && /^[1-5]$/.test(ev.key)) { ev.preventDefault(); this.keepSelection(EMOJIS[Number(ev.key) - 1].e); return; }
    if (!this.bubble.hidden && ev.key.toLowerCase() === 'n') { ev.preventDefault(); this.keepSelection(null, true); return; }
    const page = this.scroller.clientHeight * 0.88;
    switch (ev.key) {
      case 'ArrowRight': case 'PageDown': case ' ': ev.preventDefault(); this.scroller.scrollBy({ top: ev.shiftKey && ev.key === ' ' ? -page : page, behavior: 'smooth' }); break;
      case 'ArrowLeft': case 'PageUp': ev.preventDefault(); this.scroller.scrollBy({ top: -page, behavior: 'smooth' }); break;
      case 'ArrowDown': ev.preventDefault(); this.scroller.scrollBy({ top: 80, behavior: 'smooth' }); break;
      case 'ArrowUp': ev.preventDefault(); this.scroller.scrollBy({ top: -80, behavior: 'smooth' }); break;
      case 'Home': ev.preventDefault(); this.scroller.scrollTo({ top: 0 }); break;
      case 'End': ev.preventDefault(); this.scroller.scrollTo({ top: this.scroller.scrollHeight }); break;
      case '+': case '=': this.setPref('size', clamp(this.prefs.size + 1, 14, 34)); break;
      case '-': case '_': this.setPref('size', clamp(this.prefs.size - 1, 14, 34)); break;
      case 'b': case 'B': this.toggleBookmark(); break;
      case 'c': case 'C': this.togglePanel('toc'); break;
      case 'a': case 'A': this.togglePop(); break;
      case 'l': case 'L': if (this.book.format === 'pdf') this.setPageMode(!this.pageMode); break;
      case 't': case 'T': { const order = ['paper', 'sepia', 'mist', 'night']; this.setPref('theme', order[(order.indexOf(this.prefs.theme) + 1) % order.length]); break; }
      case 'f': case 'F': this.togglePanel('search', true); ev.preventDefault(); break;
    }
  }
}

// Wrap [start, end) character range (offsets into root.textContent) with wrapper elements.
// Returns created wrapper elements. Text content of root is unchanged.
export function wrapTextRange(root, start, end, makeWrapper) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0; const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    const len = n.data.length;
    if (pos + len > start && pos < end) targets.push({ n, s: Math.max(0, start - pos), e: Math.min(len, end - pos) });
    pos += len;
    if (pos >= end) break;
  }
  const out = [];
  for (const { n, s, e } of targets) {
    let t = n;
    if (s > 0) t = t.splitText(s);
    if (e - s < t.data.length) t.splitText(e - s);
    if (!t.data.trim() && targets.length > 1) continue;
    const w = makeWrapper();
    t.parentNode.insertBefore(w, t); w.appendChild(t);
    out.push(w);
  }
  return out;
}
