/*
 * QuickConvert shared namespace. Loaded on the page AND inside the worker.
 *
 * Why classic scripts and not ES modules: when index.html is opened straight from
 * disk (file://), Chrome and Edge refuse to load module scripts and worker files.
 * Classic scripts work everywhere, so each file registers itself on a global `QC`.
 *
 * Worker-side modules are written as `QC.define(name, factory, { worker: true })`.
 * The factory must be self-contained (use only its `QC` argument and browser
 * globals) because on file:// the worker is rebuilt from `factory.toString()`.
 * See js/pool.js.
 */
function qcBootstrap(root) {
  'use strict';
  var QC = root.QC = root.QC || {};

  QC.modules = QC.modules || [];
  QC.bootstrap = qcBootstrap;

  QC.define = function (name, factory, opts) {
    QC.modules.push({ name: name, factory: factory, worker: !!(opts && opts.worker) });
    QC[name] = factory(QC);
  };

  // Pinned third-party libraries. Loaded on demand, never at page load.
  QC.libs = {
    xlsx: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js',
    marked: 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js'
  };

  var loaded = {};
  // Load a classic script once, in either a worker or a page.
  QC.loadScript = function (url) {
    if (loaded[url]) return loaded[url];
    loaded[url] = new Promise(function (resolve, reject) {
      if (typeof importScripts === 'function') {
        try { importScripts(url); resolve(); }
        catch (e) { reject(e); }
        return;
      }
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('load failed')); };
      document.head.appendChild(s);
    }).catch(function () {
      delete loaded[url];
      throw QC.error('lib', 'Could not load a helper library. Check your connection.');
    });
    return loaded[url];
  };

  // Errors carry a short `code` so the page can react (e.g. retry decoding).
  QC.error = function (code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  };
}
qcBootstrap(self);
