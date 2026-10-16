/*
 * Worker pool (page side): at most two workers, one job per worker, a small priority queue.
 *
 * Where the worker code comes from, tried in this order:
 *   file  new Worker('js/worker.js')        http(s). Real files, easiest to debug.
 *   blob  rebuilt from the loaded modules   file://, where Chrome blocks worker files.
 *   main  runs jobs on the page itself      last resort. Force it with ?worker=main to set
 *                                           breakpoints in conversion code on the page.
 * Any mode can be forced for debugging: ?worker=file | blob | main
 */
QC.define('pool', function (QC) {
  'use strict';

  var forced = new URLSearchParams(location.search).get('worker');
  var modes = forced ? [forced]
    : typeof Worker === 'undefined' ? ['main']
    : location.protocol === 'file:' ? ['blob', 'main']
    : ['file', 'blob', 'main'];
  var SIZE = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
  var modeIndex = 0, generation = 0, slots = null, queue = [], nextId = 1, blobUrl = null, dead = false;

  function mode() { return modes[modeIndex]; }

  function clone(value, transfer) {
    return typeof structuredClone === 'function' ? structuredClone(value, { transfer: transfer || [] }) : value;
  }

  // Worker source rebuilt from the factories already loaded on the page.
  function blobSource() {
    if (!blobUrl) {
      var src = ['(' + QC.bootstrap.toString() + ')(self);'];
      QC.modules.forEach(function (m) {
        if (m.worker) src.push('QC.define(' + JSON.stringify(m.name) + ', ' + m.factory.toString() + ', { worker: true });');
      });
      src.push('QC.jobs.listen(self);', '//# sourceURL=quickconvert-worker.js');
      blobUrl = URL.createObjectURL(new Blob([src.join('\n')], { type: 'text/javascript' }));
    }
    return blobUrl;
  }

  // Worker-shaped object that runs jobs on the page. Messages are cloned like real ones.
  function inlineWorker() {
    var w = { onmessage: null, onerror: null };
    function deliver(data) { setTimeout(function () { if (w.onmessage) w.onmessage({ data: data }); }, 0); }
    w.postMessage = function (msg, transfer) {
      var copy = clone(msg, transfer);
      setTimeout(function () {
        QC.jobs.handle(copy, function (reply, t) { deliver(clone(reply, t)); });
      }, 0);
    };
    w.terminate = function () { w.onmessage = null; };
    deliver({ type: 'ready' });
    return w;
  }

  function Slot(gen) {
    var slot = this;
    slot.gen = gen;
    slot.job = null;
    slot.ready = false;
    var m = mode();
    try {
      slot.worker = m === 'file' ? new Worker('js/worker.js')
        : m === 'blob' ? new Worker(blobSource())
        : inlineWorker();
    } catch (e) {
      setTimeout(function () { fallback(gen); }, 0); // e.g. SecurityError on file://
      return;
    }
    slot.worker.onmessage = function (e) { slot.onMessage(e.data); };
    slot.worker.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      slot.onError();
    };
    slot.timer = setTimeout(function () { if (!slot.ready) fallback(gen); }, 10000);
  }

  Slot.prototype.onMessage = function (d) {
    if (d.type === 'ready') {
      this.ready = true;
      clearTimeout(this.timer);
      pump();
      return;
    }
    var job = this.job;
    if (!job || d.id !== job.id) return;
    if (d.type === 'progress') {
      if (job.onProgress) job.onProgress(d.progress);
      return;
    }
    this.job = null;
    if (d.type === 'done') job.resolve(d.result);
    else job.reject(QC.error(d.code || 'failed', d.error));
    pump();
  };

  Slot.prototype.onError = function () {
    if (this.gen !== generation) return;
    if (!this.ready) { fallback(this.gen); return; }
    // Crashed during a job (e.g. out of memory): fail that job and start a fresh worker.
    var job = this.job;
    this.job = null;
    if (job) job.reject(QC.error('crash', 'The converter stopped (out of memory?).'));
    this.worker.terminate();
    slots[slots.indexOf(this)] = new Slot(this.gen);
  };

  function start() {
    generation++;
    var n = mode() === 'main' ? 1 : SIZE;
    slots = [];
    for (var i = 0; i < n; i++) slots.push(new Slot(generation));
  }

  function fallback(gen) {
    if (gen !== generation) return; // another slot already handled it
    slots.forEach(function (s) {
      clearTimeout(s.timer);
      if (s.worker) s.worker.terminate();
    });
    if (modeIndex >= modes.length - 1) {
      dead = true;
      queue.splice(0).forEach(function (j) { j.reject(QC.error('crash', 'Could not start the converter.')); });
      return;
    }
    modeIndex++;
    console.warn('[QuickConvert] worker mode "' + modes[modeIndex - 1] + '" failed, using "' + mode() + '"');
    start();
  }

  function pump() {
    if (!slots) return;
    for (var s = 0; s < slots.length; s++) {
      var slot = slots[s];
      if (!slot.ready || slot.job || !queue.length) continue;
      var best = 0;
      for (var i = 1; i < queue.length; i++) if (queue[i].priority > queue[best].priority) best = i;
      var job = queue.splice(best, 1)[0];
      slot.job = job;
      try {
        slot.worker.postMessage({ id: job.id, task: job.task, file: job.file, options: job.options }, job.transfer || []);
      } catch (e) {
        slot.job = null;
        job.reject(QC.error('failed', 'Could not hand the file to the converter.'));
        s--; // try this slot again with the next job
      }
    }
  }

  /*
   * job: { task, file?, options, transfer?, priority? (higher first), key?, owner?, onProgress? }
   * A new job with the same `key` cancels the queued one (used for previews).
   */
  function run(job) {
    if (!slots) start();
    return new Promise(function (resolve, reject) {
      if (job.key) cancel(function (j) { return j.key === job.key; });
      if (dead) { reject(QC.error('crash', 'Could not start the converter.')); return; }
      job.id = nextId++;
      job.priority = job.priority || 0;
      job.resolve = resolve;
      job.reject = reject;
      queue.push(job);
      pump();
    });
  }

  // Drop queued jobs, and stop running ones marked `stoppable` (long video jobs: their worker is
  // replaced). Their promises reject with code 'cancelled'.
  function cancel(filter) {
    queue = queue.filter(function (j) {
      if (!filter(j)) return true;
      j.reject(QC.error('cancelled', 'Cancelled.'));
      return false;
    });
    (slots || []).forEach(function (slot, i) {
      var j = slot.job;
      if (!j || !j.stoppable || !filter(j)) return;
      slot.job = null;
      slot.worker.terminate();
      slots[i] = new Slot(slot.gen);
      j.reject(QC.error('cancelled', 'Cancelled.'));
    });
  }

  // SVG has no pixels of its own: drawn at least 2048 px on the longer side, so it stays sharp
  // when made smaller (workers can't draw SVG at all, so it always comes here).
  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      function fail() { URL.revokeObjectURL(url); reject(QC.error('decode', 'Could not read this image.')); }
      img.onload = function () {
        var source = img;
        if (/svg/.test(file.type) || /\.svg$/i.test(file.name)) {
          var w = img.naturalWidth || 1024, h = img.naturalHeight || w, k = Math.max(1, 2048 / Math.max(w, h));
          source = document.createElement('canvas');
          source.width = Math.round(w * k);
          source.height = Math.round(h * k);
          source.getContext('2d').drawImage(img, 0, 0, source.width, source.height);
        }
        createImageBitmap(source).then(function (b) { URL.revokeObjectURL(url); resolve(b); }, fail);
      };
      img.onerror = fail;
      img.src = url;
    });
  }

  // Image jobs: if the worker can't decode the file, decode it here with <img> and retry once.
  async function runImage(job) {
    try {
      return await run(job);
    } catch (e) {
      if (e.code !== 'decode' || !job.file) throw e;
      var bitmap = await decodeWithImg(job.file);
      return run(Object.assign({}, job, {
        file: null, options: Object.assign({}, job.options, { bitmap: bitmap }), transfer: [bitmap]
      }));
    }
  }

  return { run: run, runImage: runImage, cancel: cancel, mode: mode };
});
