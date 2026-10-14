/*
 * Small animation helpers (page only). Everything is skipped when the system asks for
 * reduced motion, and nothing that matters ever waits for an animation to finish.
 */
QC.define('motion', function (QC) {
  'use strict';

  var EASE = 'cubic-bezier(.2, .8, .2, 1)';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  function calm() { return reduced.matches || typeof Element.prototype.animate !== 'function'; }

  // Run `done` when the animation ends, or after a timer if the page isn't animating
  // (background tab), so the work behind it always completes.
  function afterAnim(anim, ms, done) {
    var ran = false;
    function once() { if (!ran) { ran = true; done(); } }
    anim.onfinish = once;
    setTimeout(once, ms + 80);
  }

  // Change the layout, then let the given elements glide from where they were
  // (a "FLIP" animation: First, Last, Invert, Play).
  function glide(parts, change) {
    parts = calm() ? [] : parts.filter(Boolean);
    var before = parts.map(function (n) { return n.getBoundingClientRect(); });
    change();
    parts.forEach(function (n, i) {
      var a = n.getBoundingClientRect(), b = before[i];
      if (!a.width || !b.width) return; // hidden before or after
      var dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      n.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: 260, easing: EASE });
    });
  }

  // A removed element folds its height away, then leaves the page.
  function foldAway(node) {
    if (calm()) { node.remove(); return; }
    var cs = getComputedStyle(node);
    node.style.overflow = 'hidden';
    node.style.pointerEvents = 'none';
    var anim = node.animate([
      { opacity: 1, height: node.offsetHeight + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginBottom: cs.marginBottom },
      { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px' }
    ], { duration: 180, easing: 'ease-in', fill: 'forwards' });
    afterAnim(anim, 180, function () { node.remove(); });
  }

  // A newly shown element grows from nothing to its height.
  function unfold(node) {
    if (calm()) return;
    var h = node.offsetHeight;
    node.style.overflow = 'hidden';
    var anim = node.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 240, easing: EASE });
    afterAnim(anim, 240, function () { node.style.overflow = ''; });
  }

  /* ----- morph: a box changes (or is replaced) and its parts move instead of popping ----- */

  // Parts are marked with data-morph="key". Positions are kept relative to the nearest marked
  // ancestor, so a part inside a moving part isn't moved twice.
  function shown(n) { return n.getClientRects().length > 0; }

  function anchorOf(n, root) {
    var a = n.parentElement && n.parentElement.closest('[data-morph]');
    return a && root.contains(a) ? a : root;
  }

  // See-through copy of a part, to fade out where it was. Copies canvas pixels and drops
  // names and ids, so the copy can't join the real form controls.
  function ghostOf(node) {
    var g = node.cloneNode(true);
    var from = node.querySelectorAll('canvas'), to = g.querySelectorAll('canvas');
    for (var i = 0; i < from.length; i++) {
      to[i].width = from[i].width;
      to[i].height = from[i].height;
      if (from[i].width && from[i].height) to[i].getContext('2d').drawImage(from[i], 0, 0);
    }
    [g].concat(Array.prototype.slice.call(g.querySelectorAll('[name], [id], [for]'))).forEach(function (n) {
      n.removeAttribute('name'); n.removeAttribute('id'); n.removeAttribute('for');
    });
    g.setAttribute('aria-hidden', 'true');
    g.inert = true;
    return g;
  }

  function snapshot(root) {
    var base = root.getBoundingClientRect(), parts = {};
    root.querySelectorAll('[data-morph]').forEach(function (n) {
      if (!shown(n)) return;
      var r = n.getBoundingClientRect(), a = anchorOf(n, root), ar = a.getBoundingClientRect();
      parts[n.dataset.morph] = {
        anchor: a === root ? '' : a.dataset.morph,
        x: r.left - ar.left, y: r.top - ar.top,                  // relative to its anchor
        rx: r.left - base.left, ry: r.top - base.top, w: r.width, h: r.height,
        ghost: ghostOf(n)
      };
    });
    return { height: base.height, parts: parts };
  }

  // Animate `root` (the same box after a change, or the box that replaced it) from `snap`.
  function play(snap, root) {
    if (calm() || !snap) return;
    root.getAnimations().forEach(function (a) { a.cancel(); });
    var base = root.getBoundingClientRect(), seen = {};
    if (Math.abs(base.height - snap.height) > 1) {
      root.style.overflow = 'hidden';
      var grow = root.animate([{ height: snap.height + 'px' }, { height: base.height + 'px' }], { duration: 260, easing: EASE });
      afterAnim(grow, 260, function () { root.style.overflow = ''; });
    }
    root.querySelectorAll('[data-morph]').forEach(function (n) {
      if (!shown(n)) return;
      var key = n.dataset.morph, old = snap.parts[key];
      seen[key] = true;
      var r = n.getBoundingClientRect(), a = anchorOf(n, root), ar = a.getBoundingClientRect();
      var anchor = a === root ? '' : a.dataset.morph;
      n.getAnimations().forEach(function (x) { x.cancel(); });
      if (old && old.anchor === anchor) {
        var dx = old.x - (r.left - ar.left), dy = old.y - (r.top - ar.top);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          n.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: 260, easing: EASE });
        }
      } else if (!old) {
        n.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
          { duration: 220, delay: 60, easing: EASE, fill: 'backwards' });
      }
    });
    Object.keys(snap.parts).forEach(function (key) {
      if (seen[key]) return;
      var o = snap.parts[key], g = o.ghost;
      g.removeAttribute('hidden');
      g.style.position = 'absolute';
      g.style.left = o.rx + 'px';
      g.style.top = o.ry + 'px';
      g.style.width = o.w + 'px';
      g.style.height = o.h + 'px';
      g.style.margin = '0';
      g.style.pointerEvents = 'none';
      g.style.zIndex = '-1';           // behind the new content (the box isolates its stacking)
      root.appendChild(g);
      var fade = g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      afterAnim(fade, 160, function () { g.remove(); });
    });
  }

  // Change a box in place (show/hide parts) with its parts moving instead of popping.
  function morph(root, change) {
    if (calm()) { change(); return; }
    var snap = snapshot(root);
    change();
    play(snap, root);
  }

  return { EASE: EASE, calm: calm, afterAnim: afterAnim, glide: glide, foldAway: foldAway, unfold: unfold,
    snapshot: snapshot, play: play, morph: morph };
});
