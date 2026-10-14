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

  var ICON = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>'
  };

  function settingsKey(item) { return JSON.stringify([item.target, item.kind === 'image' ? item.settings : null]); }

  function jobOptions(item) {
    return { from: item.type, to: item.target, settings: Object.assign({}, item.settings) };
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
      result: null, pending: null, cache: null
    };
    if (!f) fail(item, 'Unsupported format.', true);
    else if (f.kind === 'image' && !caps.offscreen) fail(item, 'Images need a newer browser (no OffscreenCanvas).', true);
    buildRow(item, f);
    return item;
  }

  function buildRow(item, f) {
    var row = document.getElementById('tpl-row').content.firstElementChild.cloneNode(true);
    var q = function (s) { return row.querySelector(s); };
    item.dom = { row: row, target: q('.file-target'), gear: q('.file-gear'), status: q('.file-status'), panel: q('.file-panel') };

    q('.file-name').textContent = item.file.name;
    q('.file-name').title = item.file.name;
    q('.file-meta').textContent = formatBytes(item.file.size) + ' · ' + (f ? f.desc : 'Unknown type');
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

    item.dom.gear.hidden = item.kind !== 'image' || item.permanent;
    item.dom.gear.addEventListener('click', function () { togglePanel(item); });
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
    item.pending = null;
  }

  // Settings or format changed: any finished result is now stale.
  function invalidate(item) {
    if (item.permanent) return;
    item.run++; // results of jobs already running for this item will be ignored
    QC.pool.cancel(function (j) { return j.owner === item.id && j.task === 'convert' && !j.key; });
    if (item.status !== 'idle') {
      dropResult(item);
      item.status = 'idle';
      item.error = '';
      render(item);
    }
    updateToolbar();
  }

  function removeItem(item) {
    if (panel && panel.item === item) closePanel();
    item.run++;
    QC.pool.cancel(function (j) { return j.owner === item.id; });
    dropResult(item);
    item.cache = null;
    items.delete(item.id);
    item.dom.row.remove();
    updateToolbar();
  }

  function clearAll() {
    Array.from(items.values()).forEach(removeItem);
  }

  /* ---------- rendering ---------- */

  function render(item) {
    var box = item.dom.status;
    box.className = 'file-status is-' + item.status;
    box.textContent = '';
    switch (item.status) {
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
    el.toolbar.hidden = !list.length;
    el.drop.classList.toggle('is-compact', list.length > 0);
    var total = list.reduce(function (n, i) { return n + i.file.size; }, 0);
    el.summary.textContent = list.length + (list.length === 1 ? ' file · ' : ' files · ') + formatBytes(total);
    var todo = list.filter(canConvert).length;
    var busy = list.some(function (i) { return i.status === 'queued' || i.status === 'converting'; });
    el.convert.disabled = !todo;
    el.convert.textContent = busy && !todo ? 'Converting…' : todo > 1 ? 'Convert ' + todo + ' files' : 'Convert';
    var done = list.filter(function (i) { return i.status === 'done'; }).length;
    el.zip.hidden = done < 2;
  }

  function canConvert(item) {
    return !item.permanent && (item.status === 'idle' || item.status === 'failed');
  }

  /* ---------- conversion ---------- */

  function convertAll() {
    items.forEach(function (item) { if (canConvert(item)) convertItem(item); });
    updateToolbar();
  }

  function convertItem(item) {
    var run = ++item.run;
    var key = settingsKey(item);
    dropResult(item);
    if (item.cache && item.cache.key === key) { finish(item, item.cache.result); return; }

    item.status = 'queued';
    item.progress = 0;
    item.error = '';
    render(item);
    var job = {
      task: 'convert', owner: item.id, file: item.file, options: jobOptions(item),
      onProgress: function (p) {
        if (run !== item.run) return;
        item.progress = p;
        if (item.status !== 'converting') { item.status = 'converting'; render(item); updateToolbar(); }
        else renderProgress(item);
      }
    };
    (item.kind === 'image' ? QC.pool.runImage(job) : QC.pool.run(job)).then(function (r) {
      if (run !== item.run || !items.has(item.id)) return;
      if (item.kind === 'image') item.cache = { key: key, result: r };
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
      dropResult(item);
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
    item.result = { blob: r.blob, url: URL.createObjectURL(r.blob), name: QC.formats.outputName(item.file.name, item.target), info: r };
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

  /* ---------- advanced panel ---------- */

  var panelCtx = {
    onChange: invalidate,
    onApplyAll: applyToAll,
    settingsKey: settingsKey,
    jobOptions: jobOptions,
    formatBytes: formatBytes,
    percentChange: percentChange
  };

  function closePanel() {
    if (!panel) return;
    panel.ctrl.close();
    panel.item.dom.gear.setAttribute('aria-expanded', 'false');
    panel.item.dom.row.classList.remove('is-open');
    panel = null;
  }

  function togglePanel(item) {
    if (panel && panel.item === item) { closePanel(); return; }
    openPanelFor(item);
  }

  function openPanelFor(item, focusSelector) {
    if (!panel || panel.item !== item) {
      closePanel();
      panel = { item: item, ctrl: QC.panel.open(item, item.dom.panel, panelCtx) };
      item.dom.gear.setAttribute('aria-expanded', 'true');
      item.dom.row.classList.add('is-open');
    }
    if (focusSelector) {
      var target = item.dom.panel.querySelector(focusSelector);
      if (target) { target.focus(); target.select && target.select(); }
    }
  }

  // Copy settings (and output format) to every other image in the batch.
  function applyToAll(source) {
    var count = 0;
    items.forEach(function (item) {
      if (item === source || item.kind !== 'image' || item.permanent) return;
      item.settings = JSON.parse(JSON.stringify(source.settings));
      if (QC.formats.outputsFor(item.type, caps).indexOf(source.target) !== -1) {
        item.target = source.target;
        item.dom.target.value = source.target;
      }
      invalidate(item);
      count++;
    });
    var btn = source.dom.panel.querySelector('.apply-all');
    if (btn) {
      btn.textContent = count ? 'Applied to ' + count + (count === 1 ? ' image' : ' images') : 'No other images';
      setTimeout(function () { btn.textContent = 'Apply to all images'; }, 1800);
    }
  }

  /* ---------- input ---------- */

  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
  }

  function wireInput() {
    el.drop.addEventListener('click', function () { el.input.click(); });
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
      list: document.getElementById('files'), toolbar: document.getElementById('toolbar'),
      summary: document.getElementById('summary'), convert: document.getElementById('convert-all'),
      zip: document.getElementById('zip-all'), clear: document.getElementById('clear-all'),
      banner: document.getElementById('banner')
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
    window.addEventListener('pagehide', function (e) {
      if (e.persisted) return; // kept in the back/forward cache; links must still work on return
      items.forEach(dropResult);
      if (zipUrl) URL.revokeObjectURL(zipUrl);
    });
  }

  return { init: init, addFiles: addFiles, items: items, caps: caps, formatBytes: formatBytes };
});

QC.app.init();
