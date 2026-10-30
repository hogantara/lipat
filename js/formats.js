// Format detection + parsing. Every parser returns the same shape:
// { title, author, format, cover (Blob|null), sections: [{ id, title, html }], toc: [{ title, sectionId, anchor, depth }], pageCount }
// PDFs additionally keep the original file so "original layout" mode can render real pages.

const CDN = {
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs',
  pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs',
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
  marked: 'https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.7/marked.min.js',
  purify: 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.4/purify.min.js',
};

const scriptCache = {};
function loadScript(url) {
  if (scriptCache[url]) return scriptCache[url];
  scriptCache[url] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + url));
    document.head.appendChild(s);
  });
  return scriptCache[url];
}

let pdfjsLib = null, pdfjsFailed = false;
export async function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  // the browser remembers a failed import() for that URL until reload, so a retry asks for a fresh one
  try { pdfjsLib = await import(pdfjsFailed ? CDN.pdfjs + '?r=' + Date.now() : CDN.pdfjs); } catch (e) { pdfjsFailed = true; throw e; }
  pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;
  return pdfjsLib;
}
async function getPurify() { await loadScript(CDN.purify); return window.DOMPurify; }

// ------------------------------------------------------------------ utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const stripExt = (name) => name.replace(/\.[^.]+$/, '');
const prettyName = (name) => { let t = stripExt(name).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim(); if (t === t.toLowerCase()) t = t.replace(/\b\w/g, c => c.toUpperCase()); return t; };

async function sanitize(html, { allowImages = true } = {}) {
  const DOMPurify = await getPurify();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'title', 'head'],
    FORBID_ATTR: ['style', 'onload', 'onerror', 'class'],
    ADD_ATTR: ['data-page', 'id'],
    ALLOW_DATA_ATTR: true,
    ...(allowImages ? {} : { FORBID_TAGS: ['img'] }),
  });
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

