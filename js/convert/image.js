/*
 * Image pipeline: decode -> crop and resize (OffscreenCanvas) -> encode.
 * Runs in the worker. Also used on the page for computeSize() (dimension preview).
 * TIFF and HEIC decode with UTIF and libheif where the browser can't (loaded only then).
 */
QC.define('image', function (QC) {
  'use strict';

  var MAX_SIDE = 16384;
  var PREVIEW_MAX = 1200;
  var LOSSY = { jpg: true, webp: true, pdf: true };      // PDF holds a JPEG
  var NO_ALPHA = { jpg: true, bmp: true, gif: true, pdf: true };
  // The preview shows formats a browser can't display as a picture it can (same pixels for the
  // lossless ones, the JPEG for PDF); sizes still come from the real format.
  var SHOWN_AS = { tiff: 'png', tga: 'png', qoi: 'png', pdf: 'jpg' };

  function supported() { return typeof OffscreenCanvas !== 'undefined'; }

  /* ---------- settings ---------- */

  function defaults() {
    return {
      quality: 85,
      targetOn: false, targetValue: '', targetUnit: 'KB',
      resizeMode: 'none', percent: 100,
      width: '', height: '', lockAspect: true, lockDriver: 'w',
      resample: 'high',
      background: '#ffffff', // fills transparent areas in JPG/BMP/GIF (image content, not a UI colour)
      crop: null,            // { x, y, w, h } as fractions of the picture, or null for all of it
      cropRatio: 'none'      // the shape picked in the panel: none | free | orig | 1:1 | 4:3 ...
    };
  }

  // The part of a w x h picture that's kept, in pixels.
  function cropRect(w, h, s) {
    var c = s.crop;
    if (!c) return { x: 0, y: 0, width: w, height: h };
    var x = Math.min(w - 1, Math.round(c.x * w)), y = Math.min(h - 1, Math.round(c.y * h));
    return { x: x, y: y, width: Math.max(1, Math.min(w - x, Math.round(c.w * w))), height: Math.max(1, Math.min(h - y, Math.round(c.h * h))) };
  }

  // Target size in bytes, or 0 when off. 1 KB = 1000 bytes (stricter than 1024, so
  // "under 700 KB" holds whichever convention the user's OS shows).
  function targetBytes(s) {
    var v = parseFloat(s.targetValue);
    if (!s.targetOn || !(v > 0)) return 0;
    return Math.floor(v * (s.targetUnit === 'MB' ? 1e6 : 1e3));
  }

  // Output dimensions for a source of w x h: cropped, then resized. Shared by the page and the worker.
  function computeSize(w, h, s) {
    var c = cropRect(w, h, s);
    w = c.width;
    h = c.height;
    var ow = w, oh = h;
    if (s.resizeMode === 'percent') {
      var p = parseFloat(s.percent) > 0 ? parseFloat(s.percent) : 100;
      ow = w * p / 100;
      oh = h * p / 100;
    } else if (s.resizeMode === 'pixels') {
      var W = parseInt(s.width, 10), H = parseInt(s.height, 10);
      if (s.lockAspect) {
        if (s.lockDriver === 'h' && H > 0) { oh = H; ow = H * w / h; }
        else if (W > 0) { ow = W; oh = W * h / w; }
        else if (H > 0) { oh = H; ow = H * w / h; }
      } else {
        if (W > 0) ow = W;
        if (H > 0) oh = H;
      }
    }
    return { width: Math.max(1, Math.round(ow)), height: Math.max(1, Math.round(oh)) };
  }

  function checkSize(size) {
    if (size.width > MAX_SIDE || size.height > MAX_SIDE) {
      throw QC.error('toolarge', 'Too large: max ' + MAX_SIDE + ' px per side.');
    }
  }

  // ICO holds one square image up to 256 px; the picture is fitted and centred.
  function icoSize(size) {
    var side = Math.min(QC.ico.MAX_SIDE, Math.max(size.width, size.height));
    return { width: side, height: side };
  }

  /* ---------- decode / draw / encode ---------- */

  // The browser decodes most formats; TIFF and HEIC (iPhone photos) fall back to libraries.
  async function decode(source, type) {
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return source;
    try {
      return await createImageBitmap(source);
    } catch (e) {
      try {
        if (type === 'tiff' || type === 'heic') return await createImageBitmap(type === 'tiff' ? await tiffPixels(source) : await heicPixels(source));
        if (QC.codecs.canRead(type)) return await QC.codecs.read(type, source);
      } catch (err) { if (err.code) throw err; }
      if (type === 'jxl') throw QC.error('unsupported', 'This browser can\'t open JPEG XL (Safari can).');
      throw QC.error('decode', 'Could not read this image.');
    }
  }

  // First page of a TIFF (any compression UTIF knows: none, LZW, Deflate, PackBits, JPEG).
  async function tiffPixels(file) {
    await QC.loadScript(QC.libs.pako);                 // UTIF inflates Deflate pages with it
    await QC.loadScript(QC.libs.utif);
    var buf = await file.arrayBuffer(), ifd = self.UTIF.decode(buf)[0];
    self.UTIF.decodeImage(buf, ifd);
    return new ImageData(new Uint8ClampedArray(self.UTIF.toRGBA8(ifd).buffer), ifd.width, ifd.height);
  }

  async function heicPixels(file) {
    await QC.loadScript(QC.libs.heif);
    var lib = self.libheif;
    if (typeof lib === 'function') lib = await lib();  // the WebAssembly build may need starting first
    var images = new lib.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    if (!images.length) throw QC.error('decode', 'Could not read this HEIC photo.');
    var img = images[0], w = img.get_width(), h = img.get_height();
    return new Promise(function (resolve, reject) {
      img.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, function (d) {
        if (d) resolve(new ImageData(d.data, w, h)); else reject(QC.error('decode', 'Could not read this HEIC photo.'));
      });
    });
  }

  function smoothing(ctx, resample) {
    if (resample === 'nearest') {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = resample === 'bilinear' ? 'low' : 'high';
    }
  }

  // Draw `bitmap` into a new canvas of `size`, using the chosen resampling. Formats without
  // transparency get the background colour behind the picture.
  function draw(bitmap, size, fmt, s) {
    var box = fmt === 'ico' ? icoSize(size) : size;
    var canvas = new OffscreenCanvas(box.width, box.height);
    var ctx = canvas.getContext('2d');
    if (!ctx) throw QC.error('encode', 'Canvas is not available.');
    if (NO_ALPHA[fmt]) {
      ctx.fillStyle = s.background || '#ffffff';
      ctx.fillRect(0, 0, box.width, box.height);
    }
    smoothing(ctx, s.resample);
    var c = cropRect(bitmap.width, bitmap.height, s);
    if (fmt === 'ico') {
      var k = box.width / Math.max(size.width, size.height);
      var dw = Math.max(1, Math.round(size.width * k)), dh = Math.max(1, Math.round(size.height * k));
      ctx.drawImage(bitmap, c.x, c.y, c.width, c.height, Math.floor((box.width - dw) / 2), Math.floor((box.height - dh) / 2), dw, dh);
    } else {
      ctx.drawImage(bitmap, c.x, c.y, c.width, c.height, 0, 0, box.width, box.height);
    }
    return canvas;
  }

  async function encode(canvas, fmt, quality) {
    if (fmt === 'bmp' || fmt === 'tiff' || fmt === 'tga' || fmt === 'qoi') {
      var pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      var bytes = fmt === 'bmp' || fmt === 'tiff' ? QC[fmt].encode(pixels) : QC.codecs[fmt](pixels);
      return new Blob([bytes], { type: QC.formats.get(fmt).mime });
    }
    if (fmt === 'pdf') {
      var jpeg = await toBlob(canvas, 'image/jpeg', quality / 100);
      return new Blob([QC.codecs.pdf(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height)], { type: 'application/pdf' });
    }
    if (fmt === 'gif') {                               // one frame, 256 colours picked for the picture
      var G = await QC.loadCjs(QC.libs.gifenc), w = canvas.width, h = canvas.height;
      var px = canvas.getContext('2d').getImageData(0, 0, w, h).data, palette = G.quantize(px, 256), gif = G.GIFEncoder();
      gif.writeFrame(G.applyPalette(px, palette), w, h, { palette: palette });
      gif.finish();
      return new Blob([gif.bytes()], { type: 'image/gif' });
    }
    if (fmt === 'ico') {
      var png = await toBlob(canvas, 'image/png');
      var wrapped = QC.ico.wrapPng(new Uint8Array(await png.arrayBuffer()), canvas.width, canvas.height);
      return new Blob([wrapped], { type: 'image/x-icon' });
    }
    return toBlob(canvas, QC.formats.get(fmt).mime, LOSSY[fmt] ? quality / 100 : undefined);
  }

  async function toBlob(canvas, mime, quality) {
    var opts = { type: mime };
    if (quality !== undefined) opts.quality = quality;
    var blob;
    try {
      blob = await canvas.convertToBlob(opts);
    } catch (e) {
      throw QC.error('encode', 'Encoding failed (image may be too large for this browser).');
    }
    // Browsers silently fall back to PNG for types they can't encode (e.g. WebP in Safari).
    if (blob.type !== mime) throw QC.error('encode', 'This browser can\'t create ' + mime.split('/')[1].toUpperCase() + ' files.');
    return blob;
  }

  /* ---------- target-size search ---------- */

  // Largest integer v in [lo, hi] where test(v).fits, assuming size grows with v.
  // Binary search: about log2(hi - lo) passes (7 for 1..100), plus one if a first guess is given.
  async function searchMax(lo, hi, test, guess) {
    var best = null, smallest = null;
    var v = guess ? Math.min(hi, Math.max(lo, guess)) : (lo + hi) >> 1;
    while (lo <= hi) {
      var r = await test(v);
      if (!smallest || r.blob.size < smallest.blob.size) smallest = r;
      if (r.fits) { best = r; lo = v + 1; } else { hi = v - 1; }
      v = (lo + hi) >> 1;
    }
    return { best: best, smallest: smallest };
  }

  /*
   * Full-resolution conversion with all settings applied.
   * Returns { blob, width, height, quality?, scale?, unreachable?, mode }.
   */
  async function render(bitmap, fmt, s, progress) {
    var report = progress || function () {};
    var size = computeSize(bitmap.width, bitmap.height, s);
    checkSize(size);
    var target = fmt === 'ico' ? 0 : targetBytes(s);
    var canvas, blob;

    if (!target) {
      canvas = draw(bitmap, size, fmt, s);
      report(0.6);
      blob = await encode(canvas, fmt, s.quality);
      return { blob: blob, width: canvas.width, height: canvas.height, quality: LOSSY[fmt] ? s.quality : undefined };
    }

    var passes = 0;
    if (LOSSY[fmt]) {
      // Lossy: search the highest quality that fits.
      canvas = draw(bitmap, size, fmt, s);
      var q = await searchMax(1, 100, async function (quality) {
        var b = await encode(canvas, fmt, quality);
        report(0.2 + 0.8 * Math.min(1, ++passes / 8));
        return { blob: b, fits: b.size <= target, quality: quality };
      });
      var pickQ = q.best || q.smallest;
      return { blob: pickQ.blob, width: size.width, height: size.height, quality: pickQ.quality,
        unreachable: !q.best, mode: 'quality' };
    }

    // Lossless (PNG, BMP): quality does nothing, so the only lever is dimensions.
    canvas = draw(bitmap, size, fmt, s);
    blob = await encode(canvas, fmt);
    report(0.25);
    if (blob.size <= target) return { blob: blob, width: size.width, height: size.height, scale: 100, mode: 'scale' };

    var guess = Math.floor(Math.sqrt(target / blob.size) * 100);
    var r = await searchMax(1, 99, async function (pct) {
      var scaled = { width: Math.max(1, Math.round(size.width * pct / 100)), height: Math.max(1, Math.round(size.height * pct / 100)) };
      var b = await encode(draw(bitmap, scaled, fmt, s), fmt);
      report(0.25 + 0.75 * Math.min(1, ++passes / 8));
      return { blob: b, fits: b.size <= target, scale: pct, width: scaled.width, height: scaled.height };
    }, guess);
    var pick = r.best || r.smallest;
    return { blob: pick.blob, width: pick.width, height: pick.height, scale: pick.scale,
      unreachable: !r.best, mode: 'scale' };
  }

  /* ---------- tasks ---------- */

  async function convert(source, opts, progress) {
    if (!supported()) throw QC.error('unsupported', 'Image conversion needs a newer browser (OffscreenCanvas).');
    var bitmap = await decode(source, opts.from);
    try {
      progress(0.1);
      return await render(bitmap, opts.to, opts.settings, progress);
    } finally {
      bitmap.close();
    }
  }

  // Any pixel that isn't fully opaque?
  function anyTransparent(ctx, w, h) {
    var d = ctx.getImageData(0, 0, w, h).data;
    for (var i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
    return false;
  }

  // Decode once and return a copy no larger than PREVIEW_MAX, the original size, and whether
  // the picture has transparency (checked on the copy, which is plenty to tell).
  async function prepare(source, type) {
    if (!supported()) throw QC.error('unsupported', 'Image conversion needs a newer browser (OffscreenCanvas).');
    var bitmap = await decode(source, type);
    var w = bitmap.width, h = bitmap.height;
    var k = Math.min(1, PREVIEW_MAX / Math.max(w, h));
    var canvas = new OffscreenCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
    var ctx = canvas.getContext('2d');
    smoothing(ctx, 'high');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    var alpha = anyTransparent(ctx, canvas.width, canvas.height);
    if (k === 1) return { bitmap: bitmap, width: w, height: h, hasAlpha: alpha };
    bitmap.close();
    return { bitmap: canvas.transferToImageBitmap(), width: w, height: h, hasAlpha: alpha };
  }

  /*
   * Fast preview from the downscaled copy.
   * opts: { bitmap, srcWidth, srcHeight, to, settings, override?: { width, height, quality } }
   * The estimate scales the preview's encoded size by the pixel ratio to the real output.
   */
  async function preview(opts) {
    var s = opts.settings, fmt = opts.to, bitmap = opts.bitmap;
    try {
      var out = opts.override && opts.override.width
        ? { width: opts.override.width, height: opts.override.height }
        : computeSize(opts.srcWidth, opts.srcHeight, s);
      checkSize(out);
      var real = fmt === 'ico' ? icoSize(out) : out;
      var k = Math.min(1, PREVIEW_MAX / Math.max(out.width, out.height));
      var size = { width: Math.max(1, Math.round(out.width * k)), height: Math.max(1, Math.round(out.height * k)) };
      var canvas = draw(bitmap, size, fmt, s);
      var ratio = (real.width * real.height) / (canvas.width * canvas.height);
      var target = fmt === 'ico' ? 0 : targetBytes(s);
      var quality = s.quality;
      if (opts.override && opts.override.quality) {
        quality = opts.override.quality;
      } else if (target && LOSSY[fmt]) {
        // Rough guess on the small copy; the exact search runs on the full image.
        var q = await searchMax(1, 100, async function (qq) {
          var b = await encode(canvas, fmt, qq);
          return { blob: b, fits: b.size * ratio <= target, quality: qq };
        });
        quality = (q.best || q.smallest).quality;
      }
      var blob = await encode(canvas, fmt, quality);
      var estimate = fmt === 'bmp' ? QC.bmp.fileSize(real.width, real.height) : Math.round(blob.size * ratio);  // TIFF: close enough
      var shown = SHOWN_AS[fmt] ? await encode(canvas, SHOWN_AS[fmt], quality) : blob;
      return {
        blob: shown, width: canvas.width, height: canvas.height,
        outWidth: real.width, outHeight: real.height,
        estimate: estimate, quality: LOSSY[fmt] ? quality : undefined
      };
    } finally {
      bitmap.close();
    }
  }

  return {
    supported: supported, defaults: defaults, targetBytes: targetBytes, computeSize: computeSize, cropRect: cropRect,
    convert: convert, prepare: prepare, preview: preview, LOSSY: LOSSY, NO_ALPHA: NO_ALPHA, MAX_SIDE: MAX_SIDE
  };
}, { worker: true });
