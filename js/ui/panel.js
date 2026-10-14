/*
 * Advanced panel for one image: quality, target size, resize, resampling, live preview.
 *
 * Preview runs in two steps, debounced 400 ms after each change:
 *   1. fast:  render from a <=1200 px copy, estimate the output size from the pixel ratio
 *   2. exact: full-resolution conversion. Its result is cached on the item, so pressing
 *             Convert afterwards with the same settings is instant.
 */
QC.define('panel', function (QC) {
  'use strict';

  var DEBOUNCE = 400;

  // ctx: { onChange(item), onApplyAll(item), settingsKey(item), jobOptions(item), formatBytes(n), percentChange(a, b) }
  function open(item, host, ctx) {
    var root = document.getElementById('tpl-panel').content.firstElementChild.cloneNode(true);
    host.appendChild(root);
    var $ = function (sel) { return root.querySelector(sel); };
    var el = {
      qField: $('[data-show="quality"]'), qRange: $('.q-range'), qValue: $('.q-value'), qFound: $('.q-found'),
      tField: $('[data-show="target"]'), tOn: $('.t-on'), tInputs: $('.t-inputs'), tValue: $('.t-value'), tUnit: $('.t-unit'), tNote: $('.t-note'),
      modes: root.querySelectorAll('.r-mode'), rPercent: $('.r-percent'), rPct: $('.r-pct'),
      rPixels: $('.r-pixels'), rW: $('.r-w'), rH: $('.r-h'), rLock: $('.r-lock'), rInfo: $('.r-info'),
      rs: $('.rs'), stats: $('.preview-stats'), applyAll: $('.apply-all'), reset: $('.reset')
    };
    el.modes.forEach(function (r) { r.name = 'resize-' + item.id; });

    var compare = QC.preview.create($('.preview-host'));
    var timer = null, generation = 0, closed = false;
    var fast = null, exact = null, exactBusy = false, exactProgress = 0, previewError = '';
    var s = item.settings;

    /* ----- fields <-> settings ----- */

    function lossy() { return !!QC.image.LOSSY[item.target]; }

    function fill() {
      el.qRange.value = s.quality;
      el.tOn.checked = s.targetOn;
      el.tValue.value = s.targetValue;
      el.tUnit.value = s.targetUnit;
      el.modes.forEach(function (r) { r.checked = r.value === s.resizeMode; });
      el.rPct.value = s.percent;
      el.rW.value = s.width;
      el.rH.value = s.height;
      el.rs.value = s.resample;
      sync();
    }

    // Visibility and derived values. Call after any change.
    function sync() {
      var ico = item.target === 'ico';
      el.qField.hidden = !lossy();
      el.tField.hidden = ico;
      var targetActive = s.targetOn && !ico;
      el.tInputs.hidden = !s.targetOn;
      el.qRange.disabled = targetActive && lossy();
      el.qValue.textContent = el.qRange.disabled ? 'auto' : s.quality;
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
      }
      renderTargetNotes();
      renderStats();
    }

    function renderTargetNotes() {
      var active = s.targetOn && item.target !== 'ico' && QC.image.targetBytes(s) > 0;
      var q = exact && exact.quality ? exact.quality : null;
      el.qFound.hidden = !(active && lossy());
      if (active && lossy()) {
        el.qFound.textContent = q ? 'Quality found: ' + q
          : fast && fast.quality ? 'Quality found: ~' + fast.quality + ' (estimating)' : 'Quality found: …';
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

    /* ----- events ----- */

    el.qRange.addEventListener('input', function () {
      s.quality = parseInt(el.qRange.value, 10);
      el.qValue.textContent = s.quality;
      changed();
    });
    el.tOn.addEventListener('change', function () { s.targetOn = el.tOn.checked; if (s.targetOn) el.tValue.focus(); changed(); });
    el.tValue.addEventListener('input', function () { s.targetValue = el.tValue.value; changed(); });
    el.tUnit.addEventListener('change', function () { s.targetUnit = el.tUnit.value; changed(); });
    el.rs.addEventListener('change', function () { s.resample = el.rs.value; changed(); });

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

    el.applyAll.addEventListener('click', function () { ctx.onApplyAll(item); });
    el.reset.addEventListener('click', function () {
      var fresh = QC.image.defaults();
      Object.keys(fresh).forEach(function (k) { s[k] = fresh[k]; });
      stale();
      fill();
      ctx.onChange(item);
      schedule();
    });

    /* ----- preview pipeline ----- */

    function schedule(now) {
      clearTimeout(timer);
      timer = setTimeout(runPreview, now ? 0 : DEBOUNCE);
    }

    function ignorable(e) { return e && (e.code === 'cancelled'); }

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
      QC.pool.cancel(function (j) { return j.owner === item.id && /^(prepare|preview|exact):/.test(j.key || ''); });
      compare.destroy();
      if (item.previewSource) { item.previewSource.close(); item.previewSource = null; }
      root.remove();
    }

    // Called by the app when the target format changes while the panel is open.
    function refresh() { stale(); fill(); schedule(); }

    fill();
    prepare();
    return { close: close, refresh: refresh };
  }

  return { open: open };
});
