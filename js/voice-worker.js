// Supertonic's speech worker. It downloads Supertonic 3 once, checks every file against its SHA-256, keeps the files in
// IndexedDB (voice-store.js), and turns sentences into audio off the page's thread. kokoro-worker.js does the same for Kokoro.
//
// The model comes from npm through jsDelivr, as base64 inside small JS files (the @3sln/donki-lle-voice-multi packages,
// a sherpa-onnx conversion of huggingface.co/Supertone/supertonic-3). The parts are read as text and decoded here;
// nothing downloaded is executed. ONNX Runtime comes from jsDelivr too, at a pinned version.
//
// Messages in:  { t: 'check' } { t: 'load' } { t: 'speak', id, text, lang, voice, steps } { t: 'forget' }
// Messages out: { t: 'checked', cached } { t: 'progress', done, total } { t: 'preparing' } { t: 'ready' }
//               { t: 'audio', id, pcm (Int16Array), sampleRate, ms } { t: 'failed', id?, message } { t: 'forgotten' }
import { Supertonic } from './supertonic.js';
import { voiceStore, sha256 } from './voice-store.js';

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const CDN = 'https://cdn.jsdelivr.net/npm/';
const VERSION = '0.1.1';
const MODEL_ID = 'supertonic-3@' + VERSION;
// file -> size, SHA-256, and its parts as [package path, byte size of the part file]
const FILES = {
  'duration_predictor.onnx': [3700147, 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db', [['multi/c/000.js', 4933551]]],
  'text_encoder.onnx': [36416150, 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff', [['multi/c/001.js', 12582931], ['multi/c/002.js', 12582931], ['multi/c/003.js', 12582931], ['multi/c/004.js', 10806151]]],
  'vector_estimator.onnx': [78400833, '20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd', [['multi/c/005.js', 12582931], ['multi/c/006.js', 12582931], ['multi/c/007.js', 12582931],
    ['multi-2/c/000.js', 12582931], ['multi-2/c/001.js', 12582931], ['multi-2/c/002.js', 12582931], ['multi-2/c/003.js', 12582931], ['multi-2/c/004.js', 12582931], ['multi-2/c/005.js', 3871167]]],
  'vocoder.onnx': [25991073, 'e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152', [['multi-2/c/006.js', 12582931], ['multi-2/c/007.js', 12582931], ['multi-3/c/000.js', 9488959]]],
  'tts.json': [8253, '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09', [['multi-3/c/001.js', 11023]]],
  'unicode_indexer.bin': [262144, '8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30', [['multi-3/c/002.js', 349547]]],
  'voice.bin': [517168, '67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8', [['multi-3/c/003.js', 689579]]],
};
const partUrl = (p) => { const [pkg, ...rest] = p.split('/'); return `${CDN}@3sln/donki-lle-voice-${pkg}@${VERSION}/${rest.join('/')}`; };

// ------------------------------------------------------------ IndexedDB: one record per file
const store = voiceStore(MODEL_ID, 'supertonic-');
const getFile = (f) => store.get(f);
const putFile = (f, buf) => store.put(f, buf);
const cached = () => store.has(Object.keys(FILES));

// ------------------------------------------------------------ download
// base64 straight from the part's bytes into the file buffer: no 25 MB strings on the way
const B64 = new Uint8Array(256).fill(255);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i; });
function decodeInto(src, from, to, out, at) {
  let acc = 0, bits = 0;
  for (let i = from; i < to; i++) {
    const v = B64[src[i]];
    if (v === 255) continue; // padding, or a stray byte
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 255; }
  }
  return at;
}
async function fetchPart(url, size, onBytes) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const buf = new Uint8Array(size);
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > size) throw new Error('part larger than expected: ' + url);
    buf.set(value, n); n += value.length; onBytes(value.length);
  }
  if (n !== size) throw new Error('part smaller than expected: ' + url);
  // export default "<base64>";
  const q1 = buf.indexOf(34), q2 = buf.lastIndexOf(34);
  const head = new TextDecoder().decode(buf.subarray(0, q1 + 1));
  if (head !== 'export default "' || q2 <= q1) throw new Error('unexpected part format: ' + url);
  return buf.subarray(q1 + 1, q2);
}
async function download(progress) {
  const total = Object.values(FILES).reduce((n, [, , parts]) => n + parts.reduce((m, [, s]) => m + s, 0), 0);
  let done = 0;
  const tick = (n) => { done += n; progress(done, total); };
  // three parts at a time, files in order so the small ones finish first
  for (const [name, [size, hash, parts]] of Object.entries(FILES)) {
    if (await getFile(name).catch(() => null)) { tick(parts.reduce((m, [, s]) => m + s, 0)); continue; }
    const out = new Uint8Array(size);
    let at = 0;
    for (let i = 0; i < parts.length; i += 3) {
      const got = await Promise.all(parts.slice(i, i + 3).map(([p, s]) => fetchPart(partUrl(p), s, tick)));
      for (const b of got) at = decodeInto(b, 0, b.length, out, at);
    }
    if (at !== size) throw new Error(`${name}: ${at} bytes, expected ${size}`);
    if (await sha256(out) !== hash) throw new Error(`${name} did not match its checksum`);
    await putFile(name, out.buffer);
  }
}

