// A natural voice, page side. Its speech worker (voice-worker.js for Supertonic, kokoro-worker.js for Kokoro) makes one
// sentence at a time; the page plays them through one <audio> element. Chrome keeps an audio element playing with the
// screen off and gives it lock-screen controls, which Android's built-in speech engine does not get.
//
// Speech is made chapter by chapter and kept on the device (audio-store.js), so what was made while reading, while
// paused, or days ago plays at once, without even loading the model. It makes ahead at least twenty minutes and on to
// the end of the next chapter. When the device makes speech slower than it is read, the voice doesn't stop every few
// sentences: before a chapter it waits once, for as long as it takes to have enough ready that the rest of the chapter
// is made before the voice gets there (see _target), and then reads it through.
//
// Positions are ReadAloud's { si, k }. The host supplies the sentences and hears what happens: { book(), seg(pos),
// after(pos), chapter(si) (which chapter a section is in), charsLeft(pos) (to the end of its chapter), lang(), voice(),
// steps(), speed(seconds, ms), lastSpeed(), onStart(pos), onEnd(), onChange(), onPause(), onFail(message) }
import { audioStore, textHash, chapterKey } from './audio-store.js';
import { decodeClip, clipSeconds } from './clip.js';

const AHEAD_MIN = 1200;  // made ahead of the voice: at least twenty minutes, and on to the end of the next chapter,
const AHEAD_MAX = 5400;  // but no more than ninety minutes
const SPAN = 1800;       // a head start covers at most half an hour: a book without chapters waits again after that
const HISTORY = 5;       // sentences kept behind the voice, so going back is instant
const REFILL = 15;       // run dry on a device that keeps up: seconds to gather before going on
const SPC = 1 / 14;      // seconds of speech per character, until the voice has said some
const same = (a, b) => !!a && !!b && a.si === b.si && a.k === b.k;

function wavBlob(pcm, rate) {
  const head = new DataView(new ArrayBuffer(44)), str = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); head.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt '); head.setUint32(16, 16, true);
  head.setUint16(20, 1, true); head.setUint16(22, 1, true); head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true);
  head.setUint16(32, 2, true); head.setUint16(34, 16, true); str(36, 'data'); head.setUint32(40, pcm.byteLength, true);
  return new Blob([head.buffer, pcm.buffer], { type: 'audio/wav' });
}

export class NaturalVoice {
  // worker: the speech worker's file name in js/; mb: its one-time download; model: its name in the stored audio's keys
  constructor(host, worker, mb, model) {
    this.host = host; this.workerFile = worker; this.mb = mb; this.model = model;
    this.status = 'unknown';   // unknown | absent | stored | downloading | preparing | ready | failed
    this.progress = 0;         // share downloaded, 0 to 1
    this.items = [];           // sentences ready, in reading order: { pos, key, dur, clip?, url? }
    this.at = -1;              // index of the sentence playing or paused on
    this.next = null;          // the next sentence to make
    this.pending = null;       // the sentence being looked up or made
    this.requests = new Map(); // worker requests: id -> { key, chapter, chars }
    this.metas = new Map();    // chapter key -> Promise of Map(text hash -> seconds) of what is stored
    this.playing = false;      // the reader wants sound
    this.waiting = false;      // ...but not enough is ready yet
    this.rate = 1; this.reqId = 0; this.tok = 0;
    this.secs = 0; this.chars = 0; this._speed = 0; this.made = 0; // measured: seconds per character, and speed
    // making speech ahead stops while the page is hidden and silent, and goes on when it shows again
    document.addEventListener('visibilitychange', () => this._pump());
    const a = this.audio = new Audio();
    a.preload = 'auto';
    a.addEventListener('ended', () => this._advance());
    a.addEventListener('error', () => { if (a.getAttribute('src')) this._advance(); });
    // Paused by the system (a call, another app taking the sound): tell the reader. Our own pauses say so first
    // (playing is false). A new src cancels the pause event of the sentence before; if one still arrives just after a
    // switch, look again once it has settled.
    const external = () => { if (a.paused && !a.ended && this.playing && !this.waiting && a.getAttribute('src')) { this.playing = false; host.onPause(); } };
    a.addEventListener('pause', () => {
      if (a.ended || !this.playing) return;
      if (performance.now() - this._switchAt < 500) setTimeout(external, 600); else external();
    });
    this._switchAt = 0;
  }

