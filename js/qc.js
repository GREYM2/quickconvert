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
    xlsx: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js',      // XLSX, ODS, CSV
    xlsxFull: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',  // + old Excel .xls (950 KB)
    marked: 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js',
    yaml: 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js',
    mediabunny: 'https://cdn.jsdelivr.net/npm/mediabunny@1.58.1/dist/bundles/mediabunny.min.cjs',  // video (680 KB)
    gifenc: 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.js',                             // GIF writer
    mp3Encoder: 'https://cdn.jsdelivr.net/npm/@mediabunny/mp3-encoder@1.58.1/dist/bundles/mediabunny-mp3-encoder.min.js',  // LAME (310 KB)
    aacEncoder: 'https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@1.58.1/dist/bundles/mediabunny-aac-encoder.min.js',  // for Firefox (990 KB)
    flacEncoder: 'https://cdn.jsdelivr.net/npm/@mediabunny/flac-encoder@1.58.1/dist/bundles/mediabunny-flac-encoder.min.js', // (320 KB)
    heif: 'https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js',          // HEIC photos (1.4 MB)
    utif: 'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js',                                          // TIFF reader
    pako: 'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako_inflate.min.js'                          // for UTIF
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

  // Load a CommonJS bundle once (libraries without a plain script build) and return its exports.
  // globals: names the bundle expects to find, e.g. { Mediabunny: exports }.
  var cjs = {};
  QC.loadCjs = function (url, globals) {
    if (cjs[url]) return cjs[url];
    cjs[url] = fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (code) {
      var module = { exports: {} }, names = Object.keys(globals || {});
      Function.apply(null, ['module', 'exports'].concat(names, [code]))
        .apply(null, [module, module.exports].concat(names.map(function (k) { return globals[k]; })));
      return module.exports;
    }).catch(function () {
      delete cjs[url];
      throw QC.error('lib', 'Could not load a helper library. Check your connection.');
    });
    return cjs[url];
  };

  // Errors carry a short `code` so the page can react (e.g. retry decoding).
  QC.error = function (code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  };
}
qcBootstrap(self);
