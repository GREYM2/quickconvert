/*
 * Word documents (.docx) <-> the document model in js/convert/doc.js.
 *   read(buffer, { images })  -> { title, blocks, images }   headings, lists, tables, links,
 *                                                           bold/italic, code, quotes, pictures
 *   write(doc, { font, size }) -> Blob                       a plain, valid .docx (stored ZIP)
 *   preview(doc, { font, size }) -> HTML page that looks like the Word page
 */
QC.define('docx', function (QC) {
  'use strict';

  var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  var MONO = /consolas|courier|mono|menlo|lucida console|source code|fira code/i;
  var PICTURE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };
  var MAX_PICTURES = 30e6;   // bytes of pictures embedded in one HTML page

  /* ---------- reading ---------- */

  function attr(node, name) {
    if (!node) return null;
    var a = node.attrs;
    if (a['w:' + name] !== undefined) return a['w:' + name];
    for (var k in a) if (QC.markup.local(k) === name) return a[k];
    return null;
  }

  // <w:b/> is on; <w:b w:val="0"/> or "false" is off.
  function on(node) {
    if (!node) return false;
    var v = attr(node, 'val');
    return v === null || !/^(0|false|off|none)$/i.test(v);
  }

  function parseRels(xml) {
    var rels = Object.create(null);
    if (!xml) return rels;
    QC.markup.findAll(QC.markup.parseXml(xml), function (n) { return QC.markup.local(n.name) === 'Relationship'; }).forEach(function (r) {
      rels[r.attrs.Id] = { target: r.attrs.Target || '', external: r.attrs.TargetMode === 'External' };
    });
    return rels;
  }

  function parseStyles(xml) {
    var M = QC.markup, raw = Object.create(null), done = Object.create(null);
    if (xml) {
      M.findAll(M.parseXml(xml), function (n) { return M.local(n.name) === 'style'; }).forEach(function (s) {
        var pPr = M.kid(s, 'pPr'), rPr = M.kid(s, 'rPr'), numPr = pPr && M.kid(pPr, 'numPr'), fonts = rPr && M.kid(rPr, 'rFonts');
        raw[attr(s, 'styleId')] = {
          name: (attr(M.kid(s, 'name'), 'val') || '').toLowerCase(),
          basedOn: attr(M.kid(s, 'basedOn'), 'val'),
          outline: pPr && M.kid(pPr, 'outlineLvl') ? parseInt(attr(M.kid(pPr, 'outlineLvl'), 'val'), 10) : null,
          numId: numPr ? attr(M.kid(numPr, 'numId'), 'val') : null,
          ilvl: numPr && M.kid(numPr, 'ilvl') ? parseInt(attr(M.kid(numPr, 'ilvl'), 'val'), 10) : null,
          b: rPr && M.kid(rPr, 'b') ? on(M.kid(rPr, 'b')) : null,
          i: rPr && M.kid(rPr, 'i') ? on(M.kid(rPr, 'i')) : null,
          mono: fonts ? MONO.test(attr(fonts, 'ascii') || attr(fonts, 'hAnsi') || '') : null
        };
      });
    }
    // A style with its parents' properties filled in.
    return function style(id) {
      if (!id || !raw[id]) return {};
      if (done[id]) return done[id];
      done[id] = {};                                   // guards against loops in basedOn
      var s = raw[id], base = style(s.basedOn), out = {};
      Object.keys(s).forEach(function (k) { out[k] = s[k] !== null && s[k] !== undefined ? s[k] : base[k]; });
      out.name = s.name;
      return (done[id] = out);
    };
  }

  function parseNumbering(xml) {
    var M = QC.markup, abstract = Object.create(null), nums = Object.create(null);
    if (xml) {
      var tree = M.parseXml(xml);
      M.findAll(tree, function (n) { return M.local(n.name) === 'abstractNum'; }).forEach(function (a) {
        var levels = {};
        M.kids(a, 'lvl').forEach(function (l) {
          levels[attr(l, 'ilvl')] = { fmt: attr(M.kid(l, 'numFmt'), 'val') || 'decimal', start: parseInt(attr(M.kid(l, 'start'), 'val'), 10) || 1 };
        });
        abstract[attr(a, 'abstractNumId')] = levels;
      });
      M.findAll(tree, function (n) { return M.local(n.name) === 'num'; }).forEach(function (n) {
        var starts = {};
        M.kids(n, 'lvlOverride').forEach(function (o) {
          var so = M.kid(o, 'startOverride');
          if (so) starts[attr(o, 'ilvl')] = parseInt(attr(so, 'val'), 10) || 1;
        });
        nums[attr(n, 'numId')] = { abstract: attr(M.kid(n, 'abstractNumId'), 'val'), starts: starts };
      });
    }
    return function format(numId, ilvl) {
      var n = nums[numId], lvl = n && abstract[n.abstract] && abstract[n.abstract][ilvl];
      var fmt = lvl ? lvl.fmt : 'bullet';
      return { ordered: fmt !== 'bullet' && fmt !== 'none', start: n && n.starts[ilvl] || (lvl ? lvl.start : 1) };
    };
  }

  function base64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Pictures as data: URLs, keyed by relationship id.
  async function loadPictures(tree, rels, zip) {
    var M = QC.markup, out = Object.create(null), total = 0;
    var ids = M.findAll(tree, function (n) { return M.local(n.name) === 'blip' || M.local(n.name) === 'imagedata'; })
      .map(function (n) { return n.attrs['r:embed'] || n.attrs['r:id']; }).filter(Boolean);
    for (var i = 0; i < ids.length; i++) {
      var rel = rels[ids[i]];
      if (!rel || rel.external || out[ids[i]]) continue;
      var path = rel.target.replace(/^\//, '');
      if (!/^word\//.test(path)) path = 'word/' + path;
      var type = PICTURE_TYPES[((/\.(\w+)$/.exec(path) || [])[1] || '').toLowerCase()];
      if (!type) continue;                              // EMF/WMF/TIFF can't be shown in a browser
      var bytes = await zip.bytes(path);
      if (!bytes || total + bytes.length > MAX_PICTURES) continue;
      total += bytes.length;
      out[ids[i]] = 'data:' + type + ';base64,' + base64(bytes);
    }
    return out;
  }

  function reader(ctx) {
    var M = QC.markup;

    function runMarks(rPr, marks) {
      if (!rPr) return marks;
      var m = Object.assign({}, marks), cs = ctx.style(attr(M.kid(rPr, 'rStyle'), 'val'));
      if (cs.b) m.b = 1;
      if (cs.i) m.i = 1;
      if (cs.mono) m.code = 1;
      if (M.kid(rPr, 'b')) { if (on(M.kid(rPr, 'b'))) m.b = 1; else delete m.b; }
      if (M.kid(rPr, 'i')) { if (on(M.kid(rPr, 'i'))) m.i = 1; else delete m.i; }
      if (on(M.kid(rPr, 'strike')) || on(M.kid(rPr, 'dstrike'))) m.del = 1;
      var fonts = M.kid(rPr, 'rFonts');
      if (fonts && MONO.test(attr(fonts, 'ascii') || attr(fonts, 'hAnsi') || '')) m.code = 1;
      return m;
    }

    function add(inl, text, marks) {
      var last = inl[inl.length - 1], run = Object.assign({ text: text }, marks);
      if (last && last.text !== undefined && ['b', 'i', 'code', 'del', 'href'].every(function (k) { return (last[k] || '') === (run[k] || ''); })) last.text += text;
      else inl.push(run);
    }

    function picture(node, inl) {
      var blip = M.find(node, function (n) { return M.local(n.name) === 'blip' || M.local(n.name) === 'imagedata'; });
      var id = blip && (blip.attrs['r:embed'] || blip.attrs['r:id']);
      var doc = M.find(node, function (n) { return M.local(n.name) === 'docPr'; });
      var alt = doc ? (doc.attrs.descr || doc.attrs.title || '').trim() : '';
      if (id && ctx.pictures[id]) inl.push({ img: ctx.pictures[id], alt: alt });
      else if (alt) add(inl, '[' + alt + ']', {});        // a picture the browser can't show (EMF, TIFF)
      ctx.pictureCount++;
    }

    // Paragraph content -> inline runs. Links come as <w:hyperlink> or as HYPERLINK fields.
    function inlines(p) {
      var inl = [], field = null;
      function walk(node, marks) {
        node.children.forEach(function (c) {
          if (c.name === undefined) return;
          var n = M.local(c.name);
          if (n === 'r') run(c, marks);
          else if (n === 'hyperlink') {
            var rel = ctx.rels[c.attrs['r:id']], href = rel && rel.external ? QC.doc.safeUrl(rel.target) : '';
            walk(c, href ? Object.assign({}, marks, { href: href }) : marks);
          } else if (n === 'fldSimple') {
            var link = /HYPERLINK\s+"([^"]+)"/i.exec(attr(c, 'instr') || '');
            var safe = link ? QC.doc.safeUrl(link[1]) : '';
            walk(c, safe ? Object.assign({}, marks, { href: safe }) : marks);
          } else if (/^(ins|smartTag|sdt|sdtContent|customXml|bdo|dir|moveTo)$/.test(n)) walk(c, marks);
        });
      }
      function run(r, marks) {
        var m = runMarks(M.kid(r, 'rPr'), marks);
        r.children.forEach(function (c) {
          if (c.name === undefined) return;
          var n = M.local(c.name);
          if (n === 'fldChar') {
            var type = attr(c, 'fldCharType');
            if (type === 'begin') field = { instr: '', href: '', shown: false };
            else if (type === 'separate' && field) {
              var link = /HYPERLINK\s+"([^"]+)"/i.exec(field.instr);
              field.href = link ? QC.doc.safeUrl(link[1]) : '';
              field.shown = true;
            } else if (type === 'end') field = null;
            return;
          }
          if (n === 'instrText') { if (field) field.instr += M.textOf(c); return; }
          if (field && !field.shown) return;
          var mm = field && field.href ? Object.assign({}, m, { href: field.href }) : m;
          if (n === 't') add(inl, M.textOf(c), mm);
          else if (n === 'tab') add(inl, '\t', mm);
          else if (n === 'noBreakHyphen') add(inl, '‑', mm);
          else if ((n === 'br' && !/page|column/.test(attr(c, 'type') || '')) || n === 'cr') inl.push({ br: true });
          else if (n === 'drawing' || n === 'pict' || n === 'object') picture(c, inl);
        });
      }
      walk(p, {});
      return inl;
    }

    function paraInfo(p) {
      var pPr = M.kid(p, 'pPr'), st = ctx.style(pPr && attr(M.kid(pPr, 'pStyle'), 'val'));
      var outline = pPr && M.kid(pPr, 'outlineLvl') ? parseInt(attr(M.kid(pPr, 'outlineLvl'), 'val'), 10) : st.outline;
      var heading = /^heading (\d)$/.exec(st.name || ''), level = 0;
      if (heading) level = +heading[1];
      else if (st.name === 'title') level = 1;
      else if (outline >= 0 && outline < 6) level = outline + 1;
      var numPr = pPr && M.kid(pPr, 'numPr');
      var numId = numPr && M.kid(numPr, 'numId') ? attr(M.kid(numPr, 'numId'), 'val') : st.numId;
      var ilvl = numPr && M.kid(numPr, 'ilvl') ? parseInt(attr(M.kid(numPr, 'ilvl'), 'val'), 10) : st.ilvl || 0;
      return {
        level: Math.min(6, level), numId: numId && numId !== '0' ? numId : null, ilvl: Math.min(8, ilvl || 0),
        code: /code|preformatted|source|listing/.test(st.name || ''), quote: /quote/.test(st.name || '')
      };
    }

    function cellInlines(tc) {
      var parts = [];
      tc.children.forEach(function (c) {
        if (c.name === undefined) return;
        var n = M.local(c.name);
        if (n === 'p') parts.push(QC.doc.tidy(inlines(c)));
        else if (n === 'tbl') parts.push([{ text: M.textOf(c).replace(/\s+/g, ' ').trim() }]);
        else if (n === 'sdt') { var inner = M.kid(c, 'sdtContent'); if (inner) parts.push(cellInlines(inner)); }
      });
      var out = [];
      parts.forEach(function (p) { if (!p.length) return; if (out.length) out.push({ br: true }); out.push.apply(out, p); });
      return out;
    }

    function table(tbl) {
      var rows = [], header = false;
      M.kids(tbl, 'tr').forEach(function (tr, r) {
        var cells = [], trPr = M.kid(tr, 'trPr');
        if (r === 0 && trPr && M.kid(trPr, 'tblHeader')) header = true;
        M.kids(tr, 'tc').forEach(function (tc) {
          var tcPr = M.kid(tc, 'tcPr'), span = tcPr && M.kid(tcPr, 'gridSpan') ? parseInt(attr(M.kid(tcPr, 'gridSpan'), 'val'), 10) || 1 : 1;
          var merge = tcPr && M.kid(tcPr, 'vMerge'), cont = merge && attr(merge, 'val') !== 'restart';
          cells.push(cont ? [] : cellInlines(tc));
          for (var k = 1; k < span; k++) cells.push([]);
        });
        rows.push(cells);
      });
      header = header || rows.length > 1;
      // A header row in bold is just a header row; its bold isn't part of the text.
      if (header && rows[0].every(function (c) { return c.every(function (r) { return r.text === undefined || r.b; }); })) {
        rows[0] = rows[0].map(function (c) { return c.map(function (r) { if (r.b) { r = Object.assign({}, r); delete r.b; } return r; }); });
      }
      return { type: 'table', rows: rows, header: header };
    }

    // Body content in order; numbered paragraphs become (nested) lists.
    function blocks(container, out, lists) {
      container.children.forEach(function (c) {
        if (c.name === undefined) return;
        var n = M.local(c.name);
        if (n === 'tbl') { lists.length = 0; out.push(table(c)); return; }
        if (n === 'sdt') { var inner = M.kid(c, 'sdtContent'); if (inner) blocks(inner, out, lists); return; }
        if (n === 'customXml' || n === 'ins') { blocks(c, out, lists); return; }
        if (n !== 'p') return;
        var info = paraInfo(c), raw = inlines(c), last = out[out.length - 1];
        if (info.code) {
          var text = QC.doc.plain(raw);
          if (last && last.type === 'code' && last.fromDocx) last.text += '\n' + text;
          else out.push({ type: 'code', text: text, lang: '', fromDocx: true });
          lists.length = 0;
          return;
        }
        var inl = QC.doc.tidy(raw);
        if (!inl.length) return;                       // empty paragraphs are just spacing
        if (info.level) {
          lists.length = 0;
          out.push({ type: 'heading', level: info.level, inlines: inl.map(function (r) { return r.br ? { text: ' ' } : r; }) });
          return;
        }
        if (info.numId) { listItem(out, lists, info, inl); return; }
        lists.length = 0;
        if (info.quote && last && last.type === 'quote') last.blocks.push({ type: 'para', inlines: inl });
        else out.push(info.quote ? { type: 'quote', blocks: [{ type: 'para', inlines: inl }] } : { type: 'para', inlines: inl });
      });
    }

    function listItem(out, lists, info, inl) {
      var lvl = info.ilvl;
      while (lists.length && lists[lists.length - 1].level > lvl) lists.pop();
      var top = lists[lists.length - 1];
      if (top && top.level === lvl && top.numId !== info.numId) { lists.pop(); top = lists[lists.length - 1]; }
      if (!top || top.level < lvl) {
        var f = ctx.numbering(info.numId, lvl);
        var block = { type: 'list', ordered: f.ordered, start: f.start, items: [] };
        if (top) {
          var items = top.block.items;
          if (!items.length) items.push([]);
          items[items.length - 1].push(block);
        } else out.push(block);
        lists.push(top = { level: lvl, numId: info.numId, block: block });
      }
      top.block.items.push([{ type: 'para', inlines: inl }]);
    }

    return { blocks: blocks };
  }

  async function read(buffer, opts) {
    opts = opts || {};
    var M = QC.markup, zip = QC.zip.read(buffer);
    if (!zip.has('word/document.xml')) throw QC.error('decode', 'Not a Word document (.docx).');
    var tree = M.parseXml(await zip.text('word/document.xml'));
    var rels = parseRels(await zip.text('word/_rels/document.xml.rels'));
    var ctx = {
      rels: rels,
      style: parseStyles(await zip.text('word/styles.xml')),
      numbering: parseNumbering(await zip.text('word/numbering.xml')),
      pictures: opts.images ? await loadPictures(tree, rels, zip) : {},
      pictureCount: 0
    };
    var body = M.find(tree, function (n) { return M.local(n.name) === 'body'; });
    if (!body) throw QC.error('decode', 'This Word document has no content.');
    var out = [];
    reader(ctx).blocks(body, out, []);
    out.forEach(function (b) { delete b.fromDocx; });
    var core = await zip.text('docProps/core.xml'), title = '';
    if (core) {
      var t = M.find(M.parseXml(core), function (n) { return M.local(n.name) === 'title'; });
      if (t) title = M.textOf(t).trim();
    }
    return { title: title, blocks: out, pictures: ctx.pictureCount };
  }

  /* ---------- writing ---------- */

  var FONT_CSS = {
    'Calibri': 'Calibri, Carlito, "Segoe UI", sans-serif',
    'Arial': 'Arial, "Liberation Sans", Helvetica, sans-serif',
    'Times New Roman': '"Times New Roman", "Liberation Serif", Times, serif',
    'Georgia': 'Georgia, serif',
    'Cambria': 'Cambria, Caladea, Georgia, serif',
    'Consolas': 'Consolas, "Liberation Mono", monospace'
  };

  function options(opts) {
    opts = opts || {};
    var size = parseFloat(opts.size);
    return { font: FONT_CSS[opts.font] ? opts.font : 'Calibri', size: size >= 8 && size <= 28 ? size : 11 };
  }

  function writer() {
    var x = function (s) { return QC.markup.escapeXml(s); };
    var links = [], orderedLists = [];

    function linkId(href) {
      var id = 'rId' + (links.length + 10);
      links.push({ id: id, href: href });
      return id;
    }

    function textRuns(text, rPr) {
      var out = '';
      text.split('\n').forEach(function (line, li) {
        if (li) out += '<w:r>' + rPr + '<w:br/></w:r>';
        line.split('\t').forEach(function (part, ti) {
          if (ti) out += '<w:r>' + rPr + '<w:tab/></w:r>';
          if (part) out += '<w:r>' + rPr + '<w:t xml:space="preserve">' + x(part) + '</w:t></w:r>';
        });
      });
      return out;
    }

    function runProps(r, bold) {
      var p = '';
      if (r.href) p += '<w:rStyle w:val="Hyperlink"/>' + (r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '');
      else if (r.code) p += '<w:rStyle w:val="CodeChar"/>';
      if (r.b || bold) p += '<w:b/><w:bCs/>';
      if (r.i) p += '<w:i/><w:iCs/>';
      if (r.del) p += '<w:strike/>';
      return p ? '<w:rPr>' + p + '</w:rPr>' : '';
    }

    function runs(inl, bold) {
      var out = '';
      for (var i = 0; i < inl.length; i++) {
        var r = inl[i];
        if (r.br) { out += '<w:r><w:br/></w:r>'; continue; }
        if (r.img !== undefined) {                     // pictures aren't embedded; their description is kept
          if (r.alt) out += textRuns('[' + r.alt + ']', '<w:rPr><w:i/></w:rPr>');
          continue;
        }
        if (r.href && /^(https?|mailto):/i.test(r.href)) {
          var group = '', href = r.href;
          while (i < inl.length && inl[i].text !== undefined && inl[i].href === href) { group += textRuns(inl[i].text, runProps(inl[i], bold)); i++; }
          i--;
          out += '<w:hyperlink r:id="' + linkId(href) + '" w:history="1">' + group + '</w:hyperlink>';
          continue;
        }
        out += textRuns(r.text, runProps(r.href ? Object.assign({}, r, { href: '' }) : r, bold));
      }
      return out;
    }

    function para(style, content, props) {
      var pPr = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + (props || '');
      return '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + content + '</w:p>';
    }

    function numId(list) {
      if (!list.ordered) return 1;
      orderedLists.push({ start: list.start || 1 });
      return orderedLists.length + 1;
    }

    function block(b, ctx) {
      switch (b.type) {
        case 'heading': return para('Heading' + b.level, runs(b.inlines));
        case 'para': return para(ctx.quote ? 'Quote' : ctx.indent ? 'ListParagraph' : '', runs(b.inlines),
          !ctx.quote && ctx.indent ? '<w:ind w:left="' + ctx.indent + '"/>' : '');
        case 'code': return para('Code', textRuns(b.text, ''), ctx.indent ? '<w:ind w:left="' + ctx.indent + '"/>' : '');
        case 'hr': return para('', '', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A0A0A0"/></w:pBdr>');
        case 'quote': return b.blocks.map(function (q) { return block(q, Object.assign({}, ctx, { quote: true })); }).join('');
        case 'list': return list(b, ctx);
        case 'table': return table(b);
        default: return '';
      }
    }

    function list(b, ctx) {
      var level = ctx.level === undefined ? 0 : ctx.level + 1, id = numId(b), out = '';
      if (b.ordered && level) orderedLists[id - 2].level = level;
      b.items.forEach(function (item) {
        var numPr = '<w:numPr><w:ilvl w:val="' + Math.min(8, level) + '"/><w:numId w:val="' + id + '"/></w:numPr>';
        var first = item[0], rest = item.slice(1);
        if (first && first.type === 'para') out += para('ListParagraph', runs(first.inlines), numPr);
        else { out += para('ListParagraph', '', numPr); if (first) rest = item; }
        var inner = { level: level, indent: 720 * (Math.min(8, level) + 1) };
        rest.forEach(function (sub) { out += block(sub, inner); });
      });
      return out;
    }

    function table(b) {
      var w = b.rows.reduce(function (n, r) { return Math.max(n, r.length); }, 1), col = Math.floor(9026 / w), grid = '';
      for (var c = 0; c < w; c++) grid += '<w:gridCol w:w="' + col + '"/>';
      var rows = b.rows.map(function (r, ri) {
        var head = b.header && ri === 0, cells = '';
        for (var c = 0; c < w; c++) {
          cells += '<w:tc><w:tcPr><w:tcW w:w="' + col + '" w:type="dxa"/></w:tcPr>' +
            para('', runs(r[c] || [], head), '<w:spacing w:after="0"/>') + '</w:tc>';
        }
        return '<w:tr>' + (head ? '<w:trPr><w:tblHeader/></w:trPr>' : '') + cells + '</w:tr>';
      }).join('');
      return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>' +
        '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
        '</w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>' + rows + '</w:tbl>';
    }

    function body(blocks) {
      var out = '';
      blocks.forEach(function (b, i) {
        out += block(b, {});
        var next = blocks[i + 1];
        if (b.type === 'table' && (!next || next.type === 'table')) out += para('', '');  // keeps tables apart
      });
      return out || para('', '');
    }

    return { body: body, links: links, orderedLists: orderedLists };
  }

  function stylesXml(font, size) {
    var f = QC.markup.escapeXml(font), sz = Math.round(size * 2);
    function heading(n, pt, color) {
      return '<w:style w:type="paragraph" w:styleId="Heading' + n + '"><w:name w:val="heading ' + n + '"/><w:basedOn w:val="Normal"/>' +
        '<w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/>' +
        '<w:spacing w:before="' + (n < 3 ? 360 : 240) + '" w:after="80"/><w:outlineLvl w:val="' + (n - 1) + '"/></w:pPr>' +
        '<w:rPr><w:b/><w:bCs/>' + (color ? '<w:color w:val="' + color + '"/>' : '') + '<w:sz w:val="' + pt * 2 + '"/><w:szCs w:val="' + pt * 2 + '"/></w:rPr></w:style>';
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:styles xmlns:w="' + W + '">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="' + f + '" w:hAnsi="' + f + '" w:eastAsia="' + f + '" w:cs="' + f + '"/>' +
      '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>' +
      heading(1, Math.round(size * 1.8), '1F3864') + heading(2, Math.round(size * 1.45), '1F3864') + heading(3, Math.round(size * 1.25), '1F3864') +
      heading(4, Math.round(size * 1.1)) + heading(5, size) + heading(6, size) +
      '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>' +
      '<w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/>' +
      '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="360"/></w:pPr>' +
      '<w:rPr><w:color w:val="404040"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="' + Math.max(16, sz - 2) + '"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:basedOn w:val="DefaultParagraphFont"/>' +
      '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/>' +
      '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/>' +
      '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
      '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>' +
      '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>' +
      '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders>' +
      '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      '</w:styles>';
  }

  function numberingXml(orderedLists) {
    var bullets = ['•', '◦', '▪'], formats = ['decimal', 'lowerLetter', 'lowerRoman'];
    function levels(bullet) {
      var out = '';
      for (var i = 0; i < 9; i++) {
        out += '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + (bullet ? 'bullet' : formats[i % 3]) + '"/>' +
          '<w:lvlText w:val="' + (bullet ? bullets[i % 3] : '%' + (i + 1) + '.') + '"/><w:lvlJc w:val="left"/>' +
          '<w:pPr><w:ind w:left="' + 720 * (i + 1) + '" w:hanging="360"/></w:pPr></w:lvl>';
      }
      return out;
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:numbering xmlns:w="' + W + '">' +
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + levels(true) + '</w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' + levels(false) + '</w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
      orderedLists.map(function (l, i) {           // each numbered list starts again from its own first number
        return '<w:num w:numId="' + (i + 2) + '"><w:abstractNumId w:val="1"/>' +
          '<w:lvlOverride w:ilvl="' + (l.level || 0) + '"><w:startOverride w:val="' + l.start + '"/></w:lvlOverride></w:num>';
      }).join('') +
      '</w:numbering>';
  }

  async function write(doc, opts) {
    var o = options(opts), x = QC.markup.escapeXml, w = writer();
    var body = w.body(doc.blocks);
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:document xmlns:w="' + W + '" xmlns:r="' + R + '"><w:body>' + body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
      'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + R + '/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="' + R + '/numbering" Target="numbering.xml"/>' +
      w.links.map(function (l) {
        return '<Relationship Id="' + l.id + '" Type="' + R + '/hyperlink" Target="' + x(l.href) + '" TargetMode="External"/>';
      }).join('') + '</Relationships>';
    var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var files = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="' + R + '/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>'],
      ['word/document.xml', xml],
      ['word/styles.xml', stylesXml(o.font, o.size)],
      ['word/numbering.xml', numberingXml(w.orderedLists)],
      ['word/_rels/document.xml.rels', rels],
      ['docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + x(doc.title || '') + '</dc:title>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
        '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>']
    ];
    var zip = await QC.zip.build(files.map(function (f) { return { name: f[0], blob: new Blob([f[1]]) }; }));
    return new Blob([zip], { type: QC.formats.get('docx').mime });
  }

  // The document on a sheet of paper, roughly as Word shows it.
  function preview(doc, opts) {
    var o = options(opts);
    return '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>' + QC.markup.escapeHtml(doc.title || 'Document') + '</title>\n' +
      '<style>html{background:#d9d9d6}body{box-sizing:border-box;max-width:21cm;min-height:29.7cm;margin:16px auto;padding:2.54cm;' +
      'background:#ffffff;color:#1e1e20;box-shadow:0 1px 4px rgba(0,0,0,.25);font:' + o.size + 'pt/1.15 ' + FONT_CSS[o.font] + '}' +
      'h1,h2,h3{color:#1f3864}h1{font-size:1.8em}h2{font-size:1.45em}h3{font-size:1.25em}h4{font-size:1.1em}h5,h6{font-size:1em}' +
      'p{margin:0 0 8pt}a{color:#0563c1}pre{padding:4pt 6pt;background:#f2f2f2;font:.92em/1.2 Consolas,monospace;white-space:pre-wrap}' +
      'code{font-family:Consolas,monospace;background:#f2f2f2}blockquote{margin:0 0 8pt;padding-left:10pt;border-left:3pt solid #bfbfbf;color:#404040}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:8pt}th,td{border:1px solid #1e1e20;padding:2pt 5pt;text-align:left;vertical-align:top}' +
      'img{max-width:100%}@media (max-width:600px){body{padding:1.2cm;min-height:0}}</style>\n</head>\n<body>\n' +
      QC.doc.toHtml(doc) + '\n</body>\n</html>\n';
  }

  return { read: read, write: write, preview: preview, FONTS: Object.keys(FONT_CSS) };
}, { worker: true });