// ------------------------------------------------------------ the model
let tts = null, loading = null;
async function load(progress) {
  if (!(await cached())) await download(progress);
  post({ t: 'preparing' });
  const ort = await import(ORT + 'ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = ORT;
  ort.env.logLevel = 'error'; // not the warnings about which nodes run where
  // Threads need shared memory, which needs an isolated page (sw.js asks for it). Half the cores, at most four:
  // on a phone the other half are slow cores that hold the fast ones back.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;

  const files = {};
  for (const name of Object.keys(FILES)) {
    const buf = await getFile(name);
    if (!buf) throw new Error('missing ' + name);
    files[name] = name.endsWith('.onnx') ? new Uint8Array(buf) : name === 'tts.json' ? JSON.parse(new TextDecoder().decode(buf)) : buf;
  }
  const cpu = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  tts = await Supertonic.create(ort, files, cpu);
  await tts.speak('Ready.', 'en', { steps: 2 }); // the first run compiles kernels; do it before the reader waits on it
  // The graphics chip (WebGPU) was tried here and is left out: on a Galaxy S23 its extra 21 MB build and shader
  // compiling kept the voice from starting at all.
  post({ t: 'engine', gpu: false, threads: ort.env.wasm.numThreads });
}

const post = (m, transfer) => self.postMessage(m, transfer || []);
let queue = Promise.resolve();
self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.t === 'check') cached().then(c => post({ t: 'checked', cached: c }));
  else if (m.t === 'load') {
    loading = loading || load((done, total) => post({ t: 'progress', done, total }))
      .then(() => post({ t: 'ready' }))
      .catch(e => { loading = null; post({ t: 'failed', message: String(e && e.message || e) }); });
  } else if (m.t === 'speak') {
    // one sentence at a time, in order
    queue = queue.then(async () => {
      try {
        const t = performance.now();
        const { wav, sampleRate } = await tts.speak(m.text, m.lang, { voice: m.voice, steps: m.steps });
        const pcm = new Int16Array(wav.length);
        for (let i = 0; i < wav.length; i++) pcm[i] = Math.max(-1, Math.min(1, wav[i])) * 32767;
        post({ t: 'audio', id: m.id, pcm, sampleRate, ms: performance.now() - t }, [pcm.buffer]);
      } catch (e) { post({ t: 'failed', id: m.id, message: String(e && e.message || e) }); }
    });
  } else if (m.t === 'forget') {
    tts = null; loading = null;
    store.forget().catch(() => {}).then(() => post({ t: 'forgotten' }));
  }
};
