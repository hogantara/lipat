// Read aloud. Two engines read the same sentences: the natural voice (Supertonic 3, run on the device; see natural.js)
// and the device voice (the Web Speech API: free, in every language the phone or browser speaks, but stopped by Android
// when the screen turns off). This module prepares the text, picks the engine and voice, and runs the player.
//
// Natural, understandable speech comes from what the voice is given and which voice is picked:
// - The text is cleaned for the ear. Footnote numbers, page numbers, code, ruby readings and bullets
//   are dropped, links become their site name, soft hyphens go, and headings or runs set in capitals
//   are put in sentence case so the voice doesn't spell them out.
// - It is spoken one whole sentence at a time, so the voice keeps its intonation. Intl.Segmenter
//   splits after "Mr." or "J." and before "she asked", so those are joined again. Only very long
//   sentences are cut, at a clause.
// - The device voice is the best one installed for the book's language: natural, premium and online voices
//   first, novelty and eSpeak voices last. The language comes from the file, or from the text itself
//   when the file doesn't say (PDF, Word, text) or says something the text contradicts.
//
// Device voice quirks handled here:
// - Android Chrome can't pause(). Pause cancels, and play says the sentence again from its start.
// - Chrome's network voices go silent after about 15 s in one utterance, so their sentences are cut shorter.
// - Utterances are queued ahead in the engine, so the voice goes on with the screen off while the
//   page's scripts are throttled. A watchdog restarts the sentence if the engine goes quiet.
// - A silent looping <audio> gives the session lock-screen and headset controls (Media Session).
//   Not on iOS, where it would take the audio session from the speech.
//
// Positions are character offsets into a section's textContent, like marks, so they survive the
// <mark> and search-hit wrappers that split text nodes.
import { db } from './db.js';
import { NaturalVoice, NATURAL_MB } from './natural.js';
import { SUPERTONIC_LANGS, SUPERTONIC_VOICES } from './supertonic.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const same = (a, b) => !!a && !!b && a.si === b.si && a.k === b.k;
const frame = () => new Promise(r => { requestAnimationFrame(() => r()); setTimeout(r, 60); });

const AHEAD = 24;                                   // utterances queued in the engine ahead of the voice
const HL = 'lipat-say', HL_WORD = 'lipat-say-word'; // CSS custom highlight names (see app.css)
const IOS = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

// ------------------------------------------------------------ languages
// BCP 47, with Java's old codes (Android once reported Indonesian as "in") and underscores fixed.
export function normLang(tag) {
  if (!tag) return '';
  const [l, ...rest] = String(tag).trim().replace(/_/g, '-').split('-');
  const low = l.toLowerCase();
  const base = { in: 'id', iw: 'he', ji: 'yi', jw: 'jv', mo: 'ro', tl: 'fil' }[low] || low;
  if (!/^[a-z]{2,3}$/.test(base) || ['und', 'mul', 'zxx', 'mis'].includes(base)) return '';
  const region = rest.find(x => /^([a-z]{2}|\d{3})$/i.test(x));
  return region ? `${base}-${region.toUpperCase()}` : base;
}
export const baseOf = (tag) => normLang(tag).split('-')[0];

