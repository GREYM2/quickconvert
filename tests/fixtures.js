/*
 * Test file generators. Used by tests/index.html, and handy in the app's console:
 *   var s = document.createElement('script'); s.src = 'tests/fixtures.js'; document.head.appendChild(s);
 *   QCFixtures.all().then(QCFixtures.drop);
 */
(function () {
  'use strict';

  function canvas(w, h, paint) {
    var c = new OffscreenCanvas(w, h);
    paint(c.getContext('2d'), w, h);
    return c;
  }

  // Gradients, circles and per-pixel noise: compresses like a photo, so PNG gets big.
  function paintPhoto(x, w, h) {
    var g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#3a6ea5'); g.addColorStop(0.5, '#e0b050'); g.addColorStop(1, '#5a2a3a');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    for (var i = 0; i < 60; i++) {
      x.fillStyle = 'hsla(' + (i * 37 % 360) + ',60%,' + (30 + i % 40) + '%,0.5)';
      x.beginPath();
      x.arc((i * 733) % w, (i * 397) % h, (40 + (i * 53) % 200) * w / 2600, 0, 7);
      x.fill();
    }
    var id = x.getImageData(0, 0, w, h), d = id.data, s = 12345;
    for (var p = 0; p < d.length; p += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      var n = (s >> 16) % 48 - 24;
      d[p] += n; d[p + 1] += n; d[p + 2] += n;
    }
    x.putImageData(id, 0, 0);
  }

  // Checkerboard with a few blue dots: three colours only, so resampling differences are obvious.
  function paintPixelArt(x, w, h) {
    for (var y = 0; y < h; y++) {
      for (var i = 0; i < w; i++) {
        x.fillStyle = (i * y) % 7 === 0 ? '#2244cc' : ((i >> 2) + (y >> 2)) % 2 ? '#dd3333' : '#33aa33';
        x.fillRect(i, y, 1, 1);
      }
    }
  }

  function photo(w, h, type, quality) {
    return canvas(w, h, paintPhoto).convertToBlob({ type: type || 'image/png', quality: quality });
  }

  function pixelArt(w, h) {
    return canvas(w || 32, h || 32, paintPixelArt).convertToBlob({ type: 'image/png' });
  }

  // Two 8x8 frames: red then blue. LZW with a clear code every 2 pixels keeps codes 3 bits wide.
  function gif() {
    var out = [], w = 8, h = 8;
    function push() { for (var i = 0; i < arguments.length; i++) out.push(arguments[i]); }
    function str(s) { for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); }
    str('GIF89a'); push(w, 0, h, 0, 0xf1, 0, 0);
    push(255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0);
    push(0x21, 0xff, 0x0b); str('NETSCAPE2.0'); push(3, 1, 0, 0, 0);
    [0, 1].forEach(function (colour) {
      push(0x21, 0xf9, 4, 0x04, 50, 0, 0, 0);
      push(0x2c, 0, 0, 0, 0, w, 0, h, 0, 0, 2);
      var codes = [];
      for (var p = 0; p < w * h; p += 2) codes.push(4, colour, colour);
      codes.push(5);
      var bytes = [], acc = 0, bits = 0;
      codes.forEach(function (c) {
        acc |= c << bits; bits += 3;
        while (bits >= 8) { bytes.push(acc & 255); acc >>= 8; bits -= 8; }
      });
      if (bits) bytes.push(acc & 255);
      for (var i = 0; i < bytes.length; i += 255) {
        var chunk = bytes.slice(i, i + 255);
        out.push(chunk.length);
        chunk.forEach(function (b) { out.push(b); });
      }
      push(0);
    });
    push(0x3b);
    return new Blob([new Uint8Array(out)], { type: 'image/gif' });
  }

  function bmp(w, h) {
    var c = canvas(w, h, paintPhoto);
    return new Blob([QC.bmp.encode(c.getContext('2d').getImageData(0, 0, w, h))], { type: 'image/bmp' });
  }

  function csv(rows) {
    var s = 'id,name,code,amount,text\r\n';
    for (var i = 1; i <= rows; i++) {
      s += i + ',"Name ' + i + ', Jr",' + String(i).padStart(4, '0') + ',' + (i * 1.25).toFixed(2) + ',"q ""' + i + '"" ü"\r\n';
    }
    return s;
  }

  async function all() {
    function file(parts, name, type) { return new File(parts, name, { type: type || '' }); }
    return [
      file([await photo(2600, 2000)], 'big-photo.png', 'image/png'),
      file([await pixelArt(32, 32)], 'pixel-art.png', 'image/png'),
      file([gif()], 'anim.gif', 'image/gif'),
      file([await photo(640, 480, 'image/jpeg', 0.9)], 'photo.jpg', 'image/jpeg'),
      file([await photo(400, 300, 'image/webp', 0.8)], 'photo.webp', 'image/webp'),
      file([bmp(100, 80)], 'small.bmp', 'image/bmp'),
      file([csv(50)], 'people.csv', 'text/csv'),
      file([JSON.stringify([{ a: 1, b: 'x' }, { a: 2, c: { d: true } }, { b: null }])], 'data.json', 'application/json'),
      file(['# Title\n\nSome *em* text & <b>tags</b>.\n\n- one\n- two\n'], 'readme.md'),
      file(['Line one\nline two\n\nPara <2>'], 'notes.txt', 'text/plain'),
      file(['zzz'], 'mystery.xyz')
    ];
  }

  // Simulate a real drag-and-drop onto the page.
  function drop(files) {
    var dt = new DataTransfer();
    files.forEach(function (f) { dt.items.add(f); });
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return files.length;
  }

  window.QCFixtures = { photo: photo, pixelArt: pixelArt, gif: gif, bmp: bmp, csv: csv, all: all, drop: drop };
})();
