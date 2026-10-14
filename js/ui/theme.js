/*
 * Light/dark theme. Follows the system until the user picks the other one.
 * Picking the theme the system already uses clears the override again.
 * The initial theme is applied by a tiny inline script in <head> to avoid a flash.
 */
QC.define('theme', function (QC) {
  'use strict';

  var KEY = 'qc-theme';
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var memory = null; // used when localStorage is blocked

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return memory; }
  }
  function store(value) {
    memory = value;
    try {
      if (value) localStorage.setItem(KEY, value);
      else localStorage.removeItem(KEY);
    } catch (e) { /* private mode: keep it in memory only */ }
  }

  function system() { return media.matches ? 'dark' : 'light'; }
  function current() { return stored() || system(); }

  function apply() {
    var choice = stored();
    if (choice) document.documentElement.setAttribute('data-theme', choice);
    else document.documentElement.removeAttribute('data-theme');
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      var next = current() === 'dark' ? 'light' : 'dark';
      btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
      btn.title = 'Switch to ' + next + ' theme';
      btn.dataset.current = current();
    }
  }

  // A short colour cross-fade while switching (see html.theme-anim in style.css).
  var fadeTimer = null;
  function toggle() {
    var next = current() === 'dark' ? 'light' : 'dark';
    var root = document.documentElement;
    root.classList.add('theme-anim');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () { root.classList.remove('theme-anim'); }, 260);
    store(next === system() ? null : next);
    apply();
  }

  function init() {
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', toggle);
    if (media.addEventListener) media.addEventListener('change', apply);
    apply();
  }

  return { init: init, toggle: toggle, current: current };
});
