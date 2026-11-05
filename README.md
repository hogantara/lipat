# Lipat

A calm, mobile-first e-reader that turns what you read into what you keep.

Add a PDF, EPUB, Word document, Markdown, plain text or saved web page. Lipat detects the format
itself, reflows everything into one comfortable reading column, and lets you react to ideas with one
of five emoji so your marks stay organised. Connect Google Drive and every mark lands in a tidy
Markdown folder, one file per book.

## Live

<https://hogantara.github.io/lipat/> — open on your phone, then **Add to Home Screen** / **Install app**.
The Google client ID for this origin is baked into `js/config.js`, so Settings → Connect Google Drive just works there.

## Run it

Static files, no build step. Serve the folder over HTTP (ES modules, the PDF worker and the service
worker all need it):

```bash
python3 -m http.server 8477 --directory lipat
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
  `T` theme, `A` text settings, `P` listen, `Esc` back).

**Listening**
- Every book can be read aloud, in every format. Tap the headphones (`P` on a keyboard). Lipat reads
  from the top of the screen, or from a word you long-press or select, and highlights the sentence
  being spoken. The page follows the voice until you scroll away; then the player offers "Back to the
  voice" and "Read from here".
- Two voices, chosen the first time you listen and changed any time from the player:
  - **Natural**: a neural voice that sounds like a person, in one of two models, each a one-time download:
    - [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad, for English books, with 13
      American and British speakers. It is one of the models [AudioSmith](https://github.com/hehehai/AudioSmith)
      runs on the Mac; Lipat runs it in the browser. Text becomes phonemes with eSpeak NG (the `phonemizer`
      package), then one model call makes the sound. A one-time 122 MB download: onnx-community's uint8f16
      export (on WebAssembly about 75% faster than the 92 MB q8 one) and the voice files from Hugging Face
      at a pinned commit. It makes speech about a quarter slower than Supertonic, so the working ahead below
      matters more. The default for English when you first pick the natural voice; readers who already have
      Supertonic keep it until they pick a Kokoro speaker.
    - [Supertonic 3](https://github.com/supertone-inc/supertonic) by Supertone, in 31 languages including
      English and Indonesian, with ten speakers. Books in other languages than English always use it.
    Pick between them in the Speaker list of the voice settings (English books list both). Each runs
    on the device in a worker with ONNX Runtime, so book text never leaves it, and plays through an audio
    element, so it keeps reading with the screen off and shows lock-screen controls. Supertonic is a one-time
    145 MB download from jsDelivr. Both are checked against SHA-256 sums and kept in IndexedDB, and each can
    be removed on its own. It works ahead of the
    voice, uses up to four cores where the browser supports Document-Isolation-Policy (Chrome 137 and
    later; the service worker asks for it). Supertonic picks its quality (denoising steps, 5 to 8;
    below 5 it sounds hissy) from how fast the device is, and the voice settings say what it runs on
    and how fast. If the device can't keep up, the player says "Preparing the next part" with how far
    along it is, gathers about a minute of speech (15 seconds on a device that keeps up), and goes on
    by itself: a rare wait instead of one every few sentences. Once it is on the device it also prepares
    ahead whenever a book is open, from where you are, up to 20 minutes, even before you press play and
    while paused (not while the screen is off and nothing plays). So on a slow device a few minutes of
    reading first give a long stretch of listening without a stop.
  - **Device**: the system's own voices (Web Speech API). Instant and in every language the device speaks,
    but Android stops it when the screen turns off. Lipat picks the best installed voice for the book's
    language. Used automatically for languages the natural voice doesn't speak.
- The language comes from the file, or from the text itself for PDF, Word and text files. Speaker, speed
  (0.6× to 2.5×; the speed button cycles common speeds) and language are in the player's voice settings.
- The text is prepared for the ear: footnote numbers, page numbers, code and bullets are skipped, links
  are read as their site name, headings and runs in capitals are not spelled out, and abbreviations
  like "Mr.", "Jl." or "J. R. R." don't break a sentence. Each sentence is spoken whole so the voice
  keeps its intonation.
- Lock screen, notification and headset buttons play, pause and skip (Media Session).

**Keeping**
- Select text, tap a reaction: 💡 Aha · ❤️ Love · 🤔 Hmm · 😮 Whoa · 😤 Nope (keys `1`–`5`).
- Add a note to any mark. Bookmark a spot.
- Marks tab shows everything across all books, filterable by reaction, book and text. Tap a mark to
  jump back to it in context.
- Settings → Export downloads (or shares, on a phone) one Markdown file with everything.

**Google Drive**
- Settings → Google Drive. One-time setup: create an OAuth client ID (type Web application) in
  Google Cloud, enable the Drive API, add the site's origin to Authorized JavaScript origins, paste
  the client ID. Lipat asks only for the `drive.file` scope: it can see and edit only files it created.
- Add → From Google Drive picks books straight from Drive with the Google Picker, then downloads
  them through the Drive API. Picking a file grants Lipat access to that file only. One-time setup
  in the same Cloud project: enable the Google Picker API, create an API key restricted to the
  Picker API and to the site's origin, and put it in `GOOGLE_API_KEY` in `js/config.js`. Until
  then Add goes straight to the device file picker.
- Folder layout in your Drive:

  ```
  Lipat/
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
- Android: "Share to Lipat" from any app's share sheet, and "Open with Lipat" for supported files.