let langNames, regionNames;
export const langName = (b) => { try { langNames = langNames || new Intl.DisplayNames(['en'], { type: 'language' }); return langNames.of(b) || b; } catch { return b; } };
const regionName = (r) => { try { regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' }); return regionNames.of(r) || r; } catch { return r; } };

// Common short words, for telling Latin-script languages apart.
const STOP = Object.fromEntries(Object.entries({
  en: 'the and of to in is that it was for with as his he on be at by you are this have not but had from they she her which or we an were there been one all their so would',
  id: 'yang dan di ini itu dengan untuk tidak dari dalam akan ke pada juga ada saya kami mereka adalah karena atau bisa sudah oleh sebagai telah kita aku dia ia lebih saat seperti hanya harus tetapi namun',
  es: 'el la de que y en los se del las un por con no una su para es al lo como más pero sus le ya este porque esta entre cuando muy sin sobre también me hasta hay donde',
  fr: 'le la de et les des en un une du est que qui dans pour pas au sur ne se ce il elle plus par je avec son sa ses nous vous mais ou était',
  de: 'der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um noch wie',
  pt: 'o a de que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está eu também',
  it: 'il di che e la per un in è non una del sono le si da con i della al gli ma come anche lo ha più questo nel alla se ci',
  nl: 'de het een en van in is dat op te zijn met voor niet aan er die maar om ook als dan bij nog door wat naar hij ze',
  sv: 'och i att det som en på är av för med till den har de inte om ett men var jag hon han sig',
  da: 'og i at det en den til er som på de med for af ikke der var har et men jeg hun han sig',
  nb: 'og i det at en som på er for til av med de ikke den har var jeg seg men om et han hun',
  fi: 'ja on ei se että hän oli ole mutta kun niin myös tai jos joka mitä ovat sen',
  pl: 'i w nie na się z że do to jest jak o co ale po tak od za jego przez tym był',
  cs: 'a se na je že v to s z do o ve jako by pro ale jsem není když jak tak',
  tr: 've bir bu da de için ile çok ne o ama gibi daha var olan sonra kadar ben en mi',
  vi: 'và của là có không được một những trong cho người này các với đã khi thì như để',
  ro: 'și de în a la cu nu se că pe o un este din care mai ce pentru sunt',
  hu: 'a az és hogy nem is egy meg van ez de csak már még volt ki mint',
  ca: 'i de la el que en a les els per un una amb no és del al dels més com',
  fil: 'ang ng sa na at mga ay si ko hindi niya ako siya ito kung',
  sw: 'na ya wa kwa katika ni la za hii kuwa au lakini kama hiyo',
}).map(([k, v]) => [k, new Set(v.split(' '))]));
const SCRIPTS = { ko: /\p{sc=Hangul}/gu, ar: /\p{sc=Arabic}/gu, he: /\p{sc=Hebrew}/gu, ru: /\p{sc=Cyrillic}/gu, el: /\p{sc=Greek}/gu, th: /\p{sc=Thai}/gu, hi: /\p{sc=Devanagari}/gu, bn: /\p{sc=Bengali}/gu, ta: /\p{sc=Tamil}/gu, te: /\p{sc=Telugu}/gu, gu: /\p{sc=Gujarati}/gu, pa: /\p{sc=Gurmukhi}/gu, kn: /\p{sc=Kannada}/gu, ml: /\p{sc=Malayalam}/gu, ka: /\p{sc=Georgian}/gu, hy: /\p{sc=Armenian}/gu, km: /\p{sc=Khmer}/gu, lo: /\p{sc=Lao}/gu, my: /\p{sc=Myanmar}/gu, si: /\p{sc=Sinhala}/gu, am: /\p{sc=Ethiopic}/gu };

// The language of a stretch of text: { lang, sure } or null when there is too little to tell.
export function detectLang(text) {
  const t = String(text || '').slice(0, 30000);
  const count = (re) => (t.match(re) || []).length;
  const letters = count(/\p{L}/gu);
  if (letters < 40) return null;
  const kana = count(/[\p{sc=Hiragana}\p{sc=Katakana}]/gu), han = count(/\p{sc=Han}/gu);
  if ((kana + han) / letters > 0.3) return { lang: kana > (kana + han) * 0.05 ? 'ja' : 'zh', sure: true };
  for (const [lang, re] of Object.entries(SCRIPTS)) {
    const n = count(re);
    if (n / letters < 0.4) continue;
    if (lang === 'ar') return { lang: count(/[ٹڈڑںے]/gu) > n * 0.01 ? 'ur' : count(/[پچژگ]/gu) > n * 0.01 ? 'fa' : 'ar', sure: true };
    if (lang === 'ru') return { lang: count(/[ђћџљњј]/giu) > n * 0.01 ? 'sr' : count(/[ієїґ]/giu) > n * 0.01 ? 'uk' : count(/[ыэ]/giu) < n * 0.001 && count(/ъ/giu) > n * 0.005 ? 'bg' : 'ru', sure: true };
    return { lang, sure: true };
  }
  const words = t.toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 20) return null;
  const scores = Object.entries(STOP).map(([lang, set]) => [lang, words.reduce((n, w) => n + set.has(w), 0) / words.length]).sort((a, b) => b[1] - a[1]);
  const [[lang, best], [, second]] = scores;
  if (best < 0.05) return null;
  return { lang, sure: best >= 0.12 && best >= second * 1.3 };
}

// ------------------------------------------------------------ voices
const DEFAULT_REGION = { en: 'US', es: 'ES', pt: 'BR', fr: 'FR', de: 'DE', zh: 'CN', ar: 'SA', id: 'ID', nl: 'NL', it: 'IT', ja: 'JP', ko: 'KR', ru: 'RU', hi: 'IN', ms: 'MY', sv: 'SE', bn: 'IN', ta: 'IN' };
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;
const DATED = /^(Junior|Ralph|Fred|Kathy|Princess|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const prefRegions = (lang) => {
  const b = baseOf(lang);
  try { return (navigator.languages || [navigator.language]).map(normLang).filter(t => t.startsWith(b + '-')).map(t => t.split('-')[1]); } catch { return []; }
};

// How good a voice is for a language; -Infinity when it speaks another language.
export function voiceScore(v, lang, regions = prefRegions(lang)) {
  const [vb, vr] = normLang(v.lang).split('-'), [wb, wr] = normLang(lang).split('-');
  if (!vb || vb !== wb) return -Infinity;
  const n = v.name || '';
  let s = 0;
  if (vr && vr === wr) s += 20;
  else if (vr && regions.includes(vr)) s += 12 - regions.indexOf(vr);
  else if (vr && DEFAULT_REGION[wb] === vr) s += 6;
  if (/natural|neural|wavenet|journey|studio|chirp|premium/i.test(n)) s += 60;   // Edge, Google, Apple top tiers
  else if (/enhanced|online|siri/i.test(n)) s += 35;
  else if (/^google\b/i.test(n) && !v.localService) s += 25;                      // Chrome's network voices
  if (/espeak|festival|mbrola|\bpico\b/i.test(n)) s -= 80;
  if (/compact/i.test(n)) s -= 40;
  if (NOVELTY.test(n)) s -= 100; else if (DATED.test(n)) s -= 30;
  if (v.default) s += 4;
  if (v.localService) s += 1;
  return s;
}
export function rankVoices(voices, lang, regions = prefRegions(lang)) {
  return voices.map(v => [v, voiceScore(v, lang, regions)]).filter(([, s]) => s > -Infinity).sort((a, b) => b[1] - a[1]).map(([v]) => v);
}
// "Microsoft Aria Online (Natural) - English (United States)" -> "Aria (Natural)"
export function voiceLabel(v) {
  return (v.name || v.voiceURI || 'Voice').replace(/^(Microsoft|Google|Apple)\s+/i, '').replace(/\s+Online\s*\(Natural\)/i, ' (Natural)').replace(/\s+-\s+[^-]+$/, '').trim();
}

// ------------------------------------------------------------ text for the ear
// Replace in a string while keeping, for every character, the section offset it came from.
function mreplace({ s, o }, re, fn) {
  let out = '', oo = [], last = 0;
  for (const m of s.matchAll(re)) {
    const i = m.index, len = m[0].length;
    out += s.slice(last, i); for (let k = last; k < i; k++) oo.push(o[k]);
    const r = typeof fn === 'function' ? fn(m[0], i, s) : fn;
    out += r; for (let k = 0; k < r.length; k++) oo.push(o[i + (r.length > 1 ? Math.round(k * (len - 1) / (r.length - 1)) : 0)]);
    last = i + len;
  }
  if (!last) return { s, o };
  out += s.slice(last); for (let k = last; k < s.length; k++) oo.push(o[k]);
  return { s: out, o: oo };
}
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'“”]*[^\s<>"'“”.,;:!?)\]]/gi;
const ROMAN = /^(?=[MDCLXVI])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
// two or more words in capitals in a row: CHAPTER ONE, IT WAS A bright cold day
const SHOUT = /(?<![\p{L}\p{N}])\p{Lu}[\p{Lu}\p{M}'’]*(?:[\s,;:\-–—.]+\p{Lu}[\p{Lu}\p{M}'’]*)+(?![\p{L}\p{N}])/gu;
const safeLocale = (lang) => { try { 'a'.toLocaleLowerCase(lang); return lang; } catch { return undefined; } };
// Lower case, keeping Roman numerals, initials and "I", then a capital at each sentence start.
function sentenceCase(m, capFirst, lang) {
  let r = m.replace(/\p{L}[\p{L}\p{M}'’]*/gu, (w, i, str) => (w.length > 1 ? ROMAN.test(w) : w === 'I' || str[i + 1] === '.') ? w : w.toLocaleLowerCase(lang));
  r = r.replace(/([.!?…]\s+["'“‘(]*)(\p{Ll})/gu, (_, a, b) => a + b.toLocaleUpperCase(lang));
  if (capFirst) r = r.replace(/^(\P{L}*)(\p{Ll})/u, (_, a, b) => a + b.toLocaleUpperCase(lang));
  return r;
}
const startsSentence = (s, i) => { const b = s.slice(0, i).trimEnd(); return !b || /[.!?…:]["'”’)\]]*$/u.test(b) || /^["'“‘«(\[]+$/u.test(b); };

function clean(t, heading, lang) {
  lang = safeLocale(lang);
  t = mreplace(t, /[­​⁠﻿]/g, '');                               // soft hyphens, zero-width spaces
  t = mreplace(t, /[•▪◦●■□◆◇►▸▶➢➤✓✔☐☑]/gu, ' ');                                     // bullets read as "bullet"
  t = mreplace(t, URL_RE, m => m.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0]);
  t = mreplace(t, /\s*\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/g, '');                      // citation numbers [12]
  t = mreplace(t, /\s+/g, ' ');
  if (heading && !/\p{Ll}/u.test(t.s) && (t.s.match(/\p{Lu}/gu) || []).length >= 3) t = mreplace(t, /^[\s\S]+$/gu, m => sentenceCase(m, true, lang));
  else t = mreplace(t, SHOUT, (m, i, s) => /\p{Lu}{2}/u.test(m) ? sentenceCase(m, startsSentence(s, i), lang) : m);
  return t;
}

// Titles and abbreviations that a sentence never ends on in practice; a number follows the second set.
const TITLES = new Set('mr mrs ms mx dr prof st mt sr jr gen col capt cpt lt sgt rev hon pres gov sen rep fr hr mme mlle sra srta dipl ing eg ie cf vs viz bpk ny nn sdr sdri jl drs dra ir hj kh tn yth'.split(' '));
const NUMBERED = new Set('no nos nr fig figs vol vols ch chap pp p art sec hlm tab eq ex'.split(' '));
const ORDINAL_DOT = new Set(['de', 'da', 'nb', 'no', 'fi', 'cs', 'sk', 'pl', 'hu', 'sl', 'hr', 'sr', 'et', 'lv', 'lt', 'is', 'tr']);
function joins(prev, next, lang) {
  const p = prev.trimEnd(), n = next.replace(/^[\s"'“”‘’«»(\[¿¡—–-]+/u, '');
  if (!/\p{L}/u.test(p)) return true;                       // "1." or "*" before the text it numbers
  if (/^\p{Ll}/u.test(n)) return true;                      // “Really?” she asked. / dll. kemudian pulang
  if (/\d\.$/.test(p) && ORDINAL_DOT.has(baseOf(lang))) return true; // am 3. Oktober
  const m = p.match(/(?:^|[^\p{L}.])([\p{L}.]*\p{L})\.$/u);
  if (!m) return false;
  if (/^\p{Lu}$/u.test(m[1])) return true;                  // an initial: J. R. R. Tolkien
  // U.S., U.K.: usually mid-sentence. When one does end a sentence, the voice still hears "U.S. The" and pauses itself.
  if (/^\p{Lu}(\.\p{Lu})+$/u.test(m[1])) return true;
  const w = m[1].replace(/\./g, '').toLowerCase();
  return TITLES.has(w) || (NUMBERED.has(w) && /^\d/.test(n)); // Mr. Smith, e.g. Paris, No. 5
}
const trimSpan = (s, a, b) => { while (a < b && /\s/.test(s[a])) a++; while (b > a && /\s/.test(s[b - 1])) b--; return [a, b]; };
const segmenters = new Map();
function segmenter(lang) {
  const b = baseOf(lang) || 'en';
  if (!segmenters.has(b)) {
    let sg = null;
    try { sg = new Intl.Segmenter(b, { granularity: 'sentence' }); } catch { try { sg = new Intl.Segmenter('en', { granularity: 'sentence' }); } catch {} }
    segmenters.set(b, sg);
  }
  return segmenters.get(b);
}
// Sentence spans [start, end) in s, trimmed.
export function sentences(s, lang = 'en') {
  const sg = segmenter(lang);
  const raw = sg ? Array.from(sg.segment(s), x => [x.index, x.index + x.segment.length])
    : Array.from(s.matchAll(/[^.!?…。！？]+(?:[.!?…。！？]+["'”’)\]]*)?\s*/gu), m => [m.index, m.index + m[0].length]);
  const out = [];
  for (const [a, b] of raw) { const p = out[out.length - 1]; if (p && joins(s.slice(p[0], p[1]), s.slice(a, b), lang)) p[1] = b; else out.push([a, b]); }
  return out.map(([a, b]) => trimSpan(s, a, b)).filter(([a, b]) => b > a);
}
// Cut [a, b) into pieces of at most max characters, at a clause if there is one.
const CUTS = [/[;:]\s/g, /[,，、]\s?/g, /\s[—–]\s?/g, /\s/g];
function cut(s, a, b, max) {
  const out = [];
  while (b - a > max) {
    const lo = a + Math.floor(max * 0.4), hi = a + max;
    let k = -1;
    for (const re of CUTS) {
      re.lastIndex = lo;
      for (let m; (m = re.exec(s)) && m.index + m[0].length <= hi;) k = m.index + m[0].length;
      if (k > a) break;
    }
    if (k <= a) k = hi;
    out.push(trimSpan(s, a, k)); a = k;
  }
  out.push(trimSpan(s, a, b));
  return out.filter(([x, y]) => y > x);
}

// One block of text, given as runs of [text, section offset], as utterances:
// [{ text, start, end, map }] where map[i] is the section offset of text[i].
export function speakable(runs, { heading = false, lang = 'en', maxLen = 320 } = {}) {
  let t = { s: '', o: [] };
  for (const [s, off] of runs) { t.s += s; for (let i = 0; i < s.length; i++) t.o.push(off + i); }
  const { s, o } = clean(t, heading, lang);
  if (!/[\p{L}\p{N}]/u.test(s) || (!heading && /^[\d\s.,–-]+$/u.test(s))) return []; // a stray page number
  const out = [];
  for (const [a, b] of sentences(s, lang)) for (const [x, y] of cut(s, a, b, maxLen)) {
    const text = s.slice(x, y);
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    const map = o.slice(x, y);
    out.push({ text, map, start: map[0], end: map[map.length - 1] + 1 });
  }
  // a heading ends with a full stop so the voice drops its pitch and pauses
  const last = out[out.length - 1];
  if (heading && last && !/[.!?…:;。！？]["'”’)\]]*$/u.test(last.text)) { last.text += '.'; last.map.push(last.map[last.map.length - 1]); }
  return out;
}

// ------------------------------------------------------------ DOM helpers
const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|CAPTION|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/;
// not read: code, ruby readings, PDF page numbers and footnotes, hidden text
const SKIP = 'pre, script, style, rt, rp, .pg, p.fn, [aria-hidden="true"], [hidden]';
// a footnote marker: a superscript or link that is only a number or a symbol
const MARKER = /^[\s[(]*(?:\d{1,3}|[*†‡§¶#]+)[\])\s.,]*$/;
function skipped(el, cache) {
  if (cache.has(el)) return cache.get(el);
  let r = !!el.closest(SKIP);
  if (!r) { const x = el.closest('sup, a[href], a[data-epub-target]'); r = !!x && MARKER.test(x.textContent); }
  cache.set(el, r);
  return r;
}
// A Range over [start, end) of root's textContent.
function textRange(root, start, end) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), r = document.createRange();
  let pos = 0, started = false, n, last = null;
  while ((n = w.nextNode())) {
    const len = n.data.length; last = n;
    if (!started && start < pos + len) { r.setStart(n, Math.max(0, start - pos)); started = true; }
    if (started && end <= pos + len) { r.setEnd(n, Math.max(0, end - pos)); return r; }
    pos += len;
  }
  if (started && last) r.setEnd(last, last.data.length);
  return started ? r : null;
}
const offsetBefore = (root, el) => { const r = document.createRange(); r.selectNodeContents(root); r.setEndBefore(el); return r.toString().length; };
const highlight = (name, range) => {
  const h = window.CSS?.highlights;
  if (!h || typeof Highlight === 'undefined') return;
  if (range) h.set(name, new Highlight(range)); else h.delete(name);
};
const fmtRate = (r) => `${Math.round(r * 100) / 100}×`;
function onVoices(fn) { if (typeof speechSynthesis.addEventListener === 'function') speechSynthesis.addEventListener('voiceschanged', fn); else speechSynthesis.onvoiceschanged = fn; }
function voicesReady(ms = 1500) {
  return new Promise(res => {
    const now = speechSynthesis.getVoices();
    if (now.length) return res(now);
    let done = false;
    const fin = () => { if (!done) { done = true; res(speechSynthesis.getVoices()); } };
    onVoices(fin); setTimeout(fin, ms);
  });
}
// iOS and Chrome only speak after a tap. When the first real utterance has to wait (voices loading,
// leaving the PDF page view), a silent one inside the tap unlocks speech for the page.
let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
}
// 10 s of 8-bit silence as a WAV: Chrome shows media controls only for media longer than a few seconds.
let silenceUrl = null;
function silence() {
  if (silenceUrl) return silenceUrl;
  const rate = 8000, n = rate * 10, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return silenceUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function hint(hasVoice) {
  const ua = navigator.userAgent, pf = navigator.platform || '';
  const lead = hasVoice ? '' : 'Add a voice for this language on your device, then come back. ';
  if (/Android/i.test(ua)) return lead + 'Voices come from Android. For a more natural one, open Android Settings, search for Text-to-speech, and install voice data for your language.';
  if (IOS) return lead + 'Voices come from your device. For a more natural one, download an Enhanced or Premium voice in Settings, Accessibility, Spoken Content, Voices.';
  if (/Edg\//.test(ua)) return lead + 'Voices marked Natural sound the most human. They need a connection.';
  if (/Mac/.test(pf)) return lead + 'Voices come from macOS. For a more natural one, add a Premium or Enhanced voice in System Settings, Accessibility, Spoken Content.';
  if (/Win/.test(pf)) return lead + 'Voices come from Windows and your browser. Microsoft Edge has natural voices built in.';
  return lead + 'Voices come from your device and browser.';
}

// ------------------------------------------------------------ the player
// Two engines read the same sentences. The natural voice (Supertonic 3, natural.js) sounds like a person and keeps
// going with the screen off; it speaks 31 languages and downloads once. The device voice (Web Speech API, below) needs
// nothing and speaks every language the device has, but Android stops it when the screen turns off.
const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2];
export class ReadAloud {
  constructor(reader) {
    this.r = reader;
    this.state = 'off';            // off | playing | paused
    this.segs = new Map();         // section index -> utterances, built when first needed
    this.cur = null;               // { si, k } being read, or paused on
    this.next = null;              // the next one to queue (device voice)
    this.q = [];                   // queued in the engine, oldest first: { u, pos } (device voice)
    this.gen = 0;                  // bumped on every restart; events of older utterances are ignored
    // engine: null until the reader picks one; natural: Supertonic voice style; steps: its denoising steps, tuned to this device
    this.prefs = { rate: 1, voices: {}, engine: null, natural: 0, steps: 6 };
    this.badVoices = new Set();    // network voices that failed this session
    this.following = true;         // the page keeps the voice in view until the reader scrolls away from it
    this.errors = 0;
    this.bar = $('#say-bar'); this.pop = $('#say-pop');
    // voices load late on most platforms; ask early so the first tap can speak at once
    this.voices = speechSynthesis.getVoices();
    onVoices(() => { this.voices = speechSynthesis.getVoices(); if (!this.pop.hidden) this._renderPop(); });
    this.ready = db.getSetting('listen', null).then(p => {
      if (p) this.prefs = { ...this.prefs, ...p, voices: { ...(p.voices || {}) } };
      this.prefs.steps = clamp(this.prefs.steps || 6, 5, 8); // older builds went down to 3, which sounds broken
      this._syncRate();
    });
    this.nat = new NaturalVoice({
      seg: (pos) => this._seg(pos), after: (pos) => this._after(pos),
      lang: () => baseOf(this.lang), voice: () => this.prefs.natural, steps: () => this.prefs.steps,
      speed: (sec, ms) => this._tune(sec, ms),
      // slower than the voice: gather a minute before going on, so the waits are rare
      refill: () => this.speedSeen && this.speedSeen < this.prefs.rate * 1.05 ? 60 : 15,
      onStart: (pos) => { if (this.state === 'playing' && !same(pos, this.cur)) this._setCurrent(pos); },
      onEnd: () => this._finish(),
      onChange: () => { this._ui(); if (!this.pop.hidden) this._renderPop(); },
      onPause: () => { if (this.state === 'playing') { this.state = 'paused'; this._ui(); } },
      onFail: (msg) => { if (this.engine === 'natural' && this.state !== 'off') { this.pause(); this.r.toast("The natural voice didn't load. Check your connection and try again.", { label: 'Details', fn: () => this.r.toast(String(msg).slice(0, 160)) }); } },
    });
    // a mark or search hit wraps text under the highlight: point the highlight at the new nodes
    this.observer = new MutationObserver(() => { if (this.state !== 'off') this._paint(); });
    addEventListener('pagehide', () => speechSynthesis.cancel());
    $$('[data-act="listen"]', reader.view).forEach(b => { b.hidden = false; });
    // a finger or wheel on the page: whatever scrolls next is the reader's doing, not the page following the voice
    const user = () => { this._userAt = Date.now(); };
    for (const t of ['touchmove', 'wheel']) reader.scroller.addEventListener(t, user, { passive: true });
    this._wire();
  }

  _wire() {
    this.bar.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-say]'); if (!b) return;
      ({ play: () => this.toggle(), back: () => this.skip(-1), next: () => this.skip(1), voice: () => this.togglePop(), stop: () => this.stop(),
        rate: () => this.setRate(RATES.find(x => x > this.prefs.rate + 0.01) || RATES[0]),
        here: () => this.play({ here: true }), find: () => { this.following = true; this._reveal(true); this._ui(); } })[b.dataset.say]?.();
    });
    $('#say-engine').onclick = (ev) => { const b = ev.target.closest('button'); if (b) this.setEngine(b.dataset.v); };
    $('#say-get').onclick = () => this._getNatural();
    // the first-time choice is kept only once the reader starts with it
    $('#say-start').onclick = () => { this.prefs.engine = this._chosen || 'natural'; this._save(); this.closePop(); this.play(); };
    $('#say-remove').onclick = () => {
      if (!confirm(`Remove the natural voice from this device? Getting it back is a ${NATURAL_MB} MB download.`)) return;
      if (this.engine === 'natural') this.stop();
      this.nat.forget(); this._renderPop();
    };
    $('#say-lang').onchange = (ev) => this.setLang(ev.target.value);
    $('#say-voice').onchange = (ev) => this.setVoice(ev.target.value);
    const rate = $('#say-rate');
    rate.oninput = () => this.setRate(Number(rate.value));
    $$('[data-rate]', this.pop).forEach(b => b.onclick = () => this.setRate(Math.round((this.prefs.rate + Number(b.dataset.rate)) * 10) / 10));
  }

  // which engine reads this book: the natural voice when chosen and it speaks the language
  get engine() { return this.prefs.engine === 'natural' && this._naturalSpeaks() ? 'natural' : 'device'; }
  _naturalSpeaks() { return !!this.r.book && SUPERTONIC_LANGS.has(baseOf(this.r.book.speechLang || this._bookLang())); }

  // ---------------------------------------------------------- controls
  toggle() { if (this.state === 'playing') this.pause(); else this.play(); }

  // Start, or resume. Reads from the selection if there is one, else from the paused sentence if it is
  // still on screen, else from the top of the screen. here: always from the selection or the screen.
  async play({ here = false } = {}) {
    const r = this.r, book = r.book;
    if (!book) return;
    if (book.isScanned) { r.toast('This PDF is scanned pages, so there is no text to read aloud.'); return; }
    await this.ready;
    // the first time, the reader picks a voice: the choice is a 145 MB download or a voice that stops with the screen
    if (!this.prefs.engine && this._naturalSpeaks() && this.state === 'off') { this._chosen = 'natural'; this.openPop(); return; }
    this.errors = 0;
    const natural = this.engine === 'natural';
    if (!natural && (r.pageMode || !this.voices.length)) unlock();
    if (!natural) this._audio(true);
    this._media(true);
    if (r.pageMode) { await r.setPageMode(false); await frame(); if (r.book !== book) return; }
    if (!natural && !this.voices.length) { this.voices = await voicesReady(); if (r.book !== book) return; }
    const resume = !here && this.state === 'paused' && this.cur && this._inView();
    this._setup();
    const pos = this._fromSelection() || (resume ? this.cur : null) || this._visiblePos();
    if (!pos) { if (this.state !== 'playing') { this._audio(false); if (this.state === 'off') this._media(false); } r.toast('There is no text here to read aloud.'); return; }
    if (natural && resume && pos === this.cur && this.nat.canResume(pos)) { this.state = 'playing'; this.nat.resume(); this._ui(); return; }
    this._playFrom(pos, true);
    if (natural && this.nat.status !== 'ready') this.nat.load().catch(() => {});
  }
  pause() {
    if (this.state !== 'playing') return;
    this.gen++; clearTimeout(this.dog); speechSynthesis.cancel(); this.q = [];
    this.nat.pause();
    this.state = 'paused'; this.word = null; highlight(HL_WORD, null);
    this._audio(false); this._ui();
  }
  stop() {
    if (this.state === 'off') return;
    this.gen++; clearTimeout(this.dog); clearTimeout(this._rt); clearTimeout(this._st); speechSynthesis.cancel();
    this.nat.stop();
    this.q = []; this.next = this.cur = this.word = this.range = null; this.state = 'off'; this.following = true; this.ended = false;
    highlight(HL, null); highlight(HL_WORD, null);
    this.closePop(); this._audio(false); this._media(false); this._ui();
    if (this.r.book) this.prepareSoon();
  }
  // a new book: forget the old one's sentences and language
  reset() { this.stop(); this.segs.clear(); this.key = null; this.detected = null; this.metaSid = null; }
  // the book closed: free the natural voice's memory (it stays on the device)
  release() { clearTimeout(this._pt); this.nat.release(); }
  // Prepare ahead: with the natural voice chosen and on the device, make speech from where the reader is whenever the
  // book is open, so listening later starts at once and doesn't wait on a slow device. Never downloads unasked.
  prepareSoon(ms = 1500) { clearTimeout(this._pt); this._pt = setTimeout(() => this._prepare(), ms); }
  async _prepare() {
    await this.ready;
    const r = this.r;
    if (!r.book || this.state !== 'off' || r.pageMode || this.prefs.engine !== 'natural' || !this._naturalSpeaks()) return;
    if (!(await this.nat.check()) || this.nat.status === 'failed' || this.state !== 'off' || !r.book) return;
    this._setup();
    const pos = this._visiblePos();
    if (!pos) return;
    this.nat.prepare(pos);
    this.nat.load().catch(() => {});
  }
  // Back: the start of this sentence, or the one before if this one only just began. Paused, it only moves.
  skip(dir) {
    if (this.state === 'off') return;
    const cur = this.cur;
    let p;
    if (!cur) p = this._visiblePos();
    else if (dir > 0) p = this._after(cur);
    else p = this.state === 'playing' && Date.now() - this.startedAt > 2500 ? cur : (this._before(cur) || cur);
    if (!p) return;
    if (this.state === 'playing') this._playFrom(p, true);
    else this._setCurrent(p, true);
  }
  setRate(v) {
    this.prefs.rate = Math.round(clamp(v || 1, 0.6, 2.5) * 100) / 100;
    this._save(); this._syncRate(); this._ui();
    // the natural voice changes speed at once; the device voice says the sentence again at the new speed
    this.nat.setRate(this.prefs.rate);
    clearTimeout(this._rt);
    if (this.state === 'playing' && this.engine === 'device') this._rt = setTimeout(() => { if (this.state === 'playing') { this._setup(); this._playFrom(this.cur || this.next); } }, 400);
  }
  setVoice(v) {
    if (this.engine === 'natural') { this.prefs.natural = Number(v) || 0; this._save(); this._apply(true); return; }
    const b = baseOf(this.lang || this._bookLang());
    if (v) this.prefs.voices[b] = v; else delete this.prefs.voices[b];
    this._save(); this._apply();
  }
  setLang(b) {
    const book = this.r.book;
    book.speechLang = b || null;
    db.updateBook(book.id, { speechLang: book.speechLang });
    this._apply(true);
  }
  setEngine(e) {
    if (e === this.prefs.engine && this.engine === e) return;
    const was = this.engine;
    this._chosen = e;
    if (this.prefs.engine || this.state !== 'off') { this.prefs.engine = e; this._save(); }
    if (this.state !== 'off' && this.engine !== was) {
      // the other engine goes on from the same sentence
      this.gen++; speechSynthesis.cancel(); this.q = []; clearTimeout(this.dog); this.nat.stop(); this._audio(false);
      this._apply(true);
      if (this.engine === 'natural' && this.nat.status !== 'ready') this.nat.load().catch(() => {});
    } else this._renderPop();
  }
  // a new voice, language or engine: say the sentence again with it, so the choice can be heard
  _apply(fresh = false) {
    this._setup(); this._renderPop();
    // not listening: what was prepared ahead is in the old voice or language
    if (this.state === 'off') { this.nat.stop(); this.prepareSoon(); return; }
    const p = this.cur || this._visiblePos();
    if (!p) return;
    if (this.engine === 'device') this._audio(true);
    this._playFrom(p, false, fresh);
  }
  _getNatural() {
    this.nat.load().catch(() => {});
    this._renderPop();
  }
  // The natural voice must make speech faster than it is read: fewer denoising steps on a slower device, more on a faster one.
  _tune(sec, ms) {
    const rtf = sec * 1000 / ms, need = this.prefs.rate * 1.25;
    this.rtf = this.rtf ? this.rtf * 0.6 + rtf * 0.4 : rtf;
    this.speedSeen = this.rtf;
    let s = this.prefs.steps;
    // below 5 steps the voice turns hissy and broken: never go there
    if (this.rtf < need && s > 5) s--;
    else if (this.rtf > need * 2 && s < 8) s++;
    if (s !== this.prefs.steps) { this.prefs.steps = s; this.rtf = null; this._save(); }
  }
  _save() { db.setSetting('listen', this.prefs); }
  // what the natural voice runs on and how it keeps up, for the voice settings
  _perf() {
    const n = this.nat, on = n.gpu ? "Runs on this device's graphics chip." : n.threads > 1 ? `Runs on ${n.threads} processor cores.` : n.threads ? 'Runs on one processor core.' : '';
    const speed = this.speedSeen ? ` Makes speech ${this.speedSeen.toFixed(1)} times as fast as it reads.` : '';
    const m = Math.floor(n.ready / 60), ahead = m >= 1 ? ` ${m} ${m === 1 ? 'minute is' : 'minutes are'} ready ahead.` : '';
    return on + speed + ahead;
  }

  // ---------------------------------------------------------- language and voice
  // The book's language: what its blocks declare, unless the text clearly says otherwise.
  _bookLang() {
    if (this.detected) return this.detected;
    const r = this.r, secs = r.book.sections;
    const counts = new Map();
    for (const el of r.content.querySelectorAll('[lang]')) { const l = normLang(el.getAttribute('lang')); if (l) counts.set(l, (counts.get(l) || 0) + 1); }
    const declared = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    let sample = '';
    const step = Math.max(1, Math.floor(secs.length / 12));
    for (let i = Math.floor(step / 2); i < secs.length && sample.length < 24000; i += step) sample += (r.sectionEls.get(secs[i].id)?.textContent || '').slice(0, 2000) + '\n';
    const d = detectLang(sample);
    return this.detected = declared && (!d || !d.sure || baseOf(declared) === d.lang) ? declared : d?.lang || declared || baseOf(navigator.language) || 'en';
  }
  _pickVoice(lang) {
    const all = this.voices.filter(v => !this.badVoices.has(v.voiceURI));
    const want = this.prefs.voices[baseOf(lang)];
    return (want && all.find(v => v.voiceURI === want && baseOf(v.lang) === baseOf(lang))) || rankVoices(all, lang)[0] || null;
  }
  // Language, voice and sentence length for the current settings. Sentences are rebuilt when the
  // language or length changes, keeping the place.
  _setup() {
    const book = this.r.book;
    const lang = book.speechLang || this._bookLang();
    const voice = this._pickVoice(lang), natural = this.engine === 'natural';
    // the natural voice was trained on pieces of up to 300 characters; Chrome's network voices go quiet after about 15 s
    const maxLen = natural ? 300 : voice && !voice.localService ? Math.round(170 * clamp(this.prefs.rate, 0.7, 2)) : 320;
    const key = `${lang}|${maxLen}`;
    if (key !== this.key) {
      const keep = this.cur && this._seg(this.cur) && { si: this.cur.si, off: this._seg(this.cur).start };
      this.segs.clear(); this.key = key; this.lang = lang; this.maxLen = maxLen;
      this.cur = keep ? this._posAt(keep.si, keep.off) : null;
    }
    this.lang = lang; this.voice = voice;
    // (an engine that lists no voices at all still speaks with its default one: nothing to warn about)
    if (!natural && this.voices.length && baseOf(voice?.lang) !== baseOf(lang) && this.warned !== book.id + lang) {
      this.warned = book.id + lang;
      this.r.toast(`No ${langName(baseOf(lang))} voice on this device yet.`, { label: 'Voices', fn: () => this.openPop() });
    }
  }

  // ---------------------------------------------------------- sentences
  _segs(si) {
    let segs = this.segs.get(si);
    if (segs) return segs;
    segs = [];
    const sec = this.r.book.sections[si], root = sec && this.r.sectionEls.get(sec.id);
    if (root) {
      const cache = new Map(), w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let pos = 0, block = null, runs = [], heading = false;
      const flush = () => { if (runs.length) for (const x of speakable(runs, { heading, lang: this.lang, maxLen: this.maxLen })) segs.push({ ...x, sid: sec.id }); runs = []; };
      for (let n; (n = w.nextNode());) {
        if (n.nodeType === 1) { if (n.tagName === 'BR') flush(); continue; }
        const len = n.data.length;
        if (!len) continue;
        const p = n.parentNode;
        let b = p;
        while (b !== root && !BLOCK.test(b.tagName)) b = b.parentNode;
        if (b !== block) { flush(); block = b; heading = /^H[1-6]$/.test(b.tagName) || !!b.closest('.title-block'); }
        if (!skipped(p, cache)) runs.push([n.data, pos]);
        pos += len;
      }
      flush();
    }
    this.segs.set(si, segs);
    return segs;
  }
  _seg(p) { return p && this._segs(p.si)[p.k]; }
  _si(sid) { return this.r.book.sections.findIndex(s => s.id === sid); }
  _first(si) { for (; si >= 0 && si < this.r.book.sections.length; si++) if (this._segs(si).length) return { si, k: 0 }; return null; }
  _after(p) { return p.k + 1 < this._segs(p.si).length ? { si: p.si, k: p.k + 1 } : this._first(p.si + 1); }
  _before(p) {
    if (p.k > 0) return { si: p.si, k: p.k - 1 };
    for (let si = p.si - 1; si >= 0; si--) { const n = this._segs(si).length; if (n) return { si, k: n - 1 }; }
    return null;
  }
  // the sentence holding this offset, or the next one
  _posAt(si, off) {
    if (si < 0) return this._first(0);
    const k = this._segs(si).findIndex(s => s.end > off);
    return k >= 0 ? { si, k } : this._first(si + 1);
  }
  _fromSelection() {
    const r = this.r, loc = r.pending || r._selectionToMark();
    if (!loc) return null;
    r.hideBubble(); window.getSelection()?.removeAllRanges();
    return this._posAt(this._si(loc.sectionId), loc.start);
  }
  // the sentence at the top of the screen
  _visiblePos() {
    const r = this.r, a = r._visibleAnchor();
    if (!a || !a.el) return this._first(0);
    const root = r.sectionEls.get(a.sectionId);
    let off = offsetBefore(root, a.el);
    const b = a.el.getBoundingClientRect(), top = r.scroller.getBoundingClientRect().top + 70;
    if (b.top < top) {
      // a block that starts above the screen: the line at the top
      const cs = getComputedStyle(a.el), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 24;
      const at = r._offsetAt(cs.direction === 'rtl' ? b.right - 6 : b.left + 6, top + lh / 2);
      if (at && at.sid === a.sectionId && at.off > off) off = at.off;
    }
    return this._posAt(this._si(a.sectionId), off);
  }

  // ---------------------------------------------------------- the engine
  _playFrom(pos, jump = false, fresh = false) {
    const gen = ++this.gen, busy = speechSynthesis.speaking || speechSynthesis.pending;
    speechSynthesis.cancel();
    this.q = []; this.next = pos; this.state = 'playing'; this.lastEvent = Date.now(); this.ended = false;
    this._setCurrent(pos, jump);
    if (this.engine === 'natural') { clearTimeout(this.dog); this.nat.setRate(this.prefs.rate); this.nat.play(pos, { fresh }); this._ui(); return; }
    this._ui();
    const go = () => { if (gen === this.gen) { this._fill(); this._watch(); } };
    // some engines drop a speak() that comes straight after cancel()
    if (busy) setTimeout(go, 80); else go();
  }
  _fill() {
    while (this.state === 'playing' && this.q.length < AHEAD && this.next) {
      const pos = this.next, s = this._seg(pos), gen = this.gen;
      const u = new SpeechSynthesisUtterance(s.text);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice?.lang || this.lang;
      u.rate = this.prefs.rate; u.pitch = 1; u.volume = 1;
      u.onstart = () => { if (gen === this.gen) this._started(pos, u); };
      u.onboundary = (e) => { if (gen === this.gen && (!e.name || e.name === 'word')) this._word(pos, e); };
      u.onend = () => { if (gen === this.gen) this._ended(u); };
      u.onerror = (e) => { if (gen === this.gen) this._error(pos, e); };
      this.q.push({ u, pos });
      speechSynthesis.speak(u);
      this.next = this._after(pos);
    }
  }
  _started(pos, u) {
    this.lastEvent = Date.now();
    const i = this.q.findIndex(x => x.u === u);
    if (i > 0) this.q.splice(0, i);
    if (!same(pos, this.cur)) this._setCurrent(pos);
    this._fill(); this._watch();
  }
  _ended(u) {
    this.lastEvent = Date.now(); this.errors = 0;
    const i = this.q.findIndex(x => x.u === u);
    if (i >= 0) this.q.splice(0, i + 1);
    if (this.q.length) { if (!same(this.q[0].pos, this.cur)) this._setCurrent(this.q[0].pos); }
    else if (!this.next) { this._finish(); return; }
    this._fill(); this._watch();
  }
  _word(pos, e) {
    this.lastEvent = Date.now();
    const s = this._seg(pos), i = e.charIndex;
    if (!s || !same(pos, this.cur) || !(i >= 0) || i >= s.text.length) return;
    let n = e.charLength;
    if (!n) { const m = s.text.slice(i).match(/^[\p{L}\p{N}\p{M}'’-]+/u); n = m ? m[0].length : 1; }
    this.word = { start: s.map[i], end: s.map[Math.min(i + n, s.map.length) - 1] + 1 };
    const root = this.r.sectionEls.get(s.sid);
    highlight(HL_WORD, root && textRange(root, this.word.start, this.word.end));
  }
  _error(pos, e) {
    const err = e?.error || 'unknown';
    if (err === 'interrupted' || err === 'canceled') return;
    console.warn('speech error', err, this.voice?.name);
    if (err === 'not-allowed') { this.pause(); this.r.toast('Tap play to start listening.'); return; }
    if (this.voice && !this.voice.localService && /network|synthesis/.test(err)) {
      this.badVoices.add(this.voice.voiceURI); this._setup();
      this.r.toast('That voice needs a connection. Using one on this device.');
      this._playFrom(this.cur || pos); return;
    }
    if (++this.errors >= 3) { this.pause(); this.r.toast('The voice stopped working. Try another one.', { label: 'Voices', fn: () => this.openPop() }); return; }
    const nx = this._after(pos);
    if (nx) this._playFrom(nx); else this._finish();
  }
  _finish() {
    this.gen++; clearTimeout(this.dog); this.nat.stop();
    this.q = []; this.next = this.cur = this.word = this.range = null; this.state = 'paused'; this.ended = true;
    highlight(HL, null); highlight(HL_WORD, null);
    this._audio(false); this._ui();
    this.r.toast('End of the book.');
  }
  // The engine sometimes goes quiet without an end or an error (Chrome on desktop): say the sentence again.
  _watch() {
    clearTimeout(this.dog);
    if (this.state !== 'playing') return;
    const s = this._seg(this.cur);
    const ms = 10000 + 2 * (s ? s.text.length * 80 / this.prefs.rate : 0);
    this.dog = setTimeout(() => {
      if (this.state !== 'playing') return;
      if (document.hidden || Date.now() - this.lastEvent < ms - 50) { this._watch(); return; }
      console.warn('speech went quiet; saying the sentence again');
      const p = this.cur || this.next;
      if (p) this._playFrom(p); else this._finish();
    }, ms);
  }

  // ---------------------------------------------------------- on the page
  _setCurrent(pos, jump = false) {
    if (jump) this.following = true;
    this.cur = pos; this.word = null; this.startedAt = Date.now();
    this._paint();
    if (this.following) this._reveal();
    const sid = this.r.book.sections[pos.si]?.id;
    if (sid !== this.metaSid) this._meta();
    this._syncHere();
  }
  _paint() {
    const s = this._seg(this.cur), root = s && this.r.sectionEls.get(s.sid);
    this.range = root ? textRange(root, s.start, s.end) : null;
    highlight(HL, this.range);
    highlight(HL_WORD, this.range && this.word ? textRange(root, this.word.start, this.word.end) : null);
  }
  _bottom() { const vr = this.r.scroller.getBoundingClientRect(); return this.bar.hidden ? vr.bottom : Math.min(vr.bottom, this.bar.getBoundingClientRect().top); }
  _rect() { const rc = this.range?.getBoundingClientRect(); return rc && (rc.width || rc.height) ? rc : null; }
  _inView() {
    const rc = this._rect(); if (!rc) return false;
    return rc.bottom > this.r.scroller.getBoundingClientRect().top + 40 && rc.top < this._bottom();
  }
  // bring the sentence into view, a third of the way down, only when it isn't already
  _reveal() {
    const rc = this._rect(); if (!rc) return;
    const sc = this.r.scroller, vr = sc.getBoundingClientRect();
    if (rc.top >= vr.top + 64 && rc.bottom <= this._bottom() - 8) return;
    // no animation when far, when motion is reduced, or with the screen off
    const far = Math.abs(rc.top - vr.top) > vr.height * 2 || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
    const to = Math.max(0, sc.scrollTop + rc.top - vr.top - vr.height * 0.3);
    this.r._progScrollAt = Date.now();
    this._own = { from: sc.scrollTop, to, at: Date.now() };
    sc.scrollTo({ top: to, behavior: far ? 'auto' : 'smooth' });
  }
  // "Read from here": when the reader has scrolled away from the voice, or selected text to start at
  sync() { this._syncHere(); }
  _syncHere() {
    const on = this.state !== 'off', away = on && !!this.cur && !this.following, here = on && (!!this.r.pending || away);
    $('[data-say="here"]', this.bar).hidden = !here;
    $('[data-say="find"]', this.bar).hidden = !away || !!this.r.pending;
    this.bar.classList.toggle('is-away', here);
  }
  // Any scroll but the page's own following (a swipe, the contents, a search hit) decides whether the
  // reader is still with the voice: following stops when its sentence leaves the screen, and starts
  // again when the reader scrolls back to it.
  onScroll() {
    // not listening: prepare from where the reader has moved to, once the scrolling settles
    if (this.state === 'off') { if (this.prefs.engine === 'natural') this.prepareSoon(2500); return; }
    if (!this.cur) return;
    const check = () => { this.following = this._inView(); this._syncHere(); };
    clearTimeout(this._st); this._st = setTimeout(check, 1250); // and once more when all scrolling has settled
    // the page's own smooth scroll, on its way: between where it started and where it is going
    const o = this._own, st = this.r.scroller.scrollTop, now = Date.now();
    const ours = o && now - o.at < 1500 && st >= Math.min(o.from, o.to) - 2 && st <= Math.max(o.from, o.to) + 2;
    if (ours && now - (this._userAt || 0) > 600) return;
    cancelAnimationFrame(this._sr); this._sr = requestAnimationFrame(check);
  }

  // ---------------------------------------------------------- lock screen, headset, notification
  _media(on) {
    const ms = navigator.mediaSession; if (!ms) return;
    const acts = { play: () => this.play(), pause: () => this.pause(), stop: () => this.stop(), previoustrack: () => this.skip(-1), nexttrack: () => this.skip(1), seekbackward: () => this.skip(-1), seekforward: () => this.skip(1) };
    for (const [k, fn] of Object.entries(acts)) { try { ms.setActionHandler(k, on ? fn : null); } catch {} }
    if (!on) { try { ms.metadata = null; } catch {} this.metaSid = null; }
  }
  _meta() {
    const ms = navigator.mediaSession, b = this.r.book;
    if (!this.cur || !b) return;
    const sec = b.sections[this.cur.si];
    this.metaSid = sec?.id;
    if (!ms || typeof MediaMetadata === 'undefined') return;
    const chapter = (b.sectionTitles?.[sec.id] || sec.title || '').trim();
    const artwork = b.coverUrl ? [{ src: b.coverUrl, sizes: '512x512' }] : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
    try { ms.metadata = new MediaMetadata({ title: chapter || b.title, artist: b.author || '', album: chapter ? b.title : '', artwork }); } catch {}
  }
  _audio(on) {
    if (IOS || this.noAudio) return;
    if (on) {
      if (!this.audio) {
        this.audio = new Audio(silence()); this.audio.loop = true;
        this.audio.addEventListener('pause', () => {
          if (this._ownPause) { this._ownPause = false; return; }
          if (this.state !== 'playing') return;
          // Paused by the system just as the voice started: the speech engine took the audio focus from
          // the silent track. Keep the voice and drop the track. Later, it is a call or another app.
          if (Date.now() - this._audioAt < 3000) { this.noAudio = true; return; }
          this.pause();
        });
      }
      if (this.audio.paused) { this._audioAt = Date.now(); this.audio.play().catch(() => {}); }
    } else if (this.audio && !this.audio.paused) { this._ownPause = true; this.audio.pause(); }
  }

  // ---------------------------------------------------------- bar and sheet
  // What the player is doing, in a few words.
  _statusText() {
    const n = this.engine === 'natural' && this.nat;
    if (n && n.status === 'downloading') return `Downloading the natural voice, ${Math.floor(n.progress * 100)}%`;
    if (n && this.state === 'playing' && n.status !== 'ready') return n.status === 'failed' ? "The natural voice didn't load" : 'Getting the natural voice ready';
    if (this.ended) return 'End of the book';
    if (this.state === 'paused') return 'Paused';
    if (n && n.waiting) return n.at < 0 ? 'Preparing the first sentence' : `Preparing the next part, ${Math.min(99, Math.floor(n.ready / n.target * 100))}%`;
    return 'Reading';
  }
  _ui() {
    const on = this.state !== 'off', playing = this.state === 'playing';
    document.body.classList.toggle('listening', on);
    this.bar.hidden = !on;
    const pb = $('[data-say="play"]', this.bar);
    pb.innerHTML = `<i class="ph-fill ph-${playing ? 'pause' : 'play'}" aria-hidden="true"></i>`;
    pb.setAttribute('aria-label', playing ? 'Pause' : 'Play'); pb.title = `${playing ? 'Pause' : 'Play'} (P)`;
    if (on) {
      const n = this.engine === 'natural' && this.nat, busy = n && playing && (n.status !== 'ready' || n.waiting);
      $('.say-state', this.bar).textContent = this._statusText();
      const sec = this.cur && this.r.book.sections[this.cur.si];
      $('.say-where', this.bar).textContent = sec ? (this.r.book.sectionTitles?.[sec.id] || sec.title || '').trim() : '';
      this.bar.classList.toggle('is-busy', !!busy);
      const meter = $('.say-meter', this.bar);
      meter.hidden = !(n && n.status === 'downloading');
      meter.firstElementChild.style.width = n ? `${Math.round(n.progress * 100)}%` : '0';
      const rate = $('[data-say="rate"]', this.bar);
      rate.textContent = fmtRate(this.prefs.rate); rate.setAttribute('aria-label', `Speed ${fmtRate(this.prefs.rate)}. Change speed`);
    }
    for (const b of $$('[data-act="listen"]', this.r.view)) { b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(playing)); b.title = playing ? 'Pause (P)' : 'Listen (P)'; }
    try { if (navigator.mediaSession) navigator.mediaSession.playbackState = on ? (playing ? 'playing' : 'paused') : 'none'; } catch {}
    if (on) this.observer.observe(this.r.content, { childList: true, subtree: true }); else this.observer.disconnect();
    this._syncHere();
  }
  _syncRate() {
    const r = this.prefs.rate, el = $('#say-rate');
    el.value = r; el.setAttribute('aria-valuetext', fmtRate(r));
    $('#say-rate-val').textContent = fmtRate(r);
    $('[data-say="rate"]', this.bar).textContent = fmtRate(r);
  }
  togglePop(open = this.pop.hidden) {
    const r = this.r;
    if (open) { r.panel.hidden = true; r.typePop.hidden = true; r.closeEditor(); if (r.pending) r.hideBubble(); this._renderPop(); }
    this.pop.hidden = !open;
    r._syncScrim();
    if (open) this.nat.check().then(() => { if (!this.pop.hidden) this._renderPop(); });
  }
  openPop() { this.togglePop(true); }
  closePop() { if (!this.pop.hidden) { this.pop.hidden = true; this.r._syncScrim(); } }
  _renderPop() {
    const book = this.r.book;
    if (!book) return;
    if (!this.voices.length) this.voices = speechSynthesis.getVoices();
    const first = !this.prefs.engine, choice = first ? (this._chosen || 'natural') : this.prefs.engine;
    const auto = baseOf(this._bookLang()), lang = book.speechLang || this._bookLang(), base = baseOf(lang);
    const speaks = SUPERTONIC_LANGS.has(base), n = this.nat, natural = choice === 'natural' && speaks;
    // engine
    $$('#say-engine button').forEach(b => { const on = b.dataset.v === choice; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', String(on)); });
    const has = n.status === 'stored' || n.status === 'ready' || n.status === 'preparing';
    const about = choice === 'device' ? 'Uses the voices built into this device. Starts at once. On Android it stops when the screen turns off.'
      : !speaks ? `The natural voice doesn't speak ${langName(base)} yet. This book uses the device voice.`
      : n.status === 'downloading' ? `Downloading, ${Math.round(n.progress * NATURAL_MB)} of ${NATURAL_MB} MB. You can keep reading.`
      : n.status === 'failed' ? "The download didn't finish. Check your connection and try again."
      : n.status === 'ready' ? `Sounds like a person and keeps reading with the screen off. Stored on this device. ${this._perf()}`.trim()
      : has ? 'Sounds like a person and keeps reading with the screen off. Stored on this device.'
      : `Sounds like a person and keeps reading with the screen off. A one-time ${NATURAL_MB} MB download.`;
    $('#say-about').textContent = about;
    const meter = $('#say-dl');
    meter.hidden = !(choice === 'natural' && n.status === 'downloading');
    meter.firstElementChild.style.width = `${Math.round(n.progress * 100)}%`;
    // download: offered in place unless the first-time button below does it
    const get = $('#say-get');
    get.hidden = first || !natural || has || n.status === 'downloading' || n.status === 'unknown';
    $('span', get).textContent = n.status === 'failed' ? 'Try again' : `Download, ${NATURAL_MB} MB`;
    $('#say-remove').hidden = first || !has;
    const start = $('#say-start');
    start.hidden = !first;
    start.textContent = natural && !has ? `Download and listen` : 'Start listening';
    // speaker
    const vs = $('#say-voice'), vrow = vs.closest('.row');
    vrow.hidden = first;
    if (natural) {
      vs.innerHTML = SUPERTONIC_VOICES.map((v, i) => `<option value="${i}">${v[0] === 'F' ? 'Female' : 'Male'} ${v.slice(1)}</option>`).join('');
      vs.value = String(this.prefs.natural); vs.disabled = false;
    } else {
      const ranked = rankVoices(this.voices.filter(v => !this.badVoices.has(v.voiceURI)), lang);
      // the region, when the voices differ in it and the name doesn't say
      const regions = new Set(ranked.map(v => normLang(v.lang).split('-')[1]).filter(Boolean));
      const label = (v) => {
        let t = voiceLabel(v);
        const rg = normLang(v.lang).split('-')[1];
        if (regions.size > 1 && rg && !t.includes(regionName(rg)) && !new RegExp(`\\b(${rg}${rg === 'GB' ? '|UK' : ''})\\b`).test(t)) t += `, ${regionName(rg)}`;
        return t;
      };
      const want = this.prefs.voices[base];
      vs.innerHTML = ranked.length ? `<option value="">Automatic (${esc(label(ranked[0]))})</option>` + ranked.map(v => `<option value="${esc(v.voiceURI)}">${esc(label(v))}</option>`).join('')
        : `<option value="">${this.voices.length ? `No ${esc(langName(base))} voice on this device` : 'Device default'}</option>`;
      vs.value = want && ranked.some(v => v.voiceURI === want) ? want : '';
      vs.disabled = !ranked.length;
      $('#say-hint').textContent = first ? '' : hint(ranked.length > 0 || !this.voices.length);
    }
    $('#say-hint').hidden = natural || first;
    // language
    const bases = [...new Set([...SUPERTONIC_LANGS, ...this.voices.map(v => baseOf(v.lang)).filter(Boolean)])].filter(b => b !== auto).sort((a, b) => langName(a).localeCompare(langName(b)));
    const ls = $('#say-lang');
    ls.innerHTML = `<option value="">Automatic (${esc(langName(auto))})</option>` + bases.map(b => `<option value="${esc(b)}">${esc(langName(b))}</option>`).join('');
    ls.value = book.speechLang && baseOf(book.speechLang) !== auto ? baseOf(book.speechLang) : '';
    ls.closest('.row').hidden = first;
    $('#say-rate').closest('.row').hidden = first;
    this._syncRate();
  }
}
