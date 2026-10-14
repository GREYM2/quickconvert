/*
 * Page wiring and state. One `item` per dropped file:
 *   status: idle | queued | converting | done | failed | attention
 *   attention = a target size couldn't be reached; the user decides what to do.
 */
QC.define('app', function (QC) {
  'use strict';

  var LARGE_FILE = 100e6;
  var items = new Map();
  var seq = 0;
  var panel = null;          // { item, ctrl } for the one open advanced panel
  var wide = window.matchMedia('(min-width: 1024px)'); // must match the breakpoint in style.css
  var zipUrl = null;
  var caps = { offscreen: false, webp: false };
  var el = {};

  /* ---------- helpers ---------- */

  // Decimal units (1 KB = 1000 B), rounded down so a size never looks bigger than it is.
  function formatBytes(n) {
    if (n < 1000) return n + ' B';
    if (n < 1e6) return (Math.floor(n / 100) / 10).toFixed(1) + ' KB';
    if (n < 1e9) return (Math.floor(n / 1e4) / 100).toFixed(2) + ' MB';
    return (Math.floor(n / 1e7) / 100).toFixed(2) + ' GB';
  }

  function percentChange(from, to) {
    var p = Math.round((to - from) / from * 100);
    if (p === -100 && to > 0) p = -99; // a file that still exists didn't shrink by 100%
    return (p > 0 ? '+' : p < 0 ? '−' : '±') + Math.abs(p) + '%';
  }

  // Tiny DOM builder. Text always goes through textContent (file names are user input).
  function h(tag, props, children) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v; // only for our own constant SVG strings
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    (children || []).forEach(function (c) {
      if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  var M = QC.motion; // animation helpers (js/ui/motion.js)

  var ICON = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/><path d="M12 8v4l3 2"/></svg>'
  };

  // Same key = same output, so a cached result can be reused.
  function settingsKey(item) {
    return JSON.stringify([item.target, item.kind === 'image' ? item.settings : [item.editVersion, item.page]]);
  }

  function jobOptions(item) {
    return { from: item.type, to: item.target, settings: Object.assign({}, item.settings), page: Object.assign({}, item.page) };
  }

  // The file to convert: the original, or the user's edited text.
  function sourceFile(item) {
    return item.editedText != null ? new File([item.editedText], item.file.name, { type: item.file.type }) : item.file;
  }

  // "photo.png" -> "photo.jpg", or the name typed in "Save as".
  function nameFor(item, ext) {
    return item.outBase ? item.outBase + '.' + ext : QC.formats.outputName(item.file.name, ext);
  }

  function metaText(item) {
    var f = QC.formats.get(item.type);
    return formatBytes(item.file.size) + ' · ' + (f ? f.desc : 'Unknown type') + (item.editedText != null ? ' · edited' : '');
  }

  function detectCaps() {
    caps.offscreen = typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype;
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      caps.webp = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { caps.webp = false; }
  }

  /* ---------- items ---------- */

  function addFiles(fileList) {
    Array.prototype.forEach.call(fileList || [], function (file) {
      var item = createItem(file);
      items.set(item.id, item);
      el.list.appendChild(item.dom.row);
      render(item);
    });
    updateToolbar();
  }

  function createItem(file) {
    var f = QC.formats.detect(file.name, file.type);
    var item = {
      id: 'f' + (++seq), file: file, type: f ? f.key : null, kind: f ? f.kind : null,
      target: f ? QC.formats.defaultOutput(f.key, caps) : null,
      settings: QC.image.defaults(), dims: null, previewSource: null,
      status: 'idle', progress: 0, error: '', permanent: false, run: 0,
      result: null, outdated: false, pending: null, cache: null,
      outBase: null, editedText: null, editVersion: 0,
      page: { background: '#ffffff', font: 'system', weights: false }  // HTML output style
    };
    if (!f) fail(item, 'Unsupported format.', true);
    else if (f.kind === 'image' && !caps.offscreen) fail(item, 'Images need a newer browser (no OffscreenCanvas).', true);
    buildRow(item, f);
    return item;
  }

  function buildRow(item, f) {
    var row = document.getElementById('tpl-row').content.firstElementChild.cloneNode(true);
    var q = function (s) { return row.querySelector(s); };
    item.dom = { row: row, target: q('.file-target'), gear: q('.file-gear'), status: q('.file-status'),
      panel: q('.file-panel'), meta: q('.file-meta') };

    q('.file-name').textContent = item.file.name;
    q('.file-name').title = item.file.name;
    item.dom.meta.textContent = metaText(item);
    // Clicking anywhere on the file (except its controls and open settings) works like its name.
    function clicked(e) {
      if (heldItem === item) { heldItem = null; return; }   // the finger lifting after a hold
      onFileClick(item, e);
    }
    q('.file-name').addEventListener('click', clicked);
    row.addEventListener('click', function (e) {
      if (e.target.closest('button, a, select, input, textarea, label, iframe, .file-panel')) return;
      clicked(e);
    });
    wireHold(row, item);
    if (item.file.size > LARGE_FILE) q('.file-warn').hidden = false;

    var select = item.dom.target;
    var outs = f ? QC.formats.outputsFor(f.key, caps) : [];
    outs.forEach(function (o) { select.appendChild(h('option', { value: o, text: QC.formats.get(o).label })); });
    if (!outs.length) select.appendChild(h('option', { text: '—' }));
    select.value = item.target || '';
    select.disabled = item.permanent;
    select.addEventListener('change', function () {
      item.target = select.value;
      invalidate(item);
      if (panel && panel.item === item) panel.ctrl.refresh();
    });

    // Unsupported file: keep the gear's space so the format menus line up.
    if (item.permanent) item.dom.gear.style.visibility = 'hidden';
    item.dom.gear.addEventListener('click', function () { pick(item); });
    q('.file-remove').addEventListener('click', function () { removeItem(item); });
  }

  function fail(item, message, permanent) {
    item.status = 'failed';
    item.error = message;
    item.permanent = !!permanent;
  }

  function dropResult(item) {
    if (item.result) URL.revokeObjectURL(item.result.url);
    item.result = null;
    item.outdated = false;
    item.pending = null;
  }

  // Settings, text or format changed. A finished result stays downloadable, marked as outdated,
  // until the file is converted again.
  function invalidate(item) {
    if (item.permanent) return;
    item.run++; // results of jobs already running for this item will be ignored
    QC.pool.cancel(function (j) { return j.owner === item.id && j.task === 'convert' && !j.key; });
    item.dom.meta.textContent = metaText(item);
    var changed = item.status !== 'idle' || (item.result && !item.outdated);
    item.pending = null;
    item.status = 'idle';
    item.error = '';
    if (item.result) item.outdated = true;
    if (changed) render(item);
    updateToolbar();
  }

  function removeItem(item) {
    if (panel && panel.item === item) closePanel(true);
    item.run++;
    QC.pool.cancel(function (j) { return j.owner === item.id; });
    dropResult(item);
    item.cache = null;
    selection.delete(item);
    if (anchor === item) anchor = null;
    items.delete(item.id);
    M.foldAway(item.dom.row);
    updateToolbar();
    updateSide();
  }

  function clearAll() {
    var all = Array.from(items.values());
    closePanel(true);
    all.forEach(removeItem);
    updateSide();
  }

  /* ---------- rendering ---------- */

  function render(item) {
    var box = item.dom.status;
    box.className = 'file-status is-' + item.status;
    box.textContent = '';
    switch (item.status) {
      case 'idle':
        if (!item.result) break;
        box.classList.add('is-outdated');
        box.appendChild(h('span', { class: 'status-icon', html: ICON.history }));
        box.appendChild(h('span', { class: 'status-text', text: 'Settings changed. Previous result: ' +
          formatBytes(item.result.blob.size) + '. Convert again to update.' }));
        box.appendChild(h('a', { class: 'btn btn-small btn-outdated', href: item.result.url, download: item.result.name,
          title: 'Previous result: ' + item.result.name }, [h('span', { class: 'btn-icon', html: ICON.download }), 'Download old']));
        break;
      case 'queued':
        box.appendChild(h('span', { class: 'muted', text: 'Queued' }));
        break;
      case 'converting':
        box.appendChild(h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Converting',
          'aria-valuemin': '0', 'aria-valuemax': '100' }, [h('span')]));
        box.appendChild(h('span', { class: 'muted bar-text' }));
        renderProgress(item);
        break;
      case 'done':
        box.appendChild(h('span', { class: 'status-icon', html: ICON.check }));
        box.appendChild(h('span', { class: 'status-text', text: doneText(item) }));
        box.appendChild(h('a', { class: 'btn btn-small', href: item.result.url, download: item.result.name,
          title: item.result.name }, [h('span', { class: 'btn-icon', html: ICON.download }), 'Download']));
        break;
      case 'failed':
        box.appendChild(h('span', { class: 'status-icon', html: ICON.alert }));
        box.appendChild(h('span', { class: 'status-text', text: item.error }));
        break;
      case 'attention':
        var p = item.pending;
        box.appendChild(h('span', { class: 'status-icon', html: ICON.alert }));
        box.appendChild(h('span', { class: 'status-text', text: 'Can\'t reach ' +
          formatBytes(QC.image.targetBytes(item.settings)) + '. Smallest possible: ' + formatBytes(p.blob.size) +
          (p.mode === 'quality' ? ' (quality 1).' : ' (1% size).') }));
        box.appendChild(h('span', { class: 'status-actions' }, [
          h('button', { type: 'button', class: 'btn btn-small', text: 'Use ' + formatBytes(p.blob.size) + ' file',
            onclick: function () { setResult(item, p); render(item); updateToolbar(); } }),
          h('button', { type: 'button', class: 'btn btn-small btn-quiet', text: 'Change target',
            onclick: function () { openPanelFor(item, '.t-value'); } })
        ]));
        break;
    }
  }

  function renderProgress(item) {
    var bar = item.dom.status.querySelector('.bar');
    if (!bar) return;
    var pct = Math.round(item.progress * 100);
    bar.firstChild.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
    item.dom.status.querySelector('.bar-text').textContent = pct + '%';
  }

  function doneText(item) {
    var r = item.result.info, size = item.result.blob.size;
    var parts = [formatBytes(size) + ' (' + percentChange(item.file.size, size) + ')'];
    if (item.kind === 'image') {
      parts.push(r.width + ' × ' + r.height);
      if (r.quality && item.settings.targetOn && QC.image.targetBytes(item.settings)) parts.push('quality ' + r.quality);
    } else if (typeof r.rows === 'number') {
      parts.push(r.rows.toLocaleString() + (r.rows === 1 ? ' row' : ' rows'));
    }
    if (r.note) parts.push(r.note);
    return parts.join(' · ');
  }

  function updateToolbar() {
    var list = Array.from(items.values());
    el.summary.hidden = el.actions.hidden = !list.length;
    el.drop.classList.toggle('is-compact', list.length > 0);
    var total = list.reduce(function (n, i) { return n + i.file.size; }, 0);
    el.summary.textContent = '';
    if (selection.size) {
      el.summary.appendChild(document.createTextNode(selection.size + ' of ' + list.length + ' selected · '));
      el.summary.appendChild(h('button', { type: 'button', class: 'link-btn', text: 'Clear selection', onclick: clearSelection }));
    } else {
      el.summary.textContent = list.length + (list.length === 1 ? ' file · ' : ' files · ') + formatBytes(total);
    }
    var todo = scope().filter(canConvert).length;
    var busy = list.some(function (i) { return i.status === 'queued' || i.status === 'converting'; });
    var label = selection.size > 1 ? 'Convert ' + selection.size + ' files'
      : selection.size === 1 || list.length === 1 ? 'Convert file' : 'Convert all files';
    el.convert.disabled = !todo;
    el.convert.textContent = busy && !todo ? 'Converting…' : label;
    var done = list.filter(function (i) { return i.status === 'done'; }).length;
    el.zip.hidden = done < 2;
  }

  function canConvert(item) {
    return !item.permanent && (item.status === 'idle' || item.status === 'failed');
  }

  /* ---------- conversion ---------- */

  // Converts the selected files, or all files when none are selected.
  function convertAll() {
    scope().forEach(function (item) { if (canConvert(item)) convertItem(item); });
    updateToolbar();
  }

  function convertItem(item) {
    var run = ++item.run;
    var key = settingsKey(item);
    item.pending = null;
    if (item.cache && item.cache.key === key) { finish(item, item.cache.result); return; }

    item.status = 'queued';
    item.progress = 0;
    item.error = '';
    render(item);
    var job = {
      task: 'convert', owner: item.id, file: sourceFile(item), options: jobOptions(item),
      onProgress: function (p) {
        if (run !== item.run) return;
        item.progress = p;
        if (item.status !== 'converting') { item.status = 'converting'; render(item); updateToolbar(); }
        else renderProgress(item);
      }
    };
    (item.kind === 'image' ? QC.pool.runImage(job) : QC.pool.run(job)).then(function (r) {
      if (run !== item.run || !items.has(item.id)) return;
      item.cache = { key: key, result: r };
      finish(item, r);
    }, function (err) {
      if (run !== item.run || !items.has(item.id)) return;
      if (err.code === 'cancelled') item.status = 'idle';
      else fail(item, err.message || 'Conversion failed.');
      render(item);
      updateToolbar();
    });
  }

  function finish(item, r) {
    if (r.unreachable) {
      item.status = 'attention';
      item.pending = r;
    } else {
      setResult(item, r);
    }
    render(item);
    updateToolbar();
  }

  function setResult(item, r) {
    dropResult(item);
    item.result = { blob: r.blob, url: URL.createObjectURL(r.blob), ext: item.target, name: nameFor(item, item.target), info: r };
    item.status = 'done';
  }

  function downloadZip() {
    var done = Array.from(items.values()).filter(function (i) { return i.status === 'done'; });
    if (done.length < 2) return;
    var label = el.zip.textContent;
    el.zip.disabled = true;
    el.zip.textContent = 'Building ZIP…';
    QC.pool.run({
      task: 'zip', priority: 1,
      options: { entries: done.map(function (i) { return { name: i.result.name, blob: i.result.blob }; }) },
      onProgress: function (p) { el.zip.textContent = 'Building ZIP… ' + Math.round(p * 100) + '%'; }
    }).then(function (r) {
      if (zipUrl) URL.revokeObjectURL(zipUrl);
      zipUrl = URL.createObjectURL(r.blob);
      var a = h('a', { href: zipUrl, download: 'quickconvert.zip' });
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, function (err) {
      window.alert('Could not build the ZIP: ' + (err.message || 'unknown error'));
    }).then(function () {
      el.zip.disabled = false;
      el.zip.textContent = label;
    });
  }

  /* ---------- settings panel ---------- */

  // Wide screens: a clicked file's panel is in a side column, which can be hidden (×).
  // Settings only open when the user clicks a file, never by themselves.
  // Phones: the panel opens inside the file's row and can be closed again.
  var RESIZE_KEYS = ['resizeMode', 'percent', 'width', 'height', 'lockAspect', 'lockDriver'];

  var panelCtx = {
    onChange: invalidate,
    onTarget: function (item) {
      item.dom.target.value = item.target;
      invalidate(item);
    },
    onApplyAll: applyToAll,
    onClose: retract,
    // Renaming changes no content, so a finished result just gets the new name.
    onRename: function (item) {
      if (!item.result) return;
      item.result.name = nameFor(item, item.result.ext);
      render(item);
    },
    copyLabel: function (item) {
      return copyTargets(item).scoped ? 'Copy settings to selected files' : 'Copy settings to all files';
    },
    outputs: function (item) { return QC.formats.outputsFor(item.type, caps); },
    outputName: function (item) { return nameFor(item, item.target); },
    sourceFile: sourceFile,
    settingsKey: settingsKey,
    jobOptions: jobOptions,
    formatBytes: formatBytes,
    percentChange: percentChange
  };

  function panelHost(item) { return wide.matches ? el.sideInner : item.dom.panel; }

  // Two columns only while a panel is shown on a wide screen (see body.show-side in style.css).
  // Switching between the layouts glides; the side column slides in.
  function updateSide() {
    var show = !!panel;
    if (document.body.classList.contains('show-side') === show) return;
    M.glide([document.querySelector('.brand'), document.getElementById('theme-toggle'), el.summary, el.actions,
      document.querySelector('.col-main')], function () { document.body.classList.toggle('show-side', show); });
    if (show && wide.matches && !M.calm()) {
      el.sideInner.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: M.EASE });
    }
  }

  // keepSide: another panel opens right away, so don't collapse the layout in between.
  function closePanel(keepSide) {
    if (!panel) return;
    panel.ctrl.close();
    panel.item.dom.gear.setAttribute('aria-expanded', 'false');
    panel.item.dom.row.classList.remove('is-open');
    panel = null;
    if (!keepSide) updateSide();
  }

  // Hide the settings because the user deselected the file (×, click it again, Esc).
  // On wide screens the side column slides out first, then the layout glides back.
  var leaving = null;
  function retract() {
    if (!panel) return;
    if (!wide.matches) { closePanel(); return; }
    if (M.calm()) { closePanel(); return; }
    var ctrl = panel.ctrl;
    panel.item.dom.gear.setAttribute('aria-expanded', 'false');
    panel.item.dom.row.classList.remove('is-open');
    panel = null;
    var anim = el.sideInner.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(24px)' }],
      { duration: 160, easing: 'ease-in', fill: 'forwards' });
    var l = leaving = { anim: anim, ctrl: ctrl };
    M.afterAnim(anim, 160, function () { if (leaving === l) { finishLeaving(); updateSide(); } });
  }

  function finishLeaving() {
    if (!leaving) return;
    var l = leaving;
    leaving = null;
    l.ctrl.close();
    l.anim.cancel();
  }

  function openPanelFor(item, focusSelector) {
    if (item.permanent) return;
    finishLeaving();
    if (!panel || panel.item !== item) {
      // Wide screens: the panel for the new file grows or shrinks from the old one, shared
      // options move into place and the rest fade in or out. Phones: it unfolds in the row.
      var snap = panel && wide.matches ? M.snapshot(panel.ctrl.root) : null;
      var picture = panel && wide.matches ? panel.ctrl.picture() : null;
      closePanel(true);
      panel = { item: item, ctrl: QC.panel.open(item, panelHost(item), panelCtx, { startPicture: picture }) };
      if (snap) M.play(snap, panel.ctrl.root);
      else if (!wide.matches) M.unfold(panel.ctrl.root);
      item.dom.gear.setAttribute('aria-expanded', 'true');
      item.dom.row.classList.add('is-open');
      updateSide();
    }
    if (focusSelector) {
      var target = panel.ctrl.root.querySelector(focusSelector);
      if (target) { target.focus(); if (target.select) target.select(); }
    }
  }

  // Gear or a plain click on a file. On phones a second click closes the panel again.
  function pick(item) {
    if (!wide.matches && panel && panel.item === item) closePanel();
    else openPanelFor(item);
  }

  /* ---------- choosing files (Ctrl / Shift click, like a file manager) ---------- */

  // A plain click only shows a file's settings; Convert still means all files.
  // Ctrl/Cmd-click toggles files and Shift-click selects a range (on touch screens: hold a file,
  // then tap more): then Convert (and Copy settings) apply to the selected files only.
  var selection = new Set();
  var anchor = null;        // last file clicked by the user, where a Shift range starts

  function onFileClick(item, e) {
    var list = Array.from(items.values());
    if (touched && e.detail && selection.size && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      toggleChosen(item);                              // touch: while choosing, a tap adds or removes
      return;
    }
    if (e.shiftKey && anchor && items.has(anchor.id)) {
      var a = list.indexOf(anchor), b = list.indexOf(item);
      if (!(e.ctrlKey || e.metaKey)) selection.clear();
      list.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (i) { if (!i.permanent) selection.add(i); });
    } else if (e.ctrlKey || e.metaKey) {
      // Starting a selection: the file clicked before counts as chosen, like in Explorer.
      if (!selection.size && anchor && anchor !== item && items.has(anchor.id) && !anchor.permanent) selection.add(anchor);
      toggleChosen(item);
      return;
    } else {
      var shown = panel && panel.item === item;
      selection.clear();
      anchor = item;
      renderSelection();
      if (shown && wide.matches) retract();            // clicking the shown file again deselects it
      else pick(item);
      return;
    }
    renderSelection();
    if (wide.matches) openPanelFor(item);
  }

  // Add a file to the chosen ones, or take it out again.
  function toggleChosen(item) {
    anchor = item;
    if (selection.has(item)) {
      selection.delete(item);
      renderSelection();
      if (panel && panel.item === item) retract();     // deselected the file on show
      return;
    }
    if (!item.permanent) selection.add(item);
    renderSelection();
    if (wide.matches) openPanelFor(item);
  }

  // Touch screens have no Ctrl or Shift: holding a file chooses it, and while files are chosen
  // a tap adds or removes a file instead of showing its settings, like a phone's photo gallery.
  var HOLD_MS = 450;
  var HOLD_SKIP = 'button:not(.file-name), a, select, input, textarea, label, iframe, .file-panel';
  var touched = false;      // the last press on a file was a finger or pen, not a mouse
  var heldItem = null;      // chosen by the current hold; the click when the finger lifts is ignored

  function wireHold(row, item) {
    row.addEventListener('pointerdown', function (e) {
      touched = e.pointerType !== 'mouse';
      heldItem = null;
      if (!touched || !e.isPrimary || e.target.closest(HOLD_SKIP)) return;
      var x = e.clientX, y = e.clientY;
      var timer = setTimeout(function () {
        stop();
        heldItem = item;
        toggleChosen(item);
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) { /* not allowed */ }
      }, HOLD_MS);
      function move(ev) { if (Math.abs(ev.clientX - x) > 10 || Math.abs(ev.clientY - y) > 10) stop(); }
      function stop() {
        clearTimeout(timer);
        row.removeEventListener('pointermove', move);
        row.removeEventListener('pointerup', stop);
        row.removeEventListener('pointercancel', stop);   // the finger started scrolling
      }
      row.addEventListener('pointermove', move);
      row.addEventListener('pointerup', stop);
      row.addEventListener('pointercancel', stop);
    });
    // No long-press menu on a file: holding it chooses it.
    row.addEventListener('contextmenu', function (e) {
      if (touched && !e.target.closest(HOLD_SKIP)) e.preventDefault();
    });
  }

  // Nothing chosen any more; if the file on show was one of them, its settings retract too.
  function clearSelection() {
    if (!selection.size) return;
    var shownWasSelected = panel && selection.has(panel.item);
    selection.clear();
    renderSelection();
    if (shownWasSelected) retract();
  }

  function renderSelection() {
    items.forEach(function (i) { i.dom.row.classList.toggle('is-selected', selection.has(i)); });
    if (panel) panel.ctrl.updateCopy();
    updateToolbar();
  }

  // Files that Convert and Copy settings act on.
  function scope() { return selection.size ? Array.from(selection) : Array.from(items.values()); }

  function copyTargets(source) {
    var others = Array.from(selection).filter(function (i) { return i !== source; });
    return others.length ? { scoped: true, list: others } : { scoped: false, list: Array.from(items.values()) };
  }

  // Copy the output format (where the file supports it) and, between images, all image
  // settings. keepSize leaves each image's own resize settings alone. Returns how many changed.
  function applyToAll(source, keepSize) {
    var count = 0;
    copyTargets(source).list.forEach(function (item) {
      if (item === source || item.permanent) return;
      var touched = false;
      if (source.kind === 'data' && item.kind === 'data' && JSON.stringify(item.page) !== JSON.stringify(source.page)) {
        item.page = Object.assign({}, source.page);
        touched = true;
      }
      if (source.kind === 'image' && item.kind === 'image') {
        var own = {};
        RESIZE_KEYS.forEach(function (k) { own[k] = item.settings[k]; });
        item.settings = JSON.parse(JSON.stringify(source.settings));
        if (keepSize) Object.assign(item.settings, own);
        touched = true;
      }
      if (item.target !== source.target && QC.formats.outputsFor(item.type, caps).indexOf(source.target) !== -1) {
        item.target = source.target;
        item.dom.target.value = source.target;
        touched = true;
      }
      if (touched) { invalidate(item); count++; }
    });
    return count;
  }

  /* ---------- input ---------- */

  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
  }

  function isEditable(t) {
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  // Screenshots arrive as "image.png"; give them a name you can tell apart.
  function namePasted(file) {
    if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
    var d = new Date(), two = function (n) { return (n < 10 ? '0' : '') + n; };
    var ext = ((file.type.split('/')[1] || 'png').replace('jpeg', 'jpg'));
    return new File([file], 'Pasted image ' + two(d.getHours()) + '-' + two(d.getMinutes()) + '-' + two(d.getSeconds()) + '.' + ext,
      { type: file.type, lastModified: file.lastModified });
  }

  function wireInput() {
    el.drop.addEventListener('click', function () { el.input.click(); });

    // Ctrl+V adds pasted files (screenshots, files copied in the file manager).
    // Pasting into a text field still pastes text there.
    window.addEventListener('paste', function (e) {
      if (isEditable(e.target)) return;
      var files = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []);
      if (!files.length) return;
      e.preventDefault();
      addFiles(files.map(namePasted));
    });

    // Esc deselects everything (and hides the settings), Ctrl+A selects every file (outside
    // text fields). Listens on window so the full-screen view and the copy question claim Esc first.
    window.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || isEditable(e.target)) return;
      if (e.key === 'Escape' && (selection.size || (panel && wide.matches))) {
        clearSelection();
        retract();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && items.size) {
        e.preventDefault();
        items.forEach(function (i) { if (!i.permanent) selection.add(i); });
        renderSelection();
      }
    });
    el.input.addEventListener('change', function () {
      addFiles(el.input.files);
      el.input.value = ''; // allow picking the same file again
    });

    // Dropping anywhere on the page works; it never navigates away to the file.
    var depth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      el.drop.classList.add('is-drag');
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) el.drop.classList.remove('is-drag');
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      el.drop.classList.remove('is-drag');
      addFiles(e.dataTransfer.files);
    });
  }

  function init() {
    el = {
      drop: document.getElementById('drop'), input: document.getElementById('file-input'),
      list: document.getElementById('files'), actions: document.getElementById('actions'),
      summary: document.getElementById('summary'), convert: document.getElementById('convert-all'),
      zip: document.getElementById('zip-all'), clear: document.getElementById('clear-all'),
      banner: document.getElementById('banner'), sideInner: document.querySelector('#side .side-inner')
    };
    QC.theme.init();
    detectCaps();
    if (!caps.offscreen) {
      el.banner.textContent = 'This browser can\'t convert images here (no OffscreenCanvas). Data files still work. ' +
        'Try a current Chrome, Edge, Firefox, or Safari 16.4+.';
      el.banner.hidden = false;
    }
    wireInput();
    el.convert.addEventListener('click', convertAll);
    el.zip.addEventListener('click', downloadZip);
    el.clear.addEventListener('click', clearAll);
    var onWide = function () { if (panel) panel.ctrl.mount(panelHost(panel.item)); };
    if (wide.addEventListener) wide.addEventListener('change', onWide);
    else wide.addListener(onWide);
    window.addEventListener('pagehide', function (e) {
      if (e.persisted) return; // kept in the back/forward cache; links must still work on return
      items.forEach(dropResult);
      if (zipUrl) URL.revokeObjectURL(zipUrl);
    });
  }

  return { init: init, addFiles: addFiles, items: items, caps: caps, formatBytes: formatBytes };
});

QC.app.init();
