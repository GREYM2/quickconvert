/*
 * Settings panel for one file: output name and format, "copy to all", and then
 *   images:    quality, file size, resize, resampling and a live before/after preview
 *   documents: the original text (editable) and a live view of the converted result
 *
 * Image preview runs in two steps, debounced 400 ms after each change:
 *   1. fast:  render from a <=1200 px copy, estimate the output size from the pixel ratio
 *   2. exact: full-resolution conversion. Its result is cached on the item, so pressing
 *             Convert afterwards with the same settings is instant (documents cache too).
 */
QC.define('panel', function (QC) {
  'use strict';

  var DEBOUNCE = 400;
  var TEXT_TYPES = { csv: true, json: true, txt: true, md: true };
  var EDIT_LIMIT = 2e6;      // bigger text files are shown read-only (a textarea gets slow)
  var PEEK_BYTES = 100e3;    // how much of a big file to show
  var SHOW_CHARS = 200e3;    // how much result text to show
  var TABLE_COLS = 50;
  var EXT_ALIAS = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', htm: 'html', markdown: 'md', text: 'txt' };

  /*
   * ctx: { onChange(item), onTarget(item), onRename(item), onClose(), onApplyAll(item, keepSize) -> count,
   *        copyLabel(item), outputs(item), outputName(item), sourceFile(item), settingsKey(item),
   *        jobOptions(item), formatBytes(n), percentChange(a, b) }
   * host: the file's row (phones) or the side column (wide screens). mount() moves the panel.
   */
  function open(item, host, ctx) {
    var root = document.getElementById('tpl-panel').content.firstElementChild.cloneNode(true);
    host.appendChild(root);
    var isImage = item.kind === 'image';
    var $ = function (sel) { return root.querySelector(sel); };
    var el = {
      sub: $('.panel-sub'), pName: $('.p-name'), nameTip: $('.name-tip'), nameNote: $('.p-name-note'),
      copy: $('.copy-all'), reset: $('.reset'), headMain: $('.head-main'),
      confirm: $('.head-confirm'), confirmQ: $('.confirm-question'),
      bgField: $('[data-show="background"]'), bgPicks: root.querySelectorAll('.bg-pick'),
      bgColor: $('.bg-color'), bgChip: $('.bg-custom-chip'), bgHint: $('.bg-hint'),
      body: $('.panel-body'), settings: $('.panel-settings'), previewCol: $('.panel-preview'),
      target: $('.p-target'),
      qField: $('[data-show="quality"]'), qRange: $('.q-range'), qNum: $('.q-num'), qFound: $('.q-found'),
      tField: $('[data-show="target"]'), tModes: root.querySelectorAll('.t-mode'), tInputs: $('.t-inputs'),
      tValue: $('.t-value'), tUnit: $('.t-unit'), tNote: $('.t-note'),
      modes: root.querySelectorAll('.r-mode'), rPercent: $('.r-percent'), rPct: $('.r-pct'),
      rPixels: $('.r-pixels'), rW: $('.r-w'), rH: $('.r-h'), rLock: $('.r-lock'), rInfo: $('.r-info'),
      rs: $('.rs'), stats: $('.preview-stats'),
      docSrc: $('.doc-src'), docSrcView: $('.doc-src-view'), docSrcNote: $('.doc-src-note'),
      docOut: $('.doc-out'), docOutNote: $('.doc-out-note')
    };
    root.querySelectorAll('[data-image]').forEach(function (n) { n.hidden = !isImage; });
    root.querySelectorAll('[data-doc]').forEach(function (n) { n.hidden = isImage; });
    el.body.classList.toggle('is-doc', !isImage);
    el.reset.textContent = isImage ? 'Reset' : 'Undo edits';
    el.reset.title = isImage ? 'Reset the image settings' : 'Go back to the file as it was';
    el.modes.forEach(function (r) { r.name = 'resize-' + item.id; });
    el.tModes.forEach(function (r) { r.name = 'size-' + item.id; });
    el.bgPicks.forEach(function (r) { r.name = 'bg-' + item.id; });
    el.copy.textContent = ctx.copyLabel(item);
    $('.panel-close').addEventListener('click', function () { ctx.onClose(); });
    var outputs = ctx.outputs(item);
    outputs.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o;
      opt.textContent = QC.formats.get(o).label;
      el.target.appendChild(opt);
    });
    el.nameTip.textContent = 'End the name with ' + outputs.map(function (o) { return '.' + o; }).join(', ') + ' to change the format.';

    // The name field is as wide as the name, so the pencil sits right at the end of it.
    var measure = document.createElement('span');
    measure.className = 'name-measure';
    measure.setAttribute('aria-hidden', 'true');
    el.pName.parentNode.appendChild(measure);
    function setName(value) {
      if (value !== undefined) el.pName.value = value;
      measure.textContent = el.pName.value || ' ';
      el.pName.style.width = Math.ceil(measure.getBoundingClientRect().width) + 22 + 'px'; // + padding and border
    }
    el.pName.addEventListener('input', function () { setName(); });

    var compare = isImage ? QC.preview.create($('.preview-host'), { maxHeight: previewMaxHeight, controls: $('.zoom-slot') }) : null;
    var timer = null, generation = 0, closed = false;
    var fast = null, exact = null, exactBusy = false, exactProgress = 0, previewError = '';
    var docToken = 0;
    var s = item.settings;

    // Keep the whole panel on screen in the side column (sized for the unscrolled page): the
    // picture gets the height the rest leaves. Below a file on phones: a share of the screen.
    function previewMaxHeight() {
      var portrait = root.classList.contains('is-portrait');
      var side = root.closest('.col-side');
      if (!side) return window.innerHeight * (portrait ? 0.7 : 0.6);
      var avail = window.innerHeight - (side.getBoundingClientRect().top + window.scrollY) - 16;
      var box = root.querySelector('.compare');
      var boxH = box ? box.offsetHeight : 0;
      var chrome = root.offsetHeight - el.body.offsetHeight;          // name, save as, padding
      var extra = el.previewCol.offsetHeight - boxH;                  // zoom buttons and stats
      var bodyStyle = getComputedStyle(el.body);
      if (bodyStyle.gridTemplateColumns.split(' ').length > 1) {
        // Settings beside the preview. On short screens they are the taller column; use that height.
        return Math.max(avail - chrome - extra, el.settings.offsetHeight - extra);
      }
      return avail - chrome - extra - el.settings.offsetHeight - (parseFloat(bodyStyle.rowGap) || 0);
    }

    /* ----- fields <-> settings ----- */

    function lossy() { return !!QC.image.LOSSY[item.target]; }

    function setFill(range) {
      range.style.setProperty('--fill', (range.value - range.min) / (range.max - range.min) * 100 + '%');
    }

    function fill() {
      el.target.value = item.target;
      setName(ctx.outputName(item));
      if (isImage) {
        el.tModes.forEach(function (r) { r.checked = r.value === (s.targetOn ? 'target' : 'auto'); });
        el.tValue.value = s.targetValue;
        el.tUnit.value = s.targetUnit;
        el.modes.forEach(function (r) { r.checked = r.value === s.resizeMode; });
        el.rPct.value = s.percent;
        el.rW.value = s.width;
        el.rH.value = s.height;
        el.rs.value = s.resample;
        var preset = s.background === '#ffffff' || s.background === '#000000';
        el.bgPicks.forEach(function (r) { r.checked = preset ? r.value === s.background : r.value === 'custom'; });
        if (!preset) el.bgColor.value = s.background;
        el.bgChip.style.setProperty('--c', el.bgColor.value);
      } else {
        el.reset.disabled = item.editedText == null;
      }
      sync();
    }

    // Visibility and derived values. Call after any change.
    function sync() {
      el.sub.textContent = (item.type || '').toUpperCase() + ' → ' + (item.target || '').toUpperCase() +
        ' · ' + ctx.formatBytes(item.file.size) + ' · from ' + item.file.name;
      el.sub.title = el.sub.textContent;
      if (document.activeElement !== el.pName) setName(ctx.outputName(item));
      if (!isImage) return;
      var ico = item.target === 'ico';
      el.qField.hidden = !lossy();
      el.tField.hidden = ico;
      el.tInputs.hidden = !s.targetOn;
      // Only when the picture really has transparent areas and the format can't keep them.
      el.bgField.hidden = !(item.hasAlpha && QC.image.NO_ALPHA[item.target]);
      el.bgHint.textContent = QC.formats.get(item.target).label + ' has no transparency, so transparent areas get this colour.';
      renderQuality(s.targetOn && !ico && lossy());
      el.rPercent.hidden = s.resizeMode !== 'percent';
      el.rPixels.hidden = s.resizeMode !== 'pixels';
      el.rLock.setAttribute('aria-pressed', String(!!s.lockAspect));
      el.rLock.classList.toggle('is-on', !!s.lockAspect);

      var d = item.dims;
      el.rW.disabled = el.rH.disabled = !d;
      if (!d) {
        el.rInfo.textContent = 'Reading image…';
      } else {
        var out = QC.image.computeSize(d.width, d.height, s);
        el.rInfo.textContent = 'Original ' + d.width + ' × ' + d.height +
          (out.width !== d.width || out.height !== d.height ? '  →  ' + out.width + ' × ' + out.height : '') +
          (ico ? ' (ICO: fitted into ' + Math.min(256, Math.max(out.width, out.height)) + ' px square)' : '');
        // Below a file (phones), tall pictures may use more of the screen height.
        root.classList.toggle('is-portrait', out.height > out.width * 1.1);
      }
      renderTargetNotes();
      renderStats();
      compare.layout(); // the panel's height may have changed
    }

    // Slider and number box show the same value. With a target size they show the quality found.
    function renderQuality(byTarget) {
      var found = exact && exact.quality ? exact.quality : fast && fast.quality ? fast.quality : null;
      var q = byTarget && found ? found : s.quality;
      el.qRange.disabled = el.qNum.disabled = byTarget;
      el.qRange.value = q;
      setFill(el.qRange);
      if (document.activeElement !== el.qNum || byTarget) el.qNum.value = q;
    }

    function renderTargetNotes() {
      var active = s.targetOn && item.target !== 'ico' && QC.image.targetBytes(s) > 0;
      var q = exact && exact.quality ? exact.quality : null;
      el.qFound.hidden = !(s.targetOn && lossy());
      if (s.targetOn && lossy()) {
        el.qFound.textContent = !active ? 'Set by the target size.'
          : q ? 'Quality found for the target: ' + q
          : fast && fast.quality ? 'Quality found: ~' + fast.quality + ' (estimating)' : 'Finding the quality…';
      }
      var note = '';
      if (active && !lossy()) {
        note = item.target.toUpperCase() + ' is lossless, so quality can\'t shrink it. The only way here is to reduce the dimensions.';
        if (exact && exact.mode === 'scale' && !exact.unreachable) {
          note += exact.scale < 100 ? ' Scaled to ' + exact.scale + '% (' + exact.width + ' × ' + exact.height + ').' : ' Already fits at full size.';
        }
      }
      if (active && exact && exact.unreachable) {
        note = 'Can\'t get under ' + ctx.formatBytes(QC.image.targetBytes(s)) + '. Smallest possible: ' +
          ctx.formatBytes(exact.blob.size) + (exact.mode === 'quality' ? ' at quality 1' : ' at 1% size') +
          '. Raise the target or resize the image.';
      }
      el.tNote.textContent = note;
      el.tNote.hidden = !note;
      el.tNote.classList.toggle('is-warn', !!(exact && exact.unreachable && active));
    }

    function renderStats() {
      if (previewError) { el.stats.textContent = previewError; el.stats.classList.add('is-error'); return; }
      el.stats.classList.remove('is-error');
      if (!item.dims) { el.stats.textContent = 'Loading preview…'; return; }
      var parts = [];
      parts.push(fast ? 'Estimated ≈ ' + ctx.formatBytes(fast.estimate) : 'Estimating…');
      if (exact && !exactBusy) {
        parts.push('Actual ' + ctx.formatBytes(exact.blob.size) + ' (' + ctx.percentChange(item.file.size, exact.blob.size) + ')');
        parts.push(exact.width + ' × ' + exact.height);
      } else {
        parts.push('Actual: calculating…' + (exactProgress ? ' ' + Math.round(exactProgress * 100) + '%' : ''));
      }
      el.stats.textContent = parts.join('  ·  ');
    }

    // The exact result belongs to the old settings; show "calculating" until the new one lands.
    function stale() {
      exact = null;
      exactBusy = true;
      exactProgress = 0;
    }

    function changed() {
      stale();
      sync();
      ctx.onChange(item);
      schedule();
    }

    /* ----- output name ----- */

    function setNameNote(text) {
      el.nameNote.textContent = text || '';
      el.nameNote.hidden = !text;
    }

    // "photo.webp" -> name "photo", format WebP (when this file can become WebP).
    function commitName() {
      var value = el.pName.value.trim(), base = value, note = '';
      var m = /^(.*)\.([a-z0-9]{1,10})$/i.exec(value);
      if (m) {
        var ext = m[2].toLowerCase(), key = EXT_ALIAS[ext] || ext;
        var known = QC.formats.get(key) || QC.formats.detect('x.' + ext);
        if (known && outputs.indexOf(known.key) !== -1) {
          base = m[1];
          if (known.key !== item.target) {
            item.target = known.key;
            ctx.onTarget(item);
            refresh();
          }
        } else if (known) {
          base = m[1];
          note = 'This file can\'t become ' + known.label + ', so it stays ' + QC.formats.get(item.target).label + '.';
        }
      }
      base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
      item.outBase = base || null;
      ctx.onRename(item);
      setName(ctx.outputName(item));
      setNameNote(note);
    }

    el.pName.addEventListener('change', commitName);
    el.pName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); el.pName.blur(); }
      if (e.key === 'Escape') { setName(ctx.outputName(item)); el.pName.blur(); }
    });
    el.pName.addEventListener('focus', function () {
      var dot = el.pName.value.lastIndexOf('.');      // select the name, not the extension
      el.pName.setSelectionRange(0, dot > 0 ? dot : el.pName.value.length);
    });

    /* ----- events ----- */

    el.target.addEventListener('change', function () {
      item.target = el.target.value;
      setNameNote('');
      ctx.onTarget(item);
      refresh();
    });

    el.qRange.addEventListener('input', function () {
      s.quality = parseInt(el.qRange.value, 10);
      changed();
    });
    el.qNum.addEventListener('input', function () {
      var v = parseInt(el.qNum.value, 10);
      if (!(v >= 1 && v <= 100)) return; // wait for a valid number
      s.quality = v;
      changed();
    });
    el.qNum.addEventListener('change', function () { el.qNum.value = s.quality; });
    el.tModes.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        s.targetOn = r.value === 'target';
        if (s.targetOn) el.tValue.focus();
        changed();
      });
    });
    el.tValue.addEventListener('input', function () { s.targetValue = el.tValue.value; changed(); });
    el.tUnit.addEventListener('change', function () { s.targetUnit = el.tUnit.value; changed(); });
    el.rs.addEventListener('change', function () { s.resample = el.rs.value; changed(); });

    el.bgPicks.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        s.background = r.value === 'custom' ? el.bgColor.value : r.value;
        changed();
      });
    });
    // The custom swatch always opens the colour picker (also when it's already chosen).
    $('.swatch-custom').addEventListener('click', function (e) {
      if (e.target.tagName !== 'INPUT') el.bgColor.click();
    });
    el.bgColor.addEventListener('input', function () {
      s.background = el.bgColor.value;
      el.bgChip.style.setProperty('--c', el.bgColor.value);
      el.bgPicks.forEach(function (r) { r.checked = r.value === 'custom'; });
      changed();
    });

    el.modes.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        s.resizeMode = r.value;
        if (s.resizeMode === 'pixels' && item.dims && !s.width && !s.height) {
          s.width = String(item.dims.width);
          s.height = String(item.dims.height);
          s.lockDriver = 'w';
          el.rW.value = s.width;
          el.rH.value = s.height;
        }
        changed();
      });
    });
    el.rPct.addEventListener('input', function () { s.percent = el.rPct.value; changed(); });

    function linked(from) {
      var d = item.dims;
      if (!d || !s.lockAspect) return;
      if (from === 'w') {
        var w = parseInt(s.width, 10);
        s.height = w > 0 ? String(Math.max(1, Math.round(w * d.height / d.width))) : '';
        el.rH.value = s.height;
      } else {
        var h = parseInt(s.height, 10);
        s.width = h > 0 ? String(Math.max(1, Math.round(h * d.width / d.height))) : '';
        el.rW.value = s.width;
      }
    }
    el.rW.addEventListener('input', function () { s.width = el.rW.value; s.lockDriver = 'w'; linked('w'); changed(); });
    el.rH.addEventListener('input', function () { s.height = el.rH.value; s.lockDriver = 'h'; linked('h'); changed(); });
    el.rLock.addEventListener('click', function () {
      s.lockAspect = !s.lockAspect;
      if (s.lockAspect) linked(s.lockDriver);
      changed();
    });

    el.reset.addEventListener('click', function () {
      if (isImage) {
        var fresh = QC.image.defaults();
        Object.keys(fresh).forEach(function (k) { s[k] = fresh[k]; });
      } else {
        item.editedText = null;
        item.editVersion++;
        loadSource();
      }
      stale();
      fill();
      ctx.onChange(item);
      schedule();
    });

    /* ----- copy settings to other files ----- */

    // An exact pixel size only fits this picture, so the top row turns into a question first.
    function onConfirmKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); } }

    function openConfirm() {
      var out = item.dims ? QC.image.computeSize(item.dims.width, item.dims.height, s) : { width: s.width, height: s.height };
      el.confirmQ.textContent = 'Also copy the exact size (' + out.width + ' × ' + out.height + ' px)?';
      el.headMain.hidden = true;
      el.confirm.hidden = false;
      document.addEventListener('keydown', onConfirmKey);
      $('.copy-cancel').focus();
    }

    function closeConfirm() {
      if (el.confirm.hidden) return;
      el.confirm.hidden = true;
      el.headMain.hidden = false;
      document.removeEventListener('keydown', onConfirmKey);
      el.copy.focus();
    }

    function copy(keepSize) {
      closeConfirm();
      var n = ctx.onApplyAll(item, keepSize);
      el.copy.textContent = n ? 'Copied to ' + n + (n === 1 ? ' file' : ' files') : 'No other files to copy to';
      setTimeout(function () { el.copy.textContent = ctx.copyLabel(item); }, 1800);
    }

    el.copy.addEventListener('click', function () {
      if (isImage && s.resizeMode === 'pixels') openConfirm();
      else copy(false);
    });
    $('.copy-cancel').addEventListener('click', closeConfirm);
    $('.copy-except').addEventListener('click', function () { copy(true); });
    $('.copy-everything').addEventListener('click', function () { copy(false); });

    /* ----- documents: original (editable) and result ----- */

    function note(text) {
      var p = document.createElement('p');
      p.className = 'doc-more';
      p.textContent = text;
      return p;
    }

    function cell(v) {
      if (v === null || v === undefined) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }

    function renderTable(box, rows, total) {
      box.textContent = '';
      if (!rows || !rows.length) { box.appendChild(note('No rows.')); return; }
      var table = document.createElement('table');
      var head = table.createTHead(), body = table.createTBody();
      rows.forEach(function (row, i) {
        var tr = (i === 0 ? head : body).insertRow();
        row.slice(0, TABLE_COLS).forEach(function (v) {
          var c = document.createElement(i === 0 ? 'th' : 'td');
          c.textContent = cell(v);
          tr.appendChild(c);
        });
      });
      box.appendChild(table);
      if (total > rows.length - 1) {
        box.appendChild(note('Showing the first ' + (rows.length - 1) + ' of ' + total.toLocaleString() + ' rows.'));
      }
    }

    function renderText(box, text) {
      box.textContent = '';
      var pre = document.createElement('pre');
      pre.textContent = text.length > SHOW_CHARS ? text.slice(0, SHOW_CHARS) : text;
      box.appendChild(pre);
      if (text.length > SHOW_CHARS) box.appendChild(note('Showing the first 200 KB.'));
    }

    // Converted HTML in a sandboxed frame: no scripts, no access to this page.
    function renderHtml(box, html) {
      box.textContent = '';
      var css = getComputedStyle(document.documentElement);
      var frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.title = 'Converted page';
      frame.srcdoc = html.replace('</head>', '<style>body{background:' + css.getPropertyValue('--bg') +
        ';color:' + css.getPropertyValue('--text') + '}a{color:inherit}</style></head>');
      box.appendChild(frame);
    }

    async function loadSource() {
      if (TEXT_TYPES[item.type]) {
        var big = item.file.size > EDIT_LIMIT;
        el.docSrc.hidden = false;
        el.docSrcView.hidden = true;
        el.docSrc.readOnly = big;
        var text = item.editedText != null ? item.editedText
          : await (big ? item.file.slice(0, PEEK_BYTES) : item.file).text();
        if (closed) return;
        el.docSrc.value = text;
        el.docSrcNote.textContent = big ? 'First 100 KB. Files over 2 MB can\'t be edited here.'
          : item.editedText != null ? 'Edited' : 'Click to edit';
        return;
      }
      // Spreadsheets: a table of the first sheet.
      el.docSrc.hidden = true;
      el.docSrcView.hidden = false;
      el.docSrcNote.textContent = 'Reading…';
      try {
        var r = await QC.pool.run({ task: 'convert', key: 'docsrc:' + item.id, owner: item.id, priority: 3,
          file: item.file, options: { from: item.type, to: 'csv', settings: {} } });
        if (closed) return;
        renderTable(el.docSrcView, r.preview, r.rows);
        el.docSrcNote.textContent = r.note ? r.note.charAt(0).toUpperCase() + r.note.slice(1) : 'Read-only';
      } catch (err) {
        if (!ignorable(err) && !closed) el.docSrcNote.textContent = err.message;
      }
    }

    async function runDoc() {
      if (closed) return;
      var token = ++docToken, key = ctx.settingsKey(item);
      el.docOutNote.textContent = 'Converting…';
      el.docOut.classList.remove('is-error');
      try {
        var r = item.cache && item.cache.key === key ? item.cache.result : await QC.pool.run({
          task: 'convert', key: 'doc:' + item.id, owner: item.id, priority: 3,
          file: ctx.sourceFile(item), options: ctx.jobOptions(item)
        });
        if (closed || token !== docToken) return;
        item.cache = { key: key, result: r };
        var t = item.target, parts = [ctx.formatBytes(r.blob.size)];
        if (typeof r.rows === 'number') parts.push(r.rows.toLocaleString() + (r.rows === 1 ? ' row' : ' rows'));
        if (r.note) parts.push(r.note);
        if ((t === 'csv' || t === 'xlsx') && r.preview) {
          renderTable(el.docOut, r.preview, r.rows);
        } else {
          var text = await r.blob.text();
          if (closed || token !== docToken) return;
          if (t === 'html') renderHtml(el.docOut, text); else renderText(el.docOut, text);
        }
        el.docOut.classList.toggle('is-frame', t === 'html');
        el.docOutNote.textContent = parts.join(' · ');
      } catch (err) {
        if (ignorable(err) || closed || token !== docToken) return;
        el.docOut.classList.remove('is-frame');
        el.docOut.classList.add('is-error');
        el.docOut.textContent = err.message || 'Conversion failed.';
        el.docOutNote.textContent = '';
      }
    }

    el.docSrc.addEventListener('input', function () {
      item.editedText = el.docSrc.value;
      item.editVersion++;
      el.docSrcNote.textContent = 'Edited';
      el.reset.disabled = false;
      ctx.onChange(item);
      schedule();
    });

    /* ----- image preview pipeline ----- */

    function schedule(now) {
      clearTimeout(timer);
      timer = setTimeout(isImage ? runPreview : runDoc, now ? 0 : DEBOUNCE);
    }

    function ignorable(e) { return e && e.code === 'cancelled'; }

    function runFast(gen, override) {
      return QC.pool.run({
        task: 'preview', key: 'preview:' + item.id, owner: item.id, priority: 3,
        options: { bitmap: item.previewSource, srcWidth: item.dims.width, srcHeight: item.dims.height,
          to: item.target, settings: Object.assign({}, s), override: override }
      }).then(function (r) {
        if (gen !== generation || closed) return;
        if (override && fast) r.estimate = fast.estimate; // keep the prediction made before the exact result
        fast = r;
        compare.setResult(r.blob);
        sync();
      });
    }

    async function runPreview() {
      if (closed || !item.previewSource) return;
      var gen = ++generation;
      var key = ctx.settingsKey(item);
      previewError = '';
      exactProgress = 0;
      var cached = item.cache && item.cache.key === key ? item.cache.result : null;
      exact = cached;
      exactBusy = !cached;
      sync();
      try {
        await runFast(gen);
        if (gen !== generation || closed) return;
        if (!cached) {
          var r = await QC.pool.runImage({
            task: 'convert', key: 'exact:' + item.id, owner: item.id, priority: 2, file: item.file,
            options: ctx.jobOptions(item),
            onProgress: function (p) { if (gen === generation) { exactProgress = p; renderStats(); } }
          });
          if (gen !== generation || closed) return;
          item.cache = { key: key, result: r };
          exact = r;
          exactBusy = false;
          sync();
        }
        // Make the preview match what the exact step picked (quality or scaled size).
        var e = exact;
        if (e && (e.quality !== fast.quality || (e.mode === 'scale' && e.scale < 100))) {
          await runFast(gen, { quality: e.quality, width: e.mode === 'scale' ? e.width : 0, height: e.height });
        }
      } catch (err) {
        if (ignorable(err) || gen !== generation || closed) return;
        exactBusy = false;
        previewError = err.message || 'Preview failed.';
        renderStats();
      }
    }

    function prepare() {
      QC.pool.runImage({ task: 'prepare', key: 'prepare:' + item.id, owner: item.id, priority: 4, file: item.file, options: {} })
        .then(function (r) {
          if (closed) { r.bitmap.close(); return; }
          item.dims = { width: r.width, height: r.height };
          item.hasAlpha = r.hasAlpha;
          item.previewSource = r.bitmap;
          compare.setOriginal(r.bitmap);
          fill();
          schedule(true);
        }, function (err) {
          if (ignorable(err) || closed) return;
          previewError = err.message || 'Could not read this image.';
          renderStats();
        });
    }

    /* ----- lifecycle ----- */

    function close() {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', onConfirmKey);
      QC.pool.cancel(function (j) { return j.owner === item.id && /^(prepare|preview|exact|doc|docsrc):/.test(j.key || ''); });
      if (compare) compare.destroy();
      if (item.previewSource) { item.previewSource.close(); item.previewSource = null; }
      root.remove();
    }

    // Called by the app when the format or settings change from outside the panel.
    function refresh() { stale(); fill(); schedule(); }

    function mount(newHost) {
      if (root.parentNode !== newHost) newHost.appendChild(root);
    }

    // The copy button says "all" or "selected" depending on the file selection.
    function updateCopy() { el.copy.textContent = ctx.copyLabel(item); }

    fill();
    if (isImage) {
      prepare();
    } else {
      loadSource();
      schedule(true);
    }
    return { close: close, refresh: refresh, mount: mount, updateCopy: updateCopy, root: root };
  }

  return { open: open };
});
