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

  // Screen height for sizing the picture, with the browser's bars shown. Phones hide and show
  // those bars while the page scrolls, which changes window.innerHeight (and fires resize):
  // sizing by it made the picture jump between two sizes. 100svh stays put.
  var probe = null;
  function screenHeight() {
    if (!probe) {
      probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none';
      document.body.appendChild(probe);
    }
    return probe.offsetHeight || window.innerHeight;
  }

  // opts.maxHeight(): the tallest the picture may be inside the panel (CSS px).
  // opts.controls: element for the zoom buttons (default: below the picture).
  // opts.start: { canvas, w, h } picture to show until this one's content arrives.
  function create(host, opts) {
    opts = opts || {};
    host.innerHTML =
      '<div class="compare" style="--pos:50%">' +
        '<canvas class="compare-view" role="img" aria-label="Preview: original on the left, result on the right"></canvas>' +
        '<div class="compare-divider" role="slider" tabindex="0" aria-label="Compare original and result"' +
          ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span class="compare-handle"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/></svg></span></div>' +
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
    var goal = { z: 1, cx: 0.5, cy: 0.5 };   // where zoom is heading; z/cx/cy glide towards it
    var tween = 0, tweenT = 0;
    var grow = false;                        // next size change comes from new content: animate it
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
        availH = Math.max(220, opts.maxHeight ? opts.maxHeight() : screenHeight() * 0.6);
      }
      var scale = Math.min(availW / n[0], availH / n[1]);
      if (scale * dpr >= 2) scale = Math.floor(scale * dpr) / dpr;
      var w = n[0] * scale, h = n[1] * scale;
      if (w !== W || h !== H) {
        var fromW = W, fromH = H;
        W = w; H = h;
        box.style.width = w + 'px';
        box.style.height = h + 'px';
        view.width = Math.max(1, Math.round(w * dpr));
        view.height = Math.max(1, Math.round(h * dpr));
        // A new picture of another size: the frame resizes smoothly instead of jumping.
        if (grow && fromW && fromH && !QC.motion.calm()) {
          box.animate([{ width: fromW + 'px', height: fromH + 'px' }, { width: w + 'px', height: h + 'px' }],
            { duration: 260, easing: QC.motion.EASE });
        }
      }
      grow = false;
      clampView();
      draw();
    }

    /* ----- drawing ----- */

    function clampState(st) {
      st.z = clamp(st.z, 1, maxZoom());
      var half = 0.5 / st.z;
      st.cx = clamp(st.cx, half, 1 - half);
      st.cy = clamp(st.cy, half, 1 - half);
      return st;
    }

    function clampView() {
      var st = clampState({ z: z, cx: cx, cy: cy });
      z = st.z; cx = st.cx; cy = st.cy;
      clampState(goal);
    }

    // Draw a picture fitted inside the frame without stretching: one with another shape (the
    // original next to a square ICO, or an unlocked resize) is letterboxed. Clipped to [from, to].
    function blit(src, sw, sh, from, to) {
      var span = 1 / z, u0 = cx - span / 2, v0 = cy - span / 2;
      var frame = W / H, aspect = sw / sh, rw = 1, rh = 1;  // picture rect in 0..1 frame units
      if (aspect > frame * 1.01) rh = frame / aspect;
      else if (aspect < frame / 1.01) rw = aspect / frame;
      var dx = ((1 - rw) / 2 - u0) / span * view.width, dw = rw / span * view.width;
      var dy = ((1 - rh) / 2 - v0) / span * view.height, dh = rh / span * view.height;
      // Only the visible part of the source is drawn.
      var x0 = Math.max(dx, from), x1 = Math.min(dx + dw, to);
      var y0 = Math.max(dy, 0), y1 = Math.min(dy + dh, view.height);
      if (x1 <= x0 || y1 <= y0) return;
      // Magnified: hard pixels, so nearest vs smooth resampling is visible. Otherwise smooth.
      ctx.imageSmoothingEnabled = dw / sw < 2;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, (x0 - dx) / dw * sw, (y0 - dy) / dh * sh, (x1 - x0) / dw * sw, (y1 - y0) / dh * sh,
        x0, y0, x1 - x0, y1 - y0);
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

    // The label follows the gliding zoom: 1.1×, 1.2×, 1.3×… (one decimal, whole numbers from 10×).
    function renderZoom() {
      var isZoomed = z > 1.05;
      zoomOut.disabled = goal.z <= 1.001;
      zoomIn.disabled = goal.z >= maxZoom() - 0.001;
      zoomFit.textContent = isZoomed ? (z < 10 ? z.toFixed(1) : Math.round(z)) + '×' : 'Fit';
      box.classList.toggle('is-zoomed', isZoomed);
      box.style.touchAction = isZoomed ? 'none' : 'pan-y'; // zoomed: one finger moves the picture
    }

    /* ----- zoom and pan ----- */

    // The view state after zooming `st` by `factor` around the point (x, y) (CSS px).
    function zoomed(st, factor, x, y) {
      var u = st.cx - 0.5 / st.z + (x / W) / st.z, v = st.cy - 0.5 / st.z + (y / H) / st.z;
      var nz = clamp(st.z * factor, 1, maxZoom());
      return clampState({ z: nz, cx: u - (x / W) / nz + 0.5 / nz, cy: v - (y / H) / nz + 0.5 / nz });
    }

    // Buttons, wheel and Fit set a goal; the view glides there (repeated wheel steps add up).
    function zoomTo(st) {
      goal = st;
      if (QC.motion.calm() || document.hidden) { z = goal.z; cx = goal.cx; cy = goal.cy; requestDraw(); return; }
      if (!tween) { tweenT = performance.now(); tween = requestAnimationFrame(step); }
      renderZoom();
    }

    function step(t) {
      tween = 0;
      var a = 1 - Math.exp(-(t - tweenT) / 55);   // eases out, settles in about a quarter second
      tweenT = t;
      var lz = Math.log(z), gz = Math.log(goal.z);
      z = Math.exp(lz + (gz - lz) * a);
      cx += (goal.cx - cx) * a;
      cy += (goal.cy - cy) * a;
      var done = Math.abs(gz - Math.log(z)) < 0.003 && Math.abs(goal.cx - cx) < 0.0005 && Math.abs(goal.cy - cy) < 0.0005;
      if (done) { z = goal.z; cx = goal.cx; cy = goal.cy; }
      clampView();
      draw();
      if (!done) tween = requestAnimationFrame(step);
    }

    // Pinch and drag follow the fingers directly (no glide).
    function setView(st) {
      if (tween) { cancelAnimationFrame(tween); tween = 0; }
      st = clampState(st);
      z = st.z; cx = st.cx; cy = st.cy;
      goal = { z: z, cx: cx, cy: cy };
      requestDraw();
    }

    function zoomAt(factor, x, y) { setView(zoomed({ z: z, cx: cx, cy: cy }, factor, x, y)); }

    function pan(dx, dy) { setView({ z: z, cx: cx - dx / (W * z), cy: cy - dy / (H * z) }); }

    function setPos(p) {
      pos = clamp(p, 0, 100);
      box.style.setProperty('--pos', pos + '%');
      divider.setAttribute('aria-valuenow', String(Math.round(pos)));
      requestDraw();
    }

    zoomIn.addEventListener('click', function () { zoomTo(zoomed(goal, ZOOM_STEP, W / 2, H / 2)); });
    zoomOut.addEventListener('click', function () { zoomTo(zoomed(goal, 1 / ZOOM_STEP, W / 2, H / 2)); });
    zoomFit.addEventListener('click', function () { zoomTo({ z: 1, cx: 0.5, cy: 0.5 }); });

    box.addEventListener('wheel', function (e) {
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * H : e.deltaY;
      if (dy > 0 && goal.z <= 1.001) return; // not zoomed: scrolling down still scrolls the page
      e.preventDefault();
      var r = box.getBoundingClientRect();
      zoomTo(zoomed(goal, Math.exp(-dy * 0.002), e.clientX - r.left, e.clientY - r.top));
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
      if (nearDivider(e) || goal.z <= 1.001) {
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

    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); exitFull(); } }

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
      grow = true;
      layout();
    }

    // A copy of what's on screen, for the next file's preview to start from.
    function picture() {
      if (!W || !view.width) return null;
      var c = document.createElement('canvas');
      c.width = view.width;
      c.height = view.height;
      c.getContext('2d').drawImage(view, 0, 0);
      return { canvas: c, w: W, h: H };
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
        grow = true;
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
      if (tween) cancelAnimationFrame(tween);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', layout);
      free(res);
      res = orig = null;
      view.width = view.height = 0; // free the canvas memory
      host.innerHTML = '';
      bar.remove();
    }

    // Start from the previous file's picture, so switching files doesn't flash an empty frame.
    if (opts.start) {
      W = opts.start.w; H = opts.start.h;
      box.style.width = W + 'px';
      box.style.height = H + 'px';
      view.width = Math.max(1, Math.round(W * dpr));
      view.height = Math.max(1, Math.round(H * dpr));
      ctx.drawImage(opts.start.canvas, 0, 0, view.width, view.height);
    }

    renderFullButton();
    renderZoom();
    return { setOriginal: setOriginal, setResult: setResult, layout: layout, picture: picture, destroy: destroy };
  }

  return { create: create, screenHeight: screenHeight };
});
