// Kokoro's speech worker. It downloads Kokoro 82M once from Hugging Face at a pinned commit, checks every file against
// its SHA-256, keeps the files in IndexedDB (voice-store.js), and turns sentences into audio off the page's thread.
// Same messages as voice-worker.js, so natural.js drives either one; voice is a Kokoro speaker id, lang and steps are
// not used.
//
// The model is onnx-community's uint8f16 export: on WebAssembly it makes speech about 75% faster than the smaller q8
// export (92 MB), and the fp32 one (326 MB) is slower than both. The files are read as data; nothing downloaded is
// executed. ONNX Runtime and the eSpeak NG phonemizer are libraries from jsDelivr, at pinned versions.
import { Kokoro, KOKORO_VOICES } from './kokoro.js';
import { voiceStore, sha256 } from './voice-store.js';
import { encodeClip } from './clip.js';

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const PHONEMIZER = 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js';
const COMMIT = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const BASE = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${COMMIT}/`;
const MODEL = 'onnx/model_uint8f16.onnx';
// path -> [size, SHA-256]; the voices first, so the small files finish first
const VOICE_SIZE = 522240;
const VOICE_SHA = {
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b', af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  af_nicole: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a', af_aoede: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361',
  af_kore: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e', af_sarah: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1', am_fenrir: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  am_puck: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0', bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  bf_isabella: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f', bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  bm_fable: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1',
};
const FILES = {
  ...Object.fromEntries(KOKORO_VOICES.map(([id]) => [`voices/${id}.bin`, [VOICE_SIZE, VOICE_SHA[id]]])),
  [MODEL]: [114209226, '883333e03c597584b532eebea0f8310f25f0c9ade58fe864792c12d969944a9a'],
};
const store = voiceStore('kokoro-82m@' + COMMIT.slice(0, 7), 'kokoro-');
const cached = () => store.has(Object.keys(FILES));

// ------------------------------------------------------------ download
async function fetchFile(path, size, onBytes) {
  // a dropped connection starts the file again, twice at most
  for (let attempt = 0; ; attempt++) {
    let n = 0;
    try {
      const res = await fetch(BASE + path, { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw new Error(`${res.status} for ${path}`);
      const buf = new Uint8Array(size), reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > size) throw new Error('larger than expected: ' + path);
        buf.set(value, n); n += value.length; onBytes(value.length);
      }
      if (n !== size) throw new Error('smaller than expected: ' + path);
      return buf;
    } catch (e) {
      onBytes(-n);
      if (attempt >= 2 || /expected|^\d/.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}
async function download(progress) {
  const total = Object.values(FILES).reduce((n, [s]) => n + s, 0);
  let done = 0;
  const tick = (n) => { done += n; progress(done, total); };
  for (const [path, [size, hash]] of Object.entries(FILES)) {
    if (await store.get(path).catch(() => null)) { tick(size); continue; }
    const buf = await fetchFile(path, size, tick);
    if (await sha256(buf) !== hash) throw new Error(`${path} did not match its checksum`);
    await store.put(path, buf.buffer);
  }
}

// ------------------------------------------------------------ the model
let tts = null, loading = null;
async function load(progress) {
  if (!(await cached())) await download(progress);
  post({ t: 'preparing' });
  const [ort, { phonemize }] = await Promise.all([import(ORT + 'ort.wasm.min.mjs'), import(PHONEMIZER)]);
  ort.env.wasm.wasmPaths = ORT;
  ort.env.logLevel = 'error';
  // as in voice-worker.js: half the cores, at most four, and only on an isolated page
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;
  const voices = {};
  for (const [id] of KOKORO_VOICES) {
    const buf = await store.get(`voices/${id}.bin`);
    if (!buf) throw new Error('missing voice ' + id);
    voices[id] = buf;
  }
  const model = await store.get(MODEL);
  if (!model) throw new Error('missing model');
  tts = await Kokoro.create(ort, new Uint8Array(model), voices, phonemize, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  await tts.speak('Ready.'); // the first run compiles kernels; do it before the reader waits on it
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
        const { wav, sampleRate } = await tts.speak(m.text, { voice: m.voice });
        const ms = performance.now() - t, clip = await encodeClip(wav, sampleRate);
        post({ t: 'audio', id: m.id, clip, ms }, clip ? (clip.pcm ? [clip.pcm.buffer] : clip.chunks.map(c => c.buffer)) : []);
      } catch (e) { post({ t: 'failed', id: m.id, message: String(e && e.message || e) }); }
    });
  } else if (m.t === 'forget') {
    tts = null; loading = null;
    store.forget().catch(() => {}).then(() => post({ t: 'forgotten' }));
  }
};
