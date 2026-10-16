/*
 * Minimal TIFF writer: one uncompressed strip, RGB, or RGBA when the picture has transparency.
 * Baseline tags only, so every TIFF reader opens it. Little-endian ("II").
 */
QC.define('tiff', function (QC) {
  'use strict';

  // ImageData -> Uint8Array
  function encode(img) {
    var w = img.width, h = img.height, src = img.data, alpha = false;
    for (var a = 3; a < src.length; a += 4) if (src[a] < 255) { alpha = true; break; }
    var spp = alpha ? 4 : 3, tags = alpha ? 14 : 13;
    var ifd = 8, extra = ifd + 2 + tags * 12 + 4;       // after the IFD: bits per sample, resolutions
    var bitsAt = extra, xresAt = bitsAt + 8, yresAt = xresAt + 8, data = yresAt + 8;
    var size = data + w * h * spp, out = new Uint8Array(size), dv = new DataView(out.buffer);
    out[0] = out[1] = 0x49;                            // "II"
    dv.setUint16(2, 42, true);
    dv.setUint32(4, ifd, true);
    dv.setUint16(ifd, tags, true);
    var p = ifd + 2;
    function tag(id, type, count, value) {             // type 3 = SHORT, 4 = LONG, 5 = RATIONAL
      dv.setUint16(p, id, true);
      dv.setUint16(p + 2, type, true);
      dv.setUint32(p + 4, count, true);
      if (type === 3 && count === 1) dv.setUint16(p + 8, value, true); else dv.setUint32(p + 8, value, true);
      p += 12;
    }
    tag(256, 4, 1, w);                                 // width
    tag(257, 4, 1, h);                                 // height
    tag(258, 3, spp, bitsAt);                          // bits per sample (8 each)
    tag(259, 3, 1, 1);                                 // no compression
    tag(262, 3, 1, 2);                                 // RGB
    tag(273, 4, 1, data);                              // where the pixels start
    tag(277, 3, 1, spp);                               // samples per pixel
    tag(278, 4, 1, h);                                 // rows per strip: all of them
    tag(279, 4, 1, w * h * spp);                       // strip size
    tag(282, 5, 1, xresAt);                            // 72 dpi
    tag(283, 5, 1, yresAt);
    tag(284, 3, 1, 1);                                 // channels interleaved
    tag(296, 3, 1, 2);                                 // resolution in inches
    if (alpha) tag(338, 3, 1, 2);                      // the 4th sample is (unassociated) alpha
    dv.setUint32(p, 0, true);                          // no next IFD
    for (var b = 0; b < spp; b++) dv.setUint16(bitsAt + b * 2, 8, true);
    dv.setUint32(xresAt, 72, true); dv.setUint32(xresAt + 4, 1, true);
    dv.setUint32(yresAt, 72, true); dv.setUint32(yresAt + 4, 1, true);
    for (var i = 0, o = data; i < src.length; i += 4) {
      out[o++] = src[i]; out[o++] = src[i + 1]; out[o++] = src[i + 2];
      if (alpha) out[o++] = src[i + 3];
    }
    return out;
  }

  return { encode: encode };
}, { worker: true });