  // ---------------------------------------------------------- the worker and the model
  _worker() {
    if (!this.w) {
      this.w = new Worker(new URL('./' + this.workerFile, import.meta.url), { type: 'module' });
      this.w.onmessage = (e) => this._msg(e.data);
      this.w.onerror = (e) => this._msg({ t: 'failed', message: e.message || 'The voice could not start.' });
    }
    return this.w;
  }
  // Is the model on this device? Sets status to stored or absent.
  check() {
    if (this.status !== 'unknown') return Promise.resolve(this.status !== 'absent');
    return this._checking ||= new Promise(res => {
      this._checked = (c) => { this._checking = null; res(c); };
      this._worker().postMessage({ t: 'check' });
    });
  }
  // Download if needed, then load it. Resolves when it can speak.
  load() {
    if (this.status === 'ready') return Promise.resolve();
    if (!this._loading) {
      this._loading = new Promise((res, rej) => { this._loaded = res; this._failed = rej; });
      this._loading.catch(() => {});
      try { navigator.storage?.persist?.(); } catch {}
      this._worker().postMessage({ t: 'load' });
    }
    return this._loading;
  }
  // Delete the model from this device.
  forget() {
    this.stop();
    // and the speech it made
    this.metas.clear();
    audioStore.forget({ voice: this.model + ':' }).catch(() => {});
    // a fresh worker deletes the files: one still loading or downloading would carry on and say it is ready
    if (this.w) { this.w.terminate(); this.w = null; }
    this._worker().postMessage({ t: 'forget' });
    this.status = 'absent'; this._loading = null; this._checking = null;
  }
  // Free the model's memory; it stays stored.
  release() {
    this.stop();
    if (this.w) { this.w.terminate(); this.w = null; }
    this.requests.clear();
    if (this.status === 'ready' || this.status === 'preparing') this.status = 'stored';
    // a download cut short: what is stored is asked again next time (load() goes on from the files it has)
    if (this.status === 'downloading') { this.status = 'unknown'; this.progress = 0; }
    this._loading = null; this._checking = null;
  }
  _msg(m) {
    switch (m.t) {
      case 'checked': this.status = m.cached ? 'stored' : 'absent'; this._checked?.(m.cached); break;
      case 'progress': this.status = 'downloading'; this.progress = m.done / m.total; break;
      case 'preparing': this.status = 'preparing'; break;
      case 'ready': this.status = 'ready'; this.progress = 1; this._loaded?.(); this._pump(); break;
      case 'audio': this._made(m); return;
      case 'failed':
        if (m.id != null) { this._made({ ...m, clip: null }); return; }
        this.status = 'failed'; this.error = m.message; this._loading = null; this._failed?.(new Error(m.message));
        this.host.onFail(m.message);
        break;
      case 'engine': this.gpu = m.gpu; this.threads = m.threads; return;
      case 'forgotten': break;
    }
    this.host.onChange();
  }

