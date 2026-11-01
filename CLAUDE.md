# Lipat

Mobile-first e-reader PWA with emoji reactions, notes and Google Drive sync, wrapped as an Android app. Static vanilla ES modules, no bundler, no build step. Was called Dogear until 2026-10-30; internal names (IndexedDB `dogear`, Drive file properties `dogear*`) deliberately keep the old name.

## Run

```bash
python3 -m http.server 8477 --bind 127.0.0.1 --directory .
```

Open http://localhost:8477/?nosw (the `nosw` query skips the service worker so edits show on reload). Live site: https://hogantara.github.io/lipat/ deploys from `main` on push, about a minute.

## Layout

- `index.html`, `css/app.css` — shell and all styling. Design rules: neutral palette, one green accent (`--accent`), Geist for UI, Literata only for book text and quotes, Phosphor icons (never hand-drawn SVG), reaction emoji only as content. Radius rule: controls 10px, surfaces 12px, sheets 20px. No em-dashes or middle-dot separators in copy.
- `js/app.js` — shelf, marks tab, settings, Drive sync, PWA plumbing. `BUILD` constant shows in Settings; bump it with user-visible changes.
- `js/reader.js` — reading surface, marks, touch selection (Lipat runs its own long-press selection on coarse pointers; native selection is disabled there on purpose, see comment above `_wireTouchSelection`).
- `js/speech.js` — read aloud: cleans text for the ear, splits whole sentences, picks the engine and voice, runs the player (in the bottom bar while listening), highlights and follows. Positions are section text offsets, like marks. Two engines: the device voice (Web Speech API; Android stops it when the screen turns off) and the natural voice: `js/natural.js` (page side, plays one `<audio>` so it survives screen off), `js/voice-worker.js` (downloads Supertonic 3 from jsDelivr npm parts, verifies SHA-256, IndexedDB `lipat-voice`, ONNX Runtime) and `js/supertonic.js` (inference). Denoising steps stay 5 to 8: at 3 or 4 the voice is audibly hissy. WebGPU was tried and removed: on a Galaxy S23 the extra 21 MB build plus shader compiling kept the voice from starting (and the vocoder's int32 DequantizeLinear nodes fail on it). With the natural voice chosen and stored, an open book prepares speech ahead from the visible position (up to 20 min, paused while hidden and silent); `play` reuses what is ready. Never execute the downloaded parts; they are parsed as data. Device-voice tests need a fake `speechSynthesis` (headless Chromium has no voices); natural-voice tests can fake the worker, and a real run needs the npm parts served in place of jsDelivr (the sandbox proxy blocks it).
- `js/formats.js` — PDF reflow, EPUB, DOCX, MD, HTML, TXT parsers. `js/db.js` IndexedDB v2. `js/drive.js` (sync, plus Google Picker import) and `js/export.js` Drive and Markdown. Add from Drive stays hidden until `GOOGLE_API_KEY` in `js/config.js` is set.
- `img/doodles/` — empty-state doodles drawn with anidoodle, shipped as alpha masks that CSS paints in theme colours. Source and redraw steps in `img/doodles/src/`. These are the only illustrations; UI icons stay Phosphor.
- `sw.js` — app files are network first (cache is the offline fallback), so a deploy reaches phones on the next load. Still bump `VERSION` when shipped files change so the offline copy refreshes. It adds `Document-Isolation-Policy` to the page (GitHub Pages can't send headers) so the natural voice gets threads; keep it off COOP/COEP, which would break Google sign-in popups. An isolated page refuses the worker's answers for cross-origin scripts and styles unless they carry `Cross-Origin-Resource-Policy`, so library responses are fetched as CORS and given that header. Test with the service worker on (and `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` so Playwright routes its requests).
- `android/` — Bubblewrap Trusted Web Activity. Build steps in README "Android app". Keystore and password are gitignored; never commit them. Share-target `accept` must be MIME types only.
- `.well-known/assetlinks.json` here is informational; the one Android reads lives in the sibling repo `hogantara.github.io`.

## Checks before pushing

- `node --check js/*.js`
- Open in a phone-size viewport and a desktop one, light and night theme.
- Touch selection tests need real or synthetic TouchEvents and ~300 ms waits for animation frames.

## Conventions

- Commit as `hogantara <creative@sahamdarinol.com>` (git identity is not set globally; pass `-c user.name -c user.email`).
- Copy style: short sentences, no em-dashes, no marketing voice.
