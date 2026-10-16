/*
 * Settings panel for one file: output name and format, "copy to all", and then
 *   images:    quality, file size, resize, resampling and a live before/after preview
 *   documents: the original (editable text, or a page / table view) and a live view of the
 *              result (page, code or table), plus the settings that matter for the conversion
 *
 * Image preview runs in two steps, debounced 400 ms after each change:
 *   1. fast:  render from a <=1200 px copy, estimate the output size from the pixel ratio
 *   2. exact: full-resolution conversion. Its result is cached on the item, so pressing
 *             Convert afterwards with the same settings is instant (documents cache too).
 */
QC.define('panel', function (QC) {
  'use strict';

  var DEBOUNCE = 400;
  var TEXT_TYPES = { csv: true, tsv: true, json: true, yaml: true, xml: true, txt: true, md: true, html: true };
  var EDIT_LIMIT = 2e6;      // bigger text files are shown read-only (a textarea gets slow)
  var PEEK_BYTES = 100e3;    // how much of a big file to show
  var SHOW_CHARS = 200e3;    // how much result text to show
  var TABLE_COLS = 50;
  var PREVIEW_ROWS = 200;    // rows shown in table views
  var EXT_ALIAS = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', htm: 'html', markdown: 'md', text: 'txt', yml: 'yaml' };
  var docHeight = null;      // height of the document boxes, shared by every file (drag handle)
  var viewPrefs = {};        // Page / Code / Table chosen per format ("out:html": "code"), for every file
  var VIEW_LABELS = { code: 'Code', page: 'Page', text: 'Text', table: 'Table', original: 'Original', result: 'Result' };
  var ENC_NAMES = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16', 'windows-1251': 'Windows-1251 (Cyrillic)', 'windows-1252': 'Windows-1252 (Western)' };
  var DELIM_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

  /*
   * ctx: { onChange(item), onTarget(item), onRename(item), onClose(), onApplyAll(item, keepSize) -> count,
   *        copyLabel(item), outputs(item), groups(item), outputName(item), sourceFile(item), settingsKey(item),
   *        jobOptions(item), formatBytes(n), percentChange(a, b) }
   * host: the file's row (phones) or the side column (wide screens). mount() moves the panel.
   * opts.startPicture: the previous panel's picture, shown until this file's preview is ready.
   */
  function open(item, host, ctx, opts) {
    opts = opts || {};
    var ready = false;       // set after the first fill; from then on parts appear with motion
    var root = document.getElementById('tpl-panel').content.firstElementChild.cloneNode(true);
    host.appendChild(root);
    var mode = QC.formats.handler(item.type, item.target);   // which converter: image | media | data
    var isImage = mode === 'image', isMedia = mode === 'media', isDoc = mode === 'data';
    var $ = function (sel) { return root.querySelector(sel); };
    var el = {
      sub: $('.panel-sub'), pName: $('.p-name'), nameTip: $('.name-tip'), nameNote: $('.p-name-note'),
      copy: $('.copy-all'), reset: $('.reset'), headMain: $('.head-main'),
      confirm: $('.head-confirm'), confirmQ: $('.confirm-question'),
      bgField: $('[data-show="background"]'), bgPicks: root.querySelectorAll('.bg-pick'),
      bgCustom: $('.bg-custom'), bgChip: $('.bg-custom .bg-custom-chip'), bgHint: $('.bg-hint'),
      body: $('.panel-body'), settings: $('.panel-settings'), previewCol: $('.panel-preview'),
      target: $('.p-target'),
      qField: $('[data-show="quality"]'), qRange: $('.q-range'), qNum: $('.q-num'), qFound: $('.q-found'),
      tField: $('[data-show="target"]'), tModes: root.querySelectorAll('.t-mode'), tInputs: $('.t-inputs'),
      tValue: $('.t-value'), tUnit: $('.t-unit'), tNote: $('.t-note'),
      modes: root.querySelectorAll('.r-mode'), rPercent: $('.r-percent'), rPct: $('.r-pct'),
      rPixels: $('.r-pixels'), rW: $('.r-w'), rH: $('.r-h'), rLock: $('.r-lock'), rInfo: $('.r-info'),
      rs: $('.rs'), stats: $('.preview-stats'),
      cRatio: $('.c-ratio'), cEdit: $('.c-edit'), cHint: $('.c-hint'), cropHost: $('.crop-host'),
      previewHost: $('.preview-host'), zoomSlot: $('.zoom-slot'),
      doc: $('.panel-doc'), docGrip: $('.doc-grip'),
      pageField: $('[data-show="page"]'), pgPicks: root.querySelectorAll('.pg-pick'), pgCustom: $('.pg-custom'), pgChip: $('.pg-custom .pg-chip'),
      fontField: $('[data-show="font"]'), fontSel: $('.pg-font'), fontSearch: $('.font-search'), fontName: $('.font-name'),
      fontResults: $('.font-results'),
      fontNote: $('.font-note'),
      docEdit: $('.doc-edit'), docSrc: $('.doc-src'), docSrcView: $('.doc-src-view'), docSrcNote: $('.doc-src-note'),
      docOut: $('.doc-out'), docOutNote: $('.doc-out-note'),
      encField: $('[data-show="encoding"]'), dEncoding: $('.d-encoding'), encNote: $('.d-encoding-note'),
      delimField: $('[data-show="delimiter"]'), dDelimiter: $('.d-delimiter'), delimNote: $('.d-delimiter-note'),
      sheetField: $('[data-show="sheet"]'), dSheet: $('.d-sheet'), tableField: $('[data-show="table"]'), dTable: $('.d-table'),
      csvField: $('[data-show="csvDelimiter"]'), dCsv: root.querySelectorAll('.d-csv'),
      indentField: $('[data-show="indent"]'), dIndent: root.querySelectorAll('.d-indent'), indentAll: root.querySelectorAll('[data-indent-all]'),
      layoutField: $('[data-show="layout"]'), dLayout: root.querySelectorAll('.d-layout'),
      docxField: $('[data-show="docx"]'), dDocxFont: $('.d-docx-font'), dDocxSize: $('.d-docx-size'),
      optField: $('[data-show="options"]'), checks: root.querySelectorAll('[data-check]'),
      srcViews: $('.src-views'), outViews: $('.out-views'),
      vQualityField: $('[data-morph="f-vquality"]'), vQuality: root.querySelectorAll('.v-quality'), vKeep: $('.v-keep'),
      vQualityHint: $('.v-quality-hint'), vHeight: $('.v-height'), vFpsField: $('[data-morph="f-vfps"]'), vFps: $('.v-fps'),
      vVolField: $('[data-morph="f-volume"]'), vVol: $('.v-vol'), vVolNum: $('.v-vol-num'), vVolHint: $('.v-vol-hint'),
      vSizeField: $('[data-morph="f-vsize"]'), vChField: $('[data-morph="f-channels"]'), vCh: root.querySelectorAll('.v-ch'),
      vRateField: $('[data-morph="f-rate"]'), vRate: $('.v-rate'), vFadeField: $('[data-morph="f-fade"]'),
      vFadeIn: $('.v-fade-in'), vFadeOut: $('.v-fade-out'),
      player: $('.v-player'), anim: $('.v-anim'), trim: $('.trim'), trimStart: $('.trim-start'), trimEnd: $('.trim-end'),
      trimTimes: $('.trim-times'), vViews: $('.v-views'), vStats: $('.v-stats')
    };
    var srcUrl = isMedia ? URL.createObjectURL(item.file) : null;
    root.querySelectorAll('[data-image]').forEach(function (n) { n.hidden = !isImage; });
    root.querySelectorAll('[data-doc]').forEach(function (n) { n.hidden = !isDoc; });
    root.querySelectorAll('[data-video]').forEach(function (n) { n.hidden = !isMedia; });
    el.body.classList.toggle('is-doc', isDoc);
    el.reset.textContent = isDoc ? 'Undo edits' : 'Reset';
    el.reset.hidden = isDoc && !TEXT_TYPES[item.type];          // Word and spreadsheets can't be edited here
    el.reset.title = isImage ? 'Reset the image settings' : isMedia ? 'Reset the video settings' : 'Go back to the file as it was';
    el.modes.forEach(function (r) { r.name = 'resize-' + item.id; });
    el.tModes.forEach(function (r) { r.name = 'size-' + item.id; });
    el.bgPicks.forEach(function (r) { r.name = 'bg-' + item.id; });
    el.pgPicks.forEach(function (r) { r.name = 'pg-' + item.id; });
    [[el.dCsv, 'csv'], [el.dIndent, 'indent'], [el.dLayout, 'layout'], [el.vQuality, 'vq'], [el.vCh, 'ch']].forEach(function (g) {
      g[0].forEach(function (r) { r.name = g[1] + '-' + item.id; });
    });
    QC.docx.FONTS.forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = opt.textContent = f;
      el.dDocxFont.appendChild(opt);
    });
    el.copy.textContent = ctx.copyLabel(item);
    $('.panel-close').addEventListener('click', function () { ctx.onClose(); });
    var outputs = ctx.outputs(item);
    ctx.groups(item).forEach(function (g) {               // Tables / Data / Documents
      var parent = el.target;
      if (g.label) {
        parent = document.createElement('optgroup');
        parent.label = g.label;
        el.target.appendChild(parent);
      }
      g.keys.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o;
        opt.textContent = QC.formats.get(o).label;
        parent.appendChild(opt);
      });
    });
    el.nameTip.textContent = 'End the name with ' + outputs.map(function (o) { return '.' + o; }).join(', ') + ' to change the format.';

    // The name field is as wide as the name, so the pencil sits right at the end of it.
    var measure = document.createElement('span');
    measure.className = 'name-measure';
    measure.setAttribute('aria-hidden', 'true');
    el.pName.parentNode.appendChild(measure);
    var measured = null;     // name the width fits; null until measured while visible (measuring forces a layout)
    function setName(value) {
      if (value !== undefined && value === measured && value === el.pName.value) return;
      if (value !== undefined) el.pName.value = value;
      measure.textContent = el.pName.value || ' ';
      var w = measure.getBoundingClientRect().width;
      measured = w ? el.pName.value : null;
      el.pName.style.width = Math.ceil(w) + 22 + 'px'; // + padding and border
    }
    el.pName.addEventListener('input', function () { setName(); });

    var compare = isImage ? QC.preview.create($('.preview-host'),
      { maxHeight: previewMaxHeight, controls: $('.zoom-slot'), start: opts.startPicture }) : null;
    var timer = null, generation = 0, closed = false;
    var fast = null, exact = null, exactBusy = false, exactProgress = 0, previewError = '';
    var docToken = 0, srcToken = 0, lastOut = null;
    var detected = { encoding: '', delimiter: '' };   // what auto-detection found, for the hints
    var s = item.settings;

    // Keep the whole panel on screen in the side column (sized for the unscrolled page): the
    // picture gets the height the rest leaves. Below a file on phones: a share of the screen.
    function previewMaxHeight() {
      var portrait = root.classList.contains('is-portrait');
      var side = root.closest('.col-side');
      var screenH = QC.preview.screenHeight();
      if (!side) return screenH * (portrait ? 0.7 : 0.6);
      var avail = screenH - (side.getBoundingClientRect().top + window.scrollY) - 16;
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

    // Show / hide parts: pairs of [element, visible]. After opening, parts appear and
    // disappear with motion and the panel's height follows (js/ui/motion.js).
    function show(pairs) {
      var needed = pairs.some(function (p) { return p[0].hidden === p[1]; });
      function apply() { pairs.forEach(function (p) { p[0].hidden = !p[1]; }); }
      if (needed && ready) QC.motion.morph(root, apply);
      else apply();
    }

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
        el.cRatio.value = s.cropRatio;
        var preset = s.background === '#ffffff' || s.background === '#000000';
        el.bgPicks.forEach(function (r) { r.checked = preset ? r.value === s.background : r.value === 'custom'; });
        if (!preset) el.bgChip.style.setProperty('--c', s.background);
      } else if (isMedia) {
        fillVideo();
      } else {
        el.reset.disabled = item.editedText == null;
        var d = item.doc;
        el.dEncoding.value = d.encoding;
        el.dDelimiter.value = d.delimiter;
        setRadios(el.dCsv, d.csvDelimiter);
        setRadios(el.dLayout, d.layout);
        el.dDocxFont.value = d.docxFont;
        el.dDocxSize.value = d.docxSize;
        el.checks.forEach(function (c) { c.querySelector('input').checked = !!d[c.dataset.check]; });
        fillPickers();
        var pg = item.page, presets = Array.prototype.map.call(el.pgPicks, function (r) { return r.value; });
        var preset = presets.indexOf(pg.background) !== -1;
        el.pgPicks.forEach(function (r) { r.checked = preset ? r.value === pg.background : r.value === 'custom'; });
        if (!preset) el.pgChip.style.setProperty('--c', pg.background);
        showFont(pg.font);
      }
      sync();
    }

    // Visibility and derived values. Call after any change.
    function sync() {
      el.sub.textContent = (item.type || '').toUpperCase() + ' → ' + (item.target || '').toUpperCase() +
        ' · ' + ctx.formatBytes(item.file.size) + ' · from ' + item.file.name;
      el.sub.title = el.sub.textContent;
      if (document.activeElement !== el.pName) setName(ctx.outputName(item));
      if (isMedia) { syncVideo(); return; }
      if (!isImage) {
        var need = QC.data.settingsFor(item.type, item.target), meta = item.meta || {}, html = need.page;
        var checks = [], anyCheck = false;
        el.checks.forEach(function (c) {
          var on = !!need[c.dataset.check];
          anyCheck = anyCheck || on;
          checks.push([c, on]);
        });
        el.indentAll.forEach(function (l) { checks.push([l, need.indentAll]); });
        setRadios(el.dIndent, need.indentAll || /^[24]$/.test(item.doc.indent) ? item.doc.indent : '2');
        el.dEncoding.disabled = item.editedText != null;
        el.encNote.textContent = item.editedText != null ? 'Your edits are used as they are. Undo them to change the encoding.'
          : item.doc.encoding === 'auto' && detected.encoding && detected.encoding !== 'utf-8' ? 'Found: ' + (ENC_NAMES[detected.encoding] || detected.encoding) + '.' : '';
        el.delimNote.textContent = item.doc.delimiter === 'auto' && detected.delimiter ? 'Found: ' + (DELIM_NAMES[detected.delimiter] || detected.delimiter) + '.' : '';
        show([[el.pageField, html], [el.fontField, html], [el.fontSearch, html && el.fontSel.value === 'search'],
          [el.fontNote, html && !!el.fontNote.textContent],
          [el.encField, need.encoding], [el.encNote, need.encoding && !!el.encNote.textContent],
          [el.delimField, need.delimiter], [el.delimNote, need.delimiter && !!el.delimNote.textContent],
          [el.sheetField, need.sheet && (meta.sheets || []).length > 1],
          [el.tableField, need.table && (meta.tables || []).length > 1],
          [el.csvField, need.csvDelimiter], [el.indentField, need.indent], [el.layoutField, need.layout],
          [el.docxField, need.docx], [el.optField, anyCheck]].concat(checks));
        return;
      }
      var ico = item.target === 'ico';
      el.bgHint.textContent = QC.formats.get(item.target).label + ' has no transparency, so transparent areas get this colour.';
      renderQuality(s.targetOn && !ico && lossy());
      show([
        [el.qField, lossy()],
        [el.tField, !ico],
        [el.tInputs, s.targetOn],
        // Only when the picture really has transparent areas and the format can't keep them.
        [el.bgField, !!(item.hasAlpha && QC.image.NO_ALPHA[item.target])],
        [el.rPercent, s.resizeMode === 'percent'],
        [el.rPixels, s.resizeMode === 'pixels']
      ].concat(renderTargetNotes()));
      el.cEdit.textContent = cropper ? 'Done' : 'Edit';
      show([[el.cEdit, s.cropRatio !== 'none'], [el.cHint, !!cropper]]);
      el.rLock.setAttribute('aria-pressed', String(!!s.lockAspect));
      el.rLock.classList.toggle('is-on', !!s.lockAspect);

      var d = item.dims;
      el.rW.disabled = el.rH.disabled = !d;
      if (!d) {
        el.rInfo.textContent = 'Reading image…';
      } else {
        var out = QC.image.computeSize(d.width, d.height, s), c = QC.image.cropRect(d.width, d.height, s);
        el.rInfo.textContent = 'Original ' + d.width + ' × ' + d.height + (item.type === 'raw' ? ' (the camera\'s own picture)' : '') +
          (c.width !== d.width || c.height !== d.height ? '  ·  cropped to ' + c.width + ' × ' + c.height : '') +
          (out.width !== c.width || out.height !== c.height ? '  →  ' + out.width + ' × ' + out.height : '') +
          (ico ? ' (ICO: fitted into ' + Math.min(256, Math.max(out.width, out.height)) + ' px square)' : '');
        // Below a file (phones), tall pictures may use more of the screen height.
        root.classList.toggle('is-portrait', out.height > out.width * 1.1);
      }
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

    // Sets the notes' text; returns their visibility for show().
    function renderTargetNotes() {
      var active = s.targetOn && item.target !== 'ico' && QC.image.targetBytes(s) > 0;
      var q = exact && exact.quality ? exact.quality : null;
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
      if (note) el.tNote.textContent = note;
      el.tNote.classList.toggle('is-warn', !!(exact && exact.unreachable && active));
      return [[el.qFound, s.targetOn && lossy()], [el.tNote, !!note]];
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

    // A result of another shape (crop, unlocked size) would sit in the wrong frame until the new one
    // lands: the preview shows the original alone meanwhile.
    function reframe() {
      if (!compare || !item.dims) return;
      var out = item.target === 'ico' ? { width: 1, height: 1 } : QC.image.computeSize(item.dims.width, item.dims.height, s);
      var a = compare.resultAspect();
      if (a && Math.abs(a * out.height / out.width - 1) > 0.02) compare.clearResult();
    }

    function changed() {
      stale();
      reframe();
      sync();
      ctx.onChange(item);
      schedule();
    }

    /* ----- output name ----- */

    function setNameNote(text) {
      if (text) el.nameNote.textContent = text;
      show([[el.nameNote, !!text]]);
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
        if (r.value === 'custom') pickCustom(el.bgCustom, el.bgChip, el.bgPicks, applyBg); // keyboard
        s.background = r.value === 'custom' ? customColor(el.bgChip) : r.value;
        changed();
      });
    });
    function applyBg(c) { s.background = c; changed(); }
    customSwatch(el.bgCustom, el.bgChip, el.bgPicks, applyBg);

    el.modes.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        s.resizeMode = r.value;
        if (s.resizeMode === 'pixels' && item.dims && !s.width && !s.height) {
          var kept = QC.image.cropRect(item.dims.width, item.dims.height, s);
          s.width = String(kept.width);
          s.height = String(kept.height);
          s.lockDriver = 'w';
          el.rW.value = s.width;
          el.rH.value = s.height;
        }
        changed();
      });
    });
    el.rPct.addEventListener('input', function () { s.percent = el.rPct.value; changed(); });

    function linked(from) {
      if (!item.dims || !s.lockAspect) return;
      var d = QC.image.cropRect(item.dims.width, item.dims.height, s);   // the shape that's kept
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
        editCrop(false);
        reframe();
      } else if (isMedia) {
        item.video = QC.video.defaults();
        el.player.volume = 1;
        el.player.muted = false;
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

    /* ----- crop ----- */

    var cropper = null;

    // Width / height of a crop shape, in pixels; 0 = any shape.
    function cropShape(v) {
      if (v === 'orig') return item.dims ? item.dims.width / item.dims.height : 0;
      var m = /^(\d+):(\d+)$/.exec(v);
      return m ? m[1] / m[2] : 0;
    }

    // While cropping, the picture with the crop box takes the preview's place.
    function editCrop(on) {
      if (on && !cropper && item.previewSource) {
        el.previewHost.hidden = el.zoomSlot.hidden = true;
        el.cropHost.hidden = false;
        cropper = QC.crop.open(el.cropHost, item.previewSource, { rect: s.crop, ratio: cropShape(s.cropRatio),
          maxHeight: previewMaxHeight, onChange: function (r) { s.crop = r; changed(); } });
      } else if (!on && cropper) {
        cropper.close();
        cropper = null;
        el.cropHost.hidden = true;
        el.previewHost.hidden = el.zoomSlot.hidden = false;
      }
      sync();
    }

    el.cRatio.addEventListener('change', function () {
      s.cropRatio = el.cRatio.value;
      if (s.cropRatio === 'none') {
        s.crop = null;
        editCrop(false);
      } else {
        editCrop(true);
        if (cropper) {                                   // a shape starts as its largest box; Free keeps the box
          cropper.setRatio(cropShape(s.cropRatio));
          s.crop = cropper.rect();
        }
      }
      changed();
    });
    el.cEdit.addEventListener('click', function () { editCrop(!cropper); });

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
      el.headMain.classList.add('is-back'); // fades back in (only after the question)
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

    // header: the first row holds the column names.
    function renderTable(box, rows, total, header) {
      box.textContent = '';
      box.classList.remove('is-frame');
      if (!rows || !rows.length) { box.appendChild(note('No rows.')); return; }
      header = header !== false;
      var table = document.createElement('table');
      var head = table.createTHead(), body = table.createTBody();
      rows.forEach(function (row, i) {
        var th = header && i === 0, tr = (th ? head : body).insertRow();
        row.slice(0, TABLE_COLS).forEach(function (v) {
          var c = document.createElement(th ? 'th' : 'td');
          c.textContent = cell(v);
          tr.appendChild(c);
        });
      });
      box.appendChild(table);
      var shown = rows.length - (header ? 1 : 0);
      if (total > shown) box.appendChild(note('Showing the first ' + shown + ' of ' + total.toLocaleString() + ' rows.'));
    }

    function renderText(box, text) {
      box.textContent = '';
      box.classList.remove('is-frame');
      var pre = document.createElement('pre');
      pre.textContent = text.length > SHOW_CHARS ? text.slice(0, SHOW_CHARS) : text;
      box.appendChild(pre);
      if (text.length > SHOW_CHARS) box.appendChild(note('Showing the first 200 KB.'));
    }

    // Converted HTML in a sandboxed frame: no scripts, no access to this page.
    // Shown exactly as it will be saved (its own background, text colour and font), whatever
    // the site theme. Sandboxed: no scripts, no access to this page.
    function renderHtml(box, html) {
      box.textContent = '';
      box.classList.add('is-frame');
      var frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.title = 'Converted page';
      frame.srcdoc = html;
      box.appendChild(frame);
    }

    /* ----- data and document settings ----- */

    function setRadios(radios, value) { radios.forEach(function (r) { r.checked = r.value === String(value); }); }

    function option(value, text) {
      var o = document.createElement('option');
      o.value = String(value);
      o.textContent = text;
      return o;
    }

    // Sheet and table menus, filled once the file has been read (item.meta).
    function fillPickers() {
      var need = QC.data.settingsFor(item.type, item.target), meta = item.meta || {};
      var sheets = meta.sheets || [], tables = meta.tables || [];
      el.dSheet.textContent = '';
      sheets.forEach(function (n, i) { el.dSheet.appendChild(option(i, n)); });
      var all = need.sheetAll && sheets.length > 1;
      if (all) el.dSheet.appendChild(option('all', 'All sheets'));
      el.dSheet.value = item.doc.sheet === 'all' && !all ? '0' : String(item.doc.sheet);
      if (el.dSheet.selectedIndex < 0) el.dSheet.selectedIndex = 0;
      el.dTable.textContent = '';
      tables.forEach(function (t, i) {
        el.dTable.appendChild(option(i, 'Table ' + (i + 1) + ' · ' + t.rows + (t.rows === 1 ? ' row' : ' rows') +
          ' × ' + t.cols + (t.cols === 1 ? ' column' : ' columns')));
      });
      el.dTable.value = String(Math.min(item.doc.table, Math.max(0, tables.length - 1)));
    }

    // What reading the file found: sheets, tables, encoding, separator.
    function setMeta(info) {
      if (!info) return;
      var meta = item.meta || (item.meta = {}), changed = false;
      ['sheets', 'tables'].forEach(function (k) {
        if (info[k] && JSON.stringify(info[k]) !== JSON.stringify(meta[k])) { meta[k] = info[k]; changed = true; }
      });
      if (info.encoding && item.editedText == null) detected.encoding = info.encoding;
      if (info.delimiter) detected.delimiter = info.delimiter;
      if (changed) fillPickers();
      sync();
    }

    function docChanged(reload) {
      ctx.onChange(item);
      sync();
      schedule();
      if (reload) loadSource();
      else if (currentView('src', srcViews()) === 'table') showSource();    // header row changed
    }

    el.dEncoding.addEventListener('change', function () {
      item.doc.encoding = el.dEncoding.value;
      detected.encoding = '';
      docChanged(true);
    });
    el.dDelimiter.addEventListener('change', function () { item.doc.delimiter = el.dDelimiter.value; docChanged(false); });
    el.dSheet.addEventListener('change', function () {
      item.doc.sheet = el.dSheet.value === 'all' ? 'all' : parseInt(el.dSheet.value, 10) || 0;
      docChanged(true);
    });
    el.dTable.addEventListener('change', function () { item.doc.table = parseInt(el.dTable.value, 10) || 0; docChanged(false); });
    [[el.dCsv, 'csvDelimiter'], [el.dIndent, 'indent'], [el.dLayout, 'layout']].forEach(function (g) {
      g[0].forEach(function (r) {
        r.addEventListener('change', function () { if (r.checked) { item.doc[g[1]] = r.value; docChanged(false); } });
      });
    });
    el.dDocxFont.addEventListener('change', function () { item.doc.docxFont = el.dDocxFont.value; docChanged(false); });
    el.dDocxSize.addEventListener('change', function () { item.doc.docxSize = el.dDocxSize.value; docChanged(false); });
    el.checks.forEach(function (c) {
      var input = c.querySelector('input');
      input.addEventListener('change', function () { item.doc[c.dataset.check] = input.checked; docChanged(false); });
    });

    /* ----- Page / Code / Table views ----- */

    function srcViews() {
      if (item.type === 'html' || item.type === 'md') return ['code', 'page'];
      if (item.type === 'csv' || item.type === 'tsv') return ['text', 'table'];
      return [];
    }

    function outViews() {
      var t = item.target;
      if (t === 'html' || t === 'md') return ['page', 'code'];
      if (t === 'docx') return ['page'];
      if (t === 'csv' || t === 'tsv') return ['table', 'text'];
      if (t === 'xlsx' || t === 'ods') return ['table'];
      return ['text'];
    }

    function viewKey(kind) { return kind + ':' + (kind === 'src' ? item.type : item.target); }

    function currentView(kind, views) {
      var v = viewPrefs[viewKey(kind)];
      return views.indexOf(v) !== -1 ? v : views[0];
    }

    // Small switch in the box's heading; hidden when there's only one view.
    function setViews(box, kind, views, onPick) {
      box.textContent = '';
      box.hidden = views.length < 2;
      var cur = currentView(kind, views);
      views.forEach(function (v) {
        var label = document.createElement('label'), input = document.createElement('input'), span = document.createElement('span');
        input.type = 'radio';
        input.name = kind + '-view-' + item.id;
        input.value = v;
        input.checked = v === cur;
        span.textContent = VIEW_LABELS[v];
        input.addEventListener('change', function () {
          if (!input.checked) return;
          viewPrefs[viewKey(kind)] = v;
          onPick();
        });
        label.appendChild(input);
        label.appendChild(span);
        box.appendChild(label);
      });
    }

    // The original text as a page (HTML, Markdown) or a table (CSV, TSV). Edits happen in the text view.
    async function showSource() {
      var view = currentView('src', srcViews()), text = el.docSrc.value, token = srcToken;
      var edit = view !== 'page' && view !== 'table';
      el.docSrcNote.textContent = item.file.size > EDIT_LIMIT ? 'First 100 KB. Files over 2 MB can\'t be edited here.'
        : !edit ? 'Edit in ' + VIEW_LABELS[srcViews()[0]] : item.editedText != null ? 'Edited' : 'Click to edit';
      if (edit) {
        el.docEdit.hidden = false;
        el.docSrcView.hidden = true;
        return;
      }
      el.docEdit.hidden = true;
      el.docSrcView.hidden = false;
      if (view === 'table') {
        var delim = item.type === 'tsv' ? '\t' : item.doc.delimiter !== 'auto' ? item.doc.delimiter : QC.data.detectDelimiter(text);
        var rows = QC.data.parseCSV(text, delim), header = !!item.doc.header;
        renderTable(el.docSrcView, rows.slice(0, PREVIEW_ROWS + 1), rows.length - (header ? 1 : 0), header);
        return;
      }
      var html = text;
      if (item.type === 'md') {
        try { html = QC.doc.htmlPage('', await QC.doc.markdownHtml(text)); }
        catch (err) { html = ''; }
        if (closed || token !== srcToken) return;
      }
      renderHtml(el.docSrcView, html);
    }

    function showResult() {
      if (!lastOut) return;
      var r = lastOut.r, t = item.target, view = currentView('out', outViews());
      var page = t === 'html' ? lastOut.text : r.previewHtml;
      el.docOut.classList.remove('is-error');
      if (view === 'table' && r.preview) renderTable(el.docOut, r.preview, r.rows, r.previewHeader);
      else if (view === 'page' && page) renderHtml(el.docOut, page);
      else if (lastOut.text) renderText(el.docOut, lastOut.text);
      else {
        renderText(el.docOut, '');
        el.docOut.appendChild(note('Too big to show here. Convert and download it to see all of it.'));
      }
    }

    /* ----- HTML output: page background and font ----- */

    function pageChanged() {
      ctx.onChange(item);
      sync();
      schedule();
    }

    function setFontNote(text, warn) {
      el.fontNote.textContent = text || '';
      el.fontNote.classList.toggle('is-warn', !!warn);
    }

    function noteForFont() {
      setFontNote(/^g:/.test(item.page.font) ? 'Loaded from Google Fonts when the page is opened.' : '');
    }


    // A custom colour swatch opens the colour picker (js/ui/colorpicker.js); colours apply live
    // as they're picked. The swatch's radio covers it, so its click is stopped before it ticks.
    function customColor(chip) { return chip.style.getPropertyValue('--c').trim() || '#3a6ea5'; }
    function pickCustom(label, chip, radios, apply) {
      QC.colorPicker.open(label, customColor(chip), function (hex) {
        chip.style.setProperty('--c', hex);
        radios.forEach(function (r) { r.checked = r.value === 'custom'; });
        apply(hex);
      });
    }
    function customSwatch(label, chip, radios, apply) {
      label.addEventListener('click', function (e) {
        e.preventDefault();
        pickCustom(label, chip, radios, apply);
      });
    }

    el.pgPicks.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        if (r.value === 'custom') pickCustom(el.pgCustom, el.pgChip, el.pgPicks, applyPage); // keyboard
        item.page.background = r.value === 'custom' ? customColor(el.pgChip) : r.value;
        pageChanged();
      });
    });
    function applyPage(c) { item.page.background = c; pageChanged(); }
    customSwatch(el.pgCustom, el.pgChip, el.pgPicks, applyPage);

    /* Font: three built-in fonts, or any Google Fonts family found by searching part of its name
       (list in js/ui/google-fonts.js, loaded the first time the search opens). */

    // Put the chosen Google font in the menu, so the menu shows what's used.
    function showFont(font) {
      var old = el.fontSel.querySelector('option[data-google]');
      if (old) old.remove();
      var name = /^g:/.test(font) ? font.slice(2) : '';
      if (name) {
        var opt = document.createElement('option');
        opt.value = font;
        opt.textContent = name + ' (Google Fonts)';
        opt.dataset.google = '1';
        el.fontSel.insertBefore(opt, el.fontSel.querySelector('option[value="search"]'));
      }
      el.fontSel.value = font;
      if (el.fontSel.value !== font) el.fontSel.value = 'system';
    }

    var fontList = null, hits = [], active = 0;

    function findFonts(q) {
      q = q.trim().toLowerCase();
      if (!q || !fontList) return [];
      var starts = [], contains = [];
      for (var i = 0; i < fontList.length && starts.length < 8; i++) {
        var parts = fontList[i].split('|'), lower = parts[0].toLowerCase();
        var entry = { name: parts[0], cat: parts[1], bold: parts[2] === 'b' };
        if (lower.indexOf(q) === 0 || lower.indexOf(' ' + q) !== -1) starts.push(entry);
        else if (contains.length < 8 && lower.indexOf(q) !== -1) contains.push(entry);
      }
      return starts.concat(contains).slice(0, 8);  // name starts first, each most popular first
    }

    var CATS = { s: 'Sans serif', r: 'Serif', d: 'Display', h: 'Handwriting', m: 'Monospace' };
    function renderHits() {
      el.fontResults.textContent = '';
      hits.forEach(function (f, i) {
        var li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === active));
        li.className = i === active ? 'is-active' : '';
        var n = document.createElement('span'); n.textContent = f.name;
        var c = document.createElement('span'); c.className = 'muted'; c.textContent = CATS[f.cat] || '';
        li.appendChild(n); li.appendChild(c);
        li.addEventListener('pointerdown', function (e) { e.preventDefault(); chooseFont(f); });
        el.fontResults.appendChild(li);
      });
      var q = el.fontName.value.trim();
      if (q && !hits.length && fontList) {
        var none = document.createElement('li');
        none.className = 'muted font-none';
        none.textContent = 'No Google font matches “' + q + '”.';
        el.fontResults.appendChild(none);
      }
      var open = !!el.fontResults.children.length;
      el.fontResults.hidden = !open;
      el.fontName.setAttribute('aria-expanded', String(open));
    }

    function chooseFont(f) {
      item.page.font = 'g:' + f.name;
      item.page.weights = f.bold;
      el.fontName.value = '';
      hits = [];
      renderHits();
      showFont(item.page.font);
      noteForFont();
      pageChanged();
    }

    function openSearch() {
      setFontNote('');
      sync();
      el.fontName.focus();
      if (!fontList) {
        QC.loadScript('js/ui/google-fonts.js').then(function () {
          fontList = QC.googleFonts || [];
          hits = findFonts(el.fontName.value);
          renderHits();
        }, function () { setFontNote('Couldn\'t load the font list.', true); sync(); });
      }
    }

    el.fontSel.addEventListener('change', function () {
      if (el.fontSel.value === 'search') { openSearch(); return; }
      item.page.font = el.fontSel.value;
      item.page.weights = false;
      showFont(item.page.font);
      noteForFont();
      pageChanged();
    });

    el.fontName.addEventListener('input', function () {
      hits = findFonts(el.fontName.value);
      active = 0;
      renderHits();
    });
    el.fontName.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!hits.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
        renderHits();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (hits[active]) chooseFont(hits[active]);       // Enter early: the first (best) match
      } else if (e.key === 'Escape') {
        e.preventDefault();
        el.fontName.value = '';
        hits = [];
        renderHits();
        showFont(item.page.font);
        sync();
      }
    });
    el.fontName.addEventListener('blur', function () { hits = []; renderHits(); });

    async function loadSource() {
      var token = ++srcToken;
      if (TEXT_TYPES[item.type]) {
        var big = item.file.size > EDIT_LIMIT, text;
        el.docSrc.readOnly = big;
        if (item.editedText != null) text = item.editedText;
        else {
          var buf = await (big ? item.file.slice(0, PEEK_BYTES) : item.file).arrayBuffer();
          if (closed || token !== srcToken) return;
          var dec = QC.markup.decode(buf, item.doc.encoding);
          text = dec.text;
          detected.encoding = dec.encoding;
        }
        if (closed || token !== srcToken) return;
        el.docSrc.value = text;
        setViews(el.srcViews, 'src', srcViews(), showSource);
        showSource();
        sync();
        return;
      }
      // Spreadsheets: a table of the chosen sheet. Word documents: the page.
      var word = item.type === 'docx';
      el.docEdit.hidden = true;
      el.docSrcView.hidden = false;
      el.docSrcNote.textContent = 'Reading…';
      try {
        var r = await QC.pool.run({ task: 'convert', key: 'docsrc:' + item.id, owner: item.id, priority: 3, file: item.file,
          options: word ? { from: 'docx', to: 'html', page: { background: '#ffffff', font: 'system' } }
            : { from: item.type, to: 'csv', doc: Object.assign({}, item.doc) } });
        if (closed || token !== srcToken) return;
        if (word) renderHtml(el.docSrcView, await r.blob.text());
        else { renderTable(el.docSrcView, r.preview, r.rows, true); setMeta(r.info); }
        if (closed || token !== srcToken) return;
        el.docSrcNote.textContent = !word && r.note ? r.note.charAt(0).toUpperCase() + r.note.slice(1) : 'Read-only';
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
        var binary = t === 'docx' || t === 'xlsx' || t === 'ods';
        var text = binary ? '' : r.blob.size > 8e6 && r.preview ? '' : await r.blob.text();
        if (closed || token !== docToken) return;
        lastOut = { r: r, text: text };
        setMeta(r.info);
        setViews(el.outViews, 'out', outViews(), showResult);
        showResult();
        el.docOutNote.textContent = parts.join(' · ');
      } catch (err) {
        if (ignorable(err) || closed || token !== docToken) return;
        lastOut = null;
        el.outViews.hidden = true;
        el.docOut.classList.remove('is-frame');
        el.docOut.classList.add('is-error');
        el.docOut.textContent = err.message || 'Conversion failed.';
        el.docOutNote.textContent = '';
      }
    }

    function setDocHeight(h) {
      docHeight = Math.max(140, Math.min(1400, Math.round(h)));
      el.doc.style.setProperty('--doc-h', docHeight + 'px');
    }
    if (docHeight) setDocHeight(docHeight);
    el.docGrip.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var startY = e.clientY, startH = el.docOut.offsetHeight;
      try { el.docGrip.setPointerCapture(e.pointerId); } catch (err) { /* pointer gone */ }
      function move(ev) { setDocHeight(startH + ev.clientY - startY); }
      function up() {
        el.docGrip.removeEventListener('pointermove', move);
        el.docGrip.removeEventListener('pointerup', up);
        el.docGrip.removeEventListener('pointercancel', up);
      }
      el.docGrip.addEventListener('pointermove', move);
      el.docGrip.addEventListener('pointerup', up);
      el.docGrip.addEventListener('pointercancel', up);
    });
    el.docGrip.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 80 : 20;
      if (e.key === 'ArrowUp') setDocHeight(el.docOut.offsetHeight - step);
      else if (e.key === 'ArrowDown') setDocHeight(el.docOut.offsetHeight + step);
      else return;
      e.preventDefault();
    });

    el.docSrc.addEventListener('input', function () {
      item.editedText = el.docSrc.value;
      item.editVersion++;
      el.docSrcNote.textContent = 'Edited';
      el.reset.disabled = false;
      ctx.onChange(item);
      schedule();
    });

    /* ----- video: player, trim, settings ----- */

    var info = item.meta && item.meta.video || null, videoError = '', view = 'original', shownViews = '';
    var CODECS = { avc: 'H.264', hevc: 'H.265', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'AC-3' };

    function clock(t) {
      var m = Math.floor(t / 60), sec = t - m * 60;
      return m + ':' + (sec < 9.95 ? '0' : '') + sec.toFixed(1);
    }

    function fillVideo() {
      var vs = item.video;
      setRadios(el.vQuality, vs.quality);
      el.vHeight.value = String(vs.height);
      el.vFps.value = String(vs.fps);
      el.vVol.value = vs.volume;
      setFill(el.vVol);
      if (document.activeElement !== el.vVolNum) el.vVolNum.value = vs.volume;
      setRadios(el.vCh, vs.channels);
      el.vRate.value = String(vs.rate);
      el.vFadeIn.value = String(vs.fadeIn);
      el.vFadeOut.value = String(vs.fadeOut);
      if (info && info.duration) setupTrim();
    }

    function syncVideo() {
      var vs = item.video, gifIn = item.type === 'gif', gifOut = item.target === 'gif';
      var audioOut = QC.formats.get(item.target).kind === 'audio';
      el.vHeight.options[0].textContent = gifOut ? 'Auto (480p)' : 'Auto (original)';
      el.vFps.options[0].textContent = gifOut ? 'Auto (12 fps)' : 'Auto (original)';
      if (gifIn && vs.quality === 'keep') setRadios(el.vQuality, 'high');     // a GIF can't be copied into a video
      el.vQualityHint.textContent = vs.quality === 'keep' && !gifIn ? 'Copies the video unchanged when it can: fast, no quality loss.' : '';
      el.vVolHint.textContent = vs.volume === 0 ? (audioOut ? 'Volume 0 would make a silent file.' : 'Muted: the result has no sound.')
        : vs.volume > 100 ? 'Louder than the original. Loud parts may distort.' : '';
      var quality = !gifOut && item.target !== 'wav';      // WAV is uncompressed: no quality to choose
      show([[el.vQualityField, quality], [el.vKeep, !gifIn], [el.vQualityHint, quality && !!el.vQualityHint.textContent],
        [el.vSizeField, !audioOut], [el.vFpsField, !gifIn && !audioOut],
        [el.vVolField, !gifIn && !gifOut && !(info && info.duration && !info.audioCodec)], [el.vVolHint, !!el.vVolHint.textContent],
        [el.vChField, audioOut], [el.vRateField, audioOut], [el.vFadeField, audioOut]]);
      showVideo();
    }

    function videoChanged() { ctx.onChange(item); sync(); }

    el.vQuality.forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { item.video.quality = r.value; videoChanged(); } });
    });
    [[el.vHeight, 'height'], [el.vFps, 'fps']].forEach(function (f) {
      f[0].addEventListener('change', function () { item.video[f[1]] = f[0].value === 'auto' ? 'auto' : +f[0].value; videoChanged(); });
    });

    // The player plays at the chosen volume too (up to 100%: a browser can't play louder).
    function setVolume(n) {
      item.video.volume = n;
      el.vVol.value = n;
      setFill(el.vVol);
      if (document.activeElement !== el.vVolNum) el.vVolNum.value = n;
      el.player.volume = Math.min(1, n / 100);
      el.player.muted = !n;
      videoChanged();
    }
    el.vVol.addEventListener('input', function () { setVolume(parseInt(el.vVol.value, 10)); });
    el.vVolNum.addEventListener('input', function () {
      var n = parseInt(el.vVolNum.value, 10);
      if (n >= 0 && n <= 200) setVolume(n);              // wait for a valid number
    });
    el.vVolNum.addEventListener('change', function () { el.vVolNum.value = item.video.volume; });
    el.vCh.forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { item.video.channels = r.value === 'auto' ? 'auto' : +r.value; videoChanged(); } });
    });
    el.vRate.addEventListener('change', function () { item.video.rate = el.vRate.value === 'auto' ? 'auto' : +el.vRate.value; videoChanged(); });
    [[el.vFadeIn, 'fadeIn'], [el.vFadeOut, 'fadeOut']].forEach(function (f) {
      f[0].addEventListener('change', function () { item.video[f[1]] = +f[0].value; videoChanged(); });
    });

    function setupTrim() {
      var d = info.duration;
      el.trimStart.max = el.trimEnd.max = d;
      el.trimStart.value = item.video.start;
      el.trimEnd.value = item.video.end > 0 ? item.video.end : d;
      if (view === 'original' && el.player.paused) el.player.currentTime = item.video.start;   // open at the kept part
      renderTrim();
    }

    function renderTrim() {
      var d = info.duration, a = +el.trimStart.value, b = +el.trimEnd.value;
      el.trim.style.setProperty('--a', a / d);
      el.trim.style.setProperty('--b', b / d);
      el.trimStart.style.zIndex = a > d / 2 ? 2 : 1;      // handles on top of each other: the one that can move is on top
      el.trimTimes.textContent = clock(a) + ' – ' + clock(b) + '  ·  ' +
        (a < 0.01 && b > d - 0.01 ? 'whole video' : (b - a).toFixed(1) + ' s kept');
    }

    function onTrim(isStart) {
      var d = info.duration, a = +el.trimStart.value, b = +el.trimEnd.value;
      if (b - a < 0.1) {
        if (isStart) el.trimStart.value = a = Math.max(0, b - 0.1);
        else el.trimEnd.value = b = Math.min(d, a + 0.1);
      }
      item.video.start = a > 0.01 ? Math.round(a * 100) / 100 : 0;
      item.video.end = b < d - 0.01 ? Math.round(b * 100) / 100 : 0;
      if (view === 'original' && !el.player.hidden) {     // show the frame at the handle
        el.player.pause();
        el.player.currentTime = isStart ? a : b;
      }
      renderTrim();
      ctx.onChange(item);
    }
    el.trimStart.addEventListener('input', function () { onTrim(true); });
    el.trimEnd.addEventListener('input', function () { onTrim(false); });

    // Playing the original stays inside the part that's kept.
    el.player.addEventListener('play', function () {
      var vs = item.video, t = el.player.currentTime;
      if (view === 'original' && (t < vs.start - 0.05 || (vs.end && t >= vs.end - 0.05))) el.player.currentTime = vs.start;
    });
    el.player.addEventListener('timeupdate', function () {
      if (view === 'original' && item.video.end && el.player.currentTime >= item.video.end) {
        el.player.pause();
        el.player.currentTime = item.video.end;
      }
    });

    // Original, or the converted result once there is one.
    function showVideo() {
      var views = item.result ? ['original', 'result'] : [];
      if (views.join() !== shownViews) { shownViews = views.join(); setViews(el.vViews, 'vid', views, showVideo); }
      view = views.length ? currentView('vid', views) : 'original';
      var res = view === 'result', url = res ? item.result.url : srcUrl;
      var anim = res ? item.result.ext === 'gif' : item.type === 'gif';
      var sound = QC.formats.get(res ? item.result.ext : item.type).kind === 'audio';
      el.anim.hidden = !anim;
      el.player.hidden = anim;
      el.player.classList.toggle('is-audio', sound);
      el.player.parentNode.classList.toggle('is-audio', sound);
      if (anim) {
        el.player.pause();
        if (el.anim.getAttribute('src') !== url) el.anim.src = url;
      } else if (el.player.getAttribute('src') !== url) {
        el.player.src = url;
        if (!res) el.player.currentTime = item.video.start;   // back at the kept part
      }
      show([[el.trim, !res && item.type !== 'gif' && !!(info && info.duration)]]);
      renderVideoStats();
    }

    function renderVideoStats() {
      var r = item.result, parts = [];
      el.vStats.classList.toggle('is-error', !!videoError && view !== 'result');
      if (view === 'result' && r) {
        parts.push((item.outdated ? 'Old result: ' : 'Result: ') + ctx.formatBytes(r.blob.size) +
          ' (' + ctx.percentChange(item.file.size, r.blob.size) + ')');
        if (r.info.duration) parts.push(clock(r.info.duration));
        if (r.info.note) parts.push(r.info.note);
      } else if (videoError) {
        parts.push(videoError);
      } else if (!info) {
        if (item.type !== 'gif') parts.push('Reading the video…');
      } else {
        if (info.duration) parts.push(clock(info.duration));
        if (info.width) parts.push(info.width + ' × ' + info.height);
        if (info.fps) parts.push(Math.round(info.fps) + ' fps');
        var codecs = [info.videoCodec, info.audioCodec].filter(Boolean).map(function (c) { return CODECS[c] || (/^pcm/.test(c) ? 'PCM' : c); });
        if (codecs.length) parts.push(codecs.join(' + '));
        if (info.sampleRate && !info.width) parts.push(info.sampleRate / 1000 + ' kHz');
        if (info.channels && !info.width) parts.push(info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : info.channels + ' channels');
        if (info.duration && !info.audioCodec) parts.push('no sound');
        if (info.canPlay === false) parts.push('this browser can\'t decode it');
      }
      el.vStats.textContent = parts.join('  ·  ');
    }

    function startVideo() {
      el.player.volume = Math.min(1, item.video.volume / 100);
      el.player.muted = !item.video.volume;
      if (item.type === 'gif') {                          // a GIF animates in an <img>; no trimming
        el.anim.addEventListener('load', function () {
          if (info || view !== 'original') return;
          info = { width: el.anim.naturalWidth, height: el.anim.naturalHeight };
          renderVideoStats();
        });
        return;
      }
      if (info) { setupTrim(); sync(); return; }
      QC.pool.run({ task: 'probe', key: 'probe:' + item.id, owner: item.id, priority: 4, file: item.file }).then(function (r) {
        (item.meta || (item.meta = {})).video = r;
        if (closed) return;
        info = r;
        setupTrim();
        sync();
      }, function (err) {
        if (ignorable(err) || closed) return;
        videoError = err.message || 'Could not read this video.';
        renderVideoStats();
      });
    }

    // A conversion finished: show its result.
    function result() {
      if (!isMedia || !item.result) return;
      viewPrefs[viewKey('vid')] = 'result';
      shownViews = '';
      showVideo();
    }

    /* ----- image preview pipeline ----- */

    function schedule(now) {
      clearTimeout(timer);
      if (isMedia) return;                               // video converts only on Convert: it takes a while
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
      QC.pool.runImage({ task: 'prepare', key: 'prepare:' + item.id, owner: item.id, priority: 4, file: item.file, options: { from: item.type } })
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
      QC.colorPicker.close();
      document.removeEventListener('keydown', onConfirmKey);
      QC.pool.cancel(function (j) { return j.owner === item.id && /^(prepare|preview|exact|doc|docsrc|probe):/.test(j.key || ''); });
      if (compare) compare.destroy();
      if (cropper) cropper.close();
      if (isMedia) {
        el.player.pause();
        el.player.removeAttribute('src');
        el.player.load();                                // frees the decoder
        URL.revokeObjectURL(srcUrl);
      }
      if (item.previewSource) { item.previewSource.close(); item.previewSource = null; }
      root.remove();
    }

    // Called by the app when the format or settings change from outside the panel. Another kind of
    // conversion (a GIF becoming a video) needs other settings: the app opens a fresh panel.
    function refresh() {
      if (QC.formats.handler(item.type, item.target) !== mode) { ctx.reopen(item); return; }
      stale();
      fill();
      schedule();
    }

    function mount(newHost) {
      if (root.parentNode !== newHost) newHost.appendChild(root);
    }

    // The copy button says "all" or "selected" depending on the file selection.
    function updateCopy() { el.copy.textContent = ctx.copyLabel(item); }

    // What the preview shows right now, for the next panel to start from.
    function picture() { return compare ? compare.picture() : null; }

    if (isDoc) noteForFont();
    fill();
    if (isImage) {
      prepare();
    } else if (isMedia) {
      startVideo();
    } else {
      loadSource();
      schedule(true);
    }
    ready = true;
    return { close: close, refresh: refresh, result: result, mount: mount, updateCopy: updateCopy, picture: picture, root: root };
  }

  return { open: open };
});
