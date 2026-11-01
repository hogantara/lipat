// Supertonic 3 by Supertone: a natural neural voice for 31 languages, Indonesian among them, run on the device
// with ONNX Runtime. Model under OpenRAIL-M, reference code under MIT (github.com/supertone-inc/supertonic).
// This is a port of the reference web helper (web/helper.js) with typed arrays in place of nested ones, so the
// glue around each model call costs microseconds instead of seconds. It takes ONNX Runtime as an argument, so the
// same code runs in Lipat's speech worker and in Node tests.
//
// One sentence in, audio out: a duration predictor sets the length, a text encoder reads the characters, a flow
// matching estimator turns noise into speech features over a few steps, and a vocoder makes the waveform.

export const SUPERTONIC_LANGS = new Set(['ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu',
  'id', 'it', 'ja', 'ko', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi']);
// The ten voice styles in voice.bin, in sherpa-onnx's order: the female ones first (index 0 has a median pitch near
// 186 Hz, index 5 near 130 Hz).
export const SUPERTONIC_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];

const REPLACE = { '–': '-', '‑': '-', '—': '-', '_': ' ', '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'",
  '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ' };
const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

// The reference preprocessing: the model was trained on text shaped like this.
export function prepareText(text, lang) {
  let t = String(text).normalize('NFKD').replace(EMOJI, '');
  for (const [k, v] of Object.entries(REPLACE)) t = t.replaceAll(k, v);
  t = t.replace(/[♥☆♡©\\]/g, '').replaceAll('@', ' at ').replaceAll('e.g.,', 'for example, ').replaceAll('i.e.,', 'that is, ');
  t = t.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  while (t.includes('""')) t = t.replace('""', '"');
  while (t.includes("''")) t = t.replace("''", "'");
  t = t.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(t)) t += '.';
  return `<${lang}>${t}</${lang}>`;
}

// voice.bin (sherpa-onnx's layout): six int64 shape values, [n, 50, 256] for style_ttl and [n, 8, 16] for style_dp,
// then the float32 data of every voice's ttl, then every voice's dp.
export function parseVoices(buf) {
  const head = new DataView(buf, 0, 48), dim = (i) => Number(head.getBigInt64(i * 8, true));
  const [n, t1, t2, , d1, d2] = [0, 1, 2, 3, 4, 5].map(dim);
  const ttl = new Float32Array(buf, 48, n * t1 * t2), dp = new Float32Array(buf, 48 + n * t1 * t2 * 4, n * d1 * d2);
  return Array.from({ length: n }, (_, i) => ({
    ttl: ttl.slice(i * t1 * t2, (i + 1) * t1 * t2), ttlDims: [1, t1, t2],
    dp: dp.slice(i * d1 * d2, (i + 1) * d1 * d2), dpDims: [1, d1, d2],
  }));
}

function randn(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(Math.max(1e-4, Math.random()))), a = 2 * Math.PI * Math.random();
    out[i] = r * Math.cos(a); if (i + 1 < n) out[i + 1] = r * Math.sin(a);
  }
  return out;
}

export class Supertonic {
  // files: { 'duration_predictor.onnx', 'text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx' } as bytes,
  // 'tts.json' as an object, 'unicode_indexer.bin' and 'voice.bin' as ArrayBuffers.
  // sessionOptions: one set for all four models, or a function of the model's file name.
  static async create(ort, files, sessionOptions = {}) {
    const open = (name) => ort.InferenceSession.create(files[name], typeof sessionOptions === 'function' ? sessionOptions(name) : sessionOptions);
    // one at a time: four parallel compiles can double the peak memory on a phone
    const dp = await open('duration_predictor.onnx'), enc = await open('text_encoder.onnx');
    const est = await open('vector_estimator.onnx'), voc = await open('vocoder.onnx');
    return new Supertonic(ort, { dp, enc, est, voc }, files['tts.json'], new Int32Array(files['unicode_indexer.bin']), parseVoices(files['voice.bin']));
  }
  constructor(ort, sessions, cfg, indexer, voices) {
    Object.assign(this, { ort, ...sessions, cfg, indexer, voices });
    this.sampleRate = cfg.ae.sample_rate;
  }
  // One sentence: { wav: Float32Array, sampleRate }. speed 1 is the model's own pace; the reference uses 1.05.
  async speak(text, lang, { voice = 0, steps = 8, speed = 1.05 } = {}) {
    const { ort, cfg, indexer } = this, T = (type, data, dims) => new ort.Tensor(type, data, dims);
    const s = prepareText(text, lang), L = s.length;
    const ids = new BigInt64Array(L);
    for (let j = 0; j < L; j++) { const cp = s.codePointAt(j); ids[j] = BigInt(cp < indexer.length ? indexer[cp] : -1); }
    const v = this.voices[voice] || this.voices[0];
    const textIds = T('int64', ids, [1, L]), textMask = T('float32', new Float32Array(L).fill(1), [1, 1, L]);
    const styleTtl = T('float32', v.ttl, v.ttlDims), styleDp = T('float32', v.dp, v.dpDims);
    const { duration } = await this.dp.run({ text_ids: textIds, style_dp: styleDp, text_mask: textMask });
    const seconds = duration.data[0] / speed;
    const { text_emb } = await this.enc.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask });
    const wavLen = Math.floor(seconds * this.sampleRate), chunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
    const len = Math.max(1, Math.ceil(wavLen / chunk)), dim = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
    let xt = randn(dim * len);
    const latentMask = T('float32', new Float32Array(len).fill(1), [1, 1, len]), total = T('float32', new Float32Array([steps]), [1]);
    for (let step = 0; step < steps; step++) {
      const out = await this.est.run({ noisy_latent: T('float32', xt, [1, dim, len]), text_emb, style_ttl: styleTtl, latent_mask: latentMask,
        text_mask: textMask, current_step: T('float32', new Float32Array([step]), [1]), total_step: total });
      xt = out.denoised_latent.data;
    }
    const { wav_tts } = await this.voc.run({ latent: T('float32', xt, [1, dim, len]) });
    return { wav: wav_tts.data.slice(0, wavLen), sampleRate: this.sampleRate };
  }
}
