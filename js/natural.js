// The natural voice, page side. The speech worker (voice-worker.js) makes one sentence at a time, up to four minutes
// ahead of the voice; the page plays them through one <audio> element. Chrome keeps an audio element playing with the
// screen off and gives it lock-screen controls, which Android's built-in speech engine does not get.
//
// Positions are ReadAloud's { si, k }. The host supplies the sentences and hears what happens:
// { seg(pos), after(pos), lang(), voice(), steps(), speed(seconds, ms), onStart(pos), onEnd(), onChange(), onPause(), onFail(message) }

export const NATURAL_MB = 145;
const AHEAD_SECONDS = 240;   // generated ahead of the voice
const HISTORY = 5;           // sentences kept behind it, so going back is instant
// After running dry, seconds to have ready before going on: one wait instead of one per sentence. The host can ask for
// more when the device makes speech slower than it is read (host.refill()).
const REFILL = 15;
const same = (a, b) => !!a && !!b && a.si === b.si && a.k === b.k;

function wavBlob(pcm, rate) {
  const head = new DataView(new ArrayBuffer(44)), str = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); head.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt '); head.setUint32(16, 16, true);
  head.setUint16(20, 1, true); head.setUint16(22, 1, true); head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true);
  head.setUint16(32, 2, true); head.setUint16(34, 16, true); str(36, 'data'); head.setUint32(40, pcm.byteLength, true);
  return new Blob([head.buffer, pcm.buffer], { type: 'audio/wav' });
}

export class NaturalVoice {
  constructor(host) {
    this.host = host;
    this.status = 'unknown';   // unknown | absent | stored | downloading | preparing | ready | failed
    this.progress = 0;         // share downloaded, 0 to 1
    this.items = [];           // generated sentences in reading order: { pos, url, dur }
    this.at = -1;              // index of the sentence playing or paused on
    this.next = null;          // the next sentence to generate
    this.pending = null;       // the request the worker is on
    this.playing = false;      // the reader wants sound
    this.waiting = false;      // ...but the next sentence isn't made yet
    this.rate = 1; this.reqId = 0;
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
      this.w = new Worker(new URL('./voice-worker.js', import.meta.url), { type: 'module' });
      this.w.onmessage = (e) => this._msg(e.data);
      this.w.onerror = (e) => this._msg({ t: 'failed', message: e.message || 'The voice could not start.' });
    }
    return this.w;
  }
  // Is the model on this device? Sets status to stored or absent.
  check() {
    if (this.status !== 'unknown') return Promise.resolve(this.status !== 'absent');
    return new Promise(res => { this._checked = res; this._worker().postMessage({ t: 'check' }); });
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
    if (this.w) { this.w.postMessage({ t: 'forget' }); }
    this.status = 'absent'; this._loading = null;
  }
  // Free the model's memory; it stays stored.
  release() {
    this.stop();
    if (this.w) { this.w.terminate(); this.w = null; }
    if (this.status === 'ready' || this.status === 'preparing') this.status = 'stored';
    this._loading = null;
  }
  _msg(m) {
    switch (m.t) {
      case 'checked': this.status = m.cached ? 'stored' : 'absent'; this._checked?.(m.cached); break;
      case 'progress': this.status = 'downloading'; this.progress = m.done / m.total; break;
      case 'preparing': this.status = 'preparing'; break;
      case 'ready': this.status = 'ready'; this.progress = 1; this._loaded?.(); this._pump(); break;
      case 'audio': this._made(m); return;
      case 'failed':
        if (m.id != null) { this._made({ ...m, pcm: null }); return; }
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
    if (i >= 0) { this._playAt(i); return; }
    this._clear();
    this.next = pos; this.waiting = true;
    this.host.onChange();
    this._pump();
  }
  pause() {
    this.playing = false;
    if (!this.audio.paused) this.audio.pause();
  }
  // Go on mid-sentence, when paused on pos.
  canResume(pos) { return !this.waiting && this.at >= 0 && same(this.items[this.at]?.pos, pos); }
  resume() { this.playing = true; this.audio.play().catch(() => {}); }
  stop() { this.playing = false; this._clear(); }
  setRate(r) { this.rate = r; this.audio.defaultPlaybackRate = this.audio.playbackRate = r; }
  // how far into the current sentence, in seconds of its audio
  get elapsed() { return this.audio.currentTime || 0; }
  // seconds of speech made ahead of the voice, and how much a wait gathers before going on
  get ready() { return this.items.slice(this.at + 1).reduce((n, x) => n + x.dur, 0); }
  get target() { return (this.host.refill?.() || REFILL) * this.rate; }

  _clear() {
    this._switchAt = performance.now();
    if (!this.audio.paused) this.audio.pause();
    this.audio.removeAttribute('src');
    for (const x of this.items) if (x.url) URL.revokeObjectURL(x.url);
    this.items = []; this.at = -1; this.next = null; this.pending = null; this.waiting = false;
  }
  _pump() {
    if (this.pending || !this.next || this.status !== 'ready') return;
    const ahead = this.items.slice(this.at + 1).reduce((n, x) => n + x.dur, 0);
    if (ahead > AHEAD_SECONDS && !this.waiting) return;
    const pos = this.next, s = this.host.seg(pos);
    if (!s) { this.next = null; return; }
    this.pending = { id: ++this.reqId, pos, at: performance.now() };
    this._worker().postMessage({ t: 'speak', id: this.reqId, text: s.text, lang: this.host.lang(), voice: this.host.voice(), steps: this.host.steps() });
  }
  _made(m) {
    const p = this.pending;
    if (!p || p.id !== m.id) return; // made for a place the reader has left
    this.pending = null;
    const dur = m.pcm ? m.pcm.length / m.sampleRate : 0;
    if (m.pcm) this.host.speed(dur, m.ms);
    this.items.push({ pos: p.pos, url: m.pcm ? URL.createObjectURL(wavBlob(m.pcm, m.sampleRate)) : null, dur });
    this.next = this.host.after(p.pos);
    // waiting: go on once enough is ready (all of it at the start of a reading, so it starts at once)
    const ready = this.ready;
    if (this.waiting && this.playing && this.items[this.at + 1] && (this.at < 0 || ready >= this.target || !this.next)) this._playAt(this.at + 1);
    else if (this.waiting && !this.next && this.playing) this._advance();
    this._pump();
  }
  _playAt(i) {
    const it = this.items[i];
    if (!it) return;
    this.at = i; this.waiting = false;
    if (!it.url) { this._advance(); return; } // a sentence the model could not make: skip it
    this._switchAt = performance.now();
    if (!this.audio.paused) this.audio.pause();
    this.audio.src = it.url;
    this.audio.defaultPlaybackRate = this.audio.playbackRate = this.rate;
    if (this.playing) this.audio.play().catch(() => {});
    // drop what is far behind
    while (this.at > HISTORY) { const x = this.items.shift(); if (x.url) URL.revokeObjectURL(x.url); this.at--; }
    this.host.onStart(it.pos);
    this.host.onChange();
    this._pump();
  }
  _advance() {
    if (!this.playing) return;
    const n = this.at + 1;
    if (this.items[n]) { this._playAt(n); return; }
    if (!this.next && !this.pending) { this.playing = false; this.host.onEnd(); return; }
    this.waiting = true;
    this.host.onChange();
    this._pump();
  }
}
