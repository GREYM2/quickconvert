/*
 * Text decoding and markup parsing, for workers (no DOMParser there).
 *   decode(bytes, encoding)  -> { text, encoding }   BOM, strict UTF-8, then a legacy guess
 *   parseHtml(text)          -> tree                 forgiving, like a browser (implied end tags)
 *   parseXml(text)           -> tree                 well-formed XML, CDATA, namespaces kept
 * Tree nodes: { name, attrs, children } for elements, { text } for text. Names are lower case
 * in HTML and as written in XML.
 */
QC.define('markup', function (QC) {
  'use strict';

  /* ---------- text decoding ---------- */

  // Encodings offered in the settings (labels the browser's TextDecoder knows).
  var ENCODINGS = ['utf-8', 'utf-16le', 'windows-1251', 'windows-1252'];

  function tryDecode(bytes, label, fatal) {
    try { return new TextDecoder(label, { fatal: !!fatal }).decode(bytes); }
    catch (e) { return null; }
  }

  // <meta charset="..."> or <?xml encoding="..."?> near the start of the file.
  function declaredCharset(bytes) {
    var head = String.fromCharCode.apply(null, bytes.subarray(0, 1024));
    var m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head);
    return m && tryDecode(new Uint8Array(0), m[1]) !== null ? m[1].toLowerCase() : '';
  }

  // Cyrillic text is mostly non-ASCII letters; Western European text mostly ASCII with a few accents.
  function guessLegacy(bytes) {
    var high = 0, ascii = 0;
    for (var i = 0; i < bytes.length && i < 200000; i++) {
      var b = bytes[i];
      if (b >= 0xc0) high++;
      else if ((b | 32) >= 97 && (b | 32) <= 122) ascii++;
    }
    return high > (high + ascii) * 0.3 ? 'windows-1251' : 'windows-1252';
  }

  function decode(bytes, encoding) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: tryDecode(bytes, 'utf-8'), encoding: 'utf-8' };
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: tryDecode(bytes, 'utf-16le'), encoding: 'utf-16le' };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: tryDecode(bytes, 'utf-16be'), encoding: 'utf-16be' };
    if (encoding && encoding !== 'auto') return { text: tryDecode(bytes, encoding) || '', encoding: encoding };
    var utf8 = tryDecode(bytes, 'utf-8', true);
    if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };
    var zeros = 0;                                   // UTF-16 without a BOM: every other byte is 0
    for (var i = 1; i < bytes.length && i < 2000; i += 2) if (!bytes[i]) zeros++;
    var label = zeros > Math.min(bytes.length, 2000) / 4 ? 'utf-16le' : declaredCharset(bytes) || guessLegacy(bytes);
    return { text: tryDecode(bytes, label) || '', encoding: label };
  }

  /* ---------- entities ---------- */

  var NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', shy: '­', copy: '©', reg: '®',
    trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', bull: '•', middot: '·', deg: '°', plusmn: '±',
    times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
    larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', le: '≤', ge: '≥', ne: '≠', minus: '−',
    frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', zwj: '‍', zwnj: '‌',
    ensp: ' ', emsp: ' ', thinsp: ' ', iexcl: '¡', iquest: '¿', check: '✓'
  };

  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, function (m, e) {
      if (e[0] === '#') {
        var code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code < 0x110000 && !(code >= 0xd800 && code < 0xe000) ? String.fromCodePoint(code) : '�';
      }
      var v = NAMED[e] || NAMED[e.toLowerCase()];
      return v !== undefined && (m[m.length - 1] === ';' || e.length < 5) ? v : m;
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // XML 1.0 can't hold most control characters at all, so they're dropped.
  function escapeXml(s) {
    return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  /* ---------- parser ---------- */

  function set(words) {
    var o = Object.create(null);
    words.split(' ').forEach(function (w) { o[w] = true; });
    return o;
  }

  var VOID = set('area base br col embed hr img input link meta param source track wbr');
  var RAW = set('script style textarea title xmp noembed noframes');
  var CLOSES_P = set('address article aside blockquote details dialog div dl fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul');
  // Block elements. An inline end tag never closes one (a stray </span> doesn't end a <div>).
  var SPECIAL = set('address article aside blockquote body button caption center dd details dialog dir div dl dt fieldset ' +
    'figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup html li main menu nav ol p pre section summary ' +
    'table tbody td template tfoot th thead tr ul');
  var TABLE_SCOPE = set('html td th caption table template');
  var TABLE_PARTS = set('table caption thead tbody tfoot tr td th');

  function parseAttrs(src) {
    var attrs = Object.create(null), re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, m;
    while ((m = re.exec(src))) {
      var name = m[1];
      if (!(name in attrs)) attrs[name] = decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '');
    }
    return attrs;
  }

  function parse(src, html) {
    var root = { name: '#root', attrs: {}, children: [] }, stack = [root], i = 0, n = src.length;
    function top() { return stack[stack.length - 1]; }
    function text(t) {
      if (!t) return;
      var kids = top().children, last = kids[kids.length - 1];
      if (last && last.text !== undefined) last.text += t;
      else kids.push({ text: t });
    }
    function popTo(index) { stack.length = Math.max(1, index); }
    // Implied end tags: close the nearest open `names` element, unless a `stop` element comes first.
    function closeOpen(names, stop) {
      for (var k = stack.length - 1; k > 0; k--) {
        var nm = stack[k].name;
        if (names[nm]) { popTo(k); return; }
        if (stop[nm]) return;
      }
    }
    var P = set('p'), LI = set('li'), DTDD = set('dt dd'), TR = set('tr'), CELL = set('td th'),
      SECTION = set('thead tbody tfoot'), OPTION = set('option');
    var TAG = /<(\/?)([A-Za-z][^\s\/>]*)/y;      // sticky: matches right at TAG.lastIndex
    var P_STOP = set('html body td th caption table button template'), LI_STOP = set('ul ol menu td th table body html'),
      DL_STOP = set('dl td th table body html'), TABLE = set('table html'), ROW = set('tr table html'), SELECT = set('select');

    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt === -1) { text(decodeEntities(src.slice(i))); break; }
      if (lt > i) text(decodeEntities(src.slice(i, lt)));
      i = lt;
      if (src.startsWith('<!--', i)) {
        var endC = src.indexOf('-->', i + 4);
        i = endC === -1 ? n : endC + 3;
        continue;
      }
      if (!html && src.startsWith('<![CDATA[', i)) {
        var endD = src.indexOf(']]>', i + 9);
        text(src.slice(i + 9, endD === -1 ? n : endD));
        i = endD === -1 ? n : endD + 3;
        continue;
      }
      var c = src[i + 1];
      if (c === '!' || c === '?') {                          // doctype, processing instruction
        var endP = src.indexOf('>', i);
        i = endP === -1 ? n : endP + 1;
        continue;
      }
      TAG.lastIndex = i;
      var m = TAG.exec(src);
      if (!m) { text('<'); i++; continue; }                  // a stray "<" is just text
      // Find the end of the tag, skipping ">" inside quoted attribute values.
      var j = i + m[0].length, quote = '';
      while (j < n) {
        var ch = src[j];
        if (quote) { if (ch === quote) quote = ''; }
        else if (ch === '"' || ch === '\'') quote = ch;
        else if (ch === '>') break;
        j++;
      }
      var inner = src.slice(i + m[0].length, j), name = html ? m[2].toLowerCase() : m[2];
      i = j + 1;

      if (m[1]) {                                            // end tag
        if (html && name === 'br') { top().children.push({ name: 'br', attrs: {}, children: [] }); continue; }
        for (var k = stack.length - 1; k > 0; k--) {
          var open = stack[k].name;
          if (open === name) { popTo(k); break; }
          if (html && ((TABLE_SCOPE[open] && !TABLE_PARTS[name]) || (SPECIAL[open] && !SPECIAL[name]))) break;
        }
        continue;
      }

      var selfClose = /\/\s*$/.test(inner);
      if (html) {
        if (CLOSES_P[name]) closeOpen(P, P_STOP);
        if (name === 'li') closeOpen(LI, LI_STOP);
        else if (DTDD[name]) closeOpen(DTDD, DL_STOP);
        else if (name === 'tr') closeOpen(TR, TABLE);
        else if (CELL[name]) closeOpen(CELL, ROW);
        else if (SECTION[name]) closeOpen(SECTION, TABLE);
        else if (name === 'option') closeOpen(OPTION, SELECT);
      }
      var el = { name: name, attrs: parseAttrs(selfClose ? inner.replace(/\/\s*$/, '') : inner), children: [] };
      top().children.push(el);
      if (html && VOID[name] || selfClose) continue;
      if (html && RAW[name]) {                              // content up to the end tag, as plain text
        var re = new RegExp('</' + name + '\\s*>', 'ig');
        re.lastIndex = i;
        var end = re.exec(src), body = src.slice(i, end ? end.index : n);
        if (body) el.children.push({ text: name === 'title' || name === 'textarea' ? decodeEntities(body) : body });
        i = end ? end.index + end[0].length : n;
        continue;
      }
      stack.push(el);
    }
    return root;
  }

  function parseHtml(src) { return parse(String(src || ''), true); }
  function parseXml(src) { return parse(String(src || ''), false); }

  /* ---------- tree helpers ---------- */

  // Local name without a namespace prefix: "w:p" -> "p".
  function local(name) { var k = name.indexOf(':'); return k === -1 ? name : name.slice(k + 1); }

  function textOf(node) {
    if (node.text !== undefined) return node.text;
    var out = '';
    for (var i = 0; i < node.children.length; i++) out += textOf(node.children[i]);
    return out;
  }

  // Depth-first search for elements matching `test(node)`.
  function findAll(node, test, out) {
    out = out || [];
    (node.children || []).forEach(function (c) {
      if (c.name === undefined) return;
      if (test(c)) out.push(c);
      findAll(c, test, out);
    });
    return out;
  }

  function find(node, test) {
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.name === undefined) continue;
      if (test(c)) return c;
      var deep = find(c, test);
      if (deep) return deep;
    }
    return null;
  }

  // Direct children with this name (prefix ignored when `name` has none).
  function kids(node, name) {
    return (node.children || []).filter(function (c) {
      return c.name !== undefined && (c.name === name || (name.indexOf(':') === -1 && local(c.name) === name));
    });
  }

  function kid(node, name) { return kids(node, name)[0] || null; }

  return {
    ENCODINGS: ENCODINGS, decode: decode, decodeEntities: decodeEntities, escapeHtml: escapeHtml, escapeXml: escapeXml,
    parseHtml: parseHtml, parseXml: parseXml, local: local, textOf: textOf, find: find, findAll: findAll, kids: kids, kid: kid
  };
}, { worker: true });
