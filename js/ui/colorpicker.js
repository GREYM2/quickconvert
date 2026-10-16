/*
 * Colour picker pop-up (page only): saturation/brightness square, hue slider, hex field and
 * recently used colours. Opens next to the element it belongs to and reports colours live.
 *   QC.colorPicker.open(anchor, '#rrggbb', function onChange(hex) {})
 */
QC.define('colorPicker', function (QC) {
  'use strict';

  var recent = [];          // colours picked this session, newest first
  var current = null;       // the open picker, if any

  /* ----- colour maths ----- */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join('');
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: h, s: max ? d / max : 0, v: max };
  }

  function hsvToHex(h, s, v) {
    var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, rgb;
    if (h < 60) rgb = [c, x, 0]; else if (h < 120) rgb = [x, c, 0]; else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c]; else if (h < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
    return rgbToHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
  }

  /* ----- pop-up ----- */

  function close() {
    if (!current) return;
    var c = current;
    current = null;
    document.removeEventListener('pointerdown', c.onOutside, true);
    document.removeEventListener('keydown', c.onKey, true);
    window.removeEventListener('resize', c.onResize);
    document.removeEventListener('scroll', c.onScroll, true);
    if (c.hex && recent[0] !== c.hex) {
      recent = [c.hex].concat(recent.filter(function (x) { return x !== c.hex; })).slice(0, 7);
    }
    c.el.remove();
    if (c.anchor && document.contains(c.anchor)) c.anchor.focus({ preventScroll: true });
  }

  function open(anchor, hex, onChange) {
    if (current && current.anchor === anchor) { close(); return; } // second click closes it
    close();
    var rgb = hexToRgb(hex) || [58, 110, 165];
    var hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    var el = document.createElement('div');
    el.className = 'cpick';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Choose a colour');
    el.innerHTML =
      '<div class="cpick-sv" role="slider" tabindex="0" aria-label="Saturation and brightness"><span class="cpick-dot"></span></div>' +
      '<div class="cpick-hue" role="slider" tabindex="0" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"><span class="cpick-knob"></span></div>' +
      '<div class="cpick-row">' +
        '<span class="cpick-chip"></span>' +
        '<input type="text" class="input cpick-hex" maxlength="7" spellcheck="false" aria-label="Hex colour">' +
      '</div>' +
      '<div class="cpick-recent"></div>';
    document.body.appendChild(el);
    var sv = el.querySelector('.cpick-sv'), dot = el.querySelector('.cpick-dot');
    var hue = el.querySelector('.cpick-hue'), knob = el.querySelector('.cpick-knob');
    var chip = el.querySelector('.cpick-chip'), hexIn = el.querySelector('.cpick-hex');
    var rec = el.querySelector('.cpick-recent');
    var c = current = { el: el, anchor: anchor, hex: null };

    function render(fromHex) {
      var col = hsvToHex(hsv.h, hsv.s, hsv.v);
      sv.style.setProperty('--hue', hsvToHex(hsv.h, 1, 1));
      dot.style.left = hsv.s * 100 + '%';
      dot.style.top = (1 - hsv.v) * 100 + '%';
      knob.style.left = hsv.h / 360 * 100 + '%';
      hue.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
      sv.setAttribute('aria-valuetext', 'saturation ' + Math.round(hsv.s * 100) + '%, brightness ' + Math.round(hsv.v * 100) + '%');
      chip.style.background = col;
      dot.style.background = col;
      if (!fromHex) hexIn.value = col;
      return col;
    }
    function emit(fromHex) {
      var col = render(fromHex);
      c.hex = col;
      onChange(col);
    }

    // Drag on the square or the hue bar.
    function drag(area, set) {
      area.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        area.focus();
        try { area.setPointerCapture(e.pointerId); } catch (err) { /* pointer gone */ }
        function at(ev) {
          var r = area.getBoundingClientRect();
          set(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
          emit();
        }
        function up() {
          area.removeEventListener('pointermove', at);
          area.removeEventListener('pointerup', up);
          area.removeEventListener('pointercancel', up);
        }
        at(e);
        area.addEventListener('pointermove', at);
        area.addEventListener('pointerup', up);
        area.addEventListener('pointercancel', up);
      });
    }
    drag(sv, function (x, y) { hsv.s = x; hsv.v = 1 - y; });
    drag(hue, function (x) { hsv.h = Math.min(359.9, x * 360); });

    sv.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') hsv.s = clamp(hsv.s - step, 0, 1);
      else if (e.key === 'ArrowRight') hsv.s = clamp(hsv.s + step, 0, 1);
      else if (e.key === 'ArrowUp') hsv.v = clamp(hsv.v + step, 0, 1);
      else if (e.key === 'ArrowDown') hsv.v = clamp(hsv.v - step, 0, 1);
      else return;
      e.preventDefault();
      emit();
    });
    hue.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 15 : 3;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') hsv.h = (hsv.h - step + 360) % 360;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') hsv.h = (hsv.h + step) % 360;
      else return;
      e.preventDefault();
      emit();
    });

    hexIn.addEventListener('input', function () {
      var v = hexIn.value.trim();
      if (v[0] !== '#') v = '#' + v;
      var p = hexToRgb(v);
      if (!p) return; // wait for six hex digits
      hsv = rgbToHsv(p[0], p[1], p[2]);
      emit(true);
    });
    hexIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); close(); } });

    recent.forEach(function (x) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cpick-swatch';
      b.style.background = x;
      b.title = x;
      b.setAttribute('aria-label', 'Recent colour ' + x);
      b.addEventListener('click', function () {
        var p = hexToRgb(x);
        hsv = rgbToHsv(p[0], p[1], p[2]);
        emit();
      });
      rec.appendChild(b);
    });
    rec.hidden = !recent.length;

    // Below the swatch, or above it when there's no room; always inside the window.
    var a = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    var top = a.bottom + 8 + h > window.innerHeight - 8 ? a.top - 8 - h : a.bottom + 8;
    el.style.left = clamp(a.left, 8, window.innerWidth - w - 8) + 'px';
    el.style.top = Math.max(8, top) + 'px';
    if (!QC.motion.calm()) {
      el.animate([{ opacity: 0, transform: 'translateY(-4px) scale(.97)' }, { opacity: 1, transform: 'none' }],
        { duration: 140, easing: QC.motion.EASE });
    }

    c.onOutside = function (e) { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    c.onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    // Typing a hex code on a phone: the browser may scroll the field above the keyboard.
    c.onScroll = function (e) { if (!el.contains(e.target) && document.activeElement !== hexIn) close(); };
    // Only a width change: on phones the on-screen keyboard and the browser bars change the height.
    var width0 = window.innerWidth;
    c.onResize = function () { if (window.innerWidth !== width0) close(); };
    document.addEventListener('pointerdown', c.onOutside, true);
    document.addEventListener('keydown', c.onKey, true);
    window.addEventListener('resize', c.onResize);
    document.addEventListener('scroll', c.onScroll, true);

    render();
    sv.focus({ preventScroll: true });
  }

  return { open: open, close: close, isOpen: function () { return !!current; } };
});
