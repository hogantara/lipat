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
- `js/formats.js` — PDF reflow, EPUB, DOCX, MD, HTML, TXT parsers. `js/db.js` IndexedDB v2. `js/drive.js`, `js/export.js` Drive and Markdown.
- `sw.js` — bump `VERSION` whenever shipped files change, or phones keep the old shell.
- `android/` — Bubblewrap Trusted Web Activity. Build steps in README "Android app". Keystore and password are gitignored; never commit them. Share-target `accept` must be MIME types only.
- `.well-known/assetlinks.json` here is informational; the one Android reads lives in the sibling repo `hogantara.github.io`.

## Checks before pushing

- `node --check js/*.js`
- Open in a phone-size viewport and a desktop one, light and night theme.
- Touch selection tests need real or synthetic TouchEvents and ~300 ms waits for animation frames.

## Conventions

- Commit as `hogantara <creative@sahamdarinol.com>` (git identity is not set globally; pass `-c user.name -c user.email`).
- Copy style: short sentences, no em-dashes, no marketing voice.
