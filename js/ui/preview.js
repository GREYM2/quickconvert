/*
 * Side-by-side compare: original on the left, result on the right, draggable divider.
 * Hovering with a mouse shows a lens with raw pixels (to judge nearest vs smooth resampling).
 */
QC.define('preview', function (QC) {
  'use strict';

  var LENS = 160;          // lens size in CSS px
  var LENS_PIXELS = 20;    // result pixels across the lens (8x zoom)

  function create(host) {
    host.innerHTML =
      '<div class="compare" style="--pos:50%">' +
        '<canvas class="compare-original" aria-label="Original"></canvas>' +
        '<img class="compare-result" alt="Converted preview" hidden>' +
        '<div class="compare-divider" role="slider" tabindex="0" aria-label="Compare original and result"' +
          ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span class="compare-handle"></span></div>' +
        '<span class="compare-tag compare-tag-left">Original</span>' +
        '<span class="compare-tag compare-tag-right">Result</span>' +
        '<canvas class="compare-lens" hidden></canvas>' +
      '</div>';

    var box = host.querySelector('.compare');
    var original = host.querySelector('.compare-original');
    var result = host.querySelector('.compare-result');
    var divider = host.querySelector('.compare-divider');
    var lens = host.querySelector('.compare-lens');
    var lensCtx = lens.getContext('2d');
    var pos = 50, url = null, dragging = false, destroyed = false;
    var dpr = window.devicePixelRatio || 1;
    lens.width = lens.height = Math.round(LENS * dpr);

    function setPos(p) {
      pos = Math.max(0, Math.min(100, p));
      box.style.setProperty('--pos', pos + '%');
      divider.setAttribute('aria-valuenow', String(Math.round(pos)));
    }

    // Show images at their real pixel size or an integer multiple, so the browser's own
    // scaling doesn't blur a pixelated result (or sharpen a smooth one).
    function layout() {
      var nw = result.naturalWidth || original.width, nh = result.naturalHeight || original.height;
      if (!nw || !nh) return;
      var cw = host.clientWidth || nw;
      var maxH = Math.max(200, window.innerHeight * 0.6);
      var scale = Math.min(cw / nw, maxH / nh);
      // Clearly enlarged previews use a whole number of device pixels per image pixel.
      if (scale * dpr >= 2) scale = Math.floor(scale * dpr) / dpr;
      var w = nw * scale, h = nh * scale;
      box.style.width = w + 'px';
      box.style.height = h + 'px';
      result.style.imageRendering = w * dpr / nw >= 2 ? 'pixelated' : 'auto';
      original.style.imageRendering = w * dpr / original.width >= 2 ? 'pixelated' : 'auto';
    }

    function setOriginal(bitmap) {
      original.width = bitmap.width;
      original.height = bitmap.height;
      original.getContext('2d').drawImage(bitmap, 0, 0);
      layout();
    }

    // Swap in a new result only after it has decoded, then free the old one.
    function setResult(blob) {
      var next = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        if (destroyed) { URL.revokeObjectURL(next); return; }
        result.src = next;
        result.hidden = false;
        if (url) URL.revokeObjectURL(url);
        url = next;
        layout();
      };
      img.onerror = function () { URL.revokeObjectURL(next); };
      img.src = next;
    }

    function pointToPos(e) {
      var r = box.getBoundingClientRect();
      return (e.clientX - r.left) / r.width * 100;
    }

    function drawLens(e) {
      var r = box.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) { lens.hidden = true; return; }
      var useResult = !result.hidden && x >= r.width * pos / 100;
      var src = useResult ? result : original;
      var sw = useResult ? result.naturalWidth : original.width;
      var sh = useResult ? result.naturalHeight : original.height;
      var rw = result.hidden ? original.width : result.naturalWidth;
      // Region shown, in display px: LENS_PIXELS result pixels, but always at least 2x zoom.
      var region = Math.min(LENS_PIXELS * r.width / rw, LENS / 2);
      var kx = sw / r.width, ky = sh / r.height;
      lensCtx.imageSmoothingEnabled = false;
      lensCtx.clearRect(0, 0, lens.width, lens.height);
      lensCtx.drawImage(src, (x - region / 2) * kx, (y - region / 2) * ky, region * kx, region * ky,
        0, 0, lens.width, lens.height);
      lens.style.left = x + 'px';
      lens.style.top = y + 'px';
      lens.hidden = false;
    }

    box.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      lens.hidden = true;
      box.setPointerCapture(e.pointerId);
      setPos(pointToPos(e));
    });
    box.addEventListener('pointermove', function (e) {
      if (dragging) { setPos(pointToPos(e)); return; }
      if (e.pointerType === 'mouse') drawLens(e);
    });
    function stop() { dragging = false; }
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
    box.addEventListener('pointerleave', function () { lens.hidden = true; });
    divider.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 10 : 2;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setPos(pos - step);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setPos(pos + step);
      else if (e.key === 'Home') setPos(0);
      else if (e.key === 'End') setPos(100);
      else return;
      e.preventDefault();
    });

    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null;
    if (ro) ro.observe(host);

    function destroy() {
      destroyed = true;
      if (ro) ro.disconnect();
      if (url) URL.revokeObjectURL(url);
      url = null;
      result.removeAttribute('src');
      original.width = original.height = 0; // free the canvas memory
      host.innerHTML = '';
    }

    return { setOriginal: setOriginal, setResult: setResult, destroy: destroy };
  }

  return { create: create };
});
