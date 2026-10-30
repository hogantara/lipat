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

let pdfjsLib = null;
export async function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(CDN.pdfjs);
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
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
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
    if (isHeading) { pushSection(); sectionTitle = p.trim(); html += `<h2>${esc(p.trim())}</h2>`; continue; }
    html += `<p>${esc(p).replace(/\n/g, '<br>')}</p>`;
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
  const main = doc.querySelector('article, main') || doc.body;
  main.querySelectorAll('script, style, nav, header, footer, aside, noscript, iframe').forEach(n => n.remove());
  const html = await sanitize(main.innerHTML);
  return splitHtmlIntoSections(html, title, 'html');
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
function splitHtmlIntoSections(html, title, format) {
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
    cur.parts.push(n.nodeType === 1 ? n.outerHTML : (n.textContent.trim() ? `<p>${esc(n.textContent)}</p>` : ''));
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

  // cover
  let cover = null;
  let coverId = Object.keys(manifest).find(id => manifest[id].props.includes('cover-image'));
  if (!coverId) { const m = opf.querySelector('meta[name="cover"]'); if (m) coverId = m.getAttribute('content'); }
  if (coverId && manifest[coverId]) {
    const f = entry(resolve(manifest[coverId].href));
    if (f) cover = new Blob([await f.async('arraybuffer')], { type: manifest[coverId].type || 'image/jpeg' });
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
  return lines.map(l => {
    l.items.sort((p, q) => p.x - q.x);
    let text = '';
    let prev = null;
    for (const g of l.items) {
      if (prev) {
        const gap = g.x - (prev.x + prev.w);
        if (gap > prev.size * 0.12 && !text.endsWith(' ') && !g.str.startsWith(' ')) text += ' ';
      }
      text += g.str;
      prev = g;
    }
    const sizes = l.items.map(g => g.size);
    const size = sizes.reduce((s, v) => s + v, 0) / sizes.length;
    const x0 = l.items[0].x, x1 = prev.x + prev.w;
    const bold = l.items.filter(g => g.bold).length > l.items.length / 2;
    const italic = l.items.filter(g => g.italic).length > l.items.length / 2;
    text = text.replace(/^[\u0000-\u0008\u000b-\u001f\uE000-\uF8FF]\s*/, '• ').replace(/[\u0000-\u0008\u000b-\u001f\uE000-\uF8FF]/g, '');
    return { text: text.replace(/\s+/g, ' ').trim(), x0, x1, y: l.y, size, bold, italic, leader: /(\.\s?){4,}\s*\d+\s*$/.test(text) };
  }).filter(l => l.text);
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
  const flush = () => { if (cur && cur.text.trim()) blocks.push(cur); cur = null; };
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

  for (const pg of pages) {
    let prev = null;
    let firstOnPage = true;
    for (const l of pg.lines) {
      if (isNoise(l, pg)) continue;
      if (l.size < bodySize * 0.8 && /^\d{1,3}$/.test(l.text)) continue; // stray superscript footnote number
      const hl = headingLevel(l);
      const marker = firstOnPage ? pg.num : null;
      firstOnPage = false;
      if (hl) {
        // merge consecutive heading lines of the same level (wrapped headings)
        if (cur && cur.type === 'h' && cur.level === hl && prev && !marker && Math.abs(prev.size - l.size) < 0.5 && (Math.abs(prev.y - l.y) < l.size * 1.8 || /[,\-–]$/.test(cur.text) || /^[a-z]/.test(l.text))) { cur.text += (/-$/.test(cur.text) ? '' : ' ') + l.text; prev = l; continue; }
        flush();
        cur = { type: 'h', level: hl, text: l.text, page: pg.num, marker };
        prev = l; continue;
      }
      const width = l.x1 - l.x0;
      let newPara = false;
      if (!cur || cur.type === 'h') newPara = true;
      else if (prev) {
        const gap = prev.y - l.y;                         // same page: positive gap
        const indent = l.x0 - cur.x0;
        const prevShort = (prev.x1 - prev.x0) < typicalWidth * 0.75 && /[.!?:"”’)]$/.test(prev.text);
        const listStart = /^([•\-–—*·▪◦]|\d+[.)]|[a-z][.)]|\(?[ivx]+\))\s/i.test(l.text) || prev.leader || l.leader;
        const sizeChange = Math.abs(l.size - cur.size) > bodySize * 0.15;
        if (marker) { newPara = prevShort || indent > l.size * 0.8 || listStart || sizeChange || /^[A-Z]/.test(l.text) && /[.!?]$/.test(prev.text) && (prev.x1 - prev.x0) < typicalWidth * 0.9; }
        else if (gap > l.size * Math.max(1.9, lineGap * 1.45) || gap < -l.size * 0.5) newPara = true; // big gap or column jump
        else if (indent > l.size * 0.8 && prevShort) newPara = true;
        else if (indent > l.size * 1.5) newPara = true;
        else if (prevShort && gap > l.size * Math.max(1.3, lineGap * 1.12)) newPara = true;
        else if (listStart) newPara = true;
        else if (sizeChange) newPara = true;
      }
      if (newPara) {
        flush();
        cur = { type: 'p', text: l.text, page: pg.num, size: l.size, x0: l.x0, marker, italic: l.italic };
      } else {
        if (marker) (cur.markersInside = cur.markersInside || []).push(marker);
        const hyph = /[a-z]-$/.test(cur.text) && /^[a-z]/.test(l.text);
        cur.text = hyph ? cur.text.slice(0, -1) + l.text : cur.text + ' ' + l.text;
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
      html += `<p${cls ? ` class="${cls}"` : ''}>${esc(b.text)}</p>`;
      for (const n of (b.markersInside || [])) if (n !== lastPage) { html += pageMark(n, false); lastPage = n; }
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
