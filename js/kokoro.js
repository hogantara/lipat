// Kokoro 82M by hexgrad: a small, natural English voice (American and British speakers), run on the device with ONNX
// Runtime. Model and voices under Apache-2.0 (huggingface.co/hexgrad/Kokoro-82M, ONNX export by onnx-community). It is
// one of the models AudioSmith runs on the Mac; here it runs in the browser.
//
// Text becomes phonemes with eSpeak NG (the phonemizer package, passed in), the phonemes become token ids, and one
// model call turns the ids and a speaker's style into a 24 kHz waveform. The text normalising and phoneme fixes are
// ported from kokoro-js (github.com/hexgrad/kokoro, kokoro.js/src/phonemize.js, Apache-2.0). Like supertonic.js it
// takes ONNX Runtime as an argument, so the same code runs in the speech worker and in Node tests.

export const KOKORO_LANGS = new Set(['en']);
// The speakers shipped, best first within each group: the ones the model card grades C or better. a: American, b: British.
export const KOKORO_VOICES = [
  ['af_heart', 'Heart'], ['af_bella', 'Bella'], ['af_nicole', 'Nicole'], ['af_aoede', 'Aoede'], ['af_kore', 'Kore'], ['af_sarah', 'Sarah'],
  ['am_michael', 'Michael'], ['am_fenrir', 'Fenrir'], ['am_puck', 'Puck'],
  ['bf_emma', 'Emma'], ['bf_isabella', 'Isabella'], ['bm_george', 'George'], ['bm_fable', 'Fable'],
];
export const KOKORO_DEFAULT = 'af_heart';
export const SAMPLE_RATE = 24000;
const STYLE = 256;    // one style vector per token count
const MAX_IDS = 510;  // the model's context, without the two pads

// The tokenizer (tokenizer.json): one id per phoneme character, unknown characters dropped, a pad (0) at each end.
const SYMBOLS = '$;:,.!?—…"()“” ̃ʣʥʦʨᵝꭧAIOQSTWYᵊabcdefhijklmnopqrstuvwxyzɑɐɒæβɔɕçɖðʤəɚɛɜɟɡɥɨɪʝɯɰŋɳɲɴøɸθœɹɾɻʁɽʂʃʈʧʊʋʌɣɤχʎʒʔˈˌːʰʲ↓→↗↘ᵻ';
const IDS = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 31, 33, 35, 36, 39, 41, 42, 43, 44, 45, 46,
  47, 48, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 75, 76, 77, 78, 80, 81, 82, 83, 85, 86, 87,
  90, 92, 99, 101, 102, 103, 110, 111, 112, 113, 114, 115, 116, 118, 119, 120, 123, 125, 126, 128, 129, 130, 131, 132, 133, 135, 136, 138, 139,
  140, 142, 143, 147, 148, 156, 157, 158, 162, 164, 169, 171, 172, 173, 177];
const VOCAB = new Map([...SYMBOLS].map((c, i) => [c, IDS[i]]));
export function tokenize(phonemes) {
  const ids = [0];
  for (const c of phonemes) { const id = VOCAB.get(c); if (id != null && ids.length <= MAX_IDS) ids.push(id); }
  ids.push(0);
  return ids;
}

// ------------------------------------------------------------ text to phonemes
function splitNum(m) {
  if (m.includes('.')) return m;
  if (m.includes(':')) {
    const [h, min] = m.split(':').map(Number);
    return min === 0 ? `${h} o'clock` : min < 10 ? `${h} oh ${min}` : `${h} ${min}`;
  }
  const year = parseInt(m.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return m;
  const left = m.slice(0, 2), right = parseInt(m.slice(2, 4), 10), s = m.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${s}`;
    if (right < 10) return `${left} oh ${right}${s}`;
  }
  return `${left} ${right}${s}`;
}
function flipMoney(m) {
  const bill = m[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(m.slice(1)))) return `${m.slice(1)} ${bill}s`;
  if (!m.includes('.')) return `${m.slice(1)} ${bill}${m.slice(1) === '1' ? '' : 's'}`;
  const [b, c] = m.slice(1).split('.'), d = parseInt(c.padEnd(2, '0'), 10);
  const coins = m[0] === '$' ? (d === 1 ? 'cent' : 'cents') : d === 1 ? 'penny' : 'pence';
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`;
}
const pointNum = (m) => { const [a, b] = m.split('.'); return `${a} point ${b.split('').join(' ')}`; };

// Numbers, money, times, titles and possessives in the words the voice was trained on.
export function normalize(text) {
  return String(text)
    .replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"').replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/、/g, ', ').replace(/。/g, '. ').replace(/！/g, '! ').replace(/，/g, ', ').replace(/：/g, ': ').replace(/；/g, '; ').replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ').replace(/  +/g, ' ').replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor').replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister').replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs').replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S").replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

// Punctuation goes to the model as it is (it shapes the pauses and the tune); the words between go through eSpeak.
const PUNCT = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g;
// espeak(text, lang) -> lines of IPA. British speakers (b) get eSpeak's British English.
export async function phonemize(text, espeak, british = false) {
  text = normalize(text);
  const parts = [];
  let prev = 0;
  for (const m of text.matchAll(PUNCT)) {
    if (prev < m.index) parts.push([false, text.slice(prev, m.index)]);
    if (m[0]) parts.push([true, m[0]]);
    prev = m.index + m[0].length;
  }
  if (prev < text.length) parts.push([false, text.slice(prev)]);
  const lang = british ? 'en' : 'en-us';
  let ps = '';
  for (const [punct, t] of parts) ps += punct ? t : (await espeak(t, lang)).join(' ');
  ps = ps.replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (!british) ps = ps.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return ps.trim();
}

// ------------------------------------------------------------ the model
export class Kokoro {
  // model: the ONNX file's bytes; voices: { id: ArrayBuffer of [510, 256] float32 }; espeak: phonemizer's phonemize
  static async create(ort, model, voices, espeak, sessionOptions = {}) {
    const session = await ort.InferenceSession.create(model, sessionOptions);
    const styles = {};
    for (const [id, buf] of Object.entries(voices)) styles[id] = new Float32Array(buf);
    return new Kokoro(ort, session, styles, espeak);
  }
  constructor(ort, session, styles, espeak) {
    Object.assign(this, { ort, session, styles, espeak });
    this.sampleRate = SAMPLE_RATE;
  }
  // One sentence: { wav: Float32Array, sampleRate }. speed 1 is the model's own pace.
  async speak(text, { voice = KOKORO_DEFAULT, speed = 1 } = {}) {
    const style = this.styles[voice] ? voice : KOKORO_DEFAULT, data = this.styles[style];
    const ids = tokenize(await phonemize(text, this.espeak, style[0] === 'b'));
    if (ids.length <= 2) return { wav: new Float32Array(0), sampleRate: SAMPLE_RATE };
    // each length of input has its own style vector
    const n = Math.min(ids.length - 2, data.length / STYLE - 1), T = (type, d, dims) => new this.ort.Tensor(type, d, dims);
    const out = await this.session.run({
      input_ids: T('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      style: T('float32', data.slice(n * STYLE, (n + 1) * STYLE), [1, STYLE]),
      speed: T('float32', new Float32Array([speed]), [1]),
    });
    return { wav: out.waveform.data, sampleRate: SAMPLE_RATE };
  }
}