  // ---------------------------------------------------------- playing
  // Read from pos, from what is already made when it can.
  play(pos, { fresh = false } = {}) {
    this.playing = true;
    const i = fresh ? -1 : this.items.findIndex(x => same(x.pos, pos));
    if (i < 0) { this._clear(); this.next = pos; } else this.at = i - 1;
    this.waiting = true;
    this._check();
    if (this.waiting) { this.host.onChange(); this._pump(); }
  }
  // Make speech from pos without playing it, so a later play(pos) starts at once.
  prepare(pos) {
    if (this.playing) return;
    if (this.items.some(x => same(x.pos, pos))) { this._pump(); return; }
    this._clear();
    this.next = pos;
    this._pump();
  }
  pause() {
    this.playing = false;
    if (!this.audio.paused) this.audio.pause();
  }
  // Go on mid-sentence, when paused on pos.
  canResume(pos) { return !this.waiting && this.at >= 0 && same(this.items[this.at]?.pos, pos) && !!this.audio.getAttribute('src'); }
  resume() { this.playing = true; this.audio.play().catch(() => {}); }
  stop() { this.playing = false; this._clear(); }
  setRate(r) { this.rate = r; this.audio.defaultPlaybackRate = this.audio.playbackRate = r; }
  // how far into the current sentence, in seconds of its audio
  get elapsed() { return this.audio.currentTime || 0; }
  // seconds of speech ready from item i on, and ahead of the voice
  readyFrom(i) { let n = 0; for (let j = Math.max(0, i); j < this.items.length; j++) n += this.items[j].dur; return n; }
  get ready() { return this.readyFrom(this.at + 1); }
  // speech made per second of work (1 keeps up with the voice at 1x), learnt on this device
  get speed() { return this._speed || this.host.lastSpeed?.() || 0; }
  get spc() { return this.chars > 300 ? this.secs / this.chars : SPC; }
  // While waiting: seconds until enough is ready (0 when it is a matter of the next sentence, null when not yet known).
  get eta() {
    if (!this.waiting) return 0;
    const n = this.at + 1, pos = this.items[n]?.pos || this.next, v = this.speed;
    if (!pos) return 0;
    if (!v) return null;
    const need = this._target(pos, this.at < 0) - this.readyFrom(n);
    return need > 0 ? need / v : 0;
  }
  // how much of a long wait is done, 0 to 1 (null when there is no long wait)
  get waitShare() {
    if (!this.waiting || !(this.eta > 30)) return null;
    const n = this.at + 1, pos = this.items[n]?.pos || this.next;
    return Math.min(1, this.readyFrom(n) / this._target(pos, this.at < 0));
  }
  // the voice is waiting to go into a new chapter
  get atChapter() {
    const cur = this.items[this.at]?.pos, nx = this.items[this.at + 1]?.pos || this.next;
    return !!cur && !!nx && this.host.chapter(cur.si) !== this.host.chapter(nx.si);
  }

  // Seconds of speech to have ready from pos before going on, so that the voice then reads to the end of pos's chapter
  // (or the next SPAN of it) without stopping. Speech is used up at the reading rate and made at this.speed, so over
  // what is left of the chapter the shortfall is rest * (1 - speed / rate): that much has to be ready first. A device
  // that keeps up needs none: it starts on the first sentence. Not knowing the speed yet (the first time on this
  // device), it waits for the first sentence the worker makes, which tells.
  _target(pos, start) {
    const r = this.rate, v = this.speed, rest = Math.min(SPAN, this.host.charsLeft(pos) * this.spc);
    if (!v) return start ? rest : REFILL * r;
    if (v >= r * 1.1) return start ? 0 : Math.min(rest, REFILL * r);
    return Math.min(rest, rest * (1 - v / r) * 1.15 + 5 * r);
  }
  // waiting: go on once enough is ready
  _check() {
    const n = this.at + 1, it = this.items[n];
    if (!it) {
      if (!this.next && !this.pending && this.at >= 0) { this.playing = false; this.waiting = false; this.host.onEnd(); }
      return;
    }
    if (!this.next || this.readyFrom(n) >= this._target(it.pos, this.at < 0)) this._playAt(n);
  }
  _advance() {
    if (!this.playing) return;
    const n = this.at + 1, it = this.items[n], cur = this.items[this.at];
    // within a chapter, on at once; into a new one, once enough of it is ready to read it through
    if (it && (!cur || this.host.chapter(it.pos.si) === this.host.chapter(cur.pos.si))) { this._playAt(n); return; }
    this.waiting = true;
    this._check();
    if (this.waiting) { this.host.onChange(); this._pump(); }
  }

