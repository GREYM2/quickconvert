/*
 * Video and audio. Video: MP4, WebM, MOV, MKV in; MP4, WebM, an animated GIF or just the sound out;
 * GIF animations to video. Audio: MP3, M4A, OGG, WAV, FLAC, AAC, WebA in; MP3, M4A, OGG, WAV out.
 * Trim, volume, quality; size and frame rate for video; channels, sample rate and fades for audio.
 * Decoding and encoding use the browser's WebCodecs through Mediabunny (reads and writes the
 * files), plus its MP3 and AAC encoders where the browser has none; GIFs are written with gifenc.
 * All of them load only when they're needed.
 */
QC.define('video', function (QC) {
  'use strict';

  var GIF_HEIGHT = 480, GIF_FPS = 12, MAX_GIF_FRAMES = 1500;

  function defaults() {
    return {
      start: 0, end: 0,       // trim, in seconds; end 0 = to the end
      quality: 'keep',        // keep (copy when possible) | high | medium | low
      height: 'auto',         // auto | 0 (original) | 1080 | 720 | 480 | 360 | 240
      fps: 'auto',            // auto | 0 (original) | 60 | 30 | 24 | 15 | 10
      volume: 100,            // percent; 0 = no sound
      channels: 'auto',       // audio: auto | 1 | 2
      rate: 'auto',           // audio: auto | sample rate in Hz
      fadeIn: 0, fadeOut: 0   // audio: seconds
    };
  }

  var AUDIO_CODEC = { mp3: 'mp3', m4a: 'aac', aac: 'aac', mp4: 'aac', mov: 'aac', ogg: 'opus', opus: 'opus', flac: 'flac', wav: 'pcm-s16' };
  var LOSSLESS = { wav: true, flac: true };
  var MP3_RATES = [48000, 44100, 32000];               // what the MP3 encoder takes

  function supported() { return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined'; }

  // Firefox (and Zen) hand over a malformed H.264 setup block (avcC): each parameter set's first byte
  // doubled and the reserved bits missing. Browsers cope, desktop players (Windows) refuse the file.
  // Returns a repaired copy, or the description unchanged when it's fine.
  function fixAvcC(desc) {
    var b = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
    if (b.length < 7 || b[0] !== 1) return desc;
    var p = 6, sets = [[], []], broken = (b[4] & 0xfc) !== 0xfc || (b[5] & 0xe0) !== 0xe0;
    for (var k = 0; k < 2; k++) {
      var count = k ? b[p++] : b[5] & 31;
      for (var i = 0; i < count; i++) {
        var len = b[p] << 8 | b[p + 1], nal = b.subarray(p + 2, p + 2 + len);
        p += 2 + len;
        if (nal.length > 1 && nal[0] === nal[1] && (nal[0] & 31) === (k ? 8 : 7)) { nal = nal.subarray(1); broken = true; }
        sets[k].push(nal);
      }
    }
    if (!broken || !sets[0].length) return desc;
    var sps = sets[0][0], out = [1, sps[1], sps[2], sps[3], 0xfc | (b[4] & 3), 0xe0 | sets[0].length];
    sets.forEach(function (list, k) {
      if (k) out.push(list.length);
      list.forEach(function (nal) { out.push(nal.length >> 8, nal.length & 255); for (var j = 0; j < nal.length; j++) out.push(nal[j]); });
    });
    return new Uint8Array(out);
  }

  // Every encoder made in this worker passes its setup block through fixAvcC before the muxer sees it.
  function repairEncoder() {
    var Native = self.VideoEncoder;
    if (!Native || Native.repaired) return;
    var Repaired = function (init) {
      return new Native(Object.assign({}, init, {
        output: function (chunk, meta) {
          var config = meta && meta.decoderConfig;
          if (config && config.description && /^avc/.test(config.codec)) {
            meta = Object.assign({}, meta, { decoderConfig: Object.assign({}, config, { description: fixAvcC(config.description) }) });
          }
          init.output(chunk, meta);
        }
      }));
    };
    Repaired.isConfigSupported = Native.isConfigSupported.bind(Native);
    Repaired.prototype = Native.prototype;
    Repaired.repaired = true;
    self.VideoEncoder = Repaired;
  }

  function lib() {
    repairEncoder();
    return QC.loadCjs(QC.libs.mediabunny);
  }

  async function open(file) {
    var M = await lib();
    var input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
    var video, audio;
    try { video = await input.getPrimaryVideoTrack(); audio = await input.getPrimaryAudioTrack(); }
    catch (e) { throw QC.error('decode', 'Could not read this file.'); }
    if (!video && !audio) throw QC.error('decode', 'There is no video or sound in this file.');
    return { M: M, input: input, video: video, audio: audio };
  }

  // Facts for the panel: length, size, frame rate, codecs, sound.
  async function probe(file) {
    var o = await open(file), v = o.video, a = o.audio;
    var info = { duration: await o.input.computeDuration(), audioCodec: a ? a.codec : null,
      sampleRate: a ? a.sampleRate : 0, channels: a ? a.numberOfChannels : 0, canPlay: await (v || a).canDecode() };
    if (v) {
      var stats = await v.computePacketStats(120);
      Object.assign(info, { width: v.displayWidth, height: v.displayHeight, videoCodec: v.codec,
        fps: Math.round(stats.averagePacketRate * 100) / 100 });
    }
    return info;
  }

  function quality(M, q) { return { high: M.QUALITY_HIGH, medium: M.QUALITY_MEDIUM, low: M.QUALITY_LOW }[q]; }

  function outputFormat(M, to) {
    switch (to) {
      case 'webm': return new M.WebMOutputFormat();
      case 'mkv': return new M.MkvOutputFormat();
      case 'mov': return new M.MovOutputFormat({ fastStart: 'in-memory' });
      case 'mp3': return new M.Mp3OutputFormat();
      case 'aac': return new M.AdtsOutputFormat();
      case 'ogg': case 'opus': return new M.OggOutputFormat();
      case 'flac': return new M.FlacOutputFormat();
      case 'wav': return new M.WavOutputFormat();
      default: return new M.Mp4OutputFormat({ fastStart: 'in-memory' });   // mp4, m4a
    }
  }

  // Browsers have no MP3 encoder, Firefox none for AAC, most none for FLAC: Mediabunny's add-ons fill in.
  async function addEncoder(M, codec) {
    if (await M.canEncodeAudio(codec)) return;
    var addon = await QC.loadCjs(QC.libs[codec + 'Encoder'], { Mediabunny: M });
    addon['register' + { mp3: 'Mp3', aac: 'Aac', flac: 'Flac' }[codec] + 'Encoder']();
  }

  // Auto: the original size for video, 480p for GIFs. Never larger than the original.
  function outHeight(s, srcHeight, gif) {
    var h = s.height === 'auto' ? (gif ? GIF_HEIGHT : 0) : +s.height;
    return h && h < srcHeight ? h : 0;
  }

  // { start, end } in seconds, or undefined for the whole video.
  function trimRange(s, duration) {
    var start = Math.min(Math.max(0, +s.start || 0), duration), end = +s.end > 0 ? Math.min(+s.end, duration) : duration;
    if (end - start < 0.1) throw QC.error('settings', 'The trimmed part is too short.');
    return start < 0.01 && end > duration - 0.01 ? undefined : { start: start, end: end };
  }

  // Volume and fades: every sample scaled, clipped at the loudest possible value. Timestamps are
  // seconds into the result; `total` is its length.
  function shape(M, sample, gain, fadeIn, fadeOut, total) {
    var ch = sample.numberOfChannels, rate = sample.sampleRate;
    var data = new Float32Array(sample.allocationSize({ planeIndex: 0, format: 'f32' }) / 4);
    sample.copyTo(data, { planeIndex: 0, format: 'f32' });
    for (var i = 0; i < data.length; i++) {
      var t = sample.timestamp + Math.floor(i / ch) / rate, g = gain;
      if (fadeIn && t < fadeIn) g *= Math.max(0, t / fadeIn);
      if (fadeOut && t > total - fadeOut) g *= Math.max(0, (total - t) / fadeOut);
      var x = data[i] * g;
      data[i] = x > 1 ? 1 : x < -1 ? -1 : x;
    }
    return new M.AudioSample({ data: data, format: 'f32', numberOfChannels: ch, sampleRate: rate, timestamp: sample.timestamp });
  }

  var REASONS = {
    undecodable_source_codec: 'this browser can\'t decode it', unknown_source_codec: 'its format is unknown',
    no_encodable_target_codec: 'this browser can\'t encode it in this format'
  };

  async function transcode(file, to, s, progress) {
    var o = await open(file), M = o.M, audioOut = QC.formats.get(to).kind === 'audio';
    if (!audioOut && !o.video) throw QC.error('decode', 'There is no video in this file.');
    if (audioOut && !o.audio) throw QC.error('decode', 'There is no sound in this file.');
    var duration = await o.input.computeDuration(), range = trimRange(s, duration);
    var total = range ? range.end - range.start : duration, q = quality(M, s.quality);
    var gain = Math.max(0, +s.volume) / 100, video = {}, audio = {};
    var fadeIn = audioOut ? +s.fadeIn || 0 : 0, fadeOut = audioOut ? +s.fadeOut || 0 : 0;
    if (audioOut) {
      if (!gain) throw QC.error('settings', 'Volume 0 would make a silent file.');
      video.discard = true;
      audio.codec = AUDIO_CODEC[to];
      var rate = s.rate === 'auto' ? 0 : +s.rate;
      if (to === 'mp3' && MP3_RATES.indexOf(rate || o.audio.sampleRate) < 0) rate = 44100;
      if (rate) audio.sampleRate = rate;
      if (s.channels !== 'auto') audio.numberOfChannels = +s.channels;
      if (q && !LOSSLESS[to]) audio.quality = q;
    } else {
      var h = o.video ? outHeight(s, o.video.displayHeight, false) : 0, fps = s.fps === 'auto' ? 0 : +s.fps;
      if (h) video.height = h;                         // the width follows the aspect ratio
      if (fps) video.frameRate = fps;
      if (q) video.quality = q;
      if (!gain) audio.discard = true;
    }
    if (gain && (gain !== 1 || fadeIn || fadeOut)) {
      audio.process = function (sample) { return shape(M, sample, gain, fadeIn, fadeOut, total); };
    }
    if (AUDIO_CODEC[to] === 'mp3' || AUDIO_CODEC[to] === 'flac') await addEncoder(M, AUDIO_CODEC[to]);
    // AAC only when the sound is encoded again (not copied): edited, or from another codec.
    if (AUDIO_CODEC[to] === 'aac' && o.audio && gain && (audioOut || range || audio.process || o.audio.codec !== 'aac')) await addEncoder(M, 'aac');
    var output = new M.Output({ format: outputFormat(M, to), target: new M.BufferTarget() });
    var conversion = await M.Conversion.init({ input: o.input, output: output, video: video, audio: audio, trim: range });
    var notes = [];
    conversion.discardedTracks.forEach(function (d) {
      if (d.reason === 'discarded_by_user') return;
      var why = REASONS[d.reason] || d.reason.replace(/_/g, ' ');
      if (d.track.isVideoTrack()) throw QC.error('unsupported', 'Can\'t convert this video: ' + why + '.');
      if (audioOut) throw QC.error('unsupported', 'Can\'t convert this sound: ' + why + '.');
      notes.push('no sound (' + why + ')');
    });
    if (!conversion.isValid) throw QC.error('unsupported', 'Can\'t convert this video.');
    conversion.onProgress = progress;
    await conversion.execute();
    return { blob: new Blob([output.target.buffer], { type: QC.formats.get(to).mime }), note: notes.join(' · '), duration: total };
  }

  async function toGif(file, s, progress) {
    var o = await open(file), M = o.M, v = o.video;
    if (!v) throw QC.error('decode', 'There is no video in this file.');
    if (!(await v.canDecode())) throw QC.error('unsupported', 'This browser can\'t decode this video.');
    var duration = await o.input.computeDuration(), range = trimRange(s, duration) || { start: 0, end: duration };
    var h = outHeight(s, v.displayHeight, true) || v.displayHeight;
    var w = Math.max(1, Math.round(v.displayWidth * h / v.displayHeight));
    var fps = s.fps === 'auto' ? GIF_FPS : +s.fps || Math.min(50, Math.round((await v.computePacketStats(60)).averagePacketRate) || GIF_FPS);
    var times = [];
    for (var t = range.start; t < range.end - 1e-6 && times.length < MAX_GIF_FRAMES; t += 1 / fps) times.push(t);
    var G = await QC.loadCjs(QC.libs.gifenc), gif = G.GIFEncoder(), delay = Math.round(1000 / fps), done = 0;
    var sink = new M.CanvasSink(v, { width: w, height: h, fit: 'fill', poolSize: 1 });
    for await (var frame of sink.canvasesAtTimestamps(times)) {
      if (frame) {
        var px = frame.canvas.getContext('2d').getImageData(0, 0, w, h).data;
        var palette = G.quantize(px, 256);
        gif.writeFrame(G.applyPalette(px, palette), w, h, { palette: palette, delay: delay });
      }
      progress(++done / times.length);
    }
    gif.finish();
    return { blob: new Blob([gif.bytes()], { type: 'image/gif' }), duration: range.end - range.start,
      note: times.length === MAX_GIF_FRAMES ? 'cut at ' + MAX_GIF_FRAMES + ' frames' : '' };
  }

  // shortcut: GIF frames come from the browser's ImageDecoder (not in Safari), add a GIF decoder if Safari needs it.
  async function fromGif(file, to, s, background, progress) {
    if (typeof ImageDecoder === 'undefined') throw QC.error('unsupported', 'GIF to video needs Chrome, Edge or Firefox.');
    var M = await lib();
    var dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
    await dec.tracks.ready;
    await dec.completed;
    var n = dec.tracks.selectedTrack.frameCount, first = (await dec.decode({ frameIndex: 0 })).image;
    var sh = first.displayHeight, h = outHeight(s, sh, false) || sh;
    var w = Math.round(first.displayWidth * h / sh);
    w += w % 2;                                        // video encoders want even sizes
    h += h % 2;
    var format = outputFormat(M, to);
    var codec = await M.getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width: w, height: h });
    if (!codec) throw QC.error('unsupported', 'This browser can\'t encode ' + to.toUpperCase() + ' video.');
    var canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d');
    var output = new M.Output({ format: format, target: new M.BufferTarget() });
    var source = new M.CanvasSource(canvas, { codec: codec, bitrate: quality(M, s.quality) || M.QUALITY_HIGH });
    output.addVideoTrack(source);
    await output.start();
    var t = 0;
    for (var i = 0; i < n; i++) {
      var img = i ? (await dec.decode({ frameIndex: i })).image : first;
      var d = (img.duration || 100000) / 1e6;          // microseconds; a GIF without a delay shows 0.1 s
      ctx.fillStyle = background || '#ffffff';         // video has no transparency
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      img.close();
      await source.add(t, d);
      t += d;
      progress((i + 1) / n);
    }
    source.close();
    await output.finalize();
    dec.close();
    return { blob: new Blob([output.target.buffer], { type: QC.formats.get(to).mime }), duration: t };
  }

  async function convert(file, opts, progress) {
    if (!supported()) throw QC.error('unsupported', 'Video and audio need a newer browser (Chrome, Edge, Firefox 130+ or Safari 16.4+).');
    var s = Object.assign(defaults(), opts.video || {});
    try {
      if (opts.from === 'gif') return await fromGif(file, opts.to, s, opts.settings && opts.settings.background, progress);
      if (opts.to === 'gif') return await toGif(file, s, progress);
      return await transcode(file, opts.to, s, progress);
    } catch (e) {
      if (e.code) throw e;
      throw QC.error('failed', 'Conversion failed' + (e.message ? ': ' + String(e.message).slice(0, 120) : '.'));
    }
  }

  return { defaults: defaults, supported: supported, probe: probe, convert: convert, fixAvcC: fixAvcC, GIF_HEIGHT: GIF_HEIGHT, GIF_FPS: GIF_FPS };
}, { worker: true });
