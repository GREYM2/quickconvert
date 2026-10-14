/* ICO writer: one PNG image inside an ICO container (Windows Vista+ and all browsers read it). */
QC.define('ico', function (QC) {
  'use strict';

  var MAX_SIDE = 256;

  // png: Uint8Array of a PNG file. width/height: its pixel size (max 256).
  function wrapPng(png, width, height) {
    var out = new Uint8Array(6 + 16 + png.length);
    var dv = new DataView(out.buffer);
    // ICONDIR
    dv.setUint16(0, 0, true);               // reserved
    dv.setUint16(2, 1, true);               // type: icon
    dv.setUint16(4, 1, true);               // image count
    // ICONDIRENTRY
    out[6] = width >= 256 ? 0 : width;      // 0 means 256
    out[7] = height >= 256 ? 0 : height;
    out[8] = 0;                             // palette size
    out[9] = 0;                             // reserved
    dv.setUint16(10, 1, true);              // colour planes
    dv.setUint16(12, 32, true);             // bits per pixel
    dv.setUint32(14, png.length, true);
    dv.setUint32(18, 22, true);             // offset of the PNG data
    out.set(png, 22);
    return out;
  }

  return { wrapPng: wrapPng, MAX_SIDE: MAX_SIDE };
}, { worker: true });
