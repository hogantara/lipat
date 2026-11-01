// Lipat service worker: offline app shell, cached libraries, "Share to Lipat" inbox.
const VERSION = 'lipat-v19';
const SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/reader.js', './js/formats.js', './js/db.js', './js/config.js', './js/drive.js', './js/export.js', './js/speech.js', './js/natural.js', './js/supertonic.js', './js/voice-worker.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './img/doodles/shelf-ink.webp', './img/doodles/shelf-accent.webp', './img/doodles/shelf-tone.webp', './img/doodles/marks-ink.webp', './img/doodles/marks-accent.webp', './img/doodles/marks-tone.webp'];
const INBOX = 'lipat-inbox';

self.addEventListener('install', (e) => {
  // reload: skip the HTTP cache, or a fresh worker can precache files from the previous deploy.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== INBOX).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// The page asks to be isolated (Document-Isolation-Policy), which GitHub Pages can't send as a header: then the natural
// voice may use several cores. Unlike COOP and COEP it leaves Google sign-in popups working. Browsers without it ignore it.
function isolate(r) {
  if (!r || !r.ok || r.type === 'opaque' || r.redirected) return r;
  const h = new Headers(r.headers);
  h.set('Document-Isolation-Policy', 'isolate-and-credentialless');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Share target: stash the files, then open the app which imports them.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const files = form.getAll('files');
      const inbox = await caches.open(INBOX);
      for (const f of files) {
        if (f && f.name) await inbox.put(new Request(`${self.registration.scope}__inbox__/${Date.now()}-${encodeURIComponent(f.name)}`), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name) } }));
      }
      return Response.redirect(`${self.registration.scope}?shared=1`, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  // App files and pages: network first, cache only when offline. Serving cached scripts under a
  // fresh page paired new HTML with old JS after a deploy and broke the app until the cache caught up.
  // no-cache revalidates past the HTTP cache (GitHub Pages sends max-age=600).
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin) {
    const nav = e.request.mode === 'navigate', key = nav ? './index.html' : e.request;
    e.respondWith(caches.open(VERSION).then(c => fetch(e.request, { cache: 'no-cache' })
      .then(r => { if (r.ok) c.put(key, r.clone()); return r; })
      .catch(async () => (await c.match(key)) || Response.error()))
      .then(r => nav ? isolate(r) : r));
    return;
  }
  // Libraries: versioned URLs, so cache first. ONNX Runtime too (the natural voice); the voice model itself is kept
  // in IndexedDB by the speech worker, not here, so a new version of the app doesn't download it again.
  if (/cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host) || (url.host === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/onnxruntime-web@'))) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const cached = await c.match(e.request);
      if (cached) return cached;
      // As an anonymous CORS request, answered with Cross-Origin-Resource-Policy: an isolated page (see isolate)
      // refuses a service worker's answer to its scripts and styles without it.
      let r = await fetch(e.request.url, { mode: 'cors', credentials: 'omit' }).catch(() => null);
      if (r && r.ok) {
        const h = new Headers(r.headers);
        h.set('Cross-Origin-Resource-Policy', 'cross-origin');
        r = new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: h });
      } else r = await fetch(e.request).catch(() => null);
      if (r && r.ok) c.put(e.request, r.clone());
      return r || Response.error();
    }));
  }
});
