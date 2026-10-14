# QuickConvert: Phase 1 Task List

Build a static, client-side file converter. Files never leave the user's device. Hosted on GitHub Pages.

## 1. Decisions (already made, don't revisit)

| Topic | Decision |
|---|---|
| Stack | Vanilla HTML, CSS, ES modules. No framework, no build step. Must open from `index.html` and run on GitHub Pages. |
| Conversion | In the browser only. Heavy work runs in a Web Worker. |
| Phase 1 formats | Images: JPG, PNG, WebP, GIF (first frame), BMP, ICO. Data: CSV, JSON, XLSX, TXT, Markdown → HTML. |
| Not in Phase 1 | Audio, video, PDF, Office docs, HEIC, accounts, backend, analytics. |
| Design | Minimal, cobalt.tools-like. Black and white with soft tones. Never use pure `#000` or `#fff`. No mascot yet. |
| Themes | Light and dark, follows system by default, with a manual toggle. |
| Batch | Multiple files at once. "Download all" as ZIP. |

## 2. Required features

### 2.1 Input
- Drop zone: drag and drop, or click to pick. Accepts multiple files.
- Detect type from extension and MIME. Show only the output formats that make sense for that type.
- Show name, size, and detected type per file.
- Remove a file from the list before converting.
- Warn (don't block) on files over 100 MB, since RAM may limit them.

### 2.2 Per-file row
- Target format dropdown.
- Gear icon opens the **Advanced panel**.
- Status: queued, converting (progress bar), done (new size + download), failed (short reason).

### 2.3 Advanced panel (images only)
Settings are per file. A "Apply to all" button copies them to the batch.

1. **Quality** (JPG, WebP): slider 1–100.
2. **Target size**: optional input in KB or MB. When set, the app searches for the highest quality that gets under the target.
   - Applies to the **output** format. Input format doesn't matter. Example: PNG → JPG with target 700 KB means the JPG encoder searches quality until the file is under 700 KB.
   - JPG/WebP output: binary search on quality (about 6–8 encode passes max). Keep the highest quality that fits.
   - If the target can't be reached even at quality 1, show a note with the smallest achievable size and let the user accept it or lower the target. Don't silently fail.
   - PNG output (lossless): quality has no effect. Target size is only reachable by reducing dimensions. Show a note that this is the only way to shrink PNG here.
   - Quality slider is disabled while target size is on. Show the resulting quality as read-only text (e.g. "Quality found: 72").
3. **Resize**:
   - Modes: percent (e.g. 50%) or pixels (width and height).
   - "Keep aspect ratio" lock on by default.
   - Show original dimensions next to the fields.
4. **Resampling** (used when enlarging, and when shrinking):
   - `Nearest`: pixelated, for pixel art. Set `imageSmoothingEnabled = false`.
   - `Bilinear`: smooth. Use `imageSmoothingQuality = "low"`.
   - `Bicubic / high`: smoothest. Use `imageSmoothingQuality = "high"`.
   - Do not call the high option "trilinear". Trilinear needs mipmaps and does not apply to enlarging. Label it honestly in the UI.
5. **Live preview** (required):
   - Side-by-side view: original on the left, result on the right, with a draggable divider.
   - Under the result: estimated output size, actual output size after encoding, and percent change.
   - Re-run when a setting changes, debounced about 400 ms.
   - Preview is generated from a downscaled copy (max 1200 px on the long side) so it stays fast. Final conversion uses full resolution.
   - Hovering the preview zooms in to show pixels (needed to judge nearest vs bilinear).

### 2.4 Output
- Single file: download button.
- Several files: "Download all (ZIP)". Build the ZIP in the worker with JSZip or a similar small library, or write a minimal zip writer.
- File naming: `originalname.newext`. If the name clashes in a ZIP, add `(2)`, `(3)`.

### 2.5 Privacy
- Header badge: "Files stay on your device."
- No network calls for file data. The only network traffic is loading the page and its libraries.

## 3. Technical notes

### 3.1 File layout
```
index.html
css/style.css
js/app.js            UI wiring, state
js/worker.js         runs conversions off the main thread
js/convert/image.js  canvas decode/encode, resize, resample, target-size search
js/convert/data.js   CSV/JSON/XLSX/TXT/Markdown conversions
js/convert/bmp.js    hand-written BMP encoder
js/convert/ico.js    ICO writer (PNG-in-ICO)
js/ui/preview.js     side-by-side slider and zoom
js/ui/theme.js       light/dark toggle
README.md            how to run locally and deploy to GitHub Pages
```

### 3.2 Libraries (load from cdnjs or jsDelivr with pinned versions)
- **SheetJS (xlsx)**: XLSX read and write.
- **JSZip**: ZIP output.
- **marked**: Markdown → HTML (optional, only if it stays small).
- Pick exact versions released at least two weeks before today. Do not use `latest`.

### 3.3 Image pipeline
1. Decode: `createImageBitmap(file)` (handles JPG, PNG, WebP, GIF first frame, BMP). Fall back to `<img>` if needed.
2. Resize: draw onto an `OffscreenCanvas` at the target size using the chosen smoothing setting.
3. Encode: `canvas.convertToBlob({ type, quality })`.
   - PNG output is lossless. Ignore quality for PNG.
   - WebP and JPG use quality.
4. ICO: encode PNG at 256×256 (or the source size if smaller) and wrap it in an ICO header.
5. BMP: write the header and raw pixels by hand (24-bit, bottom-up rows).

### 3.4 Worker messages
- Main → worker: `{ id, file, options }`.
- Worker → main: `{ id, type: "progress" | "done" | "error", ... }`.
- Transfer `ArrayBuffer`s, don't copy them.
- One job at a time per worker. Use a small queue. Two workers at most.

### 3.5 Memory
- Revoke every object URL when the file is removed or the page unloads.
- Close `ImageBitmap` objects after use.
- Clear preview data when a new preview replaces it.

### 3.6 Error handling
- Unsupported format, decode failure, or encode failure: mark that file as failed with a short message. Don't stop the other files.
- Browser without `OffscreenCanvas`: show a clear message.

## 4. Design spec

- Centered single column, max width about 640 px, large spacing, no clutter.
- Big rounded drop zone in the middle. Text: "Drop files here or click to choose."
- Colors through CSS variables only:

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#f2f2ef` | `#1b1b1d` |
| `--surface` | `#e8e8e4` | `#242427` |
| `--text` | `#1e1e20` | `#e6e6e3` |
| `--muted` | `#7a7a78` | `#8c8c90` |
| `--accent` | `#3a3a3c` | `#d0d0cc` |
| `--border` | `#d4d4cf` | `#38383c` |

- Font: system UI stack or a single Google Font (Inter). Keep weights to 400 and 600.
- Buttons: flat, rounded (12 px), no gradients or shadows.
- Simple SVG icons, one color (`currentColor`).
- Must work at 375 px width with no horizontal scroll.
- Respect `prefers-reduced-motion`.

## 5. Acceptance checklist

- [ ] Opens and works from a local `index.html` (double-click) with no server.
- [ ] Drops and converts 10 images at once. UI stays responsive.
- [ ] 10 MB PNG → JPG with target 700 KB ends under 700 KB, with quality chosen automatically. Preview shows the estimate before download.
- [ ] Unreachable target (e.g. 1 KB for a large photo) shows a note with the smallest achievable size, not a silent failure.
- [ ] Resize by 50% and by exact pixels, aspect lock on and off.
- [ ] Upscale 4× on a small image: nearest looks pixelated, bilinear looks smooth, high looks smoothest.
- [ ] GIF → PNG gives the first frame. BMP and ICO outputs open in an image viewer.
- [ ] CSV ↔ JSON ↔ XLSX conversions round-trip without losing rows.
- [ ] ZIP download contains all finished files with unique names.
- [ ] Failed file shows an error and doesn't block others.
- [ ] Light and dark themes both pass contrast (text ≥ 4.5:1). No pure `#000` or `#fff` anywhere.
- [ ] Mobile width 375 px works.
- [ ] Network tab shows no uploads of file data.
- [ ] README explains local run and GitHub Pages deploy.

## 6. Out of scope (do not build)

- Audio, video, PDF, Office documents, HEIC.
- Mascot, logo, branding beyond the name "QuickConvert".
- Accounts, backend, analytics, ads.
- Cloud storage or sharing.
- Any git commit or push. Ask the user first.

## 7. Work order

1. Scaffold: `index.html`, CSS variables, theme toggle, layout.
2. Drop zone, file list, type detection, per-file state.
3. Worker plus image pipeline: decode, resize, encode for JPG, PNG, WebP.
4. Advanced panel: quality, resize, resampling.
5. Target-size search.
6. Live preview: side-by-side slider, zoom, estimate.
7. ICO, BMP, GIF first frame.
8. Data conversions: CSV, JSON, TXT, XLSX, Markdown.
9. Batch queue, ZIP download, error states.
10. Polish, mobile check, acceptance checklist, README.

When unsure, choose the simplest option that meets the checklist, and list your choices in the final summary.