async function readText(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // BOM sniff
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  // Not UTF-8: a legacy encoding. Decode a sample strictly in each candidate and keep the one that reads most like
  // real text in its own script; windows-1252 (Western text) wins ties.
  const sample = bytes.subarray(0, 65536);
  let best = 'windows-1252', top = decodeScore(new TextDecoder(best).decode(sample));
  for (const enc of LEGACY) {
    let s;
    try { s = decodeScore(new TextDecoder(enc, { fatal: true }).decode(sample, { stream: true })); } catch { continue; }
    if (s > top) { best = enc; top = s; }
  }
  return new TextDecoder(best).decode(buf);
}
const LEGACY = ['gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'windows-1251', 'koi8-r'];
// frequent Han (simplified, traditional, Japanese) and Hangul syllables: the right decode hits them often, a wrong one rarely
const COMMON = new Set('的一是不了人我在有他这這中大来來上个個国國到说說们們为為子和你地出道也时時年得就那要下以生会會自着去之过過家学學对對可她里裡后後小么麼心多天而能好都然没沒日于起还還发發成事只作当當想看文无無开開手十用主行方又如前所本见見经經头頭面同三已老从從动動两兩长長知样樣现現分将將外但身些与與高意进進把法此实實回二理点點月明种種声聲全己话話儿兒向情正名定女问問力给給等几幾很最间間新什打便位因重被走电電四第门門相次东東海口西再平真听聽世气氣少关關先山水风風夜师師剑劍雨記読語車書今円気'
  + '이다의는에하고을를가지서한기사리로도자그수아나있인대해어없시면것들일게보우생주만정내전상요부각여무거비라소마중성문조원장위말경모저구제오러두공년동신했었았니습적과와은던까처럼간날안할된음속물람때더잘좀많너래');
// Average plausibility of the non-ASCII characters of a decoded sample. Wrong decodes give symbols, box drawing,
// half-width kana, rare ideographs, upper-case Cyrillic, or foreign letters glued to Latin words.
function decodeScore(text) {
  let score = 0, n = 0;
  const latin = (c) => /[A-Za-z]/.test(c || '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c < '\u0080') continue;
    n++;
    const glued = latin(text[i - 1]) || latin(text[i + 1]);
    if (/[À-ɏ]/.test(c) && c !== '×' && c !== '÷') score += glued ? 1 : 0.2; // accented Latin inside a word
    else if (/[ «»‐-…€]/.test(c)) score += 0.5;                      // quotes, dashes, ellipsis, euro
    else if (/[¡-¿]/.test(c)) continue;                                              // other Latin-1 signs
    else if (glued) score -= 1;
    else if (COMMON.has(c) || /[ぁ-ゟ]/.test(c)) score += 2;                           // frequent CJK, Hangul, hiragana
    else if (/[　-〿！-～]/.test(c)) score += 1;                               // CJK punctuation, full-width forms
    else if (/[゠-ヿ一-鿿가-힣]/.test(c)) score += 0.5;                // katakana, Han, Hangul
    else if (/[Ѐ-џ]/.test(c) && !/[Ѐ-џ]/.test(text[i - 1] + text[i + 1])) score -= 1; // lone Cyrillic: a Western sign read as cp1251
    else if (/[а-џ]/.test(c)) score += 1;                                             // Cyrillic prose is mostly lower case
    else if (/[Ѐ-Я]/.test(c)) score += 0.3;
    else score -= 1;
  }
  return n ? score / n : 0;
}

// ------------------------------------------------------------------ detect
export async function detectFormat(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const str = Array.from(head).map(b => String.fromCharCode(b)).join('');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (str.startsWith('%PDF')) return 'pdf';
  if (str.startsWith('PK')) {
    if (ext === 'docx') return 'docx';
    if (ext === 'epub') return 'epub';
    // sniff zip for mimetype / word/
    try {
      await loadScript(CDN.jszip);
      const zip = await window.JSZip.loadAsync(file);
      if (zip.file('mimetype') || zip.file('META-INF/container.xml')) return 'epub';
      if (zip.file('word/document.xml')) return 'docx';
    } catch {}
    return 'unknown';
  }
  if (['md', 'markdown', 'mdown'].includes(ext)) return 'md';
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  if (['txt', 'text', 'log', 'rtf', 'csv', 'json', ''].includes(ext)) return 'txt';
  if (['epub'].includes(ext)) return 'epub';
  if (['pdf'].includes(ext)) return 'pdf';
  // sniff: looks like html?
  const sample = await file.slice(0, 2048).text().catch(() => '');
  if (/<\s*(html|!doctype html|body|p|div)/i.test(sample)) return 'html';
  return 'txt';
}

export async function parseFile(file, onProgress = () => {}) {
  const format = await detectFormat(file);
  onProgress('Reading ' + format.toUpperCase() + '…');
  switch (format) {
    case 'pdf': return parsePdf(file, onProgress);
    case 'epub': return parseEpub(file, onProgress);
    case 'docx': return parseDocx(file);
    case 'md': return parseMarkdown(file);
    case 'html': return parseHtml(file);
    default: return parseTxt(file);
  }
}

// ------------------------------------------------------------------ TXT
export async function parseTxt(file) {
  const text = await readText(file);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Detect hard-wrapped text (Gutenberg style): most lines ~<80 chars and paragraphs separated by blank lines.
  const nonEmpty = lines.filter(l => l.trim());
  const maxLen = Math.max(...nonEmpty.slice(0, 500).map(l => l.length), 0);
  const hardWrapped = maxLen <= 90 && nonEmpty.length > 20;
  const paras = [];
  let cur = [];
  const flush = () => { if (cur.length) { paras.push(cur.join(hardWrapped ? ' ' : '\n')); cur = []; } };
  for (const l of lines) {
    if (!l.trim()) { flush(); continue; }
    if (!hardWrapped) { paras.push(l); continue; }
    cur.push(l.trim());
  }
  flush();
  const sections = [];
  let html = '';
  let title = prettyName(file.name);
  const first = paras[0] ? paras[0].trim() : '';
  if (first && first.length <= 80 && !/[.!?]$/.test(first) && paras.length > 3) { title = first.replace(/^(the\s+)?title:\s*/i, ''); title = title === title.toUpperCase() ? title.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : title; paras.shift(); }
  let sectionTitle = null, chunk = 0;
  const pushSection = () => { if (html) { sections.push({ id: 's' + sections.length, title: sectionTitle, html }); html = ''; chunk = 0; } };
  for (const p of paras) {
    const isHeading = /^(chapter|part|book|section)\b[\s\w.:'’-]{0,60}$/i.test(p.trim()) || (p.length < 60 && p === p.toUpperCase() && /[A-Z]{3,}/.test(p) && !/[.!?]$/.test(p));
    if (isHeading) { pushSection(); sectionTitle = p.trim(); html += `<h2 dir="auto">${esc(p.trim())}</h2>`; continue; }
    html += `<p dir="auto">${esc(p).replace(/\n/g, '<br>')}</p>`;
    if (++chunk > 400) pushSection();
  }
  pushSection();
  if (!sections.length) sections.push({ id: 's0', title: null, html: '<p></p>' });
  const toc = sections.filter(s => s.title).map(s => ({ title: s.title, sectionId: s.id, anchor: null, depth: 0 }));
  return { title, author: '', format: 'txt', cover: null, sections, toc, pageCount: null };
}

// ------------------------------------------------------------------ Markdown
export async function parseMarkdown(file) {
  await loadScript(CDN.marked);
  const text = await readText(file);
  const raw = window.marked.parse(text, { gfm: true, breaks: false });
  const html = await sanitize(raw);
  const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  return splitHtmlIntoSections(html, h1 ? h1[1].replace(/<[^>]+>/g, '').trim() : prettyName(file.name), 'md');
}

// ------------------------------------------------------------------ HTML
export async function parseHtml(file) {
  const text = await readText(file);
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const title = (doc.querySelector('title')?.textContent || prettyName(file.name)).trim();
  // one top-level <article> is the page's content (comments nested in it don't count); several are posts, keep them all
  const posts = [...doc.querySelectorAll('article')].filter(a => !a.parentElement.closest('article'));
  const shared = posts.length > 1 && posts.every(a => a.parentElement === posts[0].parentElement) && posts[0].parentElement;
  let main = (posts.length === 1 && posts[0]) || doc.querySelector('main') || shared || doc.body;
  main.querySelectorAll('script, style, nav, header, footer, aside, noscript, iframe').forEach(n => n.remove());
  // a lone wrapper (<main><article>, <div class=entry-content>) would hide the h1/h2 splits and the TOC
  while (main.children.length === 1 && /^(ARTICLE|MAIN|SECTION|DIV)$/.test(main.firstElementChild.tagName)
    && ![...main.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) main = main.firstElementChild;
  const html = await sanitize(main.innerHTML);
  return splitHtmlIntoSections(html, title, 'html', main.closest('[dir]')?.getAttribute('dir'), main.closest('[lang]')?.getAttribute('lang'));
}

// ------------------------------------------------------------------ DOCX
export async function parseDocx(file) {
  await loadScript(CDN.mammoth);
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.convertToHtml({ arrayBuffer: buf }, {
    convertImage: window.mammoth.images.imgElement(img => img.read('base64').then(b => ({ src: `data:${img.contentType};base64,${b}` }))),
  });
  let html = await sanitize(result.value);
  // Word files that keep their text in shapes/text boxes come out of mammoth nearly empty. Fall back to raw paragraphs.
  const words = (html.replace(/<[^>]+>/g, ' ').match(/\S+/g) || []).length;
  if (words < 120) {
    try {
      await loadScript(CDN.jszip);
      const zip = await window.JSZip.loadAsync(buf);
      const xml = await zip.file('word/document.xml').async('text');
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
      Array.from(doc.getElementsByTagNameNS(MC, 'Fallback')).forEach(n => n.remove());
      const paras = Array.from(doc.getElementsByTagNameNS(W, 'p'));
      const seen = new Set();
      const out = [];
      const ownerPara = (t) => { let n = t.parentNode; while (n && !(n.namespaceURI === W && n.localName === 'p')) n = n.parentNode; return n; };
      for (const para of paras) {
        const text = Array.from(para.getElementsByTagNameNS(W, 't')).filter(t => ownerPara(t) === para).map(t => t.textContent).join('').replace(/\s+/g, ' ').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const style = para.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttribute('w:val') || '';
        const h = /heading\s*([1-3])|title/i.exec(style);
        out.push(h ? `<h${h[1] || 1}>${esc(text)}</h${h[1] || 1}>` : `<p>${esc(text)}</p>`);
      }
      const rawWords = out.join(' ').replace(/<[^>]+>/g, ' ').match(/\S+/g)?.length || 0;
      if (rawWords > words * 1.5) html = out.join('') + html.replace(/<p>(?:(?!<img)[^<])*<\/p>/g, '');
    } catch (e) { console.warn('docx fallback failed', e); }
  }
  const parsed = splitHtmlIntoSections(html, prettyName(file.name), 'docx');
  // first h1 as title if present
  const m = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (m) parsed.title = m[1].replace(/<[^>]+>/g, '').trim() || parsed.title;
  return parsed;
}

// Split a flat HTML string into sections on h1/h2, build TOC from h1–h3.
// Blocks get the source's direction, or dir="auto" (each follows its first letter) so Arabic and Hebrew read right to left.
function splitHtmlIntoSections(html, title, format, dir, lang) {
  dir = /^(ltr|rtl)$/i.test(dir || '') ? dir.toLowerCase() : 'auto';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const nodes = Array.from(doc.body.childNodes);
  const sections = [];
  const toc = [];
  let cur = { id: 's0', title: null, parts: [] };
  const flush = () => { if (cur.parts.length) { sections.push({ id: cur.id, title: cur.title, html: cur.parts.join('') }); } };
  let hid = 0;
  for (const n of nodes) {
    if (n.nodeType === 1 && /^H[1-2]$/.test(n.tagName) && cur.parts.length) {
      flush();
      cur = { id: 's' + sections.length, title: n.textContent.trim(), parts: [] };
    }
    if (n.nodeType === 1 && /^H[1-3]$/.test(n.tagName)) {
      const id = 'h' + (hid++);
      n.id = id;
      if (!cur.title) cur.title = n.textContent.trim();
      toc.push({ title: n.textContent.trim(), sectionId: cur.id, anchor: id, depth: Number(n.tagName[1]) - 1 });
    }
    if (n.nodeType === 1) { if (!n.hasAttribute('dir')) n.setAttribute('dir', dir); if (lang && !n.hasAttribute('lang')) n.setAttribute('lang', lang); }
    cur.parts.push(n.nodeType === 1 ? n.outerHTML : (n.textContent.trim() ? `<p dir="${dir}"${lang ? ` lang="${esc(lang)}"` : ''}>${esc(n.textContent)}</p>` : ''));
  }
  flush();
  if (!sections.length) sections.push({ id: 's0', title: null, html: html || '<p></p>' });
  // normalise toc depth so the smallest depth is 0
  const minDepth = Math.min(...toc.map(t => t.depth), 0);
  toc.forEach(t => t.depth -= minDepth);
  return { title, author: '', format, cover: null, sections, toc, pageCount: null };
}

// ------------------------------------------------------------------ EPUB
export async function parseEpub(file, onProgress) {
  await loadScript(CDN.jszip);
  const zip = await window.JSZip.loadAsync(file);
  // Real-world EPUBs drift from the spec: byte-order marks, paths whose case differs from the zip entry,
  // stray % in hrefs, files the manifest lists but the zip lacks. Look up leniently; missing means skip.
  const lowerNames = new Map(Object.keys(zip.files).map(n => [n.toLowerCase(), n]));
  const entry = (path) => { if (!path) return null; const n = zip.file(path) ? path : lowerNames.get(path.toLowerCase()); return n ? zip.file(n) : null; };
  const readEntry = async (path) => { const f = entry(path); return f ? (await f.async('text')).replace(/^\uFEFF/, '') : null; };
  const xml = async (path) => { const src = await readEntry(path); return src == null ? null : new DOMParser().parseFromString(src, 'application/xml'); };
  const container = await xml('META-INF/container.xml');
  let opfPath = container?.querySelector('rootfile')?.getAttribute('full-path');
  if (!entry(opfPath)) opfPath = Object.keys(zip.files).find(n => /\.opf$/i.test(n));
  if (!opfPath) throw new Error('No package file (.opf) in EPUB');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = await xml(opfPath);
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const resolve = (href, base = opfDir) => {
    href = decode((href || '').split('#')[0]);
    const parts = (base + href).split('/');
    const out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
    return out.join('/');
  };

  const md = opf.querySelector('metadata');
  const getMeta = (tag) => { const el = md && Array.from(md.getElementsByTagName('*')).find(e => e.localName === tag); return el ? el.textContent.trim() : ''; };
  const title = getMeta('title') || prettyName(file.name);
  const author = getMeta('creator');

  const manifest = {};
  opf.querySelectorAll('manifest > item').forEach(it => {
    manifest[it.getAttribute('id')] = { href: it.getAttribute('href'), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
  });
  const spine = Array.from(opf.querySelectorAll('spine > itemref')).map(r => r.getAttribute('idref')).filter(id => manifest[id]);
  const bookDir = opf.querySelector('spine')?.getAttribute('page-progression-direction');

  // cover
  let cover = null;
  let coverId = Object.keys(manifest).find(id => manifest[id].props.includes('cover-image'));
  if (!coverId) { const m = opf.querySelector('meta[name="cover"]'); if (m) coverId = m.getAttribute('content'); }
  if (coverId && manifest[coverId]) {
    const f = entry(resolve(manifest[coverId].href));
    if (f) cover = await safeCover(await f.async('uint8array'));
  }

  // resource cache: path -> data URL
  const resCache = new Map();
  async function resource(path) {
    if (resCache.has(path)) return resCache.get(path);
    const f = entry(path);
    if (!f) { resCache.set(path, null); return null; }
    const ext = path.split('.').pop().toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'application/octet-stream';
    const url = await blobToDataURL(new Blob([await f.async('arraybuffer')], { type: mime }));
    resCache.set(path, url);
    return url;
  }

  const sections = [];
  const pathToSection = {};
  const DOMPurify = await getPurify();
  let i = 0;
  for (const id of spine) {
    onProgress(`Unpacking chapter ${++i} of ${spine.length}…`);
    const item = manifest[id];
    const path = resolve(item.href);
    const src = await readEntry(path);
    if (src == null) continue;
    const doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    let body = doc.querySelector('body');
    if (!body || doc.querySelector('parsererror')) { body = new DOMParser().parseFromString(src, 'text/html').body; }
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    // inline images
    for (const img of Array.from(body.querySelectorAll('img, image'))) {
      const attr = img.hasAttribute('src') ? 'src' : (img.hasAttribute('xlink:href') ? 'xlink:href' : 'href');
      const ref = img.getAttribute(attr);
      if (!ref || ref.startsWith('data:')) continue;
      const url = await resource(resolve(ref, dir));
      if (url) { if (img.tagName.toLowerCase() === 'image') { const n = doc.createElement('img'); n.setAttribute('src', url); img.replaceWith(n); } else img.setAttribute('src', url); }
      else img.remove();
    }
    // internal links -> data attributes we can route
    body.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (/^(https?:|mailto:)/.test(href)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); return; }
      const [p, hash] = href.split('#');
      a.setAttribute('data-epub-target', (p ? resolve(p, dir) : path) + (hash ? '#' + hash : ''));
      a.removeAttribute('href');
    });
    body.querySelectorAll('script, style, link, nav[hidden]').forEach(n => n.remove());
    // Direction and language live on <html> and <body>, which are dropped: move them onto the blocks. A chapter that
    // declares none follows the spine, then its own text (right-to-left set in CSS only).
    const root = body.ownerDocument.documentElement;
    const attr = (name) => body.getAttribute(name) || body.getAttribute('xml:' + name) || root.getAttribute(name) || root.getAttribute('xml:' + name);
    let textDir = (attr('dir') || bookDir || '').toLowerCase();
    if (textDir !== 'ltr' && textDir !== 'rtl') { const t = body.textContent; textDir = (t.match(RTL_CHARS_G) || []).length > (t.match(/\p{L}/gu) || []).length / 2 ? 'rtl' : ''; }
    const lang = attr('lang');
    for (const el of Array.from(body.children)) {
      if (textDir === 'rtl' && !el.hasAttribute('dir')) el.setAttribute('dir', 'rtl');
      if (lang && !el.hasAttribute('lang') && !el.hasAttribute('xml:lang')) el.setAttribute('lang', lang);
    }
    const clean = DOMPurify.sanitize(body.innerHTML, {
      USE_PROFILES: { html: true, svg: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'title', 'head'],
      FORBID_ATTR: ['style', 'onload', 'onerror'],
      ALLOW_DATA_ATTR: true,
    });
    const text = body.textContent.replace(/\s+/g, ' ').trim();
    const hasImg = /<img/i.test(clean);
    if (!text && !hasImg) continue;
    const h = body.querySelector('h1, h2, h3, h4');
    const sec = { id: 's' + sections.length, title: h ? h.textContent.trim() : null, html: clean, path };
    pathToSection[path] = sec.id;
    sections.push(sec);
  }

  // TOC: EPUB3 nav first, then NCX
  let toc = [];
  const navId = Object.keys(manifest).find(id => manifest[id].props.includes('nav'));
  if (navId) {
    const navPath = resolve(manifest[navId].href);
    const navSrc = await readEntry(navPath);
    const navDoc = new DOMParser().parseFromString(navSrc || '<html/>', 'application/xhtml+xml');
    const navDir = navPath.includes('/') ? navPath.slice(0, navPath.lastIndexOf('/') + 1) : '';
    const nav = Array.from(navDoc.getElementsByTagName('*')).find(e => e.localName === 'nav' && (e.getAttribute('epub:type') === 'toc' || e.getAttributeNS('http://www.idpf.org/2007/ops', 'type') === 'toc')) || Array.from(navDoc.getElementsByTagName('*')).find(e => e.localName === 'nav');
    if (nav) {
      const walk = (ol, depth) => {
        Array.from(ol.children).filter(e => e.localName === 'li').forEach(li => {
          const a = Array.from(li.children).find(e => e.localName === 'a' || e.localName === 'span');
          if (a) {
            const href = a.getAttribute('href') || '';
            const [p, hash] = href.split('#');
            const target = p ? resolve(p, navDir) : null;
            toc.push({ title: a.textContent.trim(), sectionId: target ? pathToSection[target] : null, anchor: hash || null, depth });
          }
          const sub = Array.from(li.children).find(e => e.localName === 'ol');
          if (sub) walk(sub, depth + 1);
        });
      };
      const ol = Array.from(nav.children).find(e => e.localName === 'ol');
      if (ol) walk(ol, 0);
    }
  }
  if (!toc.length) {
    const ncxId = Object.keys(manifest).find(id => manifest[id].type.includes('dtbncx') || manifest[id].href.endsWith('.ncx'));
    if (ncxId) {
      const ncxPath = resolve(manifest[ncxId].href);
      const ncxDir = ncxPath.includes('/') ? ncxPath.slice(0, ncxPath.lastIndexOf('/') + 1) : '';
      const ncx = await xml(ncxPath);
      const walk = (parent, depth) => {
        Array.from(parent.children).filter(e => e.localName === 'navPoint').forEach(np => {
          const label = np.querySelector('navLabel > text, text')?.textContent.trim() || '';
          const src = np.querySelector('content')?.getAttribute('src') || '';
          const [p, hash] = src.split('#');
          toc.push({ title: label, sectionId: p ? pathToSection[resolve(p, ncxDir)] : null, anchor: hash || null, depth });
          walk(np, depth + 1);
        });
      };
      const navMap = ncx?.querySelector('navMap');
      if (navMap) walk(navMap, 0);
    }
  }
  toc = toc.filter(t => t.sectionId);
  if (!toc.length) toc = sections.filter(s => s.title).map(s => ({ title: s.title, sectionId: s.id, anchor: null, depth: 0 }));
  return { title, author, format: 'epub', cover, sections, toc, pageCount: null };
}

// The cover becomes a blob: URL in the app's own origin, and a blob opened as a page (open image in new tab) runs
// any script it holds. So a cover is only ever a raster image, typed by its bytes and never by the manifest. An SVG
// cover is drawn onto a canvas through an <img>, where its scripts never run.
export async function safeCover(bytes) {
  const at = (i, s) => [...s].every((ch, k) => bytes[i + k] === ch.charCodeAt(0));
  const type = at(0, '\xFF\xD8\xFF') ? 'image/jpeg' : at(0, '\x89PNG') ? 'image/png' : at(0, 'GIF8') ? 'image/gif'
    : at(0, 'RIFF') && at(8, 'WEBP') ? 'image/webp' : at(4, 'ftyp') && /avi[fs]/.test(String.fromCharCode(...bytes.subarray(8, 32))) ? 'image/avif' : '';
  if (type) return new Blob([bytes], { type });
  const svg = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml').documentElement;
  if (svg.localName !== 'svg') return null;
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const num = (a) => /^\s*[\d.]+(px)?\s*$/.test(svg.getAttribute(a) || '') ? parseFloat(svg.getAttribute(a)) : 0;
  const ratio = vb[2] > 0 && vb[3] > 0 ? vb[3] / vb[2] : num('width') && num('height') ? num('height') / num('width') : 1.5;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas'); c.width = 600; c.height = Math.round(600 * Math.min(Math.max(ratio, 0.5), 3));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

// ------------------------------------------------------------------ PDF
// Reflow: text items -> lines -> paragraphs -> HTML. Keeps page markers so the
// original-layout view and the reflow view share a position (page number).
export async function parsePdf(file, onProgress) {
  const pdfjs = await getPdfjs();
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  let title = (meta?.info?.Title || '').trim();
  const author = (meta?.info?.Author || '').trim();
  const junkTitle = !title || /^(untitled|microsoft word|document\d*$|\(microsoft|microsoft powerpoint)/i.test(title) || /\\\d{3}|\?\?/.test(title) || /\.(doc|docx|pdf|indd|tex|html?|md|txt|odt|pages|pptx?|qxd|fm|p65)$/i.test(title);
  if (junkTitle) title = '';

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    if (p % 5 === 1) onProgress(`Reading page ${p} of ${pdf.numPages}…`);
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent({ includeMarkedContent: false });
    pages.push({ num: p, width: vp.width, height: vp.height, lines: itemsToLines(tc.items, tc.styles) });
    page.cleanup();
  }

  // cover thumbnail from page 1
  let cover = null;
  try {
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 360 / page.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    cover = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
  } catch {}

  // outline
  let outline = [];
  try {
    const ol = await pdf.getOutline();
    if (ol) {
      const walk = async (items, depth) => {
        for (const it of items) {
          let pageNum = null;
          try {
            let dest = it.dest;
            if (typeof dest === 'string') dest = await pdf.getDestination(dest);
            if (Array.isArray(dest) && dest[0]) pageNum = (await pdf.getPageIndex(dest[0])) + 1;
          } catch {}
          outline.push({ title: (it.title || '').trim(), page: pageNum, depth });
          if (it.items?.length) await walk(it.items, depth + 1);
        }
      };
      await walk(ol, 0);
    }
  } catch {}

  const { sections, toc, firstHeading } = reflowPages(pages, outline);
  if (!title) {
    const fromName = prettyName(file.name);
    const genericName = /^(document|doc|file|scan|scanned|download|untitled|new|print|output|final|report|pdf|export)?[\s\d_()-]*$/i.test(fromName) || /^[a-f0-9]{8,}$/i.test(fromName.replace(/\s/g, ''));
    title = (!genericName && fromName) || (firstHeading && firstHeading.length <= 120 ? firstHeading : '') || fromName || 'Untitled';
  }
  const isScanned = pages.every(pg => pg.lines.length === 0);
  return { title, author, format: 'pdf', cover, sections, toc, pageCount: pdf.numPages, isScanned };
}

// Group pdf.js text items into visual lines.
function itemsToLines(items, styles) {
  const glyphs = items.filter(it => it.str !== undefined && (it.str.trim() !== '' || it.hasEOL)).map(it => {
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(b, d) || Math.hypot(a, c) || 10;
    const font = styles[it.fontName] || {};
    return { str: it.str, x, y, w: it.width, h: it.height || size, size, bold: /bold|black|heavy|semibold/i.test(it.fontName + (font.fontFamily || '')), italic: /italic|oblique/i.test(it.fontName + (font.fontFamily || '')), eol: it.hasEOL };
  }).filter(g => g.str.trim() !== '');
  if (!glyphs.length) return [];
  // cluster by baseline y
  glyphs.sort((p, q) => (q.y - p.y) || (p.x - q.x));
  const lines = [];
  for (const g of glyphs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - g.y) <= Math.max(2, last.size * 0.45)) { last.items.push(g); }
    else lines.push({ y: g.y, size: g.size, items: [g] });
  }
  return columnOrder(lines).map(l => {
    l.items.sort((p, q) => p.x - q.x);
    // pieces in visual order (left to right), with the spaces between them
    const toks = [];
    let prev = null;
    for (const g of l.items) {
      if (prev) {
        const gap = g.x - (prev.x + prev.w);
        if (gap > prev.size * 0.12 && !prev.str.endsWith(' ') && !g.str.startsWith(' ')) toks.push({ str: ' ', d: '' });
      }
      toks.push({ str: g.str, d: RTL_CHARS.test(g.str) ? 'r' : /[\p{L}\p{N}]/u.test(g.str) ? 'l' : '' });
      prev = g;
    }
    // Right-to-left lines (Arabic, Hebrew) come as pieces in visual order: read them right to left, and keep runs
    // of the other direction (numbers, Latin words) in their own order. A neutral piece between two pieces of
    // the same direction takes that direction.
    const all = l.items.map(g => g.str).join('');
    const rtl = (all.match(RTL_CHARS_G) || []).length > (all.match(/\p{L}/gu) || []).length / 2;
    const base = rtl ? 'r' : 'l';
    const before = [];
    toks.forEach((t, i) => { before[i] = t.d || before[i - 1] || ''; });
    for (let i = toks.length - 1, after = ''; i >= 0; i--) {
      if (toks[i].d) { after = toks[i].d; continue; }
      toks[i].d = before[i] && before[i] === after ? after : base;
    }
    if (rtl) toks.reverse();
    let text = '';
    for (let i = 0; i < toks.length;) {
      let j = i;
      while (j < toks.length && (toks[j].d === base) === (toks[i].d === base)) j++;
      const run = toks.slice(i, j);
      if (toks[i].d !== base) run.reverse();
      text += run.map(t => t.str).join('');
      i = j;
    }
    const sizes = l.items.map(g => g.size);
    const size = sizes.reduce((s, v) => s + v, 0) / sizes.length;
    const x0 = l.items[0].x, x1 = prev.x + prev.w;
    const bold = l.items.filter(g => g.bold).length > l.items.length / 2;
    const italic = l.items.filter(g => g.italic).length > l.items.length / 2;
    // Arabic presentation forms (shaped glyphs) back to plain letters
    text = text.replace(/[ﬀ-﷿ﹰ-﻿]+/g, s => s.normalize('NFKC'));
    // RTL fonts often leave letters unmapped (control codes), so only a private-use glyph makes an RTL bullet
    text = text.replace(rtl ? /^[\uE000-\uF8FF]\s*/ : /^[\u0000-\u0008\u000b-\u001f\uE000-\uF8FF]\s*/, '• ').replace(/[\u0000-\u0008\u000b-\u001f\uE000-\uF8FF]/g, '');
    return { text: text.replace(/\s+/g, ' ').trim(), x0, x1, y: l.y, size, bold, italic, rtl, col: l.col || 0, colTop: !!l.colTop, leader: /(\.\s?){4,}\s*\d+\s*$/.test(text) };
  }).filter(l => l.text);
}
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const RTL_CHARS_G = new RegExp(RTL_CHARS.source, 'g');

