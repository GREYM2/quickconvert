/* Hand-written BMP encoder: 24-bit, uncompressed, bottom-up rows. */
QC.define('bmp', function (QC) {
  'use strict';

  function rowStride(width) { return (width * 3 + 3) & ~3; } // rows are padded to 4 bytes
  function fileSize(width, height) { return 54 + rowStride(width) * height; }

  // imageData: RGBA pixels from a canvas. Alpha is dropped, so flatten it first.
  function encode(imageData) {
    var w = imageData.width, h = imageData.height, src = imageData.data;
    var stride = rowStride(w), size = fileSize(w, h);
    var out = new Uint8Array(size);
    var dv = new DataView(out.buffer);

    // BITMAPFILEHEADER
    out[0] = 0x42; out[1] = 0x4d;           // "BM"
    dv.setUint32(2, size, true);
    dv.setUint32(10, 54, true);             // pixel data offset
    // BITMAPINFOHEADER
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, h, true);               // positive height = bottom-up
    dv.setUint16(26, 1, true);              // planes
    dv.setUint16(28, 24, true);             // bits per pixel
    dv.setUint32(30, 0, true);              // BI_RGB, no compression
    dv.setUint32(34, stride * h, true);
    dv.setInt32(38, 2835, true);            // 72 DPI in pixels per metre
    dv.setInt32(42, 2835, true);

    for (var y = 0; y < h; y++) {
      var s = (h - 1 - y) * w * 4;
      var d = 54 + y * stride;
      for (var x = 0; x < w; x++, s += 4, d += 3) {
        out[d] = src[s + 2];                // B
        out[d + 1] = src[s + 1];            // G
        out[d + 2] = src[s];                // R
      }
    }
    return out;
  }

  return { encode: encode, fileSize: fileSize };
}, { worker: true });
