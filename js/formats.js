/* Format registry: detection by extension/MIME and which outputs make sense. */
QC.define('formats', function (QC) {
  'use strict';

  var IMAGE_OUT = ['jpg', 'png', 'webp', 'bmp', 'ico'];

  var list = [
    { key: 'jpg', label: 'JPG', desc: 'JPG image', kind: 'image', mime: 'image/jpeg',
      exts: ['jpg', 'jpeg', 'jpe', 'jfif'], mimes: ['image/jpeg', 'image/pjpeg'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'png', label: 'PNG', desc: 'PNG image', kind: 'image', mime: 'image/png',
      exts: ['png'], mimes: ['image/png'], outputs: IMAGE_OUT, def: 'jpg' },
    { key: 'webp', label: 'WebP', desc: 'WebP image', kind: 'image', mime: 'image/webp',
      exts: ['webp'], mimes: ['image/webp'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'gif', label: 'GIF', desc: 'GIF image (first frame)', kind: 'image', mime: 'image/gif',
      exts: ['gif'], mimes: ['image/gif'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'bmp', label: 'BMP', desc: 'BMP image', kind: 'image', mime: 'image/bmp',
      exts: ['bmp', 'dib'], mimes: ['image/bmp', 'image/x-bmp', 'image/x-ms-bmp'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'ico', label: 'ICO', desc: 'ICO icon', kind: 'image', mime: 'image/x-icon',
      exts: ['ico'], mimes: ['image/x-icon', 'image/vnd.microsoft.icon'], outputs: IMAGE_OUT, def: 'png' },

    { key: 'csv', label: 'CSV', desc: 'CSV table', kind: 'data', mime: 'text/csv',
      exts: ['csv', 'tsv'], mimes: ['text/csv', 'application/csv', 'text/tab-separated-values'], outputs: ['json', 'xlsx'], def: 'json' },
    { key: 'json', label: 'JSON', desc: 'JSON data', kind: 'data', mime: 'application/json',
      exts: ['json'], mimes: ['application/json', 'text/json'], outputs: ['csv', 'xlsx'], def: 'csv' },
    { key: 'xlsx', label: 'XLSX', desc: 'Excel workbook', kind: 'data',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      exts: ['xlsx'], mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], outputs: ['csv', 'json'], def: 'csv' },
    { key: 'txt', label: 'TXT', desc: 'Plain text', kind: 'data', mime: 'text/plain',
      exts: ['txt', 'text', 'log'], mimes: ['text/plain'], outputs: ['html'], def: 'html' },
    { key: 'md', label: 'Markdown', desc: 'Markdown', kind: 'data', mime: 'text/markdown',
      exts: ['md', 'markdown', 'mdown', 'mkd'], mimes: ['text/markdown', 'text/x-markdown'], outputs: ['html', 'txt'], def: 'html' },

    // Output only.
    { key: 'html', label: 'HTML', desc: 'HTML page', kind: 'data', mime: 'text/html',
      exts: [], mimes: [], outputs: [] }
  ];

  var byKey = {};
  list.forEach(function (f) { byKey[f.key] = f; });

  function extOf(name) {
    var m = /\.([^.\\/]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  // Extension first (it's what the user sees), MIME as a fallback.
  function detect(name, mime) {
    var ext = extOf(name);
    var f = list.find(function (x) { return x.exts.indexOf(ext) !== -1; });
    if (!f && mime) f = list.find(function (x) { return x.mimes.indexOf(mime.toLowerCase()) !== -1; });
    return f || null;
  }

  // caps: { webp: bool } — formats the current browser can actually encode.
  function outputsFor(key, caps) {
    var f = byKey[key];
    if (!f) return [];
    return f.outputs.filter(function (o) { return o !== 'webp' || !caps || caps.webp; });
  }

  function defaultOutput(key, caps) {
    var outs = outputsFor(key, caps);
    var def = byKey[key] && byKey[key].def;
    return outs.indexOf(def) !== -1 ? def : outs[0];
  }

  // photo.png -> photo.jpg
  function outputName(name, key) {
    var base = (name || 'file').replace(/\.[^.\\/]+$/, '') || name || 'file';
    return base + '.' + key;
  }

  return { list: list, get: function (k) { return byKey[k]; }, detect: detect,
    outputsFor: outputsFor, defaultOutput: defaultOutput, outputName: outputName, extOf: extOf };
}, { worker: true });