// Two-column pages: find a gutter, an x that no line crosses over a run of lines with column text on both
// sides, and read each such run as the first column, then the second. Lines across the gutter (titles,
// abstracts, centred page numbers) stay where they are.
function columnOrder(lines) {
  if (lines.length < 6) return lines;
  let L = Infinity, R = -Infinity;
  for (const l of lines) for (const g of l.items) { L = Math.min(L, g.x); R = Math.max(R, g.x + g.w); }
  const span = R - L;
  // inked stretches of each line, word gaps closed
  const ink = lines.map(l => {
    const out = [];
    for (const g of [...l.items].sort((p, q) => p.x - q.x)) {
      const last = out[out.length - 1];
      if (last && g.x - last[1] < l.size * 0.7) last[1] = Math.max(last[1], g.x + g.w);
      else out.push([g.x, g.x + g.w]);
    }
    return out;
  });
  const median = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  let best = null;
  for (let x = L + span * 0.3; x <= L + span * 0.7; x += 2) {
    const runs = [];
    let run = [];
    const close = () => {
      const left = [], right = [];
      for (const i of run) {
        const lw = ink[i].filter(([, b]) => b <= x), rw = ink[i].filter(([a]) => a >= x);
        if (lw.length) left.push(lw[lw.length - 1][1] - lw[0][0]);
        if (rw.length) right.push(rw[rw.length - 1][1] - rw[0][0]);
      }
      if (left.length >= 3 && right.length >= 3 && median(left) >= span * 0.25 && median(right) >= span * 0.25) runs.push(run);
      run = [];
    };
    lines.forEach((l, i) => { if (ink[i].some(([a, b]) => a < x && b > x)) close(); else run.push(i); });
    close();
    const score = runs.reduce((s, r) => s + r.length, 0);
    if (score && (!best || score > best.score)) best = { x, runs, score };
  }
  if (!best) return lines;
  const out = [];
  let next = 0;
  for (const run of best.runs) {
    while (next < run[0]) out.push(lines[next++]);
    const side = (col, left) => run.map(i => lines[i]).map(l => ({ y: l.y, size: l.size, col, items: l.items.filter(g => (g.x + g.w / 2 < best.x) === left) })).filter(l => l.items.length);
    const lefts = side(1, true), rights = side(2, false);
    // right-to-left text reads the right column first
    const rtlLines = run.filter(i => lines[i].items.some(g => RTL_CHARS.test(g.str))).length;
    const [first, second] = rtlLines > run.length / 2 ? [rights, lefts] : [lefts, rights];
    second[0].colTop = true;
    out.push(...first, ...second);
    next = run[run.length - 1] + 1;
  }
  while (next < lines.length) out.push(lines[next++]);
  return out;
}

