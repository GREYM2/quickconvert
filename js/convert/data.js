/*
 * Data conversions: CSV <-> JSON <-> XLSX, TXT -> HTML, Markdown -> HTML/TXT.
 * CSV is parsed by hand. SheetJS (XLSX) and marked (Markdown) load only when needed.
 */
QC.define('data', function (QC) {
  'use strict';

  var PREVIEW_ROWS = 200;

  /* ---------- CSV ---------- */

  // Pick the most frequent of , ; TAB in the first line (outside quotes).
  function detectDelimiter(text) {
    var counts = { ',': 0, ';': 0, '\t': 0 }, inQuotes = false;
    for (var i = 0; i < text.length && i < 65536; i++) {
      var c = text[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes && (c === '\n' || c === '\r')) break;
      else if (!inQuotes && c in counts) counts[c]++;
    }
    var best = ',';
    if (counts[';'] > counts[best]) best = ';';
    if (counts['\t'] > counts[best]) best = '\t';
    return best;
  }

  // RFC 4180: quoted fields, "" escapes, CRLF/LF/CR line ends. Blank lines are skipped.
  function parseCSV(text, delim) {
    delim = delim || detectDelimiter(text);
    var rows = [], row = [], n = text.length, i = 0, value;
    function endRow() {
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    }
    while (i < n) {
      if (text.charCodeAt(i) === 34) {                       // quoted field
        var parts = [], j = i + 1;
        for (;;) {
          var q = text.indexOf('"', j);
          if (q === -1) { parts.push(text.slice(j)); i = n; break; } // unterminated: take the rest
          parts.push(text.slice(j, q));
          if (text.charCodeAt(q + 1) === 34) { parts.push('"'); j = q + 2; continue; }
          i = q + 1;
          break;
        }
        value = parts.join('');
        while (i < n && text[i] !== delim && text[i] !== '\n' && text[i] !== '\r') value += text[i++]; // lenient
      } else {
        var k = i;
        while (k < n) {
          var ch = text[k];
          if (ch === delim || ch === '\n' || ch === '\r') break;
          k++;
        }
        value = text.slice(i, k);
        i = k;
      }
      row.push(value);
      if (i >= n) break;
      if (text[i] === delim) {
        i++;
        if (i === n) row.push('');                            // "a,b," ends with an empty field
        continue;
      }
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
      i++;
      endRow();
    }
    if (row.length) endRow();
    return rows;
  }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) v = dateText(v);
    else if (typeof v === 'object') v = JSON.stringify(v);
    var s = String(v);
    return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(rows) {
    var lines = new Array(rows.length);
    for (var r = 0; r < rows.length; r++) lines[r] = rows[r].map(csvCell).join(',');
    return lines.length ? lines.join('\r\n') + '\r\n' : '';
  }

  /* ---------- tables ---------- */

  // "42" -> 42, but "007", "1.50", "1e3", " 1" stay strings so nothing changes on the way back.
  function inferValue(s) {
    if (typeof s !== 'string' || s === '' || s.length > 20) return s;
    var n = Number(s);
    return isFinite(n) && String(n) === s ? n : s;
  }

  function uniqueHeaders(header) {
    var seen = Object.create(null);
    return header.map(function (h, i) {
      var name = h === null || h === undefined || h === '' ? 'column_' + (i + 1) : String(h);
      var base = name, k = 1;
      while (seen[name]) name = base + '_' + (++k);
      seen[name] = true;
      return name;
    });
  }

  // [[header...], [row...], ...] -> [{header: value}, ...]
  function rowsToObjects(rows, infer) {
    if (!rows.length) return [];
    var width = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i].length > width) width = rows[i].length;
    var header = rows[0].slice();
    while (header.length < width) header.push('');
    var keys = uniqueHeaders(header);
    var out = new Array(rows.length - 1);
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r], o = Object.create(null);  // no prototype: a "__proto__" column is just a key
      for (var c = 0; c < keys.length; c++) {
        var v = c < row.length ? row[c] : '';
        if (v === null || v === undefined) v = '';
        o[keys[c]] = infer ? inferValue(v) : v;
      }
      out[r - 1] = o;
    }
    return out;
  }

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function jsonCell(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : v;
  }

  // Any JSON value -> rows. Arrays of objects get a header row (union of keys, first-seen order).
  function jsonToRows(value) {
    if (isObject(value)) {
      var keys = Object.keys(value);
      value = keys.length === 1 && Array.isArray(value[keys[0]]) ? value[keys[0]] : [value]; // { "data": [...] }
    }
    if (!Array.isArray(value)) value = [value];
    if (value.length && value.every(Array.isArray)) {
      return value.map(function (r) { return r.map(jsonCell); });
    }
    var header = [], index = Object.create(null);
    var objects = value.map(function (v) { return isObject(v) ? v : { value: v }; });
    objects.forEach(function (o) {
      Object.keys(o).forEach(function (k) {
        if (!(k in index)) { index[k] = header.length; header.push(k); }
      });
    });
    if (!header.length) return [];
    var rows = [header];
    objects.forEach(function (o) {
      var row = new Array(header.length).fill('');
      Object.keys(o).forEach(function (k) { row[index[k]] = jsonCell(o[k]); });
      rows.push(row);
    });
    return rows;
  }

  function inferRows(rows) {
    return rows.map(function (r, i) { return i === 0 ? r : r.map(inferValue); }); // keep header as text
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // Spreadsheet dates have no time zone, so print them as written instead of as UTC.
  function dateText(d) {
    var s = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (d.getHours() || d.getMinutes() || d.getSeconds()) s += ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    return s;
  }

  /* ---------- XLSX (SheetJS) ---------- */

  async function sheetjs() {
    await QC.loadScript(QC.libs.xlsx);
    return self.XLSX;
  }

  function writeXlsx(X, rows) {
    var wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), 'Sheet1');
    return X.write(wb, { type: 'array', bookType: 'xlsx', compression: true });
  }

  // First sheet as rows. For CSV: text as Excel shows it, but full-precision numbers.
  function readXlsx(X, buffer, forCsv) {
    var wb = X.read(buffer, { type: 'array', cellDates: true, dense: true });
    var name = wb.SheetNames[0];
    if (!name) throw QC.error('decode', 'The workbook has no sheets.');
    var rows = X.utils.sheet_to_json(wb.Sheets[name], forCsv
      ? { header: 1, raw: false, rawNumbers: true, defval: '', blankrows: false }
      : { header: 1, raw: true, defval: '', blankrows: false });
    if (!forCsv) rows = rows.map(function (r) { return r.map(function (v) { return v instanceof Date ? dateText(v) : v; }); });
    return { rows: rows, sheets: wb.SheetNames.length };
  }

  /* ---------- text and Markdown ---------- */

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  /* ----- page style for HTML output: background, matching text colour, font ----- */

  // Fonts that need no download.
  var LOCAL_FONTS = {
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, Consolas, "Courier New", monospace'
  };

  function luminance(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 1;
    var c = [0, 2, 4].map(function (i) {
      var v = parseInt(m[1].substr(i, 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // Dark or light text, whichever reads better on the background (higher contrast).
  function textOn(bg) {
    var l = luminance(bg);
    var dark = (l + 0.05) / (luminance('#1e1e20') + 0.05), light = (luminance('#e8e8e5') + 0.05) / (l + 0.05);
    return dark >= light ? '#1e1e20' : '#e8e8e5';
  }

  // "g:Open Sans" -> Google Fonts family name, or '' for a built-in font.
  function googleFamily(font) {
    var name = /^g:([A-Za-z0-9 ]{1,60})$/.exec(font || '');
    return name ? name[1].trim() : '';
  }

  function googleFontUrl(name, weights) {
    return 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name).replace(/%20/g, '+') +
      (weights ? ':wght@400;700' : '') + '&display=swap';
  }

  // page: { background: '#rrggbb', font: 'system' | 'serif' | 'mono' | 'g:<Google family>', weights }
  function htmlPage(title, body, page) {
    page = page || {};
    var bg = /^#[0-9a-f]{6}$/i.test(page.background || '') ? page.background : '#ffffff';
    var family = googleFamily(page.font);
    var stack = family ? '"' + family + '", ' + LOCAL_FONTS.system : LOCAL_FONTS[page.font] || LOCAL_FONTS.system;
    return '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + escapeHtml(title) + '</title>\n' +
      (family ? '<link rel="stylesheet" href="' + googleFontUrl(family, page.weights) + '">\n' : '') +
      '<style>body{max-width:46rem;margin:2rem auto;padding:0 1rem;font:16px/1.6 ' + stack + ';' +
      'background:' + bg + ';color:' + textOn(bg) + '}a{color:inherit}' +
      'pre,code{font-family:ui-monospace,Consolas,monospace}pre{overflow:auto;padding:1rem;background:rgba(128,128,128,.12)}' +
      'table{border-collapse:collapse}th,td{border:1px solid rgba(128,128,128,.4);padding:.3rem .6rem}img{max-width:100%}</style>\n' +
      '</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  }

  function textToHtml(text) {
    return text.split(/\r?\n\s*\r?\n/).filter(function (p) { return p.trim(); }).map(function (p) {
      return '<p>' + escapeHtml(p.trim()).replace(/\r?\n/g, '<br>\n') + '</p>';
    }).join('\n');
  }

  async function markdownToHtml(text) {
    await QC.loadScript(QC.libs.marked);
    return self.marked.parse(text, { gfm: true });
  }

  function decodeEntities(s) {
    var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') {
        var code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return named[e.toLowerCase()] || m;
    });
  }

  // Rendered Markdown HTML -> readable plain text.
  function htmlToText(html) {
    return decodeEntities(html
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|h[1-6]|blockquote|pre|tr)>/gi, '\n')
      .replace(/<\/t[dh]>\s*/gi, '\t')
      .replace(/<tr[^>]*>\s*/gi, '')
      .replace(/<[^>]*>/g, ''))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';
  }

  /* ---------- task ---------- */

  async function readText(file) {
    return new TextDecoder('utf-8').decode(await file.arrayBuffer()); // strips a UTF-8 BOM
  }

  function parseJSON(text) {
    try { return JSON.parse(text); }
    catch (e) { throw QC.error('decode', 'Not valid JSON.'); }
  }

  function title(name) { return (name || 'Document').replace(/\.[^.]+$/, ''); }

  // Returns { blob, rows?, note? }
  async function convert(file, opts, progress) {
    var from = opts.from, to = opts.to, X, rows, out, note = '', count;
    progress(0.1);

    if (from === 'xlsx') {
      X = await sheetjs();
      progress(0.3);
      var book;
      try { book = readXlsx(X, await file.arrayBuffer(), to === 'csv'); }
      catch (e) { throw e.code ? e : QC.error('decode', 'Could not read this workbook.'); }
      rows = book.rows;
      if (book.sheets > 1) note = 'first sheet only (of ' + book.sheets + ')';
    } else {
      var text = await readText(file);
      if (from === 'csv') rows = parseCSV(text);
      else if (from === 'json') rows = jsonToRows(parseJSON(text));
    }
    progress(0.6);

    switch (from + '>' + to) {
      case 'csv>json':
      case 'xlsx>json':
        var objects = rowsToObjects(rows, from === 'csv');
        count = objects.length;
        out = JSON.stringify(objects, null, 2) + '\n';
        break;
      case 'json>csv':
      case 'xlsx>csv':
        count = Math.max(0, rows.length - 1);
        out = '﻿' + toCSV(rows); // BOM so Excel opens UTF-8 correctly
        break;
      case 'csv>xlsx':
      case 'json>xlsx':
        X = await sheetjs();
        count = Math.max(0, rows.length - 1);
        out = writeXlsx(X, from === 'csv' ? inferRows(rows) : rows);
        break;
      case 'txt>html':
        out = htmlPage(title(file.name), textToHtml(text), opts.page);
        break;
      case 'md>html':
        out = htmlPage(title(file.name), await markdownToHtml(text), opts.page);
        break;
      case 'md>txt':
        out = htmlToText(await markdownToHtml(text));
        break;
      default:
        throw QC.error('unsupported', 'Can\'t convert ' + from.toUpperCase() + ' to ' + to.toUpperCase() + '.');
    }
    progress(0.95);
    var mime = QC.formats.get(to).mime;
    if (typeof out === 'string' && to !== 'xlsx') mime += ';charset=utf-8';
    // First rows for the page to show as a table (header + up to PREVIEW_ROWS).
    var preview = rows ? rows.slice(0, PREVIEW_ROWS + 1) : undefined;
    return { blob: new Blob([out], { type: mime }), rows: count, note: note, preview: preview };
  }

  return {
    convert: convert, parseCSV: parseCSV, toCSV: toCSV, detectDelimiter: detectDelimiter,
    rowsToObjects: rowsToObjects, jsonToRows: jsonToRows, inferValue: inferValue, htmlToText: htmlToText,
    textOn: textOn, googleFontUrl: googleFontUrl
  };
}, { worker: true });
