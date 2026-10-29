# Dogear

A calm, mobile-first e-reader that turns what you read into what you keep.

Add a PDF, EPUB, Word document, Markdown, plain text or saved web page. Dogear detects the format
itself, reflows everything into one comfortable reading column, and lets you react to ideas with one
of five emoji so your marks stay organised. Connect Google Drive and every mark lands in a tidy
Markdown folder, one file per book.

## Live

<https://hogantara.github.io/dogear/> — open on your phone, then **Add to Home Screen** / **Install app**.
The Google client ID for this origin is baked into `js/config.js`, so Settings → Connect Google Drive just works there.

## Run it

Static files, no build step. Serve the folder over HTTP (ES modules, the PDF worker and the service
worker all need it):

```bash
python3 -m http.server 8477 --directory dogear
```

Open <http://localhost:8477>. On a phone, open the same URL and choose **Add to Home Screen**
(iOS Safari) or **Install app** (Android Chrome, also in Settings). Books and marks are stored in the
browser's IndexedDB. Try the books in `samples/`.

Deploy: push this folder to the `main` branch of the GitHub repo; GitHub Pages serves it from the root.
Any other static HTTPS host works too, as long as its origin is added to the OAuth client.

## What it does

**Reading**
- One format-agnostic reading view. PDFs are reflowed into real text, so font size, font, line
  spacing, alignment and theme apply to PDFs exactly like EPUBs.
- "Original layout" toggle (PDF only, `L`) renders the actual pages with zoom, synced to the same page.
- Four themes (Paper, Sepia, Mist, Night), three typefaces (Literata, Inter, Atkinson Hyperlegible).
- Table of contents, in-book search, page numbers for PDFs, progress, time left, position remembered.
- Phone: bottom toolbar, bottom sheets, tap the page to hide or show the chrome, long-press a cover
  to remove a book. Desktop: keyboard (`← →` page, `+ −` size, `B` bookmark, `C` contents, `F` find,
  `T` theme, `A` text settings, `Esc` back).

**Keeping**
- Select text, tap a reaction: 💡 Aha · ❤️ Love · 🤔 Hmm · 😮 Whoa · 😤 Nope (keys `1`–`5`).
- Add a note to any mark. Bookmark a spot.
- Marks tab shows everything across all books, filterable by reaction, book and text. Tap a mark to
  jump back to it in context.
- Settings → Export downloads (or shares, on a phone) one Markdown file with everything.

**Google Drive**
- Settings → Google Drive. One-time setup: create an OAuth client ID (type Web application) in
  Google Cloud, enable the Drive API, add the site's origin to Authorized JavaScript origins, paste
  the client ID. Dogear asks only for the `drive.file` scope: it can see and edit only files it created.
- Folder layout in your Drive:

  ```
  Dogear/
    Index.md                 table of all books with counts
    Books/
      The Psychology of Money.md   marks grouped by chapter, in reading order
      …
    By reaction/
      💡 Aha.md  ❤️ Love.md  🤔 Hmm.md  😮 Whoa.md  😤 Nope.md  🔖 Bookmarks.md
  ```

- Files update automatically about 15 s after you change a mark, when you leave a book, and when
  you come back online. "Sync now" forces a full rewrite. If Google asks to sign in again (tokens
  last an hour, and phones block silent popups), the status line says so and "Sync now" fixes it.

**PWA**
- Installable, works offline (app shell and libraries cached).
- Android: "Share to Dogear" from any app's share sheet, and "Open with Dogear" for supported files.

## Layout

```
index.html            shell
css/app.css           mobile-first styles, desktop overrides at ≥760px
js/app.js             shelf, import, marks view, settings, Drive sync, PWA plumbing
js/reader.js          reading surface, marks, sheets/panels, search, PDF page mode
js/formats.js         format detection + parsers (PDF reflow, EPUB, DOCX, MD, HTML, TXT)
js/export.js          Markdown builders (book files, reaction files, index, download)
js/drive.js           Google Drive client (GIS token flow, drive.file scope)
js/db.js              IndexedDB (books meta, content, files, marks, settings)
sw.js                 service worker: offline cache, share-target inbox
manifest.webmanifest  PWA manifest (icons, share_target, file_handlers)
samples/              demo books
```

Libraries load from cdnjs on first use: pdf.js, JSZip, mammoth, marked, DOMPurify. Google
Identity Services loads only when you connect Drive.

## Notes on the PDF reflow

Text is pulled with pdf.js, clustered into lines by baseline, then into paragraphs using the
document's own line spacing (so double-spaced theses reflow like single-spaced books), indentation,
short-line endings and list markers. Headings come from font size, numbered/lettered titles and the
PDF outline. Running headers, footers and page numbers are stripped; footnotes are shown smaller.
Scanned PDFs with no text layer open in the original-layout view automatically.

Word files that keep their text in shapes or text boxes (posters, worksheets) fall back to raw
paragraph extraction, since mammoth skips those.

## Android app

`android/` holds a Trusted Web Activity wrapper (Bubblewrap) around the hosted site. It is the same app, full screen, in the Android share sheet, installable from an APK or publishable to Play.

Build:

```bash
cd android
export JAVA_HOME=~/.bubblewrap/jdk17/Contents/Home ANDROID_HOME=~/.bubblewrap/android_sdk
export BUBBLEWRAP_KEYSTORE_PASSWORD=$(grep storepass signing.txt | cut -d= -f2) BUBBLEWRAP_KEY_PASSWORD=$BUBBLEWRAP_KEYSTORE_PASSWORD
bubblewrap build --skipPwaValidation
```

Outputs `app-release-signed.apk` (sideload) and `app-release-bundle.aab` (Play Console). Bump `appVersionCode` and `appVersion` in `twa-manifest.json` before each release, then run `bubblewrap update --skipVersionUpgrade` and build again.

`android/android.keystore` and `android/signing.txt` are the signing key and its password. They are gitignored. Keep a backup: Play updates must be signed with the same key. The key's SHA-256 fingerprint is published at `.well-known/assetlinks.json` so Android trusts the site and hides the browser bar.
