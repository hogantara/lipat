// Lipat service worker: offline app shell, cached libraries, "Share to Lipat" inbox.
const VERSION = 'lipat-v2';
const SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/reader.js', './js/formats.js', './js/db.js', './js/config.js', './js/drive.js', './js/export.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];
const INBOX = 'lipat-inbox';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== INBOX).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

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
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  const sameOrigin = url.origin === self.location.origin;
  const isLib = /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (sameOrigin || isLib) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const cached = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
      if (isLib && cached) return cached;           // libraries: cache first
      if (cached) { net.catch(() => {}); return cached; } // app files: stale while revalidate
      return (await net) || Response.error();
    }));
  }
});
