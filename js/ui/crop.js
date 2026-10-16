/*
 * Crop box over a picture (page only). Drag the box to move it, a corner to resize it, or drag on
 * the dimmed part to draw a new box; arrow keys move it. The box is kept in fractions of the
 * picture (0..1), so it doesn't depend on how big the picture is shown.
 *   var c = QC.crop.open(host, bitmap, { rect, ratio, maxHeight(), onChange(rect) })
 *   c.setRatio(ratio)   width / height in pixels, 0 = any shape
 *   c.rect()  c.close()
 */
QC.define('crop', function (QC) {
  'use strict';

  var MIN = 0.03;   // smallest box, as a share of the picture

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function open(host, bitmap, opts) {
    var wrap = document.createElement('div'), canvas = document.createElement('canvas'), box = document.createElement('div');
    wrap.className = 'crop';
    canvas.className = 'crop-pic';
    box.className = 'crop-box';
    box.tabIndex = 0;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Crop area: drag to move, drag a corner to resize. Arrow keys move it.');
    ['nw', 'ne', 'sw', 'se'].forEach(function (h) {
      var s = document.createElement('span');
      s.className = 'crop-handle';
      s.dataset.h = h;
      box.appendChild(s);
    });
    wrap.appendChild(canvas);
    wrap.appendChild(box);
    host.appendChild(wrap);

    var aspect = bitmap.width / bitmap.height, k = 0, rect = opts.rect || { x: 0, y: 0, w: 1, h: 1 }, drag = null, laidOut = 0;

    // Largest box of the current shape, centred.
    function fitted() {
      if (!k) return { x: 0, y: 0, w: 1, h: 1 };
      var w = 1, h = 1 / k;
      if (h > 1) { h = 1; w = k; }
      return { x: (1 - w) / 2, y: (1 - h) / 2, w: w, h: h };
    }

    function setRatio(r) {
      k = r ? r / aspect : 0;                          // the shape in fractions of this picture
      if (k) rect = fitted();
      render();
    }

    // Sized to the host's width; its height follows the picture, so only width changes count.
    function layout() {
      var w = host.clientWidth || bitmap.width;
      if (w === laidOut) return;
      laidOut = w;
      var maxH = Math.max(160, opts.maxHeight ? opts.maxHeight() : 480);
      var scale = Math.min(w / bitmap.width, maxH / bitmap.height), dpr = window.devicePixelRatio || 1;
      var cw = Math.max(1, Math.round(bitmap.width * scale)), ch = Math.max(1, Math.round(bitmap.height * scale));
      wrap.style.width = cw + 'px';
      wrap.style.height = ch + 'px';
      if (canvas.width !== Math.round(cw * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      }
    }

    function render() {
      box.style.left = rect.x * 100 + '%';
      box.style.top = rect.y * 100 + '%';
      box.style.width = rect.w * 100 + '%';
      box.style.height = rect.h * 100 + '%';
    }

    function point(e) {
      var r = wrap.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
    }

    // Box from the fixed corner `a` towards the pointer, kept inside the picture and in shape.
    function resizeTo(a, p) {
      var sx = p.x < a.x ? -1 : 1, sy = p.y < a.y ? -1 : 1;
      var w = Math.abs(p.x - a.x), h = Math.abs(p.y - a.y);
      var maxW = sx > 0 ? 1 - a.x : a.x, maxH = sy > 0 ? 1 - a.y : a.y;
      if (k) {
        if (w < h * k) w = h * k; else h = w / k;
        if (w > maxW) { w = maxW; h = w / k; }
        if (h > maxH) { h = maxH; w = h * k; }
        if (w < MIN) { w = Math.min(MIN, maxW); h = w / k; }
      } else {
        w = clamp(w, Math.min(MIN, maxW), maxW);
        h = clamp(h, Math.min(MIN, maxH), maxH);
      }
      rect = { x: sx > 0 ? a.x : a.x - w, y: sy > 0 ? a.y : a.y - h, w: w, h: h };
    }

    wrap.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var p = point(e), handle = e.target.dataset && e.target.dataset.h;
      if (handle) {                                    // the opposite corner stays put
        drag = { anchor: { x: handle[1] === 'w' ? rect.x + rect.w : rect.x, y: handle[0] === 'n' ? rect.y + rect.h : rect.y } };
      } else if (e.target === box) {
        drag = { move: { x: p.x - rect.x, y: p.y - rect.y } };
      } else {
        drag = { anchor: p };                          // a new box from here
      }
      try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* pointer gone */ }
      box.focus({ preventScroll: true });
    });
    wrap.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var p = point(e);
      if (drag.move) rect = { x: clamp(p.x - drag.move.x, 0, 1 - rect.w), y: clamp(p.y - drag.move.y, 0, 1 - rect.h), w: rect.w, h: rect.h };
      else resizeTo(drag.anchor, p);
      render();
    });
    function end() {
      if (!drag) return;
      drag = null;
      opts.onChange(rect);
    }
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);

    box.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 0.1 : 0.01, dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      rect = { x: clamp(rect.x + dx, 0, 1 - rect.w), y: clamp(rect.y + dy, 0, 1 - rect.h), w: rect.w, h: rect.h };
      render();
      opts.onChange(rect);
    });

    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null;
    if (ro) ro.observe(host);
    k = opts.ratio ? opts.ratio / aspect : 0;
    layout();
    render();

    return {
      setRatio: setRatio,
      rect: function () { return rect; },
      close: function () { if (ro) ro.disconnect(); wrap.remove(); }
    };
  }

  return { open: open };
});
