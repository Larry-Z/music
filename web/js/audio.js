/* Shared Web Audio helpers: one AudioContext for the whole page, click
 * synthesis for the metronome, and Karplus-Strong plucked-string synthesis
 * for the chord library. No external libraries. */
(function (global) {
  'use strict';

  var ctx = null;
  var scheduled = {};
  var activePlucks = {};
  var STRUM_DELAY_DOWN = 0.02;
  var STRUM_DELAY_UP = 0.016;
  var STRING_TIMBRES = {
    guitar: {
      key: 'guitar', damping: 0.5, smoothing: 0.12, attack: 0.002,
      cutoff: 4200, bodyFrequency: 220, bodyGain: 1.5,
      downNoise: { from: 500, to: 1800, gain: 0.1 },
      upNoise: { from: 3200, to: 1400, gain: 0.08 }
    },
    ukulele: {
      key: 'ukulele', damping: 0.36, smoothing: 0.58, attack: 0.005,
      cutoff: 2500, bodyFrequency: 650, bodyGain: 2.5,
      downNoise: { from: 350, to: 1200, gain: 0.055 },
      upNoise: { from: 1700, to: 850, gain: 0.04 }
    }
  };

  function stringTimbre(instrument) {
    return STRING_TIMBRES[instrument] || STRING_TIMBRES.guitar;
  }

  function audioContext() {
    if (!ctx) {
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) throw new Error('当前浏览器不支持 Web Audio API');
      ctx = new Ctor();
    }
    return ctx;
  }

  /* Browsers start the context suspended until a user gesture. */
  function unlock() {
    var c = audioContext();
    if (c.state === 'suspended') c.resume();
    return c;
  }

  function hideAudioHint() {
    var hint = document.getElementById('audio-hint');
    if (hint) hint.classList.add('is-hidden');
  }

  ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
    global.addEventListener(evt, function once() {
      try {
        unlock();
        hideAudioHint();
      } catch (e) { /* 由首次实际使用的功能显示错误 */ }
      global.removeEventListener(evt, once);
    }, { once: true, passive: true });
  });

  /* ---------------------------------------------------------------- clicks */

  var SOUNDS = {
    click: { freq: 1000, accentFreq: 1500, type: 'square', decay: 0.05, gain: 0.5 },
    beep: { freq: 880, accentFreq: 1320, type: 'sine', decay: 0.09, gain: 0.55 },
    wood: { freq: 420, accentFreq: 620, type: 'triangle', decay: 0.06, gain: 0.6 }
  };

  function trackSource(source, group, onEnd) {
    if (!group) return source;
    if (!scheduled[group]) scheduled[group] = [];
    scheduled[group].push(source);
    source.onended = function () {
      var list = scheduled[group];
      if (!list) return;
      var index = list.indexOf(source);
      if (index !== -1) list.splice(index, 1);
      if (!list.length) delete scheduled[group];
      if (onEnd) onEnd();
    };
    return source;
  }

  /* 立即停止某个走带已经排进音频线程的声音。 */
  function cancelGroup(group) {
    var list = scheduled[group];
    delete activePlucks[group];
    if (!list) return;
    delete scheduled[group];
    list.slice().forEach(function (source) {
      source.onended = null;
      try { source.stop(); } catch (e) { /* 已经结束的节点无需处理 */ }
    });
  }

  /* 新一次扫弦会重新激发琴弦，旧弦音短暂淡出，避免长尾叠加失真。 */
  function releasePlucks(group, when) {
    var voices = activePlucks[group];
    if (!voices || !voices.length) return;
    delete activePlucks[group];
    for (var i = 0; i < voices.length; i++) {
      var voice = voices[i];
      var gainParam = voice.gain.gain;
      try {
        if (gainParam.cancelAndHoldAtTime) {
          gainParam.cancelAndHoldAtTime(when);
        } else {
          var progress = Math.max(0, Math.min(1, (when - voice.when) / voice.duration));
          var level = voice.peak * Math.pow(0.0001 / voice.peak, progress);
          gainParam.cancelScheduledValues(when);
          gainParam.setValueAtTime(Math.max(level, 0.0001), when);
        }
        gainParam.exponentialRampToValueAtTime(0.0001, when + 0.035);
        voice.source.stop(when + 0.055);
      } catch (e) { /* 已结束的弦音无需再释放 */ }
    }
  }

  /**
   * Schedule one metronome click.
   * @param {number} when AudioContext time to play at.
   * @param {boolean} accent Whether this is an accented (downbeat) click.
   * @param {number} volume 0..1
   * @param {string} sound Key of SOUNDS.
   */
  function click(when, accent, volume, sound, group) {
    if (!isFinite(volume) || volume <= 0) return null;
    var c = audioContext();
    var preset = SOUNDS[sound] || SOUNDS.click;
    var osc = c.createOscillator();
    var gain = c.createGain();
    var peak = volume * preset.gain * (accent ? 1 : 0.62);
    osc.type = preset.type;
    osc.frequency.setValueAtTime(accent ? preset.accentFreq : preset.freq, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + preset.decay);
    osc.connect(gain).connect(c.destination);
    trackSource(osc, group);
    osc.start(when);
    osc.stop(when + preset.decay + 0.02);
    return osc;
  }

  /* ------------------------------------------------------- strum synthesis */

  var noiseBuffer = null;

  function seededUnit(seed) {
    var value = Math.sin((seed + 1) * 12.9898) * 43758.5453;
    return value - Math.floor(value);
  }

  function sharedNoise(c, seconds) {
    if (noiseBuffer && noiseBuffer.duration >= seconds) return noiseBuffer;
    var len = Math.ceil(c.sampleRate * seconds);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffer = buf;
    return buf;
  }

  /* Filtered noise burst: the percussive part of a strum / chuck. */
  function noiseBurst(when, opts, group, variantSeed) {
    var o = opts || {};
    var peak = o.gain == null ? 0.22 : o.gain;
    if (!isFinite(peak) || peak <= 0) return null;
    var c = audioContext();
    var dur = o.duration || 0.12;
    var src = c.createBufferSource();
    src.buffer = sharedNoise(c, 0.5);
    var filter = c.createBiquadFilter();
    filter.type = o.filterType || 'bandpass';
    filter.Q.value = o.q || 0.9;
    filter.frequency.setValueAtTime(o.from || 900, when);
    filter.frequency.exponentialRampToValueAtTime(o.to || 2600, when + dur);
    var gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(filter).connect(gain).connect(c.destination);
    trackSource(src, group);
    var maxOffset = Math.max(0, src.buffer.duration - dur - 0.02);
    var offsetUnit = variantSeed == null ? Math.random() : seededUnit(variantSeed + 1000);
    src.start(when, offsetUnit * maxOffset);
    src.stop(when + dur + 0.02);
    return src;
  }

  /* 生成 Karplus-Strong 拨弦缓冲；尼龙弦先柔化起振噪声，减少高频金属感。 */
  var pluckCache = {};
  var pluckCacheKeys = [];
  var pluckVariantCursor = {};
  var PLUCK_VARIANTS = 6;
  var MAX_PLUCK_CACHE = 48;

  function pluckBuffer(freq, seconds, timbre, variantSeed) {
    var c = audioContext();
    var rate = c.sampleRate;
    var d = Math.max(0, Math.min(1, timbre.damping));
    var baseKey = rate + '/' + Math.round(freq * 10) + '/' + seconds + '/' + timbre.key + '/' + d;
    var cursor = pluckVariantCursor[baseKey] || 0;
    var variant = variantSeed == null ? cursor % PLUCK_VARIANTS : Math.abs(Math.floor(variantSeed)) % PLUCK_VARIANTS;
    if (variantSeed == null) pluckVariantCursor[baseKey] = cursor + 1;
    var key = baseKey + '/' + variant;
    if (pluckCache[key]) return pluckCache[key];
    var n = Math.max(2, Math.round(rate / freq));
    var len = Math.ceil(rate * seconds);
    var buf = c.createBuffer(1, len, rate);
    var out = buf.getChannelData(0);
    var ring = new Float32Array(n);
    for (var i = 0; i < n; i++) ring[i] = Math.random() * 2 - 1;
    if (timbre.smoothing > 0) {
      var previous = ring[n - 1];
      var mean = 0;
      for (var r = 0; r < n; r++) {
        var original = ring[r];
        ring[r] = original * (1 - timbre.smoothing) + previous * timbre.smoothing;
        previous = original;
        mean += ring[r];
      }
      mean /= n;
      for (var m = 0; m < n; m++) ring[m] -= mean;
    }
    /* 高频弦自然衰减更快；damping 越大，每轮反馈损耗越多。 */
    var feedback = 0.9995 - d * 0.004;
    var prev = 0;
    for (var s = 0; s < len; s++) {
      var cur = ring[s % n];
      var avg = feedback * (cur + prev) * 0.5;
      ring[s % n] = avg;
      prev = cur;
      out[s] = cur;
    }
    pluckCache[key] = buf;
    pluckCacheKeys.push(key);
    if (pluckCacheKeys.length > MAX_PLUCK_CACHE) {
      delete pluckCache[pluckCacheKeys.shift()];
    }
    return buf;
  }

  /* 播放单根弦，并按乐器应用起音、滤波与琴体共鸣。 */
  function pluck(freq, when, volume, duration, group, variantSeed, instrument) {
    var peak = volume == null ? 0.3 : volume;
    if (!isFinite(peak) || peak <= 0) return null;
    var c = audioContext();
    var dur = duration || 1.6;
    var timbre = stringTimbre(instrument);
    var src = c.createBufferSource();
    src.buffer = pluckBuffer(freq, dur, timbre, variantSeed);
    /* 两点平均会增加约半个采样的环路延迟，用播放速率校正音高。 */
    var delaySamples = Math.max(2, Math.round(c.sampleRate / freq));
    var renderedFreq = c.sampleRate / (delaySamples + 0.5);
    var pitchUnit = variantSeed == null ? Math.random() : seededUnit(variantSeed + 2000);
    var humanize = 1 + (pitchUnit * 2 - 1) * 0.0008;
    src.playbackRate.setValueAtTime(freq / renderedFreq * humanize, when);
    var gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + timbre.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    var tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = timbre.cutoff;
    tone.Q.value = 0.7;
    var body = c.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = timbre.bodyFrequency;
    body.Q.value = 0.9;
    body.gain.value = timbre.bodyGain;
    src.connect(tone).connect(body).connect(gain).connect(c.destination);
    var voice = { source: src, gain: gain, when: when, duration: dur, peak: peak };
    if (group) {
      if (!activePlucks[group]) activePlucks[group] = [];
      activePlucks[group].push(voice);
    }
    trackSource(src, group, function () {
      var voices = activePlucks[group];
      if (!voices) return;
      var index = voices.indexOf(voice);
      if (index !== -1) voices.splice(index, 1);
      if (!voices.length) delete activePlucks[group];
    });
    src.start(when);
    src.stop(when + dur + 0.02);
    return src;
  }

  /* 按琴弦物理顺序逐根发声：下扫从粗弦到细弦，上扫反向。 */
  function strum(freqs, when, direction, volume, group, duration, variantSeed, instrument) {
    var dur = duration || 1.8;
    if (group) releasePlucks(group, when);
    var order = direction === 'up' ? freqs.slice().reverse() : freqs;
    var stringDelay = direction === 'up' ? STRUM_DELAY_UP : STRUM_DELAY_DOWN;
    for (var i = 0; i < order.length; i++) {
      var stringSeed = variantSeed == null ? null : variantSeed * 16 + i;
      pluck(order[i], when + i * stringDelay, volume == null ? 0.24 : volume, dur, group, stringSeed, instrument);
    }
  }

  /**
   * Play one strumming-pattern stroke.
   * @param {'D'|'U'|'x'|'-'} mark Stroke symbol.
   * @param {number} when AudioContext time.
   * @param {number} volume 0..1
   * @param {number[]} freqs Chord frequencies used for D/U strokes.
   * @param {boolean} accent Whether the stroke is accented.
   */
  function stroke(mark, when, volume, freqs, accent, group, variantSeed, duration, instrument) {
    var vol = (volume == null ? 0.6 : volume) * (accent ? 1 : 0.7);
    var timbre = stringTimbre(instrument);
    if (mark === 'D') {
      strum(freqs, when, 'down', 0.2 * vol + 0.06, group, duration || 0.9, variantSeed, instrument);
      noiseBurst(when, {
        from: timbre.downNoise.from, to: timbre.downNoise.to,
        duration: 0.09, gain: timbre.downNoise.gain * vol
      }, group, variantSeed);
    } else if (mark === 'U') {
      strum(freqs, when, 'up', 0.14 * vol + 0.05, group, duration || 0.9, variantSeed, instrument);
      noiseBurst(when, {
        from: timbre.upNoise.from, to: timbre.upNoise.to,
        duration: 0.07, gain: timbre.upNoise.gain * vol
      }, group, variantSeed);
    } else if (mark === 'x') {
      if (group) releasePlucks(group, when);
      noiseBurst(when, { from: 200, to: 1600, duration: 0.07, q: 0.7, gain: 0.3 * vol }, group, variantSeed);
    }
    /* '-' (rest) produces no sound: the hand keeps moving silently. */
  }

  global.MusicAudio = {
    context: audioContext,
    unlock: unlock,
    click: click,
    strum: strum,
    stroke: stroke,
    pluck: pluck,
    noiseBurst: noiseBurst,
    cancelGroup: cancelGroup
  };
})(window);