function reflowPages(pages, outline) {
  // --- body font size (mode of sizes, weighted by text length)
  const sizeWeight = new Map();
  for (const pg of pages) for (const l of pg.lines) { const k = Math.round(l.size * 2) / 2; sizeWeight.set(k, (sizeWeight.get(k) || 0) + l.text.length); }
  let bodySize = 10;
  let best = -1;
  for (const [k, w] of sizeWeight) if (w > best) { best = w; bodySize = k; }

  // --- repeated headers/footers: identical normalized text near top/bottom on many pages
  const posText = new Map();
  for (const pg of pages) for (const l of pg.lines) {
    const rel = l.y / pg.height;
    if (rel > 0.08 && rel < 0.92) continue;
    const key = l.text.replace(/\d+/g, '#').toLowerCase();
    posText.set(key, (posText.get(key) || 0) + 1);
  }
  const repeated = new Set(Array.from(posText).filter(([, n]) => n >= Math.max(3, pages.length * 0.3)).map(([k]) => k));
  const isPageNumber = (l) => /^[\divxlc]{1,5}$/i.test(l.text) || /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(l.text);
  const isNoise = (l, pg) => {
    const rel = l.y / pg.height;
    if ((rel <= 0.08 || rel >= 0.92) && (isPageNumber(l) || repeated.has(l.text.replace(/\d+/g, '#').toLowerCase()))) return true;
    return false;
  };

  // --- lines -> paragraphs across pages
  const blocks = []; // { type: 'p'|'h', text, page, size, bold }
  let cur = null;
  let lineWidths = [];
  for (const pg of pages) for (const l of pg.lines) if (!isNoise(l, pg)) lineWidths.push(l.x1 - l.x0);
  lineWidths.sort((a, b) => a - b);
  const typicalWidth = lineWidths[Math.floor(lineWidths.length * 0.8)] || 400;

  // typical baseline-to-baseline distance (handles double-spaced documents)
  const gaps = [];
  for (const pg of pages) { let prevL = null; for (const l of pg.lines) { if (isNoise(l, pg)) continue; if (prevL) { const g = prevL.y - l.y; if (g > 0 && g < l.size * 4) gaps.push(g / l.size); } prevL = l; } }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1.2; // in units of font size
  const flush = () => { if (cur && cur.text.trim()) blocks.push(cur); if (cur?.notes) blocks.push(...cur.notes); cur = null; };
  const headingLevel = (l) => {
    if (l.size >= bodySize * 1.6) return 1;
    if (l.size >= bodySize * 1.25) return 2;
    if (l.size >= bodySize * 1.08 && l.bold) return 3;
    if (l.bold && l.size >= bodySize * 0.95 && l.text.length < 90 && !/[.,;:]$/.test(l.text)) return 3;
    // numbered / lettered section titles ("2.1.2. Chronological…", "d) Ḥikmah to…") on a short line without end punctuation
    if (l.size >= bodySize * 0.95 && l.text.length < 100 && (l.x1 - l.x0) < typicalWidth * 0.8 && !/[.,;:!?]$/.test(l.text)
        && /^(\d+(\.\d+)+\.?|[A-Za-z]\)|\(?[ivxIVX]+\)|Chapter\s+\d+|CHAPTER\s+\w+|Part\s+[\dIVX]+)\s+\S/.test(l.text)) return 3;
    return 0;
  };

  // Indents are measured from the body text edge of each page, column and direction: where unindented lines
  // start. l.s is the start of a line in reading direction (x0, or -x1 for right-to-left lines).
  for (const pg of pages) {
    const groups = new Map();
    for (const l of pg.lines) {
      if (isNoise(l, pg)) continue;
      l.s = l.rtl ? -l.x1 : l.x0;
      const k = l.col + (l.rtl ? 'r' : '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    }
    for (const ls of groups.values()) {
      const wide = Math.max(...ls.map(l => l.x1 - l.x0)) * 0.5;
      const edge = Math.min(...ls.filter(l => l.x1 - l.x0 >= wide).map(l => l.s));
      for (const l of ls) l.ind = l.s - edge;
    }
  }
  const isFn = (b) => b.size < bodySize * 0.86;
  // Does line l start a new paragraph after line prev of paragraph cur? brk: l is the first line of a page or column.
  const startsPara = (l, prev, cur, brk) => {
    const gap = prev.y - l.y;                         // same page: positive gap
    const indent = l.ind - cur.ind;                   // against the paragraph's own edge (its least indented line)
    const prevShort = (prev.x1 - prev.x0) < typicalWidth * 0.75 && /[.!?:"”’)]$/.test(prev.text);
    const listStart = /^([•\-–—*·▪◦]|\d+[.)]|[a-z][.)]|\(?[ivx]+\))\s/i.test(l.text) || prev.leader || l.leader;
    const sizeChange = Math.abs(l.size - cur.size) > bodySize * 0.15;
    if (brk) return prevShort || indent > l.size * 0.8 || listStart || sizeChange || /^[A-Z]/.test(l.text) && /[.!?]$/.test(prev.text) && (prev.x1 - prev.x0) < typicalWidth * 0.9;
    if (gap > l.size * Math.max(1.9, lineGap * 1.45) || gap < -l.size * 0.5) return true; // big gap or column jump
    if (indent > l.size * 0.8 && prevShort) return true;
    if (indent > l.size * 1.5) return true;
    if (indent > l.size && /[.!?:"”’)]$/.test(prev.text)) return true; // indented line after a sentence end
    if (prevShort && gap > l.size * Math.max(1.3, lineGap * 1.12)) return true;
    if (listStart || sizeChange) return true;
    // a one-line paragraph has no edge of its own: an indented short line, then a line indented the same way
    return cur.n === 1 && prevShort && cur.ind > l.size * 0.8 && Math.abs(indent) < l.size * 0.3;
  };

  let prev = null; // kept across pages, so the first line of a page is judged against the last one
  for (const pg of pages) {
    let firstOnPage = true;
    for (const l of pg.lines) {
      if (isNoise(l, pg)) continue;
      if (l.size < bodySize * 0.8 && /^\d{1,3}$/.test(l.text)) continue; // stray superscript footnote number
      const hl = headingLevel(l);
      const marker = firstOnPage ? pg.num : null;
      firstOnPage = false;
      const brk = !!marker || l.colTop;
      if (hl) {
        // merge consecutive heading lines of the same level (wrapped headings)
        if (cur && cur.type === 'h' && cur.level === hl && prev && !brk && Math.abs(prev.size - l.size) < 0.5 && (Math.abs(prev.y - l.y) < l.size * 1.8 || /[,\-–]$/.test(cur.text) || /^[a-z]/.test(l.text))) { cur.text += (/-$/.test(cur.text) ? '' : ' ') + l.text; prev = l; continue; }
        flush();
        cur = { type: 'h', level: hl, text: l.text, page: pg.num, marker };
        prev = l; continue;
      }
      // Small print ended the last page (footnotes) or starts this one (a running head): body text that carries
      // on continues the paragraph it interrupted, and the small print moves after that paragraph.
      let cont = false, mark = marker;
      if (cur && cur.type === 'p' && isFn(cur) && !isFn(l) && (brk || cur.marker === pg.num)) {
        flush();
        let i = blocks.length - 1;
        while (i >= 0 && blocks[i].type === 'p' && isFn(blocks[i])) i--;
        const b = blocks[i];
        if (b && b.type === 'p' && !startsPara(l, b.last, b, true)) {
          const notes = blocks.splice(i + 1);
          for (const n of notes) if (n.marker) { mark = n.marker; n.marker = null; }
          cur = blocks.pop(); cur.notes = notes; prev = cur.last; cont = true;
        }
      }
      if (!cont && (!cur || cur.type === 'h' || !prev || startsPara(l, prev, cur, brk))) {
        flush();
        cur = { type: 'p', text: l.text, page: pg.num, size: l.size, ind: l.ind, n: 1, last: l, marker, italic: l.italic };
      } else {
        const hyph = /[a-z]-$/.test(cur.text) && /^[a-z]/.test(l.text);
        // a page that starts inside the paragraph gets its marker where its text starts (a split word: before it)
        if (mark) (cur.pgs = cur.pgs || []).push([hyph ? cur.text.lastIndexOf(' ') + 1 : cur.text.length + 1, mark]);
        cur.text = hyph ? cur.text.slice(0, -1) + l.text : cur.text + ' ' + l.text;
        cur.ind = Math.min(cur.ind, l.ind); cur.n++; cur.last = l;
      }
      prev = l;
    }
  }
  flush();

  // --- blocks -> sections. New section at h1/h2 headings or every ~20 pages.
  const sections = [];
  const toc = [];
  let html = '', secTitle = null, secStartPage = 1, pagesInSec = 0, lastPage = 0;
  const pushSection = () => { if (html) sections.push({ id: 's' + sections.length, title: secTitle, html, startPage: secStartPage }); html = ''; };
  const pageMark = (n, hard) => `<span class="pg${hard ? ' hard' : ''}" id="pg${n}" data-page="${n}"></span>`;
  for (const b of blocks) {
    if (b.type === 'h' && b.level <= 2 && html) { pushSection(); secTitle = b.text; secStartPage = b.page; pagesInSec = 0; }
    else if (b.marker && html && b.page - secStartPage >= 20 && b.type === 'p' && /^[A-Z“"]/.test(b.text)) { pushSection(); secTitle = null; secStartPage = b.page; }
    if (b.marker && b.page !== lastPage) { html += pageMark(b.page, b.page !== 1); lastPage = b.page; }
    if (b.type === 'h') {
      const id = `h${b.page}-${slug(b.text)}`;
      html += `<h${Math.min(b.level + 1, 4)} id="${id}">${esc(b.text)}</h${Math.min(b.level + 1, 4)}>`;
      if (!secTitle) secTitle = b.text;
      if (!outline.length) toc.push({ title: b.text, sectionId: 's' + sections.length, anchor: id, depth: b.level - 1 });
    } else {
      const cls = [b.italic ? 'it' : '', b.size && b.size < bodySize * 0.86 ? 'fn' : ''].filter(Boolean).join(' ');
      let text = '', at = 0;
      for (const [i, n] of (b.pgs || [])) { text += esc(b.text.slice(at, i)); at = i; if (n !== lastPage) { text += pageMark(n, false); lastPage = n; } }
      html += `<p${cls ? ` class="${cls}"` : ''}>${text + esc(b.text.slice(at))}</p>`;
    }
  }
  pushSection();
  if (!sections.length) sections.push({ id: 's0', title: null, html: '<p class="muted">This PDF has no selectable text (probably scanned). Use the page-layout view.</p>', startPage: 1 });

  // outline -> toc (map page -> section)
  if (outline.length) {
    for (const o of outline) {
      if (!o.page) continue;
      const sec = [...sections].reverse().find(s => s.startPage <= o.page) || sections[0];
      toc.push({ title: o.title, sectionId: sec.id, anchor: 'pg' + o.page, depth: o.depth, page: o.page });
    }
  }
  const firstHeading = (blocks.find(b => b.type === 'h' && b.level <= 2 && b.text.length > 2) || {}).text || null;
  return { sections: sections.map(s => ({ id: s.id, title: s.title, html: s.html, startPage: s.startPage })), toc: toc.filter(t => t.title && t.title.trim()), firstHeading };
}
