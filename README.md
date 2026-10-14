# QuickConvert

A small file converter that runs entirely in the browser. Files never leave your device: there is no server, no upload, no analytics.

- **Images:** JPG, PNG, WebP, GIF (first frame), BMP, ICO → JPG, PNG, WebP, BMP, ICO
- **Data:** CSV ↔ JSON ↔ XLSX, TXT → HTML, Markdown → HTML or TXT
- Batch conversion, "Download all" as a ZIP
- Add files by dropping, choosing, or pasting (Ctrl+V)
- Per-image settings: output format, quality (slider or number), file size (auto or a target), background colour for transparent pictures going to JPG/BMP, resize (percent or pixels), resampling
- Live before/after preview: drag the divider, scroll to zoom, drag to move, pinch on touch screens, full-screen view
- Documents: see and edit the original text, with a live view of the result (table, text or rendered HTML); one handle resizes both boxes
- HTML output: page background (text colour adjusts automatically) and font: three built-in fonts, or search all Google Fonts by part of the name
- Rename the output by editing the name at the top of the settings; ending it with another extension (e.g. `.webp`) switches the format
- Ctrl/Shift-click files to choose which ones Convert and "Copy settings" apply to (Ctrl+A selects all, Esc clears)
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
js/convert/data.js      CSV parser/writer, JSON tables, XLSX (SheetJS), Markdown (marked)
js/convert/bmp.js       hand-written 24-bit BMP encoder
js/convert/ico.js       ICO writer (PNG inside ICO)
js/convert/zip.js       minimal ZIP writer (stored, no compression)
js/ui/panel.js          settings panel (any file): image preview pipeline, document view and editing
js/ui/preview.js        before/after canvas: divider, zoom and pan, full-screen view
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
- [SheetJS](https://sheetjs.com) 0.20.3 (mini build) for XLSX, from the official SheetJS CDN (the npm `xlsx` package is stuck at 0.18.5, which has known security issues)
- [marked](https://marked.js.org) 15.0.12 for Markdown

The whole page (HTML, CSS, JS) is about 100 KB, or about 35 KB gzipped as GitHub Pages serves it. Converting images never downloads a library.

## Debugging

- **`?worker=main`** runs conversions on the page, so you can set breakpoints in `js/convert/*.js` directly. `?worker=blob` and `?worker=file` force the other modes.
- **`tests/index.html`** runs the unit tests (CSV edge cases, ZIP structure, BMP/ICO headers, resize maths, target-size search, a CSV → JSON → XLSX → CSV round trip). Serve the folder and open http://localhost:8000/tests/.
- **Test files on demand** in the app's console:
  ```js
  var s = document.createElement('script'); s.src = 'tests/fixtures.js'; document.head.appendChild(s);
  QCFixtures.all().then(QCFixtures.drop);   // drops 11 sample files into the app
  ```
- Worker errors without a known cause are logged to the console as `[QuickConvert worker]`.

## Adding a format

1. **`js/formats.js`**: add an entry (`key`, `label`, `kind`, `mime`, `exts`, `mimes`, `outputs`, `def`) and list the new key in the `outputs` of the inputs that can produce it.
2. **Converter:** for images, add the encoder branch in `encode()` in `js/convert/image.js`; for data, add a `from>to` case in `convert()` in `js/convert/data.js`. New file? Write it as `QC.define('name', function (QC) { ... }, { worker: true })`.
3. **New file only:** add it to `importScripts(...)` in `js/worker.js` **and** as a `<script defer>` in `index.html` (before `jobs.js`).
4. Add a test in `tests/index.html`.

## Notes and limits

- Sizes use decimal units: 1 KB = 1000 bytes. A 700 KB target therefore stays under 700 KB whichever convention your OS shows.
- **Target size:** JPG and WebP search quality (about 7 encodes). PNG and BMP are lossless, so the only way to shrink them is to scale them down; the app does that and says so. If a target can't be reached, the app shows the smallest possible size and lets you accept it or change the target.
- The preview estimate comes from a copy downscaled to at most 1200 px, so it's approximate. The "Actual" size next to it comes from a full-resolution encode, and that result is reused when you press Convert.
- "Bicubic / high" uses the browser's `imageSmoothingQuality = "high"`. The exact filter depends on the browser.
- JPG and BMP have no transparency: transparent areas get the background colour you pick (white by default). The option only appears for pictures that actually have transparent areas.
- XLSX → CSV/JSON converts the first sheet (the app tells you when there are more).
- CSV output has a UTF-8 BOM, so Excel opens accented and non-Latin text correctly.
- Animations are short (under 0.3 s) and switch off when the system asks for reduced motion. Nothing waits on an animation: if a tab isn't drawing, timers finish the work.
- Choosing a Google font for HTML output adds a link to Google Fonts in the saved page, so the font downloads from Google when someone opens it. The built-in fonts need no network.
- ZIP files are stored without compression (images are already compressed). Limit: 65,535 files and 4 GB.
- ICO output is a single image of up to 256 × 256, fitted and centred on a transparent square.
- Needs `OffscreenCanvas` for images: Chrome/Edge 69+, Firefox 105+, Safari 16.4+. WebP output is hidden in browsers that can't encode it (Safari). Data conversions work in older browsers too.