  _ckey(si) { return chapterKey(this.host.book(), `${this.model}:${this.host.voice()}:${this.host.lang()}`, si); }
  _keep() { const si = (this.items[this.at] || this.items[0])?.pos.si ?? this.next?.si ?? 0; return [this._ckey(si), this._ckey(si + 1)]; }
  _cached(chapter, hash) {
    let m = this.metas.get(chapter);
    if (!m) { m = audioStore.chapter(chapter).catch(() => new Map()); this.metas.set(chapter, m); }
    return m.then(map => map.get(hash));
  }
  // enough made ahead (not while the voice waits for it)
  _full() {
    if (this.waiting) return false;
    const ahead = this.ready, base = (this.items[this.at] || this.items[0])?.pos || this.next;
    return ahead >= AHEAD_MAX || (ahead >= AHEAD_MIN && this.next.si > this.host.chapter(this.host.chapter(base.si) + 1));
  }
  // the next sentence: from the device when it was made before, else from the worker
  _pump() {
    if (this.pending || !this.next || !this.host.book()) return;
    if (!this.playing && document.hidden) return;
    if (this._full()) return;
    const pos = this.next, s = this.host.seg(pos);
    if (!s) { this.next = null; return; }
    const id = ++this.reqId, chapter = this._ckey(pos.si), hash = textHash(s.text), key = chapter + hash, chars = s.text.length;
    this.pending = { id, pos, key, chars };
    this._cached(chapter, hash).then(dur => {
      if (this.pending?.id !== id) return;
      if (dur != null) { this.pending = null; this._add(pos, key, dur, chars, null); return; }
      if (this.status !== 'ready') { this.pending = null; return; } // made once the model is ready ('ready' pumps)
      this.requests.set(id, { key, chapter, hash, chars });
      this._worker().postMessage({ t: 'speak', id, text: s.text, lang: this.host.lang(), voice: this.host.voice(), steps: this.host.steps() });
    });
  }
  _made(m) {
    const req = this.requests.get(m.id), clip = m.clip;
    this.requests.delete(m.id);
    let saved = null;
    if (clip && req) {
      // kept even when the reader has moved on: it is this sentence in this voice
      const dur = clipSeconds(clip);
      saved = audioStore.put(req.key, clip, this._keep()).catch(() => {});
      this.metas.get(req.chapter)?.then(map => map.set(req.hash, dur));
      // an average over the first ten sentences, then a slow one, so the wait it predicts doesn't jump about
      const v = dur * 1000 / m.ms, w = Math.max(0.1, 1 / ++this.made);
      this._speed = this._speed ? this._speed * (1 - w) + v * w : v;
      this.host.speed(dur, m.ms);
    }
    const p = this.pending;
    if (!p || p.id !== m.id) return; // made for a place the reader has left
    this.pending = null;
    // no audio (a failure, or nothing to say): skipped when its turn comes
    const it = this._add(p.pos, clip ? p.key : null, clip ? clipSeconds(clip) : 0, p.chars, clip);
    saved?.then(() => { it.clip = null; }); // from now on read back from the device, so memory holds only what plays
  }
  _add(pos, key, dur, chars, clip) {
    const it = { pos, key, dur, clip };
    this.items.push(it);
    if (dur) { this.secs += dur; this.chars += chars; }
    this.next = this.host.after(pos);
    if (this.waiting && this.playing) {
      this._check();
      if (this.waiting) this.host.onChange(); // how much of the wait is done
    }
    this._pump();
    return it;
  }
  // the sentence as a WAV the audio element can play
  _url(it) {
    return it.urlP ||= (async () => {
      const clip = it.clip || await audioStore.get(it.key);
      if (!clip) return null;
      const { pcm, rate } = await decodeClip(clip);
      if (it.dropped) return null;
      return it.url = URL.createObjectURL(wavBlob(pcm, rate));
    })().catch(() => null);
  }
  _drop(x) { x.dropped = true; if (x.url) URL.revokeObjectURL(x.url); x.url = null; }
  _clear() {
    this.tok++;
    this._switchAt = performance.now();
    if (!this.audio.paused) this.audio.pause();
    this.audio.removeAttribute('src');
    for (const x of this.items) this._drop(x);
    this.items = []; this.at = -1; this.next = null; this.pending = null; this.waiting = false;
  }
  _playAt(i) {
    const it = this.items[i];
    if (!it) return;
    this.at = i; this.waiting = false;
    if (!it.key) { this._advance(); return; } // a sentence the model could not make: skip it
    const tok = ++this.tok;
    this._url(it).then(url => {
      if (tok !== this.tok) return;
      if (!url) { this._advance(); return; }
      this._switchAt = performance.now();
      if (!this.audio.paused) this.audio.pause();
      this.audio.src = url;
      this.audio.defaultPlaybackRate = this.audio.playbackRate = this.rate;
      if (this.playing) this.audio.play().catch(() => {});
    });
    // the next two are decoded ahead, so there is no gap between sentences
    for (const x of this.items.slice(i + 1, i + 3)) if (x.key) this._url(x);
    // drop what is far behind
    while (this.at > HISTORY) { this._drop(this.items.shift()); this.at--; }
    this.host.onStart(it.pos);
    this.host.onChange();
    this._pump();
  }
}
