/*
 * Before/after preview drawn on one canvas: original left of the divider, result right of it.
 *   - mouse wheel / pinch: zoom around the pointer; drag: move the zoomed image
 *   - drag the divider (or anywhere while not zoomed) to compare
 *   - corner button: full-screen view on top of the page (not the browser's real full screen)
 * Zoom state is kept as a centre point in 0..1 image coordinates plus a factor, so it survives
 * resizes, new results and switching to full screen.
 */
QC.define('preview', function (QC) {
  'use strict';

  var ZOOM_STEP = 1.5;

  var ICON = {
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>'
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // opts.maxHeight(): the tallest the picture may be inside the panel (CSS px).
  // opts.controls: element for the zoom buttons (default: below the picture).
  function create(host, opts) {
    opts = opts || {};
    host.innerHTML =
      '<div class="compare" style="--pos:50%">' +
        '<canvas class="compare-view" role="img" aria-label="Preview: original on the left, result on the right"></canvas>' +
        '<div class="compare-divider" role="slider" tabindex="0" aria-label="Compare original and result"' +
          ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span class="compare-handle"></span></div>' +
        '<span class="compare-tag compare-tag-left">Original</span>' +
        '<span class="compare-tag compare-tag-right">Result</span>' +
        '<button type="button" class="compare-full"></button>' +
      '</div>';
    var bar = document.createElement('div');
    bar.className = 'zoom-group';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Zoom');
    bar.title = 'Tip: scroll over the picture to zoom, drag to move';
    bar.innerHTML =
      '<button type="button" data-zoom="out" aria-label="Zoom out">' + ICON.minus + '</button>' +
      '<button type="button" data-zoom="fit" class="zoom-level" aria-label="Fit to view">Fit</button>' +
      '<button type="button" data-zoom="in" aria-label="Zoom in">' + ICON.plus + '</button>';
    (opts.controls || host).appendChild(bar);

    var box = host.querySelector('.compare');
    var view = host.querySelector('.compare-view');
    var divider = host.querySelector('.compare-divider');
    var fullBtn = host.querySelector('.compare-full');
    var zoomOut = bar.querySelector('[data-zoom="out"]');
    var zoomFit = bar.querySelector('[data-zoom="fit"]');
    var zoomIn = bar.querySelector('[data-zoom="in"]');
    var ctx = view.getContext('2d');
    var dpr = window.devicePixelRatio || 1;

    var orig = null;                 // canvas copy of the downscaled original
    var res = null, resW = 0, resH = 0, resToken = 0;
    var W = 0, H = 0;                // picture size in CSS px
    var pos = 50, z = 1, cx = 0.5, cy = 0.5;
    var raf = 0, destroyed = false, full = false, viewer = null, home = null;

    /* ----- sizing ----- */

    function natural() {
      if (res) return [resW, resH];
      if (orig) return [orig.width, orig.height];
      return null;
    }

    function maxZoom() {
      var n = natural();
      return n && view.width ? Math.max(4, 32 * n[0] / view.width) : 4; // up to 32 screen px per image px
    }

    // Fit the picture into the space available. Enlarged pictures use a whole number of
    // device pixels per image pixel, so the browser's scaling doesn't blur them.
    function layout() {
      var n = natural();
      if (!n || destroyed) return;
      var availW, availH;
      if (full) {
        var stage = viewer.querySelector('.viewer-stage'); // fills the space above the bar
        availW = stage.clientWidth;
        availH = stage.clientHeight;
      } else {
        availW = host.clientWidth || n[0];
        availH = Math.max(220, opts.maxHeight ? opts.maxHeight() : window.innerHeight * 0.6);
      }
      var scale = Math.min(availW / n[0], availH / n[1]);
      if (scale * dpr >= 2) scale = Math.floor(scale * dpr) / dpr;
      var w = n[0] * scale, h = n[1] * scale;
      if (w !== W || h !== H) {
        W = w; H = h;
        box.style.width = w + 'px';
        box.style.height = h + 'px';
        view.width = Math.max(1, Math.round(w * dpr));
        view.height = Math.max(1, Math.round(h * dpr));
      }
      clampView();
      draw();
    }

    /* ----- drawing ----- */

    function clampView() {
      z = clamp(z, 1, maxZoom());
      var half = 0.5 / z;
      cx = clamp(cx, half, 1 - half);
      cy = clamp(cy, half, 1 - half);
    }

    function blit(src, sw, sh, from, to) {
      var span = 1 / z, u0 = cx - span / 2, v0 = cy - span / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(from, 0, to - from, view.height);
      ctx.clip();
      // Magnified: hard pixels, so nearest vs smooth resampling is visible. Otherwise smooth.
      ctx.imageSmoothingEnabled = view.width / (sw * span) < 2;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, u0 * sw, v0 * sh, span * sw, span * sh, 0, 0, view.width, view.height);
      ctx.restore();
    }

    function draw() {
      raf = 0;
      if (!W || destroyed) return;
      ctx.clearRect(0, 0, view.width, view.height);
      var split = res ? Math.round(view.width * pos / 100) : view.width;
      if (orig) blit(orig, orig.width, orig.height, 0, split);
      if (res) blit(res, resW, resH, split, view.width);
      renderZoom();
    }

    // Controls update now; the canvas repaints on the next frame.
    function requestDraw() {
      renderZoom();
      if (!raf) raf = requestAnimationFrame(draw);
    }

    function renderZoom() {
      var zoomed = z > 1.001;
      zoomOut.disabled = !zoomed;
      zoomIn.disabled = z >= maxZoom() - 0.001;
      zoomFit.textContent = zoomed ? (z < 10 ? z.toFixed(1) : Math.round(z)) + '×' : 'Fit';
      box.classList.toggle('is-zoomed', zoomed);
      box.style.touchAction = zoomed ? 'none' : 'pan-y'; // zoomed: one finger moves the picture
    }

    /* ----- zoom and pan ----- */

    // Zoom by `factor`, keeping the point (x, y) (CSS px inside the picture) in place.
    function zoomAt(factor, x, y) {
      var u = cx - 0.5 / z + (x / W) / z, v = cy - 0.5 / z + (y / H) / z;
      var nz = clamp(z * factor, 1, maxZoom());
      cx = u - (x / W) / nz + 0.5 / nz;
      cy = v - (y / H) / nz + 0.5 / nz;
      z = nz;
      clampView();
      requestDraw();
    }

    function pan(dx, dy) {
      cx -= dx / (W * z);
      cy -= dy / (H * z);
      clampView();
      requestDraw();
    }

    function setPos(p) {
      pos = clamp(p, 0, 100);
      box.style.setProperty('--pos', pos + '%');
      divider.setAttribute('aria-valuenow', String(Math.round(pos)));
      requestDraw();
    }

    zoomIn.addEventListener('click', function () { zoomAt(ZOOM_STEP, W / 2, H / 2); });
    zoomOut.addEventListener('click', function () { zoomAt(1 / ZOOM_STEP, W / 2, H / 2); });
    zoomFit.addEventListener('click', function () { z = 1; cx = cy = 0.5; requestDraw(); });

    box.addEventListener('wheel', function (e) {
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * H : e.deltaY;
      if (dy > 0 && z <= 1.001) return; // not zoomed: scrolling down still scrolls the page
      e.preventDefault();
      var r = box.getBoundingClientRect();
      zoomAt(Math.exp(-dy * 0.002), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    /* ----- pointer: divider, pan, pinch ----- */

    var pointers = new Map(), mode = null, last = null, pinch = null;

    function nearDivider(e) {
      var r = box.getBoundingClientRect();
      return Math.abs(e.clientX - r.left - r.width * pos / 100) <= (e.pointerType === 'mouse' ? 8 : 18);
    }

    function pinchInfo() {
      var p = Array.from(pointers.values());
      return { dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
    }

    box.addEventListener('pointerdown', function (e) {
      if (fullBtn.contains(e.target) || (e.pointerType === 'mouse' && e.button !== 0)) return;
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        mode = 'pinch';
        pinch = pinchInfo();
        pinch.z = z;
        return;
      }
      last = { x: e.clientX, y: e.clientY };
      if (nearDivider(e) || z <= 1.001) {
        mode = 'divider';
        var r = box.getBoundingClientRect();
        setPos((e.clientX - r.left) / r.width * 100);
      } else {
        mode = 'pan';
        box.classList.add('is-panning');
      }
    });

    box.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) {
        box.classList.toggle('near-divider', nearDivider(e));
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var r = box.getBoundingClientRect();
      if (mode === 'pinch' && pointers.size === 2) {
        var p = pinchInfo();
        zoomAt(pinch.z * p.dist / pinch.dist / z, p.x - r.left, p.y - r.top);
      } else if (mode === 'divider') {
        setPos((e.clientX - r.left) / r.width * 100);
      } else if (mode === 'pan') {
        pan(e.clientX - last.x, e.clientY - last.y);
        last = { x: e.clientX, y: e.clientY };
      }
    });

    function release(e) {
      pointers.delete(e.pointerId);
      if (pointers.size === 1 && mode === 'pinch') {
        var p = Array.from(pointers.values())[0];
        mode = 'pan';
        last = { x: p.x, y: p.y };
      } else if (!pointers.size) {
        mode = null;
        box.classList.remove('is-panning');
      }
    }
    box.addEventListener('pointerup', release);
    box.addEventListener('pointercancel', release);
    box.addEventListener('pointerleave', function () { box.classList.remove('near-divider'); });

    divider.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 10 : 2;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setPos(pos - step);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setPos(pos + step);
      else if (e.key === 'Home') setPos(0);
      else if (e.key === 'End') setPos(100);
      else return;
      e.preventDefault();
    });

    /* ----- full-screen view (an overlay on the page, not the browser's full screen) ----- */

    function renderFullButton() {
      fullBtn.innerHTML = full ? ICON.collapse : ICON.expand;
      fullBtn.setAttribute('aria-label', full ? 'Exit full-screen preview' : 'Full-screen preview');
      fullBtn.title = full ? 'Exit full screen (Esc)' : 'Full-screen preview';
    }

    function onKey(e) { if (e.key === 'Escape') exitFull(); }

    function enterFull() {
      if (full) return;
      home = { box: [box.parentNode, box.nextSibling], bar: [bar.parentNode, bar.nextSibling] };
      viewer = document.createElement('div');
      viewer.className = 'viewer';
      viewer.innerHTML = '<div class="viewer-stage"></div>' +
        '<div class="viewer-bar"><span class="viewer-hint">Scroll to zoom · drag to move · Esc to close</span>' +
        '<button type="button" class="btn viewer-close">Close</button></div>';
      viewer.querySelector('.viewer-stage').appendChild(box);
      viewer.querySelector('.viewer-bar').insertBefore(bar, viewer.querySelector('.viewer-close'));
      document.body.appendChild(viewer);
      document.documentElement.classList.add('viewer-open');
      full = true;

      // A click on the faded area closes (only if the press also started there, not a drag).
      var downOutside = false;
      function outside(t) { return t === viewer || t.classList.contains('viewer-stage'); }
      viewer.addEventListener('pointerdown', function (e) { downOutside = outside(e.target); });
      viewer.addEventListener('click', function (e) { if (downOutside && outside(e.target)) exitFull(); });
      viewer.querySelector('.viewer-close').addEventListener('click', exitFull);
      document.addEventListener('keydown', onKey);

      renderFullButton();
      layout();
      void viewer.offsetWidth; // start the fade from transparent
      viewer.classList.add('is-open');
      viewer.querySelector('.viewer-close').focus();
    }

    function exitFull() {
      if (!full) return;
      full = false;
      document.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('viewer-open');
      if (!destroyed) {
        home.box[0].insertBefore(box, home.box[1]);
        home.bar[0].insertBefore(bar, home.bar[1]);
      }
      viewer.remove();
      viewer = null;
      renderFullButton();
      if (!destroyed) { layout(); fullBtn.focus(); }
    }

    fullBtn.addEventListener('click', function () { if (full) exitFull(); else enterFull(); });

    /* ----- content ----- */

    function setOriginal(bitmap) {
      orig = document.createElement('canvas'); // own copy: the bitmap is closed when the panel closes
      orig.width = bitmap.width;
      orig.height = bitmap.height;
      orig.getContext('2d').drawImage(bitmap, 0, 0);
      layout();
    }

    function decode(blob) {
      return createImageBitmap(blob).catch(function () {
        return new Promise(function (resolve, reject) {
          var url = URL.createObjectURL(blob), img = new Image();
          img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = function () { URL.revokeObjectURL(url); reject(); };
          img.src = url;
        });
      });
    }

    function free(image) { if (image && image.close) image.close(); }

    // Swap in a new result once decoded; the previous one is freed.
    function setResult(blob) {
      var token = ++resToken;
      decode(blob).then(function (image) {
        if (destroyed || token !== resToken) { free(image); return; }
        free(res);
        res = image;
        resW = image.naturalWidth || image.width;
        resH = image.naturalHeight || image.height;
        layout();
      }, function () { /* keep the previous result */ });
    }

    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function () { if (!full) layout(); }) : null;
    if (ro) ro.observe(host);
    window.addEventListener('resize', layout);

    function destroy() {
      destroyed = true;
      if (full) exitFull();
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', layout);
      free(res);
      res = orig = null;
      view.width = view.height = 0; // free the canvas memory
      host.innerHTML = '';
      bar.remove();
    }

    renderFullButton();
    renderZoom();
    return { setOriginal: setOriginal, setResult: setResult, layout: layout, destroy: destroy };
  }

  return { create: create };
});
