/* Format registry: detection by extension/MIME and which outputs make sense. */
QC.define('formats', function (QC) {
  'use strict';

  var IMAGE_OUT = ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tga', 'qoi', 'ico', 'pdf'];
  var RAW_EXTS = ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'rwl', 'pef', 'ptx',
    'srw', '3fr', 'fff', 'erf', 'kdc', 'dcr', 'mos', 'iiq', 'mrw', 'x3f', 'raw'];
  var AUDIO_OUT = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav'];
  var VIDEO_OUT = ['mp4', 'webm', 'mov', 'mkv', 'gif'].concat(AUDIO_OUT);   // a video's sound can be saved on its own
  // Tables and data reach each other's formats and documents (see js/convert/data.js).
  // JSON keeps JSON as an output too: to reformat it (indent, minify, sort keys).
  var DATA_OUT = ['csv', 'tsv', 'xlsx', 'ods', 'json', 'yaml', 'xml', 'html', 'md'];
  function not(key) { return function (k) { return k !== key; }; }

  var list = [
    { key: 'jpg', label: 'JPG', desc: 'JPG image', kind: 'image', mime: 'image/jpeg',
      exts: ['jpg', 'jpeg', 'jpe', 'jfif'], mimes: ['image/jpeg', 'image/pjpeg'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'png', label: 'PNG', desc: 'PNG image', kind: 'image', mime: 'image/png',
      exts: ['png', 'apng'], mimes: ['image/png', 'image/apng'], outputs: IMAGE_OUT, def: 'jpg' },
    { key: 'webp', label: 'WebP', desc: 'WebP image', kind: 'image', mime: 'image/webp',
      exts: ['webp'], mimes: ['image/webp'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'gif', label: 'GIF', desc: 'GIF image', kind: 'image', mime: 'image/gif',
      exts: ['gif'], mimes: ['image/gif'], outputs: IMAGE_OUT.filter(not('gif')).concat(['mp4', 'webm']), def: 'png' },
    { key: 'bmp', label: 'BMP', desc: 'BMP image', kind: 'image', mime: 'image/bmp',
      exts: ['bmp', 'dib'], mimes: ['image/bmp', 'image/x-bmp', 'image/x-ms-bmp'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'ico', label: 'ICO', desc: 'ICO icon', kind: 'image', mime: 'image/x-icon',
      exts: ['ico'], mimes: ['image/x-icon', 'image/vnd.microsoft.icon'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'avif', label: 'AVIF', desc: 'AVIF image', kind: 'image', mime: 'image/avif',
      exts: ['avif'], mimes: ['image/avif'], outputs: IMAGE_OUT, def: 'jpg' },
    { key: 'heic', label: 'HEIC', desc: 'HEIC photo', kind: 'image', mime: 'image/heic',
      exts: ['heic', 'heif', 'hif'], mimes: ['image/heic', 'image/heif'], outputs: IMAGE_OUT, def: 'jpg' },
    { key: 'tiff', label: 'TIFF', desc: 'TIFF image', kind: 'image', mime: 'image/tiff',
      exts: ['tif', 'tiff'], mimes: ['image/tiff'], outputs: IMAGE_OUT, def: 'jpg' },
    { key: 'svg', label: 'SVG', desc: 'SVG drawing', kind: 'image', mime: 'image/svg+xml',
      exts: ['svg'], mimes: ['image/svg+xml'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'raw', label: 'RAW', desc: 'Camera RAW photo', kind: 'image', mime: 'image/x-raw',
      exts: RAW_EXTS, mimes: ['image/x-adobe-dng', 'image/x-canon-cr2', 'image/x-canon-cr3', 'image/x-nikon-nef', 'image/x-sony-arw',
        'image/x-fuji-raf', 'image/x-olympus-orf', 'image/x-panasonic-rw2'], outputs: IMAGE_OUT, def: 'jpg' },
    { key: 'psd', label: 'PSD', desc: 'Photoshop image', kind: 'image', mime: 'image/vnd.adobe.photoshop',
      exts: ['psd', 'psb'], mimes: ['image/vnd.adobe.photoshop', 'application/x-photoshop'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'jxl', label: 'JXL', desc: 'JPEG XL image', kind: 'image', mime: 'image/jxl',
      exts: ['jxl'], mimes: ['image/jxl'], outputs: IMAGE_OUT, def: 'jpg' },
    { key: 'tga', label: 'TGA', desc: 'TGA image', kind: 'image', mime: 'image/x-tga',
      exts: ['tga', 'icb', 'vda', 'vst'], mimes: ['image/x-tga', 'image/tga'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'qoi', label: 'QOI', desc: 'QOI image', kind: 'image', mime: 'image/qoi',
      exts: ['qoi'], mimes: ['image/qoi'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'pnm', label: 'PNM', desc: 'Netpbm image', kind: 'image', mime: 'image/x-portable-anymap',
      exts: ['ppm', 'pgm', 'pbm', 'pnm', 'pam'], mimes: ['image/x-portable-anymap', 'image/x-portable-pixmap'], outputs: IMAGE_OUT, def: 'png' },
    { key: 'icns', label: 'ICNS', desc: 'Mac icon', kind: 'image', mime: 'image/icns',
      exts: ['icns'], mimes: ['image/icns'], outputs: IMAGE_OUT, def: 'png' },
    // Output only: a picture as a one-page PDF.
    { key: 'pdf', label: 'PDF', desc: 'PDF document', kind: 'image', group: 'doc', mime: 'application/pdf',
      exts: [], mimes: [], outputs: [] },

    // Video (GIF animations convert to video too, see the GIF entry)
    { key: 'mp4', label: 'MP4', desc: 'MP4 video', kind: 'video', mime: 'video/mp4',
      exts: ['mp4', 'm4v'], mimes: ['video/mp4'], outputs: VIDEO_OUT, def: 'webm' },
    { key: 'webm', label: 'WebM', desc: 'WebM video', kind: 'video', mime: 'video/webm',
      exts: ['webm'], mimes: ['video/webm'], outputs: VIDEO_OUT, def: 'mp4' },
    { key: 'mov', label: 'MOV', desc: 'QuickTime video', kind: 'video', mime: 'video/quicktime',
      exts: ['mov', 'qt'], mimes: ['video/quicktime'], outputs: VIDEO_OUT, def: 'mp4' },
    { key: 'mkv', label: 'MKV', desc: 'Matroska video', kind: 'video', mime: 'video/x-matroska',
      exts: ['mkv'], mimes: ['video/x-matroska'], outputs: VIDEO_OUT, def: 'mp4' },
    { key: 'ts', label: 'TS', desc: 'MPEG-TS video', kind: 'video', mime: 'video/mp2t',
      exts: ['ts', 'mts', 'm2ts', 'm2t'], mimes: ['video/mp2t', 'video/vnd.dlna.mpeg-tts'], outputs: VIDEO_OUT, def: 'mp4' },
    { key: '3gp', label: '3GP', desc: '3GP video', kind: 'video', mime: 'video/3gpp',
      exts: ['3gp', '3g2'], mimes: ['video/3gpp', 'video/3gpp2'], outputs: VIDEO_OUT, def: 'mp4' },
    { key: 'ogv', label: 'OGV', desc: 'Ogg video', kind: 'video', mime: 'video/ogg',
      exts: ['ogv'], mimes: ['video/ogg'], outputs: VIDEO_OUT, def: 'mp4' },

    // Audio
    { key: 'mp3', label: 'MP3', desc: 'MP3 audio', kind: 'audio', mime: 'audio/mpeg',
      exts: ['mp3'], mimes: ['audio/mpeg', 'audio/mp3'], outputs: AUDIO_OUT, def: 'm4a' },
    { key: 'm4a', label: 'M4A', desc: 'M4A audio (AAC)', kind: 'audio', mime: 'audio/mp4',
      exts: ['m4a'], mimes: ['audio/mp4', 'audio/x-m4a'], outputs: AUDIO_OUT, def: 'mp3' },
    { key: 'ogg', label: 'OGG', desc: 'Ogg audio', kind: 'audio', mime: 'audio/ogg',
      exts: ['ogg', 'oga'], mimes: ['audio/ogg'], outputs: AUDIO_OUT, def: 'mp3' },
    { key: 'opus', label: 'OPUS', desc: 'Opus audio', kind: 'audio', mime: 'audio/ogg',
      exts: ['opus'], mimes: ['audio/opus'], outputs: AUDIO_OUT, def: 'mp3' },
    { key: 'mka', label: 'MKA', desc: 'Matroska audio', kind: 'audio', mime: 'audio/x-matroska',
      exts: ['mka'], mimes: ['audio/x-matroska'], outputs: AUDIO_OUT, def: 'mp3' },
    { key: 'wav', label: 'WAV', desc: 'WAV audio', kind: 'audio', mime: 'audio/wav',
      exts: ['wav', 'wave'], mimes: ['audio/wav', 'audio/x-wav', 'audio/wave'], outputs: AUDIO_OUT, def: 'mp3' },
    { key: 'flac', label: 'FLAC', desc: 'FLAC audio', kind: 'audio', mime: 'audio/flac',
      exts: ['flac'], mimes: ['audio/flac', 'audio/x-flac'], outputs: AUDIO_OUT, def: 'mp3' },
    { key: 'aac', label: 'AAC', desc: 'AAC audio', kind: 'audio', mime: 'audio/aac',
      exts: ['aac'], mimes: ['audio/aac', 'audio/x-aac'], outputs: AUDIO_OUT, def: 'mp3' },
    { key: 'weba', label: 'WebA', desc: 'WebM audio', kind: 'audio', mime: 'audio/webm',
      exts: ['weba'], mimes: ['audio/webm'], outputs: AUDIO_OUT, def: 'mp3' },

    // Tables
    { key: 'csv', label: 'CSV', desc: 'CSV table', kind: 'data', group: 'table', mime: 'text/csv',
      exts: ['csv'], mimes: ['text/csv', 'application/csv'], outputs: DATA_OUT.filter(not('csv')), def: 'json' },
    { key: 'tsv', label: 'TSV', desc: 'TSV table', kind: 'data', group: 'table', mime: 'text/tab-separated-values',
      exts: ['tsv', 'tab'], mimes: ['text/tab-separated-values'], outputs: DATA_OUT.filter(not('tsv')), def: 'csv' },
    { key: 'xlsx', label: 'XLSX', desc: 'Excel workbook', kind: 'data', group: 'table',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      exts: ['xlsx', 'xlsm'], mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], outputs: DATA_OUT.filter(not('xlsx')), def: 'csv' },
    { key: 'ods', label: 'ODS', desc: 'OpenDocument spreadsheet', kind: 'data', group: 'table', mime: 'application/vnd.oasis.opendocument.spreadsheet',
      exts: ['ods'], mimes: ['application/vnd.oasis.opendocument.spreadsheet'], outputs: DATA_OUT.filter(not('ods')), def: 'xlsx' },
    { key: 'xls', label: 'XLS', desc: 'Excel 97–2003 workbook', kind: 'data', group: 'table', mime: 'application/vnd.ms-excel',
      exts: ['xls'], mimes: ['application/vnd.ms-excel'], outputs: DATA_OUT, def: 'xlsx' },

    // Data
    { key: 'json', label: 'JSON', desc: 'JSON data', kind: 'data', group: 'data', mime: 'application/json',
      exts: ['json', 'jsonl', 'ndjson', 'geojson'], mimes: ['application/json', 'text/json', 'application/x-ndjson'], outputs: DATA_OUT, def: 'csv' },
    { key: 'yaml', label: 'YAML', desc: 'YAML data', kind: 'data', group: 'data', mime: 'application/yaml',
      exts: ['yaml', 'yml'], mimes: ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'], outputs: DATA_OUT.filter(not('yaml')), def: 'json' },
    { key: 'xml', label: 'XML', desc: 'XML data', kind: 'data', group: 'data', mime: 'application/xml',
      exts: ['xml'], mimes: ['application/xml', 'text/xml'], outputs: DATA_OUT.filter(not('xml')), def: 'json' },

    // Documents
    { key: 'txt', label: 'TXT', desc: 'Plain text', kind: 'data', group: 'doc', mime: 'text/plain',
      exts: ['txt', 'text', 'log'], mimes: ['text/plain'], outputs: ['html', 'md', 'docx'], def: 'html' },
    { key: 'md', label: 'Markdown', desc: 'Markdown', kind: 'data', group: 'doc', mime: 'text/markdown',
      exts: ['md', 'markdown', 'mdown', 'mkd'], mimes: ['text/markdown', 'text/x-markdown'], outputs: ['html', 'docx', 'txt'], def: 'html' },
    { key: 'html', label: 'HTML', desc: 'HTML page', kind: 'data', group: 'doc', mime: 'text/html',
      exts: ['html', 'htm', 'xhtml'], mimes: ['text/html', 'application/xhtml+xml'], outputs: ['md', 'docx', 'txt', 'csv', 'tsv', 'xlsx', 'ods', 'json'], def: 'md' },
    { key: 'docx', label: 'DOCX', desc: 'Word document', kind: 'data', group: 'doc',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      exts: ['docx'], mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], outputs: ['html', 'md', 'txt'], def: 'md' }
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

  // caps: { webp, video: bool } — what the current browser can actually encode.
  function outputsFor(key, caps) {
    var f = byKey[key];
    if (!f) return [];
    return f.outputs.filter(function (o) {
      if (!caps) return true;
      if (o === 'webp') return caps.webp;
      return caps.video || (!MEDIA[f.kind] && !MEDIA[byKey[o].kind]);   // video and audio need WebCodecs
    });
  }

  function defaultOutput(key, caps) {
    var outs = outputsFor(key, caps);
    var def = byKey[key] && byKey[key].def;
    return outs.indexOf(def) !== -1 ? def : outs[0];
  }

  // Outputs in labelled groups, for <optgroup>s: [{ label, keys }], the file's own kind first.
  // A single group has no label.
  var GROUP_LABELS = { video: 'Video', audio: 'Audio', image: 'Images', table: 'Tables', data: 'Data', doc: 'Documents' };
  function groupsFor(key, caps) {
    var outs = outputsFor(key, caps), groups = [], own = byKey[key] && (byKey[key].group || byKey[key].kind);
    Object.keys(GROUP_LABELS).sort(function (a, b) { return (b === own) - (a === own); }).forEach(function (g) {
      var keys = outs.filter(function (o) { return (byKey[o].group || byKey[o].kind) === g; });
      if (keys.length) groups.push({ label: GROUP_LABELS[g], keys: keys });
    });
    if (groups.length === 1) groups[0].label = '';
    return groups;
  }

  // Which converter handles a conversion: 'image', 'media' (video and audio) or 'data'.
  // A GIF going to MP4 is media.
  var MEDIA = { video: true, audio: true };
  function handler(from, to) {
    var f = byKey[from], t = byKey[to];
    if (!f) return null;
    return MEDIA[f.kind] || (t && MEDIA[t.kind]) ? 'media' : f.kind;
  }

  // photo.png -> photo.jpg
  function outputName(name, key) {
    var base = (name || 'file').replace(/\.[^.\\/]+$/, '') || name || 'file';
    return base + '.' + key;
  }

  return { list: list, get: function (k) { return byKey[k]; }, detect: detect,
    outputsFor: outputsFor, groupsFor: groupsFor, handler: handler, defaultOutput: defaultOutput, outputName: outputName, extOf: extOf };
}, { worker: true });
