/*
 * Minimal ZIP writer (store only, no compression). Converted images are already
 * compressed, so deflate would add code and time for almost no gain.
 * Limits: 65,535 files and 4 GB total (no Zip64).
 */
QC.define('zip', function (QC) {
  'use strict';

  var table = null;
  function crc32(bytes) {
    if (!table) {
      table = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
    }
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  // ["a.jpg", "a.jpg", "A.jpg"] -> ["a.jpg", "a (2).jpg", "A (3).jpg"] (case-insensitive, like Windows)
  function uniqueNames(names) {
    var seen = {};
    return names.map(function (name) {
      var key = name.toLowerCase();
      if (!seen[key]) { seen[key] = 1; return name; }
      var m = /^(.*?)(\.[^.]*)?$/.exec(name);
      var base = m[1], ext = m[2] || '';
      var i = seen[key], candidate;
      do { i++; candidate = base + ' (' + i + ')' + ext; } while (seen[candidate.toLowerCase()]);
      seen[key] = i;
      seen[candidate.toLowerCase()] = 1;
      return candidate;
    });
  }

  // entries: [{ name, blob }] -> Blob. File data is referenced, not copied into one buffer.
  async function build(entries, progress) {
    if (entries.length > 0xffff) throw QC.error('toolarge', 'Too many files for one ZIP.');
    var enc = new TextEncoder();
    var now = new Date();
    var time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    var names = uniqueNames(entries.map(function (e) { return e.name; }));
    var parts = [], central = [], offset = 0, centralSize = 0;

    for (var i = 0; i < entries.length; i++) {
      var blob = entries[i].blob;
      var name = enc.encode(names[i]);
      var crc = crc32(new Uint8Array(await blob.arrayBuffer()));
      var size = blob.size;
      if (offset + 30 + name.length + size > 0xffffffff) throw QC.error('toolarge', 'ZIP would be over 4 GB.');

      var local = new DataView(new ArrayBuffer(30 + name.length));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);        // version needed
      local.setUint16(6, 0x0800, true);    // flag: UTF-8 file names
      local.setUint16(8, 0, true);         // method: stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);     // compressed size
      local.setUint32(22, size, true);     // uncompressed size
      local.setUint16(26, name.length, true);
      new Uint8Array(local.buffer).set(name, 30);
      parts.push(local.buffer, blob);

      var cd = new DataView(new ArrayBuffer(46 + name.length));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);           // version made by
      cd.setUint16(6, 20, true);           // version needed
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);      // where the local header starts
      new Uint8Array(cd.buffer).set(name, 46);
      central.push(cd.buffer);

      offset += 30 + name.length + size;
      centralSize += cd.byteLength;
      if (progress) progress((i + 1) / entries.length);
    }

    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end.buffer]), { type: 'application/zip' });
  }

  return { build: build, crc32: crc32, uniqueNames: uniqueNames };
}, { worker: true });
