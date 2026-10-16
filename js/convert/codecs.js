/*
 * Image formats browsers can't open, read and written by hand:
 *   read(type, file) -> ImageBitmap   camera RAW (the camera's own JPEG inside), PSD/PSB (the flattened
 *                                     image Photoshop stores), TGA, Netpbm (PPM/PGM/PBM/PAM), QOI, ICNS
 *   tga(pixels), qoi(pixels) -> bytes, pdf(jpegBytes, w, h) -> bytes   (pixels: ImageData)
 */
QC.define('codecs', function (QC) {
  'use strict';

  function fail(message) { return QC.error('decode', message || 'Could not read this image.'); }

  function pixels(w, h) {
    if (!(w > 0 && h > 0) || w * h > 268e6) throw fail('This image is too large or damaged.');
    return new ImageData(w, h);
  }

  /* ---------- camera RAW: the largest ordinary JPEG inside, turned the way the camera says ---------- */

  // End of a JPEG starting at `s`, or -1. Only baseline/progressive JPEGs count: RAW sensor data is often
  // stored as lossless JPEG, which browsers can't show.
  function jpegEnd(b, s) {
    var p = s + 2, frame = false;
    while (p + 2 <= b.length) {
      if (b[p] !== 0xff) return -1;
      var m = b[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd9) return frame ? p + 2 : -1;
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
      if (p + 4 > b.length) return -1;
      if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return -1;   // lossless, hierarchical, arithmetic
      if (m >= 0xc0 && m <= 0xc2) frame = true;
      var len = b[p + 2] << 8 | b[p + 3];
      if (len < 2) return -1;
      p += 2 + len;
      if (m === 0xda) {                                  // compressed data runs to the next marker
        while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] !== 0 && (b[p + 1] < 0xd0 || b[p + 1] > 0xd7))) p++;
      }
    }
    return -1;
  }

  // Orientation tag (1, 3, 6, 8...) of a TIFF structure at `o` (RAW files are mostly TIFF inside).
  function tiffOrientation(b, o) {
    var le = b[o] === 0x49 && b[o + 1] === 0x49;
    if (!le && !(b[o] === 0x4d && b[o + 1] === 0x4d)) return 0;
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var ifd = o + dv.getUint32(o + 4, le);
    if (ifd + 2 > b.length) return 0;
    for (var i = 0, n = dv.getUint16(ifd, le); i < n && ifd + 14 + i * 12 <= b.length; i++) {
      var e = ifd + 2 + i * 12;
      if (dv.getUint16(e, le) === 0x112) return dv.getUint16(e + 8, le);
    }
    return 0;
  }

  // The JPEG's own Exif orientation, if it has one (the browser applies that by itself).
  function exifOrientation(b, s) {
    for (var p = s + 2; p + 10 < b.length && b[p] === 0xff && b[p + 1] >= 0xe0 && b[p + 1] <= 0xef;) {
      var len = b[p + 2] << 8 | b[p + 3];
      if (b[p + 1] === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) return tiffOrientation(b, p + 10);
      p += 2 + len;
    }
    return 0;
  }

  function turned(bitmap, o) {
    if (o !== 3 && o !== 6 && o !== 8) return bitmap;
    var side = o !== 3, w = side ? bitmap.height : bitmap.width, h = side ? bitmap.width : bitmap.height;
    var c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    x.translate(w / 2, h / 2);
    x.rotate(o === 3 ? Math.PI : o === 6 ? Math.PI / 2 : -Math.PI / 2);
    x.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close();
    return c.transferToImageBitmap();
  }

  async function raw(b) {
    var found = [];
    for (var i = 0; i + 3 < b.length; i++) {
      if (b[i] !== 0xff || b[i + 1] !== 0xd8 || b[i + 2] !== 0xff) continue;
      var end = jpegEnd(b, i);
      if (end > 0) { found.push({ start: i, end: end }); i = end - 1; }   // skip what's inside (thumbnails)
    }
    found.sort(function (a, z) { return (z.end - z.start) - (a.end - a.start); });
    for (var k = 0; k < found.length; k++) {
      try {
        var f = found[k], bitmap = await createImageBitmap(new Blob([b.subarray(f.start, f.end)], { type: 'image/jpeg' }));
        return exifOrientation(b, f.start) ? bitmap : turned(bitmap, tiffOrientation(b, 0));
      } catch (e) { /* damaged: try the next one */ }
    }
    throw QC.error('unsupported', 'This RAW file has no preview picture inside that a browser can show.');
  }

  /* ---------- PSD / PSB: the flattened image at the end of the file ---------- */

  // PackBits rows (Photoshop's RLE) into `out` until `n` bytes are written; returns the new read position.
  function unpackBits(b, p, out, n) {
    for (var o = 0; o < n && p < b.length;) {
      var c = b[p++];
      if (c > 128) { var v = b[p++]; for (c = 257 - c; c-- && o < n;) out[o++] = v; }
      else if (c < 128) { for (c++; c-- && o < n;) out[o++] = b[p++]; }
    }
    return p;
  }

  function psd(b) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint32(0) !== 0x38425053) throw fail('Not a Photoshop file.');
    var big = dv.getUint16(4) === 2, channels = dv.getUint16(12), h = dv.getUint32(14), w = dv.getUint32(18);
    var depth = dv.getUint16(22), mode = dv.getUint16(24), size = depth >> 3;
    if (mode !== 1 && mode !== 3 && mode !== 4) throw QC.error('unsupported', 'Only RGB, grayscale and CMYK Photoshop files can be read.');
    if (depth !== 8 && depth !== 16 && depth !== 32) throw QC.error('unsupported', 'This Photoshop bit depth can\'t be read.');
    var p = 26;
    p += 4 + dv.getUint32(p);                           // colour mode data
    p += 4 + dv.getUint32(p);                           // image resources
    p += big ? 8 + dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4) : 4 + dv.getUint32(p);   // layers (not needed)
    var rle = dv.getUint16(p) === 1, rowBytes = w * size, starts = [];
    p += 2;
    if (rle) {                                          // a table of each row's packed size, then the rows
      var table = p, step = big ? 4 : 2, at = table + channels * h * step;
      for (var c = 0; c < channels; c++) {
        starts.push(at);
        for (var y = 0; y < h; y++) at += big ? dv.getUint32(table + (c * h + y) * 4) : dv.getUint16(table + (c * h + y) * 2);
      }
    } else {
      for (var c2 = 0; c2 < channels; c2++) starts.push(p + c2 * h * rowBytes);
    }
    var img = pixels(w, h), out = img.data, row = new Uint8Array(rowBytes), rowView = new DataView(row.buffer);
    // Channel `c` into byte `slot` of every pixel.
    function channel(c, slot) {
      var q = starts[c];
      for (var y = 0; y < h; y++) {
        if (rle) q = unpackBits(b, q, row, rowBytes); else { row.set(b.subarray(q, q + rowBytes)); q += rowBytes; }
        for (var x = 0, o = y * w * 4 + slot; x < w; x++, o += 4) {
          out[o] = size === 1 ? row[x] : size === 2 ? row[x * 2] : Math.round(Math.min(1, Math.max(0, rowView.getFloat32(x * 4))) * 255);
        }
      }
    }
    var color = mode === 3 ? 3 : mode === 4 ? 4 : 1, alpha = channels > color;
    for (var k = 0; k < Math.min(color, channels); k++) channel(k, k);
    for (var i = 0; i < out.length; i += 4) {
      if (mode === 1) out[i + 1] = out[i + 2] = out[i];
      else if (mode === 4) {                            // stored as "white = 255": ink is the inverse
        var key = out[i + 3];
        out[i] = out[i] * key / 255; out[i + 1] = out[i + 1] * key / 255; out[i + 2] = out[i + 2] * key / 255;
      }
      out[i + 3] = 255;
    }
    if (alpha) channel(color, 3);                       // the next channel is the transparency
    return img;
  }

  /* ---------- TGA ---------- */

  function tga(b) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var type = b[2], kind = type & 7, w = dv.getUint16(12, true), h = dv.getUint16(14, true), bpp = b[16], desc = b[17];
    if ([1, 2, 3].indexOf(kind) < 0 || type & 0xf0) throw fail('Not a TGA image.');
    var bytes = (bpp + 7) >> 3, p = 18 + b[0], cmap = null;
    if (b[1] === 1) {                                   // colour map
      var first = dv.getUint16(3, true), count = dv.getUint16(5, true), cb = (b[7] + 7) >> 3;
      cmap = [];
      for (var c = 0; c < count; c++, p += cb) cmap[first + c] = color(p, cb);
    }
    function color(q, n) {
      if (n === 2) { var v = b[q] | b[q + 1] << 8; return [(v >> 10 & 31) * 255 / 31, (v >> 5 & 31) * 255 / 31, (v & 31) * 255 / 31, 255]; }
      return [b[q + 2], b[q + 1], b[q], n === 4 ? b[q + 3] : 255];
    }
    var img = pixels(w, h), out = img.data, n = w * h, k = 0, sawAlpha = false;
    function put(q) {
      var x = k % w, y = (k / w) | 0;
      if (!(desc & 0x20)) y = h - 1 - y;                // rows usually start at the bottom
      if (desc & 0x10) x = w - 1 - x;
      var o = (y * w + x) * 4, px = kind === 1 ? cmap[bytes === 2 ? b[q] | b[q + 1] << 8 : b[q]] || [0, 0, 0, 255]
        : kind === 3 ? [b[q], b[q], b[q], bytes === 2 ? b[q + 1] : 255] : color(q, bytes);
      out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = px[3];
      if (px[3]) sawAlpha = true;
      k++;
    }
    if (type & 8) {                                     // run-length packets
      while (k < n && p < b.length) {
        var head = b[p++], run = (head & 127) + 1;
        if (head & 128) { for (var r = 0; r < run && k < n; r++) put(p); p += bytes; }
        else for (var l = 0; l < run && k < n; l++, p += bytes) put(p);
      }
    } else {
      for (; k < n && p + bytes <= b.length; p += bytes) put(p);
    }
    if (!sawAlpha) for (var a = 3; a < out.length; a += 4) out[a] = 255;   // writers that leave alpha at 0
    return img;
  }

  /* ---------- Netpbm: PBM, PGM, PPM (text or binary) and PAM ---------- */

  function pnm(b) {
    var p = 0;
    function skip() {
      while (p < b.length) {
        if (b[p] === 35) while (p < b.length && b[p] !== 10) p++;   // # comment
        else if (b[p] <= 32) p++;
        else break;
      }
    }
    function token() {
      skip();
      var s = p;
      while (p < b.length && b[p] > 32) p++;
      return String.fromCharCode.apply(null, b.subarray(s, p));
    }
    var magic = token(), kind = +magic[1], w, h, max = 1, depth = 1;
    if (magic[0] !== 'P' || !(kind >= 1 && kind <= 7)) throw fail('Not a Netpbm image.');
    if (kind === 7) {
      for (var t = token(); t && t !== 'ENDHDR'; t = token()) {
        if (t === 'WIDTH') w = +token(); else if (t === 'HEIGHT') h = +token();
        else if (t === 'DEPTH') depth = +token(); else if (t === 'MAXVAL') max = +token(); else if (t === 'TUPLTYPE') token();
      }
    } else {
      w = +token(); h = +token();
      if (kind !== 1 && kind !== 4) max = +token();
      depth = kind === 3 || kind === 6 ? 3 : 1;
    }
    p++;                                                // the single space before binary data
    var img = pixels(w, h), out = img.data, wide = max > 255, scale = 255 / max;
    function sample() {
      if (kind <= 3) return +token();
      var v = wide ? b[p] << 8 | b[p + 1] : b[p];
      p += wide ? 2 : 1;
      return v;
    }
    for (var i = 0, o = 0; i < w * h; i++, o += 4) {
      var v;
      if (kind === 1) { skip(); v = b[p++] === 49 ? 0 : 255; }   // "1" is black
      else if (kind === 4) { var x = i % w, row = p + ((i / w) | 0) * ((w + 7) >> 3); v = (b[row + (x >> 3)] >> (7 - (x & 7)) & 1) ? 0 : 255; }
      if (kind === 1 || kind === 4) { out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; continue; }
      var s0 = sample() * scale;
      if (depth >= 3) { out[o] = s0; out[o + 1] = sample() * scale; out[o + 2] = sample() * scale; }
      else out[o] = out[o + 1] = out[o + 2] = s0;
      out[o + 3] = depth === 2 || depth === 4 ? sample() * scale : 255;
    }
    return img;
  }

  /* ---------- QOI (qoiformat.org) ---------- */

  function hash(r, g, b, a) { return (r * 3 + g * 5 + b * 7 + a * 11) % 64; }

  function qoiRead(b) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint32(0) !== 0x716f6966) throw fail('Not a QOI image.');
    var img = pixels(dv.getUint32(4), dv.getUint32(8)), out = img.data, seen = new Uint8Array(256);
    var r = 0, g = 0, bl = 0, a = 255, run = 0, p = 14;
    for (var o = 0; o < out.length; o += 4) {
      if (run) run--;
      else {
        var c = b[p++];
        if (c === 0xfe) { r = b[p++]; g = b[p++]; bl = b[p++]; }
        else if (c === 0xff) { r = b[p++]; g = b[p++]; bl = b[p++]; a = b[p++]; }
        else if ((c >> 6) === 0) { var i = c * 4; r = seen[i]; g = seen[i + 1]; bl = seen[i + 2]; a = seen[i + 3]; }
        else if ((c >> 6) === 1) { r = (r + (c >> 4 & 3) - 2) & 255; g = (g + (c >> 2 & 3) - 2) & 255; bl = (bl + (c & 3) - 2) & 255; }
        else if ((c >> 6) === 2) {
          var d = b[p++], dg = (c & 63) - 32;
          r = (r + dg - 8 + (d >> 4)) & 255; g = (g + dg) & 255; bl = (bl + dg - 8 + (d & 15)) & 255;
        } else run = c & 63;
        var h4 = hash(r, g, bl, a) * 4;
        seen[h4] = r; seen[h4 + 1] = g; seen[h4 + 2] = bl; seen[h4 + 3] = a;
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a;
    }
    return img;
  }

  function qoi(img) {
    var px = img.data, alpha = false;
    for (var t = 3; t < px.length; t += 4) if (px[t] < 255) { alpha = true; break; }
    var out = new Uint8Array(14 + img.width * img.height * 5 + 8), dv = new DataView(out.buffer), p = 14;
    dv.setUint32(0, 0x716f6966); dv.setUint32(4, img.width); dv.setUint32(8, img.height);
    out[12] = alpha ? 4 : 3;
    var seen = new Uint8Array(256), pr = 0, pg = 0, pb = 0, pa = 255, run = 0;
    for (var o = 0; o < px.length; o += 4) {
      var r = px[o], g = px[o + 1], b = px[o + 2], a = px[o + 3];
      if (r === pr && g === pg && b === pb && a === pa) {
        if (++run === 62 || o + 4 === px.length) { out[p++] = 0xc0 | (run - 1); run = 0; }
        continue;
      }
      if (run) { out[p++] = 0xc0 | (run - 1); run = 0; }
      var i = hash(r, g, b, a) * 4;
      if (seen[i] === r && seen[i + 1] === g && seen[i + 2] === b && seen[i + 3] === a) out[p++] = i / 4;
      else {
        seen[i] = r; seen[i + 1] = g; seen[i + 2] = b; seen[i + 3] = a;
        if (a !== pa) { out[p++] = 0xff; out[p++] = r; out[p++] = g; out[p++] = b; out[p++] = a; }
        else {
          var dr = (r - pr) << 24 >> 24, dg = (g - pg) << 24 >> 24, db = (b - pb) << 24 >> 24, rg = dr - dg, bg = db - dg;
          if (dr > -3 && dr < 2 && dg > -3 && dg < 2 && db > -3 && db < 2) out[p++] = 0x40 | (dr + 2) << 4 | (dg + 2) << 2 | (db + 2);
          else if (dg > -33 && dg < 32 && rg > -9 && rg < 8 && bg > -9 && bg < 8) { out[p++] = 0x80 | (dg + 32); out[p++] = (rg + 8) << 4 | (bg + 8); }
          else { out[p++] = 0xfe; out[p++] = r; out[p++] = g; out[p++] = b; }
        }
      }
      pr = r; pg = g; pb = b; pa = a;
    }
    out[p + 7] = 1;                                     // end marker: seven 0 bytes and a 1
    return out.slice(0, p + 8);
  }

  /* ---------- ICNS (Mac icons): the largest PNG inside ---------- */

  function icns(b) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength), best = null;
    if (dv.getUint32(0) !== 0x69636e73) throw fail('Not a Mac icon file.');
    for (var p = 8; p + 8 <= b.length;) {
      var len = dv.getUint32(p + 4), data = b.subarray(p + 8, p + len);
      if (data[0] === 0x89 && data[1] === 0x50 && (!best || data.length > best.length)) best = data;
      if (len < 8) break;
      p += len;
    }
    if (!best) throw QC.error('unsupported', 'This icon has only old-style images inside, which can\'t be read.');
    return new Blob([best], { type: 'image/png' });
  }

  /* ---------- writers ---------- */

  // Uncompressed, top row first; 32-bit with alpha only when the picture has transparency.
  function tgaWrite(img) {
    var px = img.data, alpha = false;
    for (var t = 3; t < px.length; t += 4) if (px[t] < 255) { alpha = true; break; }
    var bytes = alpha ? 4 : 3, out = new Uint8Array(18 + img.width * img.height * bytes), dv = new DataView(out.buffer);
    out[2] = 2;
    dv.setUint16(12, img.width, true);
    dv.setUint16(14, img.height, true);
    out[16] = bytes * 8;
    out[17] = 0x20 | (alpha ? 8 : 0);
    for (var i = 0, o = 18; i < px.length; i += 4) {
      out[o++] = px[i + 2]; out[o++] = px[i + 1]; out[o++] = px[i];
      if (alpha) out[o++] = px[i + 3];
    }
    return out;
  }

  // One page the size of the picture (at 96 dpi) showing the JPEG.
  function pdf(jpeg, w, h) {
    var enc = new TextEncoder(), parts = [], offsets = [], len = 0;
    function add(x) { var u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); len += u.length; }
    function obj(n, head, stream) {
      offsets[n] = len;
      add(n + ' 0 obj\n' + head);
      if (stream) { add('\nstream\n'); add(stream); add('\nendstream'); }
      add('\nendobj\n');
    }
    var pw = (w * 0.75).toFixed(2), ph = (h * 0.75).toFixed(2), draw = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q';
    add('%PDF-1.4\n');
    add(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));   // marks the file as binary
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
    obj(4, '<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>', jpeg);
    obj(5, '<< /Length ' + draw.length + ' >>', enc.encode(draw));
    var xref = len;
    add('xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(function (o) { return ('000000000' + o).slice(-10) + ' 00000 n \n'; }).join(''));
    add('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    var out = new Uint8Array(len), p = 0;
    parts.forEach(function (u) { out.set(u, p); p += u.length; });
    return out;
  }

  /* ---------- reading ---------- */

  var READERS = { raw: raw, psd: psd, tga: tga, pnm: pnm, qoi: qoiRead, icns: icns };

  function canRead(type) { return !!READERS[type]; }

  async function read(type, file) {
    var b = new Uint8Array(await file.arrayBuffer()), r;
    try { r = await READERS[type](b); }
    catch (e) { throw e.code ? e : fail(); }
    return r instanceof ImageBitmap ? r : createImageBitmap(r);
  }

  return { canRead: canRead, read: read, tga: tgaWrite, qoi: qoi, pdf: pdf, unpackBits: unpackBits, jpegEnd: jpegEnd };
}, { worker: true });
