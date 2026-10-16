# QuickConvert

A small file converter that runs entirely in the browser. Files never leave your device: there is no server, no upload, no analytics.

- **Images:** JPG, PNG, WebP, GIF (first frame), BMP, ICO, AVIF, HEIC (iPhone photos), TIFF, SVG, camera RAW (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW and more), Photoshop PSD/PSB, TGA, Netpbm (PPM, PGM, PBM, PAM), QOI, ICNS (Mac icons), JPEG XL (in Safari) → JPG, PNG, WebP, GIF, BMP, TIFF, TGA, QOI, ICO, or a one-page PDF. Crop to any shape (free, the original's shape, 1:1, 4:3, 3:2, 16:9 and the tall versions) by dragging a box over the picture, then resize.
- **Audio:** MP3, M4A, WAV, OGG, Opus, FLAC, AAC, WebA, MKA → MP3, M4A (AAC), AAC, OGG and Opus (Opus), FLAC or WAV, and the sound of any video → audio. Trim, volume, fade in and out, mono or stereo, sample rate, quality.
- **Video:** MP4, WebM, MOV, MKV, MPEG-TS (.ts, .mts, .m2ts), 3GP, OGV → MP4, WebM, MOV, MKV or an animated GIF, and GIF animations → MP4 or WebM. Trim with two handles under the player, size (1080p to 240p), frame rate, quality (Keep copies the video without re-encoding when nothing else changes), volume from mute to 200%. After converting, switch the player between Original and Result.
- **Tables:** CSV, TSV, XLSX, XLS (old Excel, read only), ODS → each other, JSON, YAML, XML, an HTML page with the table, or a Markdown table
- **Data:** JSON, YAML, XML → each other, to tables, or to a readable HTML/Markdown page (a table for lists of records, a nested list otherwise). JSON → JSON reformats it (indent, minify, sort keys). JSON Lines files are read too.
- **Documents:** Word (DOCX), HTML, Markdown, TXT → each other (DOCX as output from Markdown, HTML and TXT). Headings, lists, tables, links, bold/italic, code and quotes carry over. The tables in an HTML page can be pulled out to CSV, XLSX, ODS or JSON.
- Batch conversion, "Download all" as a ZIP
- Add files by dropping, choosing, or pasting (Ctrl+V)
- Per-image settings: output format, quality (slider or number), file size (auto or a target), background colour for transparent pictures going to JPG/BMP, resize (percent or pixels), resampling
- Live before/after preview: drag the divider, scroll to zoom, drag to move, pinch on touch screens, full-screen view
- Documents and data: see and edit the original text, with a live view of the result. Both boxes switch between views where it helps: Page or Code (HTML, Markdown), Table or Text (CSV, TSV); Word results show as a page. One handle resizes both boxes
- Settings that appear only where they matter: text encoding (auto-detects UTF-8, UTF-16, Windows-1251 and Windows-1252), separator in the file, sheet (or all sheets), which table of a page, first row as header, numbers as numbers, main content only (skips menus and footers of web pages), CSV separator and Excel BOM, indent (2, 4, tab or minified), sort keys, table or list layout, Word font and size
- HTML output: page background (text colour adjusts automatically) and font: three built-in fonts, or search all Google Fonts by part of the name
- Rename the output by editing the name at the top of the settings; ending it with another extension (e.g. `.webp`) switches the format
- Ctrl/Shift-click files to choose which ones Convert, "Copy settings" and the ZIP download apply to (Ctrl+A selects all, Esc clears). On touch screens: hold a file, then tap more files
- "Copy settings" asks first before copying an exact pixel size to other images
- Changing settings after converting keeps the old result downloadable (marked as outdated) until you convert again
- Wide screens: file list on the left, the clicked file's settings on the right (hide them with ×, by clicking the file again, or Esc). Phones: settings open under the file.

Plain HTML, CSS and JavaScript. No framework, no build step, no `npm install`.

## Run it locally

**Easiest:** double-click `index.html`. It works straight from disk in Chrome, Edge, Firefox and Safari.

**For development** (real worker file, easier debugging), serve the folder with any static server:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Deploy to GitHub Pages

1. Create a GitHub repository and push this folder to the `main` branch.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, pick **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute the site is live at `https://<user>.github.io/<repo>/`.

All paths are relative, so it works from any sub-path. Nothing needs building.

## How it works

```
index.html              page markup and <template>s for file rows and the settings panel
css/style.css           all styling; colours only through the CSS variables at the top
js/qc.js                shared namespace (QC), module registration, pinned library URLs
js/formats.js           format registry: detection, which outputs each input allows
js/app.js               page state, file rows, batch queue, ZIP download
js/pool.js              worker pool (max 2 workers, 1 job each, priority queue)
js/worker.js            worker entry when served over http(s)
js/convert/jobs.js      worker-side dispatcher: prepare, preview, convert, zip
js/convert/image.js     decode, resize, encode, target-size search (OffscreenCanvas)
js/convert/video.js     video and audio: trim, volume, quality, size, frame rate, fades, GIF both ways (Mediabunny + gifenc)
js/convert/data.js      conversion hub for data and documents: tables, JSON/YAML/XML, routing to doc.js
js/convert/doc.js       document model: HTML/Markdown/TXT in, HTML/Markdown/TXT out, page styles
js/convert/docx.js      Word documents: reader and writer (no library)
js/convert/markup.js    text decoding (encodings), forgiving HTML parser and XML parser for workers
js/convert/bmp.js       hand-written 24-bit BMP encoder
js/convert/tiff.js      hand-written TIFF encoder (uncompressed RGB/RGBA)
js/convert/codecs.js    hand-written readers for RAW, PSD, TGA, Netpbm, QOI, ICNS; writers for TGA, QOI, PDF
js/convert/ico.js       ICO writer (PNG inside ICO)
js/convert/zip.js       minimal ZIP writer (stored, no compression) and reader (for DOCX)
js/ui/panel.js          settings panel (any file): image preview pipeline, document view and editing
js/ui/preview.js        before/after canvas: divider, zoom and pan, full-screen view
js/ui/crop.js           crop box over the picture: move, resize from the corners, draw a new one
js/ui/theme.js          light/dark toggle (follows the system by default)
js/ui/motion.js         animation helpers: panel morph, layout glide, fold away (off with reduced motion)
js/ui/colorpicker.js    colour picker pop-up (square + hue slider + hex + recent colours)
js/ui/google-fonts.js   Google Fonts family names for the font search (generated; loaded only when searching)
tests/index.html        in-browser unit and end-to-end tests
tests/fixtures.js       generates test images, GIFs, CSVs and so on
```

**Why classic scripts instead of ES modules:** browsers block ES modules and worker files on `file://`, so double-clicking `index.html` would fail. Every file is a classic script that registers itself on a global `QC` object with `QC.define(name, factory)`.

**Workers:** conversions run off the main thread. The pool picks the worker source in this order:

| Mode | When | What |
|---|---|---|
| `file` | served over http(s) | `new Worker('js/worker.js')`, real files in DevTools |
| `blob` | opened from disk | worker rebuilt from the already-loaded modules via `Function.toString()` |
| `main` | last resort | runs jobs on the page itself |

Because of the `blob` mode, **worker-side modules must be self-contained**: inside a `QC.define(..., { worker: true })` factory, use only the `QC` argument and browser globals, never variables from outside the factory.

**Libraries** are loaded only when needed, from pinned CDN URLs in `js/qc.js`:
- [SheetJS](https://sheetjs.com) 0.20.3 for spreadsheets, from the official SheetJS CDN (the npm `xlsx` package is stuck at 0.18.5, which has known security issues). The mini build (280 KB) covers XLSX, ODS and CSV; the full build (950 KB) loads only for old `.xls` files.
- [marked](https://marked.js.org) 15.0.12 for Markdown
- [js-yaml](https://github.com/nodeca/js-yaml) 4.1.0 for YAML
- [Mediabunny](https://mediabunny.dev) 1.58.1 for video (reads and writes MP4, WebM, MOV, MKV on top of the browser's WebCodecs; 680 KB, loaded when a video is opened)
- [gifenc](https://github.com/mattdesl/gifenc) 1.0.3 for writing GIFs (from video, and still GIFs from images)
- [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.19.8 (WebAssembly, 1.4 MB, LGPL) for HEIC photos, and [UTIF](https://github.com/photopea/UTIF.js) 3.1.0 with [pako](https://github.com/nodeca/pako) for TIFF, loaded only when the browser can't decode the file itself (Safari can)
- Mediabunny's [MP3 encoder](https://www.npmjs.com/package/@mediabunny/mp3-encoder) (LAME, 310 KB) for MP3 output, since no browser can encode MP3, its [FLAC encoder](https://www.npmjs.com/package/@mediabunny/flac-encoder) (320 KB) where the browser has none, and its [AAC encoder](https://www.npmjs.com/package/@mediabunny/aac-encoder) (990 KB), loaded only in browsers without one of their own (Firefox, Zen)

Mediabunny and gifenc ship only as CommonJS bundles, so `QC.loadCjs()` in `js/qc.js` fetches and runs them with a `module` object (the encoder add-ons also get the `Mediabunny` global they expect).

Word documents, HTML and XML are read and written without a library (workers have no `DOMParser`, so `js/convert/markup.js` has a small forgiving parser).

The whole page (HTML, CSS, JS) is about 100 KB, or about 35 KB gzipped as GitHub Pages serves it. Converting images never downloads a library.

## Debugging

- **`?worker=main`** runs conversions on the page, so you can set breakpoints in `js/convert/*.js` directly. `?worker=blob` and `?worker=file` force the other modes.
- **`tests/index.html`** runs the unit tests (CSV edge cases, ZIP structure, BMP/ICO headers, resize maths, target-size search, the HTML and XML parsers, encodings, HTML → Markdown/text, DOCX write/read, XML/YAML/JSON, tables from web pages, round trips through XLSX and ODS). Serve the folder and open http://localhost:8000/tests/.
- **Test files on demand** in the app's console:
  ```js
  var s = document.createElement('script'); s.src = 'tests/fixtures.js'; document.head.appendChild(s);
  QCFixtures.all().then(QCFixtures.drop);   // drops 11 sample files into the app
  ```
- Worker errors without a known cause are logged to the console as `[QuickConvert worker]`.

## Adding a format

1. **`js/formats.js`**: add an entry (`key`, `label`, `kind`, `mime`, `exts`, `mimes`, `outputs`, `def`) and list the new key in the `outputs` of the inputs that can produce it.
2. **Converter:** for images, add the encoder branch in `encode()` in `js/convert/image.js`. For data and documents, everything goes through three shapes in `js/convert/data.js` (table, value, document): add a reader in `read()` that returns one of them and, for an output, a writer branch in `convert()`. A document format only needs a reader to or a writer from the model in `js/convert/doc.js`. If it needs a setting, add it to `defaults()` and `settingsFor()` in `data.js` and a field in the panel template. New file? Write it as `QC.define('name', function (QC) { ... }, { worker: true })`.
3. **New file only:** add it to `importScripts(...)` in `js/worker.js` **and** as a `<script defer>` in `index.html` (before `jobs.js`).
4. Add a test in `tests/index.html`.

## Notes and limits

- Sizes use decimal units: 1 KB = 1000 bytes. A 700 KB target therefore stays under 700 KB whichever convention your OS shows.
- **Target size:** JPG and WebP search quality (about 7 encodes). PNG and BMP are lossless, so the only way to shrink them is to scale them down; the app does that and says so. If a target can't be reached, the app shows the smallest possible size and lets you accept it or change the target.
- The preview estimate comes from a copy downscaled to at most 1200 px, so it's approximate. The "Actual" size next to it comes from a full-resolution encode, and that result is reused when you press Convert.
- "Bicubic / high" uses the browser's `imageSmoothingQuality = "high"`. The exact filter depends on the browser.
- JPG and BMP have no transparency: transparent areas get the background colour you pick (white by default). The option only appears for pictures that actually have transparent areas.
- Spreadsheets with several sheets: pick the sheet, or "All sheets" for outputs that can hold them (XLSX, ODS, JSON, YAML, XML, HTML, Markdown).
- CSV output has a UTF-8 BOM by default, so Excel opens accented and non-Latin text correctly (switch it off for other programs).
- Edited text is converted as UTF-8, whatever the original encoding was.
- Word documents: pictures carry over to HTML (embedded in the page) but not to Markdown or TXT, and Word output doesn't include pictures. Footnotes, headers, footers and comments are left out. Word files are written as plain stored ZIPs, which Microsoft Word opens normally.
- Tables pulled from a web page spread merged cells (colspan/rowspan) so every value stays in its column.
- Animations are short (under 0.3 s) and switch off when the system asks for reduced motion. Nothing waits on an animation: if a tab isn't drawing, timers finish the work.
- Choosing a Google font for HTML output adds a link to Google Fonts in the saved page, so the font downloads from Google when someone opens it. The built-in fonts need no network.
- ZIP files are stored without compression (images are already compressed). Limit: 65,535 files and 4 GB.
- ICO output is a single image of up to 256 × 256, fitted and centred on a transparent square.
- Crop: the box is kept as a share of the picture, so it lands on the same part at full resolution. "Copy settings" leaves each picture's own crop alone. Resize sizes (percent, pixels, target size) apply to the cropped part.
- Camera RAW: the app uses the camera's own full-size JPEG that every RAW file carries (fast, and the colours match the camera), turned the way the camera recorded. It doesn't develop the sensor data itself, so RAW-only adjustments (white balance, exposure recovery) aren't available. A RAW without such a picture inside can't be opened.
- Photoshop: the flattened picture Photoshop stores in every PSD (with "Maximize compatibility", the default) is used; layers aren't read. RGB, grayscale and CMYK, 8, 16 and 32 bits. CMYK becomes RGB with a simple conversion (no colour profile).
- PDF output: one page the size of the picture (96 dpi) holding it as a JPEG, so quality and target size work as for JPG. Formats a browser can't show (TIFF, TGA, QOI, PDF) are previewed as PNG (or the JPEG inside the PDF); the size shown is the real file's.
- SVG has no pixel size of its own: it's drawn at least 2048 px on the longer side (sharp when made smaller). GIF output is a single 256-colour frame; transparent areas get the background colour. TIFF output is uncompressed. Multi-page TIFFs give their first page.
- Video uses the browser's WebCodecs: Chrome and Edge 94+, Firefox 130+, Safari 16.4+. Which codecs work depends on the browser and device: MP4 is written as H.264 (or another codec the browser can encode) with AAC sound, WebM as VP9/VP8 with Opus. If the sound can't be encoded, the video is converted without it and the app says so.
- Firefox and Zen hand over a malformed H.264 header when they encode (browsers ignore it, Windows players refuse the file). `fixAvcC()` in `js/convert/video.js` repairs it before it's written, so their MP4s play everywhere.
- Audio: fades are measured in the trimmed part. MP3 is written at 48, 44.1 or 32 kHz (other sample rates become 44.1 kHz), OGG as Opus. Volume 0 isn't allowed for audio files (it would make a silent file); for video it removes the sound track.
- Video converts only when you press Convert (it can take a while); nothing runs in the background while you change settings. Changing a setting or removing the file stops a running video conversion.
- GIF to video needs the browser's ImageDecoder (Chrome, Edge, Firefox; not Safari). Transparent GIF areas become white. GIF output is limited to 1500 frames.
- Converted videos are held in memory until downloaded, so very long or large videos can run out of memory, especially on phones.
- Needs `OffscreenCanvas` for images: Chrome/Edge 69+, Firefox 105+, Safari 16.4+. WebP output is hidden in browsers that can't encode it (Safari). Data conversions work in older browsers too.
