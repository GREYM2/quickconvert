/*
 * Worker-side job dispatcher.
 *   in:  { id, task, file?, options }
 *   out: { id, type: 'progress', progress } | { id, type: 'done', result } | { id, type: 'error', error, code }
 * Files and Blobs are passed by reference; ImageBitmaps and ArrayBuffers are transferred.
 */
QC.define('jobs', function (QC) {
  'use strict';

  var tasks = {
    prepare: async function (msg) {
      var r = await QC.image.prepare(msg.options.bitmap || msg.file);
      return { result: r, transfer: [r.bitmap] };
    },
    preview: async function (msg) {
      return { result: await QC.image.preview(msg.options) };
    },
    convert: async function (msg, progress) {
      var o = msg.options, f = QC.formats.get(o.from);
      if (!f) throw QC.error('unsupported', 'Unsupported format.');
      progress(0); // lets the page switch from "queued" to "converting" right away
      var result = f.kind === 'image'
        ? await QC.image.convert(o.bitmap || msg.file, o, progress)
        : await QC.data.convert(msg.file, o, progress);
      return { result: result };
    },
    zip: async function (msg, progress) {
      return { result: { blob: await QC.zip.build(msg.options.entries, progress) } };
    }
  };

  function handle(msg, post) {
    var id = msg.id, last = 0;
    function progress(p) {
      var now = Date.now();
      if (now - last < 50 && p < 1) return; // don't flood the page
      last = now;
      post({ id: id, type: 'progress', progress: p });
    }
    Promise.resolve()
      .then(function () {
        if (!tasks[msg.task]) throw QC.error('unsupported', 'Unknown task: ' + msg.task);
        return tasks[msg.task](msg, progress);
      })
      .then(function (out) {
        post({ id: id, type: 'done', result: out.result }, out.transfer || []);
      }, function (err) {
        err = err || {};
        if (!err.code) console.error('[QuickConvert worker]', err);
        var text = err.code ? err.message : 'Conversion failed' + (err.message ? ': ' + String(err.message).slice(0, 100) : '.');
        post({ id: id, type: 'error', error: text, code: err.code });
      });
  }

  function listen(scope) {
    scope.onmessage = function (e) {
      handle(e.data, function (m, transfer) { scope.postMessage(m, transfer); });
    };
    scope.postMessage({ type: 'ready' });
  }

  return { handle: handle, listen: listen };
}, { worker: true });
