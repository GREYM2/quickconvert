/*
 * Document model shared by HTML, Markdown, plain text and Word (DOCX is in js/convert/docx.js):
 *   inputs  -> { title, blocks }   fromHtml, fromMarkdown, fromText
 *   outputs <- { title, blocks }   toHtml, toMarkdown, toText, htmlPage
 * Blocks:  heading {level, inlines} · para {inlines} · list {ordered, start, items: [[blocks]]}
 *          code {text, lang} · quote {blocks} · table {rows: [[inlines]], header} · hr
 * Inlines: text runs {text, b, i, code, del, href} · line breaks {br} · images {img, alt}
 * A new format only needs a reader to this model or a writer from it.
 */
QC.define('doc', function (QC) {
  'use strict';

  function set(words) {
    var o = Object.create(null);
    words.split(' ').forEach(function (w) { o[w] = true; });
    return o;
  }

  function each(list, fn) { for (var i = 0; i < list.length; i++) fn(list[i], i); }
  function pushAll(to, from) { for (var i = 0; i < from.length; i++) to.push(from[i]); }

  /* ---------- inline runs ---------- */

  var MARKS = ['b', 'i', 'code', 'del', 'href'];

  function sameMarks(a, b) {
    for (var k = 0; k < MARKS.length; k++) if ((a[MARKS[k]] || '') !== (b[MARKS[k]] || '')) return false;
    return true;
  }

  function addText(inl, text, marks) {
    if (!text) return;
    var last = inl[inl.length - 1];
    if (last && last.text !== undefined && sameMarks(last, marks)) { last.text += text; return; }
    var run = { text: text };
    MARKS.forEach(function (k) { if (marks[k]) run[k] = marks[k]; });
    inl.push(run);
  }

  function trimEnd(out) {
    var last = out[out.length - 1];
    if (!last || last.text === undefined || last.code) return;
    last.text = last.text.replace(/ +$/, '');
    if (!last.text) { out.pop(); trimEnd(out); }
  }

  // Merge runs with the same marks and drop the spaces HTML would collapse.
  function tidy(inl) {
    var out = [];
    each(inl, function (r) {
      var prev = out[out.length - 1];
      if (r.text === undefined) {
        if (r.br) trimEnd(out);
        out.push(r);
        return;
      }
      var t = r.text;
      if (!r.code && (!prev || prev.br || (prev.text !== undefined && / $/.test(prev.text)))) t = t.replace(/^ +/, '');
      if (!t) return;
      if (prev && prev.text !== undefined && sameMarks(prev, r)) prev.text += t;
      else out.push(Object.assign({}, r, { text: t }));
    });
    trimEnd(out);
    while (out.length && out[out.length - 1].br) out.pop();
    while (out.length && out[0].br) out.shift();
    return out;
  }

  // Inline text without formatting.
  function plain(inl) {
    return inl.map(function (r) { return r.br ? '\n' : r.img ? r.alt || '' : r.text; }).join('');
  }

  // Links and images may only point to web pages, mail, or embedded pictures.
  function safeUrl(u, img) {
    u = String(u || '').trim();
    if (!u) return '';
    var scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u.replace(/[\u0000-\u0020]/g, ''));
    if (!scheme) return u;
    var s = scheme[1].toLowerCase();
    if (s === 'http' || s === 'https' || (!img && (s === 'mailto' || s === 'tel'))) return u;
    if (img && s === 'data' && /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml)[;,]/i.test(u)) return u;
    return '';
  }

  /* ---------- HTML -> document ---------- */

  var SKIP = set('head script style noscript template iframe object embed svg math canvas video audio map ' +
    'input select textarea button link meta base source track area param frame frameset dialog');
  var MAIN_SKIP = set('nav header footer aside form');
  var WS = /[ \t\n\r\f]+/g;
  var BOLD = set('b strong'), ITALIC = set('i em cite dfn var'), CODE = set('code kbd samp tt'), DEL = set('s del strike');

  function hidden(el) {
    var a = el.attrs;
    return a.hidden !== undefined || a['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '');
  }

  function marksOf(el, marks) {
    var n = el.name, m = null;
    function add(k, v) { m = m || Object.assign({}, marks); m[k] = v; }
    if (BOLD[n]) add('b', 1);
    else if (ITALIC[n]) add('i', 1);
    else if (CODE[n]) add('code', 1);
    else if (DEL[n]) add('del', 1);
    else if (n === 'a') { var href = safeUrl(el.attrs.href); if (href) add('href', href); }
    var st = el.attrs.style;                           // inline styles from editors and generators
    if (st) {
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(st)) add('b', 1);
      if (/font-style\s*:\s*italic/i.test(st)) add('i', 1);
      if (/line-through/i.test(st)) add('del', 1);
    }
    return m || marks;
  }

  var BLOCKS = Object.create(null);

  // The blocks inside an element. Inline content between blocks becomes paragraphs.
  function blocksOf(node, ctx) {
    var out = [], inl = [];
    function flush() {
      var t = tidy(inl);
      if (t.length) out.push({ type: 'para', inlines: t });
      inl = [];
    }
    function walk(n, marks) {
      var list = n.children || [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.text !== undefined) { addText(inl, c.text.replace(WS, ' '), marks); continue; }
        var name = c.name;
        if (SKIP[name] || (ctx.mainOnly && MAIN_SKIP[name]) || hidden(c)) continue;
        if (name === 'br') { inl.push({ br: true }); continue; }
        if (name === 'img') {
          var src = safeUrl(c.attrs.src, true);
          if (src) inl.push({ img: src, alt: (c.attrs.alt || '').trim() });
          else if (c.attrs.alt) addText(inl, c.attrs.alt, marks);
          continue;
        }
        var handler = BLOCKS[name];
        if (handler) { flush(); handler(c, out, ctx); continue; }
        walk(c, marksOf(c, marks));
      }
    }
    walk(node, {});
    flush();
    return out;
  }

  // A block's content as one line of inline runs (for headings, table cells).
  function flatten(b) {
    switch (b.type) {
      case 'heading': case 'para': return b.inlines;
      case 'code': return [{ text: b.text, code: 1 }];
      case 'quote': return joinLines(b.blocks.map(flatten));
      case 'list': return joinLines(b.items.map(function (it) { return joinLines(it.map(flatten)); }));
      case 'table': return joinLines(b.rows.map(function (r) {
        return [{ text: r.map(plain).join(' | ') }];
      }));
      default: return [];
    }
  }

  function joinLines(parts) {
    var out = [];
    each(parts, function (p) {
      if (!p.length) return;
      if (out.length) out.push({ br: true });
      pushAll(out, p);
    });
    return out;
  }

  function inlinesOf(el, ctx) { return tidy(joinLines(blocksOf(el, ctx).map(flatten))); }

  function container(el, out, ctx) { pushAll(out, blocksOf(el, ctx)); }
  'p div section article main header footer nav aside figure figcaption address details summary center form fieldset legend body html hgroup li search'
    .split(' ').forEach(function (n) { BLOCKS[n] = container; });

  [1, 2, 3, 4, 5, 6].forEach(function (lvl) {
    BLOCKS['h' + lvl] = function (el, out, ctx) {
      var inl = inlinesOf(el, ctx).map(function (r) { return r.br ? { text: ' ' } : r; });
      if (inl.length) out.push({ type: 'heading', level: lvl, inlines: tidy(inl) });
    };
  });

  BLOCKS.ul = BLOCKS.ol = BLOCKS.menu = function list(el, out, ctx) {
    var items = [];
    each(el.children, function (c) {
      if (c.name === 'li') items.push(blocksOf(c, ctx));
      else if (c.name === 'ul' || c.name === 'ol') {            // a list placed right in a list: part of the last item
        var nested = [];
        list(c, nested, ctx);
        if (items.length) pushAll(items[items.length - 1], nested); else items.push(nested);
      } else if (c.text !== undefined && c.text.trim()) {
        items.push([{ type: 'para', inlines: [{ text: c.text.replace(WS, ' ').trim() }] }]);
      }
    });
    items = items.filter(function (it) { return it.length; });
    if (items.length) out.push({ type: 'list', ordered: el.name === 'ol', start: parseInt(el.attrs.start, 10) || 1, items: items });
  };

  function preText(n) {
    if (n.text !== undefined) return n.text;
    if (n.name === 'br') return '\n';
    return n.children.map(preText).join('');
  }

  BLOCKS.pre = function (el, out) {
    var text = preText(el).replace(/^\r?\n/, '').replace(/\s+$/, '');  // browsers drop a newline right after <pre>
    var code = QC.markup.kid(el, 'code');
    var cls = ((code && code.attrs.class) || '') + ' ' + (el.attrs.class || '');
    var lang = /(?:^|\s)(?:lang|language)-([\w+#.-]+)/.exec(cls);
    if (text) out.push({ type: 'code', text: text.replace(/\r\n?/g, '\n'), lang: lang ? lang[1] : '' });
  };

  BLOCKS.blockquote = function (el, out, ctx) {
    var b = blocksOf(el, ctx);
    if (b.length) out.push({ type: 'quote', blocks: b });
  };

  BLOCKS.hr = function (el, out) { out.push({ type: 'hr' }); };

  BLOCKS.dl = function dl(el, out, ctx) {
    each(el.children, function (c) {
      if (c.name === 'dt') {
        var t = inlinesOf(c, ctx).map(function (r) { return r.text !== undefined ? Object.assign({}, r, { b: 1 }) : r; });
        if (t.length) out.push({ type: 'para', inlines: t });
      } else if (c.name === 'dd') pushAll(out, blocksOf(c, ctx));
      else if (c.name === 'div') dl(c, out, ctx);                    // <div> groups inside <dl>
    });
  };

  // Rows in document order, with spans spread out so every row has its cells in the right columns.
  BLOCKS.table = function (el, out, ctx) {
    var trs = [];
    each(el.children, function (c) {
      if (c.name === 'tr') trs.push({ tr: c, head: false });
      else if (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot') {
        each(c.children, function (r) { if (r.name === 'tr') trs.push({ tr: r, head: c.name === 'thead' }); });
      }
    });
    var caption = QC.markup.kid(el, 'caption');
    if (caption) {
      var ci = inlinesOf(caption, ctx);
      if (ci.length) out.push({ type: 'para', inlines: ci.map(function (r) { return r.text !== undefined ? Object.assign({}, r, { b: 1 }) : r; }) });
    }
    var rows = [], header = false, spans = [];
    each(trs, function (t, r) {
      var cells = [], col = 0, allTh = true, n = 0;
      function carry() { while (spans[col] && spans[col].left > 0) { spans[col].left--; cells.push([]); col++; } }
      each(t.tr.children, function (c) {
        if (c.name !== 'td' && c.name !== 'th') return;
        carry();
        n++;
        if (c.name !== 'th') allTh = false;
        var inl = inlinesOf(c, ctx);
        var cs = Math.min(100, Math.max(1, parseInt(c.attrs.colspan, 10) || 1));
        var rs = Math.min(10000, Math.max(1, parseInt(c.attrs.rowspan, 10) || 1));
        for (var k = 0; k < cs; k++) {
          cells.push(k ? [] : inl);
          spans[col] = { left: rs - 1 };
          col++;
        }
      });
      carry();
      if (!n && !cells.length) return;
      if (r === 0 && (t.head || allTh)) header = true;
      rows.push(cells);
    });
    if (rows.length) out.push({ type: 'table', rows: rows, header: header });
  };

  // The page's main content: <main>, role="main", or its longest <article>.
  function mainContent(body) {
    var M = QC.markup;
    var main = M.find(body, function (n) { return n.name === 'main' || n.attrs.role === 'main'; });
    if (main) return main;
    var best = null, len = 0;
    M.findAll(body, function (n) { return n.name === 'article'; }).forEach(function (a) {
      var l = M.textOf(a).length;
      if (l > len) { best = a; len = l; }
    });
    return best;
  }

  // opts.mainOnly: skip menus, headers, footers and side bars.
  function fromHtml(html, opts) {
    opts = opts || {};
    var M = QC.markup, tree = typeof html === 'string' ? M.parseHtml(html) : html;
    var title = M.find(tree, function (n) { return n.name === 'title'; });
    var body = M.find(tree, function (n) { return n.name === 'body'; }) || tree;
    var start = opts.mainOnly ? mainContent(body) || body : body;
    var blocks = blocksOf(start, { mainOnly: !!opts.mainOnly });
    var name = title ? M.textOf(title).replace(WS, ' ').trim() : '';
    if (!name) {
      var h = blocks.find(function (b) { return b.type === 'heading'; });
      if (h) name = plain(h.inlines);
    }
    return { title: name, blocks: blocks };
  }

  async function markdownHtml(text) {
    await QC.loadScript(QC.libs.marked);
    return self.marked.parse(text, { gfm: true });
  }

  async function fromMarkdown(text) { return fromHtml(await markdownHtml(text)); }

  // Blank lines separate paragraphs; single line breaks stay.
  function fromText(text) {
    var blocks = [];
    text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).forEach(function (p) {
      if (!p.trim()) return;
      var inl = [];
      p.replace(/^\n+|\s+$/g, '').split('\n').forEach(function (line, i) {
        if (i) inl.push({ br: true });
        if (line) inl.push({ text: line });
      });
      blocks.push({ type: 'para', inlines: inl });
    });
    return { title: '', blocks: blocks };
  }

  // Table rows of plain values -> table block.
  function tableBlock(rows, header) {
    return {
      type: 'table', header: !!header,
      rows: rows.map(function (r) {
        return r.map(function (v) {
          var s = v === null || v === undefined ? '' : typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : String(v);
          var inl = [];
          s.split(/\r?\n/).forEach(function (line, i) { if (i) inl.push({ br: true }); if (line) inl.push({ text: line }); });
          return inl;
        });
      })
    };
  }

  /* ---------- document -> HTML ---------- */

  var esc = function (s) { return QC.markup.escapeHtml(s); };

  function inlineHtml(inl) {
    return inl.map(function (r) {
      if (r.br) return '<br>';
      if (r.img) return '<img src="' + esc(r.img) + '" alt="' + esc(r.alt || '') + '">';
      var s = esc(r.text);
      if (r.code) s = '<code>' + s + '</code>';
      if (r.del) s = '<del>' + s + '</del>';
      if (r.i) s = '<em>' + s + '</em>';
      if (r.b) s = '<strong>' + s + '</strong>';
      if (r.href) s = '<a href="' + esc(r.href) + '">' + s + '</a>';
      return s;
    }).join('');
  }

  function width(rows) { return rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0); }

  function blockHtml(b) {
    switch (b.type) {
      case 'heading': return '<h' + b.level + '>' + inlineHtml(b.inlines) + '</h' + b.level + '>';
      case 'para': return '<p>' + inlineHtml(b.inlines) + '</p>';
      case 'code': return '<pre><code' + (b.lang ? ' class="language-' + esc(b.lang) + '"' : '') + '>' + esc(b.text) + '</code></pre>';
      case 'quote': return '<blockquote>\n' + b.blocks.map(blockHtml).join('\n') + '\n</blockquote>';
      case 'hr': return '<hr>';
      case 'list':
        var tag = b.ordered ? 'ol' : 'ul';
        return '<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n' + b.items.map(function (it) {
          var first = it[0] && it[0].type === 'para' ? inlineHtml(it[0].inlines) : '';
          var rest = (first ? it.slice(1) : it).map(blockHtml).join('\n');
          return '<li>' + first + (rest ? (first ? '\n' : '') + rest : '') + '</li>';
        }).join('\n') + '\n</' + tag + '>';
      case 'table':
        var w = width(b.rows);
        var row = function (r, cell) {
          var cells = [];
          for (var c = 0; c < w; c++) cells.push('<' + cell + '>' + inlineHtml(r[c] || []) + '</' + cell + '>');
          return '<tr>' + cells.join('') + '</tr>';
        };
        var head = b.header && b.rows.length ? '<thead>\n' + row(b.rows[0], 'th') + '\n</thead>\n' : '';
        var body = (b.header ? b.rows.slice(1) : b.rows).map(function (r) { return row(r, 'td'); }).join('\n');
        return '<table>\n' + head + '<tbody>\n' + body + '\n</tbody>\n</table>';
      default: return '';
    }
  }

  function toHtml(doc) { return doc.blocks.map(blockHtml).join('\n'); }

  /* ----- full page with the chosen style: background, matching text colour, font ----- */

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
  // wide: tables get the whole width instead of a reading column.
  function htmlPage(title, body, page, wide) {
    page = page || {};
    var bg = /^#[0-9a-f]{6}$/i.test(page.background || '') ? page.background : '#ffffff';
    var family = googleFamily(page.font);
    var stack = family ? '"' + family + '", ' + LOCAL_FONTS.system : LOCAL_FONTS[page.font] || LOCAL_FONTS.system;
    return '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + esc(title) + '</title>\n' +
      (family ? '<link rel="stylesheet" href="' + googleFontUrl(family, page.weights) + '">\n' : '') +
      '<style>body{max-width:' + (wide ? 'none' : '46rem') + ';margin:2rem auto;padding:0 1rem;font:16px/1.6 ' + stack + ';' +
      'background:' + bg + ';color:' + textOn(bg) + '}a{color:inherit}' +
      'pre,code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}pre{overflow:auto;padding:1rem;background:rgba(128,128,128,.12)}' +
      'blockquote{margin-left:0;padding-left:1rem;border-left:3px solid rgba(128,128,128,.4)}' +
      'table{border-collapse:collapse}th,td{border:1px solid rgba(128,128,128,.4);padding:.3rem .6rem;text-align:left;vertical-align:top}' +
      'th{background:rgba(128,128,128,.12)}img{max-width:100%}</style>\n' +
      '</head>\n<body>\n' + body + '\n</body>\n</html>\n';
  }

  /* ---------- document -> Markdown ---------- */

  // Characters that would turn into formatting are escaped, so the text reads the same.
  function escapeMd(t, lineStart, table) {
    t = t.replace(/[\\`*_[\]<>]/g, '\\$&').replace(/~~/g, '\\~\\~');
    if (table) t = t.replace(/\|/g, '\\|');
    if (lineStart) {
      t = t.replace(/^[ \t]+/, '')
        .replace(/^(#{1,6}|[+\-])(?=\s|$)/, '\\$1')
        .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2');
    }
    return t;
  }

  function mdUrl(u) { return /[\s()<>]/.test(u) ? '<' + u.replace(/[<>]/g, encodeURIComponent) + '>' : u; }

  function runMd(r, out, lineStart, table) {
    var s;
    if (r.code) {
      var ticks = (r.text.match(/`+/g) || ['']).reduce(function (n, x) { return Math.max(n, x.length); }, 0) + 1;
      var fence = new Array(ticks + 1).join('`'), pad = /^`|`$/.test(r.text) ? ' ' : '';
      s = fence + pad + (table ? r.text.replace(/\|/g, '\\|') : r.text) + pad + fence;
    } else {
      s = escapeMd(r.text, lineStart, table);
    }
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);       // markers hug the text, spaces stay outside
    if (!m[2]) return s;
    var core = m[2];
    if (r.del) core = '~~' + core + '~~';
    if (r.i) core = (/\*$/.test(out) ? '_' : '*') + core + (/\*$/.test(out) ? '_' : '*');
    if (r.b) core = '**' + core + '**';
    return m[1] + core + m[3];
  }

  function inlineMd(inl, opt) {
    opt = opt || {};
    var out = '', lineStart = true;
    for (var i = 0; i < inl.length; i++) {
      var r = inl[i];
      if (r.br) { out += opt.table ? '<br>' : opt.oneLine ? ' ' : '\\\n'; lineStart = !opt.table && !opt.oneLine; continue; }
      if (r.img) {
        if (/^data:/i.test(r.img)) out += r.alt ? escapeMd(r.alt, lineStart, opt.table) : ''; // embedded pictures can't go in a .md file
        else out += '![' + escapeMd(r.alt || '', false, opt.table) + '](' + mdUrl(r.img) + ')';
        lineStart = false;
        continue;
      }
      if (r.href) {
        var text = '';
        while (i < inl.length && inl[i].text !== undefined && inl[i].href === r.href) text += runMd(inl[i++], text, false, opt.table);
        i--;
        out += '[' + text + '](' + mdUrl(r.href) + ')';
      } else {
        out += runMd(r, out, lineStart, opt.table);
      }
      lineStart = false;
    }
    return out;
  }

  function indent(text, n) {
    var pad = new Array(n + 1).join(' ');
    return text.split('\n').map(function (l, i) { return i && l ? pad + l : l; }).join('\n');
  }

  function blockMd(b) {
    switch (b.type) {
      case 'heading': return new Array(b.level + 1).join('#') + ' ' + inlineMd(b.inlines, { oneLine: true });
      case 'para': return inlineMd(b.inlines);
      case 'hr': return '---';
      case 'code':
        var ticks = (b.text.match(/^`{3,}/gm) || []).reduce(function (n, x) { return Math.max(n, x.length + 1); }, 3);
        var fence = new Array(ticks + 1).join('`');
        return fence + (b.lang || '') + '\n' + b.text + '\n' + fence;
      case 'quote':
        return b.blocks.map(blockMd).join('\n\n').split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
      case 'list':
        var loose = b.items.some(function (it) { return it.filter(function (x) { return x.type !== 'list'; }).length > 1; });
        return b.items.map(function (it, i) {
          var marker = b.ordered ? (b.start + i) + '. ' : '- ';
          var body = it.map(blockMd).join(loose ? '\n\n' : '\n');
          return marker + indent(body, marker.length);
        }).join(loose ? '\n\n' : '\n');
      case 'table':
        var w = Math.max(1, width(b.rows));
        var line = function (r) {
          var cells = [];
          for (var c = 0; c < w; c++) cells.push(inlineMd((r && r[c]) || [], { table: true }) || ' ');
          return '| ' + cells.join(' | ') + ' |';
        };
        var sep = '|' + new Array(w + 1).join(' --- |');
        return b.header ? [line(b.rows[0]), sep].concat(b.rows.slice(1).map(line)).join('\n')
          : [line(null), sep].concat(b.rows.map(line)).join('\n');
      default: return '';
    }
  }

  function toMarkdown(doc) {
    return doc.blocks.map(blockMd).filter(Boolean).join('\n\n') + '\n';
  }

  /* ---------- document -> plain text ---------- */

  function inlineText(inl) {
    return inl.map(function (r) {
      if (r.br) return '\n';
      if (r.img) return r.alt ? '[' + r.alt + ']' : '';
      return r.href && r.href !== r.text && r.href[0] !== '#' && !/^mailto:/i.test(r.href) ? r.text + ' (' + r.href + ')' : r.text;
    }).join('');
  }

  function pad(s, n) { return s.length >= n ? s : s + new Array(n - s.length + 1).join(' '); }

  function blockText(b) {
    switch (b.type) {
      case 'heading':
        var t = inlineText(b.inlines);
        return b.level <= 2 ? t + '\n' + new Array(Math.min(t.length, 80) + 1).join(b.level === 1 ? '=' : '-') : t;
      case 'para': return inlineText(b.inlines);
      case 'hr': return new Array(41).join('-');
      case 'code': return b.text.split('\n').map(function (l) { return '    ' + l; }).join('\n');
      case 'quote': return b.blocks.map(blockText).join('\n\n').split('\n').map(function (l) { return '> ' + l; }).join('\n');
      case 'list':
        return b.items.map(function (it, i) {
          var marker = b.ordered ? (b.start + i) + '. ' : '- ';
          return marker + indent(it.map(blockText).join('\n'), marker.length);
        }).join('\n');
      case 'table':
        var w = width(b.rows), cols = [];
        var text = b.rows.map(function (r) {
          var cells = [];
          for (var c = 0; c < w; c++) cells.push(inlineText(r[c] || []).replace(/\s*\n\s*/g, ' '));
          return cells;
        });
        for (var c = 0; c < w; c++) cols.push(Math.min(40, text.reduce(function (m, r) { return Math.max(m, r[c].length); }, 0)));
        var lines = text.map(function (r) { return r.map(function (v, k) { return pad(v, cols[k]); }).join('  ').replace(/\s+$/, ''); });
        if (b.header && lines.length) lines.splice(1, 0, cols.map(function (n) { return new Array(n + 1).join('-'); }).join('  '));
        return lines.join('\n');
      default: return '';
    }
  }

  function toText(doc) {
    return doc.blocks.map(blockText).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  return {
    fromHtml: fromHtml, fromMarkdown: fromMarkdown, fromText: fromText, markdownHtml: markdownHtml, tableBlock: tableBlock,
    toHtml: toHtml, toMarkdown: toMarkdown, toText: toText, htmlPage: htmlPage, plain: plain, tidy: tidy, safeUrl: safeUrl,
    textOn: textOn, googleFontUrl: googleFontUrl, LOCAL_FONTS: LOCAL_FONTS
  };
}, { worker: true });
