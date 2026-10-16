/*
 * Conversions between data and document files. Every input is read into one of three shapes,
 * and every output is written from one of them:
 *   table  rows of cells (sheets)   CSV, TSV, XLSX, ODS, XLS, tables in an HTML page
 *   value  any JSON value           JSON, YAML, XML
 *   doc    the document model       TXT, Markdown, HTML, DOCX (js/convert/doc.js, docx.js)
 * Shapes convert into each other (a table becomes a list of objects, a value becomes a table
 * or a list, a table goes into a document), so any listed input reaches any listed output.
 * CSV and XML are handled here; SheetJS, js-yaml and marked load only when needed.
 */
QC.define('data', function (QC) {
  'use strict';

  var PREVIEW_ROWS = 200;
  var MAX_PREVIEW_HTML = 4e6;   // bigger pages are shown as code only

  function set(words) {
    var o = Object.create(null);
    words.split(' ').forEach(function (w) { o[w] = true; });
    return o;
  }

  var TABLE_IN = set('csv tsv xlsx ods xls'), SHEET_IN = set('xlsx ods xls'), VALUE_IN = set('json yaml xml');
  var TEXT_IN = set('csv tsv json yaml xml txt md html');
  var TABLE_OUT = set('csv tsv xlsx ods'), VALUE_OUT = set('json yaml xml'), DOC_OUT = set('html md txt docx');

  // Per-file settings for data and document files (item.doc on the page).
  function defaults() {
    return {
      encoding: 'auto',       // text files: auto | utf-8 | utf-16le | windows-1251 | windows-1252
      delimiter: 'auto',      // CSV input: auto | , | ; | \t | |
      sheet: 0,               // spreadsheets: sheet index, or 'all'
      table: 0,               // HTML page -> table output: which table
      header: true,           // first row holds the column names
      types: true,            // text tables: "42" becomes the number 42
      mainOnly: false,        // HTML page -> document: skip menus, headers, footers
      csvDelimiter: ',',      // CSV output
      bom: true,              // CSV/TSV output starts with a UTF-8 BOM, so Excel reads it right
      indent: '2',            // JSON/YAML/XML output: 2 | 4 | tab | min
      sortKeys: false,        // JSON/YAML/XML output from data
      layout: 'auto',         // data -> HTML/Markdown: auto | table | list
      docxFont: 'Calibri',
      docxSize: '11'
    };
  }

  // Which settings matter for a conversion; the panel shows only these.
  function settingsFor(from, to) {
    var pageTables = from === 'html' && !!(TABLE_OUT[to] || VALUE_OUT[to]);
    var textTable = from === 'csv' || from === 'tsv' || pageTables;
    return {
      encoding: !!TEXT_IN[from],
      delimiter: from === 'csv',
      sheet: !!SHEET_IN[from],
      sheetAll: !!SHEET_IN[from] && to !== 'csv' && to !== 'tsv',
      table: pageTables,
      header: !!(TABLE_IN[from] || pageTables) && to !== 'csv' && to !== 'tsv',
      types: textTable && !!(VALUE_OUT[to] || to === 'xlsx' || to === 'ods'),
      mainOnly: from === 'html' && !!DOC_OUT[to],
      csvDelimiter: to === 'csv',
      bom: to === 'csv' || to === 'tsv',
      indent: !!VALUE_OUT[to],
      indentAll: !!VALUE_OUT[to] && to !== 'yaml',      // YAML can't use tabs or be minified
      sortKeys: !!VALUE_OUT[to] && !!VALUE_IN[from],
      layout: !!VALUE_IN[from] && (to === 'html' || to === 'md'),
      page: to === 'html',
      docx: to === 'docx'
    };
  }

  /* ---------- CSV ---------- */

  // Pick the most frequent of , ; TAB | in the first line (outside quotes).
  function detectDelimiter(text) {
    var counts = { ',': 0, ';': 0, '\t': 0, '|': 0 }, inQuotes = false;
    for (var i = 0; i < text.length && i < 65536; i++) {
      var c = text[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes && (c === '\n' || c === '\r')) break;
      else if (!inQuotes && c in counts) counts[c]++;
    }
    var best = ',';
    [';', '\t', '|'].forEach(function (d) { if (counts[d] > counts[best]) best = d; });
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

  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return dateText(v);
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  function toCSV(rows, delim) {
    delim = delim || ',';
    var special = new RegExp('["\\r\\n' + (delim === '\t' ? '\\t' : delim === '|' ? '\\|' : delim) + ']|^\\s|\\s$');
    var lines = new Array(rows.length);
    for (var r = 0; r < rows.length; r++) {
      lines[r] = rows[r].map(function (v) {
        var s = cellText(v);
        return special.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(delim);
    }
    return lines.length ? lines.join('\r\n') + '\r\n' : '';
  }

  /* ---------- tables and values ---------- */

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

  function rowsToValue(rows, header, infer) {
    if (header) return rowsToObjects(rows, infer);
    return infer ? rows.map(function (r) { return r.map(inferValue); }) : rows;
  }

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date); }

  // { "data": { "items": [...] } } -> the array inside. XML attributes ("@id") don't count as keys.
  // loose (for tables): also the one list of records next to other keys, e.g. { "page": 1, "users": [{...}] }.
  function records(value, loose) {
    for (var depth = 0; depth < 8 && isObject(value); depth++) {
      var keys = Object.keys(value).filter(function (k) { return k[0] !== '@'; });
      if (loose && keys.length > 1) {
        var lists = keys.filter(function (k) { var v = value[k]; return Array.isArray(v) && v.length && v.every(isObject); });
        if (lists.length === 1) return value[lists[0]];
      }
      if (keys.length !== 1) break;
      var inner = value[keys[0]];
      if (Array.isArray(inner)) return inner;
      if (!isObject(inner)) break;
      value = inner;
    }
    return value;
  }

  function jsonCell(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    return typeof v === 'object' ? JSON.stringify(v) : v;
  }

  // Any value -> rows. Arrays of objects get a header row (union of keys, first-seen order).
  function jsonToRows(value) {
    value = records(value, true);
    if (isObject(value)) value = [value];
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

  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (!isObject(v)) return v;
    var out = Object.create(null);
    Object.keys(v).sort(function (a, b) { return a.localeCompare(b); }).forEach(function (k) { out[k] = sortKeys(v[k]); });
    return out;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // Spreadsheet dates have no time zone, so print them as written instead of as UTC.
  function dateText(d) {
    var s = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (d.getHours() || d.getMinutes() || d.getSeconds()) s += ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    return s;
  }

  function scalar(v) {
    if (v === null || v === undefined) return '';
    return v instanceof Date ? v.toISOString() : String(v);
  }

  /* ---------- JSON, YAML ---------- */

  // Also reads JSON Lines (one value per line).
  function parseJSON(text) {
    try { return JSON.parse(text); }
    catch (e) {
      var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (lines.length > 1) {
        try { return lines.map(function (l) { return JSON.parse(l); }); } catch (e2) { /* not JSON Lines either */ }
      }
      throw QC.error('decode', 'Not valid JSON (' + String(e.message || '').replace(/^JSON\.parse: /, '').slice(0, 120) + ').');
    }
  }

  function indentUnit(indent) { return indent === 'tab' ? '\t' : indent === 'min' ? '' : indent === '4' ? '    ' : '  '; }

  function toJSON(value, indent) {
    var unit = indentUnit(indent);
    return JSON.stringify(value, null, unit) + (unit ? '\n' : '');
  }

  async function yaml() {
    await QC.loadScript(QC.libs.yaml);
    return self.jsyaml;
  }

  async function parseYaml(text) {
    var Y = await yaml();
    try {
      var docs = Y.loadAll(text);
      return docs.length === 1 ? docs[0] : docs;     // several "---" documents become a list
    } catch (e) {
      throw QC.error('decode', 'Not valid YAML' + (e.mark ? ' (line ' + (e.mark.line + 1) + ')' : '') + '.');
    }
  }

  async function toYaml(value, indent) {
    var Y = await yaml();
    return Y.dump(value, { indent: indent === '4' ? 4 : 2, lineWidth: -1, noRefs: true });
  }

  /* ---------- XML ---------- */

  // <a id="1"><b>x</b><b>y</b></a> -> { a: { "@id": "1", b: ["x", "y"] } }
  function xmlToValue(text) {
    var M = QC.markup, tree = M.parseXml(text);
    var root = tree.children.find(function (c) { return c.name !== undefined; });
    if (!root) throw QC.error('decode', 'Not valid XML (no root element).');
    function node(el) {
      var obj = Object.create(null), many = Object.create(null), attrs = 0, kids = 0, texts = '';
      Object.keys(el.attrs).forEach(function (k) {
        if (k === 'xmlns' || k.indexOf('xmlns:') === 0) return;
        obj['@' + k] = el.attrs[k];
        attrs++;
      });
      el.children.forEach(function (c) {
        if (c.name === undefined) { texts += c.text; return; }
        kids++;
        var v = node(c);
        if (c.name in obj) {
          if (!many[c.name]) { obj[c.name] = [obj[c.name]]; many[c.name] = true; }
          obj[c.name].push(v);
        } else obj[c.name] = v;
      });
      var t = texts.trim();
      if (!kids && !attrs) return t;
      if (t) obj['#text'] = t;
      return obj;
    }
    var out = Object.create(null);
    out[root.name] = node(root);
    return out;
  }

  function xmlName(n) {
    n = String(n).replace(/[^\p{L}\p{N}_.:-]/gu, '_');
    return /^[\p{L}_]/u.test(n) ? n : '_' + n;
  }

  function valueToXml(value, indent, itemName) {
    var x = QC.markup.escapeXml, unit = indentUnit(indent), nl = unit ? '\n' : '';
    var rootName = 'root', content = value;
    if (isObject(value)) {
      var keys = Object.keys(value);
      if (keys.length === 1 && keys[0][0] !== '@' && keys[0] !== '#text' && !Array.isArray(value[keys[0]])) {
        rootName = keys[0];
        content = value[keys[0]];
      }
    }
    if (Array.isArray(content)) { var wrap = Object.create(null); wrap[itemName || 'item'] = content; content = wrap; }
    function repeat(d) { return new Array(d + 1).join(unit); }
    function el(name, v, depth) {
      if (Array.isArray(v)) return v.map(function (item) { return el(name, item, depth); }).filter(Boolean).join(nl);
      var tag = xmlName(name), padding = repeat(depth);
      if (v === null || v === undefined || v === '') return padding + '<' + tag + '/>';
      if (!isObject(v)) return padding + '<' + tag + '>' + x(scalar(v)) + '</' + tag + '>';
      var attrs = '', kids = [], text = '';
      Object.keys(v).forEach(function (k) {
        var val = v[k];
        if (k[0] === '@' && !isObject(val) && !Array.isArray(val)) attrs += ' ' + xmlName(k.slice(1)) + '="' + x(scalar(val)) + '"';
        else if (k === '#text') text = x(scalar(val));
        else { var child = el(k, val, depth + 1); if (child) kids.push(child); }
      });
      if (!kids.length) return padding + '<' + tag + attrs + (text ? '>' + text + '</' + tag + '>' : '/>');
      return padding + '<' + tag + attrs + '>' + (text ? nl + repeat(depth + 1) + text : '') + nl + kids.join(nl) + nl + padding + '</' + tag + '>';
    }
    return '<?xml version="1.0" encoding="UTF-8"?>' + nl + el(rootName, content, 0) + nl;
  }

  /* ---------- spreadsheets (SheetJS) ---------- */

  // The full build (XLS support) replaces the small one and is never swapped back.
  async function sheetjs(full) {
    if (full) await QC.loadScript(QC.libs.xlsxFull);
    else if (!self.XLSX) await QC.loadScript(QC.libs.xlsx);
    return self.XLSX;
  }

  // For CSV: text as Excel shows it, but full-precision numbers. Otherwise raw values.
  function readBook(X, buffer, asText) {
    var wb;
    try { wb = X.read(buffer, { type: 'array', cellDates: true, dense: true }); }
    catch (e) { throw QC.error('decode', 'Could not read this spreadsheet.'); }
    if (!wb.SheetNames.length) throw QC.error('decode', 'The workbook has no sheets.');
    return {
      names: wb.SheetNames.slice(),
      rows: function (i) {
        var rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], asText
          ? { header: 1, raw: false, rawNumbers: true, defval: '', blankrows: false }
          : { header: 1, raw: true, defval: '', blankrows: false });
        return asText ? rows : rows.map(function (r) { return r.map(function (v) { return v instanceof Date ? dateText(v) : v; }); });
      }
    };
  }

  function sheetName(name, used) {
    var base = String(name || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Sheet', out = base, k = 1;
    while (used[out.toLowerCase()]) out = base.slice(0, 26) + ' (' + (++k) + ')';
    used[out.toLowerCase()] = true;
    return out;
  }

  function columnWidths(rows) {
    var w = [];
    for (var r = 0; r < rows.length && r < 1000; r++) {
      for (var c = 0; c < rows[r].length; c++) w[c] = Math.max(w[c] || 6, Math.min(60, cellText(rows[r][c]).length + 2));
    }
    return w.map(function (n) { return { wch: n || 6 }; });
  }

  function writeBook(X, sheets, bookType, header) {
    var wb = X.utils.book_new(), used = {};
    sheets.forEach(function (s) {
      var ws = X.utils.aoa_to_sheet(s.rows.length ? s.rows : [[]]);
      ws['!cols'] = columnWidths(s.rows);
      if (header && s.rows.length > 1 && ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] };   // filter buttons on the header
      X.utils.book_append_sheet(wb, ws, sheetName(s.name, used));
    });
    return X.write(wb, { type: 'array', bookType: bookType, compression: true });
  }

  /* ---------- data -> document ---------- */

  function isNested(v) { return Array.isArray(v) ? v.length > 0 : isObject(v) && Object.keys(v).length > 0; }

  function valueBlocks(v) {
    if (!isNested(v)) return [{ type: 'para', inlines: [{ text: Array.isArray(v) ? '(empty list)' : isObject(v) ? '(empty)' : scalar(v) || '(empty)' }] }];
    var items = Array.isArray(v)
      ? v.map(function (item, i) { return itemBlocks(isNested(item) ? 'Item ' + (i + 1) : null, item); })
      : Object.keys(v).map(function (k) { return itemBlocks(k, v[k]); });
    return [{ type: 'list', ordered: false, start: 1, items: items }];
  }

  function itemBlocks(key, v) {
    var label = key === null ? [] : [{ text: key, b: 1 }];
    if (isNested(v)) return [{ type: 'para', inlines: label }].concat(valueBlocks(v));
    var text = Array.isArray(v) ? '(empty list)' : isObject(v) ? '(empty)' : v === null ? 'null' : scalar(v);
    return [{ type: 'para', inlines: label.length ? label.concat([{ text: ': ' + text }]) : [{ text: text || '""' }] }];
  }

  // Lists of records become a table; anything else a nested list of keys and values.
  function valueDoc(value, layout, title) {
    var rec = records(value);
    var tabular = Array.isArray(rec) && rec.length > 0 && rec.every(function (r) { return isObject(r) || Array.isArray(r); });
    if (layout === 'table' || (layout !== 'list' && tabular)) {
      var rows = jsonToRows(value), header = !(Array.isArray(rec) && rec.every(Array.isArray));
      return { title: title, blocks: [QC.doc.tableBlock(rows, header)] };
    }
    return { title: title, blocks: valueBlocks(value) };
  }

  function hasPictures(blocks) {
    return blocks.some(function (b) {
      if (b.inlines) return b.inlines.some(function (r) { return r.img; });
      if (b.blocks) return hasPictures(b.blocks);
      if (b.items) return b.items.some(hasPictures);
      if (b.rows) return b.rows.some(function (r) { return r.some(function (c) { return c.some(function (x) { return x.img; }); }); });
      return false;
    });
  }

  /* ---------- convert ---------- */

  var ENCODING_NAMES = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16', 'windows-1251': 'Windows-1251', 'windows-1252': 'Windows-1252' };

  function baseName(name) { return (name || 'Document').replace(/\.[^.]+$/, ''); }

  // file -> { shape: 'table' | 'value' | 'doc', ... }
  async function read(file, from, to, o, name) {
    var info = {}, notes = [];
    if (SHEET_IN[from]) {
      var X = await sheetjs(from === 'xls');
      var book = readBook(X, await file.arrayBuffer(), to === 'csv' || to === 'tsv');
      info.sheets = book.names;
      var all = o.sheet === 'all' && to !== 'csv' && to !== 'tsv';
      var index = Math.min(Math.max(0, parseInt(o.sheet, 10) || 0), book.names.length - 1);
      var sheets = all ? book.names.map(function (n, i) { return { name: n, rows: book.rows(i) }; })
        : [{ name: book.names[index], rows: book.rows(index) }];
      if (!all && book.names.length > 1) notes.push('sheet ' + (index + 1) + ' of ' + book.names.length);
      return { shape: 'table', sheets: sheets, typed: true, info: info, notes: notes };
    }
    if (from === 'docx') {
      var doc = await QC.docx.read(await file.arrayBuffer(), { images: to === 'html' });
      if (doc.pictures && to !== 'html') notes.push(doc.pictures === 1 ? 'picture left out' : doc.pictures + ' pictures left out');
      return { shape: 'doc', doc: doc, info: info, notes: notes };
    }
    var decoded = QC.markup.decode(await file.arrayBuffer(), o.encoding), text = decoded.text;
    info.encoding = decoded.encoding;
    if (decoded.encoding !== 'utf-8') notes.push('read as ' + (ENCODING_NAMES[decoded.encoding] || decoded.encoding));
    switch (from) {
      case 'csv':
      case 'tsv':
        var delim = from === 'tsv' ? '\t' : o.delimiter && o.delimiter !== 'auto' ? o.delimiter : detectDelimiter(text);
        info.delimiter = delim;
        return { shape: 'table', sheets: [{ name: name, rows: parseCSV(text, delim) }], typed: false, info: info, notes: notes };
      case 'json': return { shape: 'value', value: parseJSON(text), info: info, notes: notes };
      case 'yaml': return { shape: 'value', value: await parseYaml(text), info: info, notes: notes };
      case 'xml': return { shape: 'value', value: xmlToValue(text), info: info, notes: notes };
      case 'txt': return { shape: 'doc', doc: QC.doc.fromText(text), info: info, notes: notes };
      case 'md': return { shape: 'doc', markdown: text, info: info, notes: notes };
      case 'html':
        if (!TABLE_OUT[to] && !VALUE_OUT[to]) return { shape: 'doc', doc: QC.doc.fromHtml(text, { mainOnly: o.mainOnly }), info: info, notes: notes };
        var tables = QC.doc.fromHtml(text).blocks.filter(function (b) { return b.type === 'table'; });
        info.tables = tables.map(function (t) {
          return { rows: t.rows.length, cols: t.rows.reduce(function (n, r) { return Math.max(n, r.length); }, 0) };
        });
        if (!tables.length) throw QC.error('decode', 'No tables found on this page.');
        var ti = Math.min(Math.max(0, parseInt(o.table, 10) || 0), tables.length - 1);
        if (tables.length > 1) notes.push('table ' + (ti + 1) + ' of ' + tables.length);
        var rows = tables[ti].rows.map(function (r) { return r.map(function (c) { return QC.doc.plain(c); }); });
        return { shape: 'table', sheets: [{ name: name, rows: rows }], typed: false, info: info, notes: notes };
    }
    throw QC.error('unsupported', 'Unsupported format.');
  }

  async function convert(file, opts, progress) {
    var from = opts.from, to = opts.to, o = Object.assign(defaults(), opts.doc || {});
    var fin = QC.formats.get(from), fout = QC.formats.get(to);
    if (!fin || !fout || fin.outputs.indexOf(to) === -1) {
      throw QC.error('unsupported', 'Can\'t convert ' + String(from).toUpperCase() + ' to ' + String(to).toUpperCase() + '.');
    }
    var name = baseName(file.name);
    progress(0.1);
    var src = await read(file, from, to, o, name);
    progress(0.6);

    var out, count, table = null, header = true, page = null;
    var headerRow = src.shape === 'table' ? !!o.header : true;
    var infer = src.shape === 'table' && !src.typed && o.types;

    if (TABLE_OUT[to]) {
      var sheets = src.shape === 'table' ? src.sheets
        : src.shape === 'value' ? [{ name: name, rows: jsonToRows(src.value) }] : null;
      if (!sheets) throw QC.error('unsupported', 'Can\'t convert this to a table.');
      if (to === 'csv' || to === 'tsv') {
        out = toCSV(sheets[0].rows, to === 'tsv' ? '\t' : o.csvDelimiter === ';' ? ';' : ',');
        if (o.bom) out = '﻿' + out;               // so Excel reads UTF-8 text correctly
      } else {
        var X = await sheetjs(false);
        out = writeBook(X, sheets.map(function (s) { return { name: s.name, rows: infer ? s.rows.map(function (r, i) { return headerRow && !i ? r : r.map(inferValue); }) : s.rows }; }),
          to, headerRow);
      }
      count = sheets.reduce(function (n, s) { return n + Math.max(0, s.rows.length - (headerRow ? 1 : 0)); }, 0);
      table = sheets[0].rows.slice(0, PREVIEW_ROWS + 1);
      header = headerRow;
    } else if (VALUE_OUT[to]) {
      var value;
      if (src.shape === 'value') value = o.sortKeys ? sortKeys(src.value) : src.value;
      else if (src.shape === 'table') {
        value = src.sheets.length === 1 ? rowsToValue(src.sheets[0].rows, headerRow, infer) : src.sheets.reduce(function (acc, s) {
          acc[s.name] = rowsToValue(s.rows, headerRow, infer);
          return acc;
        }, Object.create(null));
      } else throw QC.error('unsupported', 'Can\'t convert a document to data.');
      if (to === 'json') out = toJSON(value, o.indent);
      else if (to === 'yaml') out = await toYaml(value, o.indent);
      else out = valueToXml(value, o.indent, src.shape === 'table' ? 'row' : 'item');
      if (Array.isArray(value)) count = value.length;
      else if (Array.isArray(records(value))) count = records(value).length;
    } else {
      var doc;
      if (src.shape === 'doc') doc = src.doc || (to === 'html' ? null : await QC.doc.fromMarkdown(src.markdown));
      else if (src.shape === 'table') {
        doc = { title: name, blocks: [] };
        src.sheets.forEach(function (s) {
          if (src.sheets.length > 1) doc.blocks.push({ type: 'heading', level: 2, inlines: [{ text: s.name }] });
          doc.blocks.push(QC.doc.tableBlock(s.rows, headerRow));
        });
        count = src.sheets.reduce(function (n, s) { return n + Math.max(0, s.rows.length - (headerRow ? 1 : 0)); }, 0);
      } else doc = valueDoc(src.value, o.layout, name);
      var title = (doc && doc.title) || name;
      var wide = src.shape !== 'doc';                  // tables get the whole page width
      if (to === 'html') {
        var body = doc ? QC.doc.toHtml(doc) : await QC.doc.markdownHtml(src.markdown);
        out = QC.doc.htmlPage(title, body, opts.page, wide);
      } else if (to === 'md') {
        out = QC.doc.toMarkdown(doc);
        page = QC.doc.htmlPage(title, QC.doc.toHtml(doc), null, wide);
      } else if (to === 'txt') {
        out = QC.doc.toText(doc);
      } else {
        out = await QC.docx.write(doc, { font: o.docxFont, size: o.docxSize });
        page = QC.docx.preview(doc, { font: o.docxFont, size: o.docxSize });
        if (hasPictures(doc.blocks)) src.notes.push('pictures not included');
      }
    }
    progress(0.95);
    var mime = fout.mime;
    if (typeof out === 'string') mime += ';charset=utf-8';
    if (page && page.length > MAX_PREVIEW_HTML) page = null;
    return {
      blob: out instanceof Blob ? out : new Blob([out], { type: mime }),
      rows: count, note: src.notes.join(' · '),
      preview: table || undefined, previewHeader: header, previewHtml: page || undefined, info: src.info
    };
  }

  return {
    convert: convert, defaults: defaults, settingsFor: settingsFor,
    parseCSV: parseCSV, toCSV: toCSV, detectDelimiter: detectDelimiter, rowsToObjects: rowsToObjects,
    jsonToRows: jsonToRows, inferValue: inferValue, records: records,
    xmlToValue: xmlToValue, valueToXml: valueToXml, parseJSON: parseJSON
  };
}, { worker: true });