## Layout

```
index.html            shell
css/app.css           mobile-first styles, desktop overrides at ≥760px
js/app.js             shelf, import, marks view, settings, Drive sync, PWA plumbing
js/reader.js          reading surface, marks, sheets/panels, search, PDF page mode
js/speech.js          read aloud: text for the ear, voice choice, player, highlight, Media Session
js/natural.js         natural voice, page side: works ahead, plays through one audio element
js/voice-worker.js    Supertonic worker: download, checksums, IndexedDB, ONNX Runtime
js/supertonic.js      Supertonic 3 inference (port of the reference web helper)
js/kokoro-worker.js   Kokoro worker: download from Hugging Face, checksums, IndexedDB, ONNX Runtime
js/kokoro.js          Kokoro 82M inference: text normalising and phonemes (ported from kokoro-js), tokens
js/voice-store.js     IndexedDB store for both voices' files
js/formats.js         format detection + parsers (PDF reflow, EPUB, DOCX, MD, HTML, TXT)
js/export.js          Markdown builders (book files, reaction files, index, download)
js/drive.js           Google Drive client (GIS token flow, drive.file scope)
js/db.js              IndexedDB (books meta, content, files, marks, settings)
sw.js                 service worker: offline cache, share-target inbox
manifest.webmanifest  PWA manifest (icons, share_target, file_handlers)
samples/              demo books
```

Libraries load from cdnjs on first use: pdf.js, JSZip, mammoth, marked, DOMPurify. The natural voice
loads ONNX Runtime Web and the Supertonic 3 model (OpenRAIL-M licence; sample code MIT) from jsDelivr only when
chosen; the model files are the `@3sln/donki-lle-voice-multi` npm packages, a sherpa-onnx conversion of
`Supertone/supertonic-3`. Kokoro (Apache-2.0) loads ONNX Runtime Web and the `phonemizer` package (eSpeak NG)
from jsDelivr and its model files from `huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX`. Google
Identity Services loads only when you connect Drive, and the Google Picker only when you add from Drive.

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

Outputs `app-release-signed.apk` (sideload, also copied to `download/` on the site) and `app-release-bundle.aab` (Play Console). Bump `appVersionCode` and `appVersion` in `twa-manifest.json` before each release (share-target `accept` must list MIME types only, never extensions, or Android refuses to install), then run `bubblewrap update --skipVersionUpgrade` and build again.

`android/android.keystore` and `android/signing.txt` are the signing key and its password. They are gitignored. Keep a backup: Play updates must be signed with the same key. The key's SHA-256 fingerprint is published at `https://hogantara.github.io/.well-known/assetlinks.json` (repo `hogantara/hogantara.github.io`, the domain root; Android ignores a copy under `/lipat/`). Without it the app opens with a browser bar on top.


## Name

Lipat is Indonesian for fold. The mark is a strip of paper folded once into an L. The app was called Dogear until 2026-10-30 (Android package `io.github.hogantara.dogear`, which must be uninstalled by hand since the Lipat package `io.github.hogantara.lipat` is a different app); the IndexedDB database keeps the old internal name so nothing is lost, and the Google Drive folder keeps whatever name it had (sync follows file ids, so renaming the folder in Drive is safe).
