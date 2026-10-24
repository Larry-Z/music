/* 共用音频原语：节拍器点击音、带琴体响应的拨弦模型与扫弦，无外部音频素材。 */
(function (global) {
  'use strict';

  var ctx = null;
  var scheduled = {};
  var activePlucks = {};
  var STRING_TIMBRES = {
    guitar: {
      key: 'guitar', loss: 0.18, decay60: 3.6, spectralSlope: 1.05,
      pickPosition: 0.17, attack: 0.0015, contact: 0.006, contactGain: 0.11,
      downDelay: 0.012, upDelay: 0.008, highpass: 35,
      body: [[105, 3.5, 1.1], [205, 2.5, 0.9], [430, 1.5, 1.1], [950, -2, 0.8]]
    },
    ukulele: {
      key: 'ukulele', loss: 0.32, decay60: 1.65, spectralSlope: 1.45,
      pickPosition: 0.24, attack: 0.0025, contact: 0.004, contactGain: 0.065,
      downDelay: 0.009, upDelay: 0.006, highpass: 90,
      body: [[270, 4, 1.1], [540, 2.5, 0.9], [1100, -2, 0.8]]
    }
  };
  var STRUM_TIMBRES = {};
  Object.keys(STRING_TIMBRES).forEach(function (key) {
    var original = STRING_TIMBRES[key];
    ['plain', 'down', 'up'].forEach(function (direction) {
      [false, true].forEach(function (light) {
        var timbre = {};
        Object.keys(original).forEach(function (field) { timbre[field] = original[field]; });
        timbre.key = key + '-' + direction + (light ? '-light' : '');
        if (direction === 'down') {
          /* 下扫更饱满，触弦高频稍圆润，保留低弦与琴体的厚度。 */
          timbre.pickPosition += 0.025;
          timbre.spectralSlope += 0.12;
        } else if (direction === 'up') {
          /* 上扫采用更短的轻触与较明亮的泛音，低频琴体成分减少。 */
          timbre.pickPosition *= 0.62;
          timbre.spectralSlope -= 0.2;
          timbre.contact *= 0.55;
          timbre.contactGain *= 0.85;
          timbre.attack *= 0.75;
          timbre.highpass = key === 'guitar' ? 140 : 220;
          timbre.body = original.body.map(function (mode) {
            return [mode[0], mode[1] > 0 ? mode[1] * 0.3 : mode[1], mode[2]];
          });
        }
        if (light) {
          timbre.pickPosition += 0.04;
          timbre.spectralSlope += 0.3;
          timbre.contactGain *= 0.55;
        }
        STRUM_TIMBRES[timbre.key] = timbre;
      });
    });
  });

  function stringTimbre(instrument, light, direction) {
    var base = STRING_TIMBRES[instrument] || STRING_TIMBRES.guitar;
    if (!light && !direction) return base;
    return STRUM_TIMBRES[base.key + '-' + (direction || 'plain') + (light ? '-light' : '')];
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

  /* 新一次触弦接管旧弦，保留短暂共鸣；闷音使用更快的释放。 */
  function releasePlucks(group, when, releaseSeconds, retainFreqs, stringIndex) {
    var voices = activePlucks[group];
    if (!voices || !voices.length) return;
    delete activePlucks[group];
    for (var i = 0; i < voices.length; i++) {
      var voice = voices[i];
      /* 每根弦在实际触弦时刻接管，同组其他弦继续共鸣。 */
      if (stringIndex != null && voice.stringIndex !== stringIndex) {
        if (!activePlucks[group]) activePlucks[group] = [];
        activePlucks[group].push(voice);
        continue;
      }
      /* 换和弦时仍在新指法中的旧音保留，随后按弦接管。 */
      if (retainFreqs && retainFreqs.indexOf(voice.freq) !== -1 && voice.when < when) {
        if (!activePlucks[group]) activePlucks[group] = [];
        activePlucks[group].push(voice);
        continue;
      }
      var gainParam = voice.gain.gain;
      try {
        /* 尚未起音的旧弦直接取消，避免释放包络把它重新拉响。 */
        if (voice.when >= when) {
          gainParam.cancelScheduledValues(when);
          gainParam.setValueAtTime(0, when);
          voice.source.stop(when);
          continue;
        }
        if (gainParam.cancelAndHoldAtTime) {
          gainParam.cancelAndHoldAtTime(when);
        } else {
          var elapsed = Math.max(0, when - voice.when);
          var level = voice.peak;
          if (elapsed < voice.attack) level = voice.peak * elapsed / voice.attack;
          else if (elapsed > voice.duration - 0.06) {
            level *= Math.max(0, 1 - (elapsed - voice.duration + 0.06) / 0.06);
          }
          gainParam.cancelScheduledValues(when);
          gainParam.setValueAtTime(Math.max(level, 0.0001), when);
        }
        var release = releaseSeconds || 0.035;
        gainParam.linearRampToValueAtTime(0, when + release);
        voice.source.stop(when + release + 0.01);
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

  /* 拨弦缓冲：触弦位置决定泛音，反馈损耗决定延音，琴体滤波决定共鸣。 */
  var pluckCache = {};
  var pluckCacheKeys = [];
  var pluckVariantCursor = {};
  var PLUCK_VARIANTS = 4;
  var MAX_PLUCK_CACHE = 48;

  function bodyFilter(mode, rate) {
    var a = Math.pow(10, mode[1] / 40);
    var omega = 2 * Math.PI * mode[0] / rate;
    var alpha = Math.sin(omega) / (2 * mode[2]);
    var denom = 1 + alpha / a;
    return { b0: (1 + alpha * a) / denom, b1: -2 * Math.cos(omega) / denom,
      b2: (1 - alpha * a) / denom, a1: -2 * Math.cos(omega) / denom,
      a2: (1 - alpha / a) / denom, x1: 0, x2: 0, y1: 0, y2: 0 };
  }

  function bodySample(filter, value) {
    var output = filter.b0 * value + filter.b1 * filter.x1 + filter.b2 * filter.x2 -
      filter.a1 * filter.y1 - filter.a2 * filter.y2;
    filter.x2 = filter.x1; filter.x1 = value;
    filter.y2 = filter.y1; filter.y1 = output;
    return output;
  }

  function pluckBuffer(freq, seconds, timbre, variantSeed) {
    var c = audioContext();
    var rate = c.sampleRate;
    var baseKey = rate + '/' + Math.round(freq * 100) + '/' + seconds + '/' + timbre.key;
    var cursor = pluckVariantCursor[baseKey] || 0;
    var variant = variantSeed == null ? cursor % PLUCK_VARIANTS : Math.floor(seededUnit(variantSeed + 127) * PLUCK_VARIANTS);
    if (variantSeed == null) pluckVariantCursor[baseKey] = cursor + 1;
    var key = baseKey + '/' + variant;
    if (pluckCache[key]) return pluckCache[key];
    var n = Math.max(2, Math.round(rate / freq));
    var len = Math.ceil(rate * seconds);
    var buf = c.createBuffer(1, len, rate);
    var out = buf.getChannelData(0);
    var ring = new Float32Array(n);
    var position = timbre.pickPosition + (seededUnit(variant + 41) - 0.5) * 0.04;
    var harmonics = Math.min(48, Math.floor(n / 2) - 1);
    var phase = seededUnit(variant + 83) * 2 * Math.PI;
    for (var h = 1; h <= harmonics; h++) {
      /* 触弦点处的节点会削弱对应泛音；钢弦保留更多高频，尼龙弦更圆润。 */
      var amplitude = Math.sin(Math.PI * h * position) / Math.pow(h, timbre.spectralSlope);
      amplitude *= 0.92 + seededUnit(variant * 97 + h) * 0.16;
      for (var i = 0; i < n; i++) ring[i] += amplitude * Math.sin(2 * Math.PI * h * i / n + phase);
    }
    var energy = 0, mean = 0;
    for (var r = 0; r < n; r++) { energy += ring[r] * ring[r]; mean += ring[r]; }
    mean /= n;
    var scale = 0.24 / Math.max(0.001, Math.sqrt(energy / n));
    for (var m = 0; m < n; m++) ring[m] = (ring[m] - mean) * scale;

    /* 每周期的损耗按目标衰减时间计算，避免不同音高的延音完全失衡。 */
    var decay = timbre.decay60 * Math.pow(220 / freq, 0.15);
    var feedback = Math.pow(0.001, 1 / (freq * decay));
    var prev = ring[n - 1];
    var filters = timbre.body.map(function (mode) { return bodyFilter(mode, rate); });
    var hp = Math.exp(-2 * Math.PI * timbre.highpass / rate);
    var lastInput = 0, lastOutput = 0;
    var noiseState = 12345 + variant * 7919;
    var noisePrevious = 0;
    for (var s = 0; s < len; s++) {
      var cur = ring[s % n];
      var avg = feedback * (cur * (1 - timbre.loss) + prev * timbre.loss);
      ring[s % n] = avg;
      prev = cur;
      var value = cur;
      /* 数毫秒的触弦声随每根弦起音，代替贯穿整次扫弦的长噪声。 */
      if (s < rate * timbre.contact * 7) {
        noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
        var noise = noiseState / 2147483648 - 1;
        var contact = (noise - noisePrevious) * 0.5;
        noisePrevious = noise;
        value += contact * timbre.contactGain * Math.exp(-s / (rate * timbre.contact));
      }
      for (var b = 0; b < filters.length; b++) value = bodySample(filters[b], value);
      var highpassed = hp * (lastOutput + value - lastInput);
      lastInput = value; lastOutput = highpassed;
      out[s] = highpassed;
    }
    pluckCache[key] = buf;
    pluckCacheKeys.push(key);
    if (pluckCacheKeys.length > MAX_PLUCK_CACHE) {
      delete pluckCache[pluckCacheKeys.shift()];
    }
    return buf;
  }

  /* 播放单根弦，并按乐器应用起音、滤波与琴体共鸣。 */
  function pluck(freq, when, volume, duration, group, variantSeed, instrument, touch) {
    var peak = volume == null ? 0.3 : volume;
    if (!isFinite(peak) || peak <= 0) return null;
    var c = audioContext();
    var dur = Math.max(0.1, duration || (instrument === 'ukulele' ? 1.7 : 2.6));
    var timbre = stringTimbre(instrument, touch && touch.light, touch && touch.direction);
    var src = c.createBufferSource();
    src.buffer = pluckBuffer(freq, dur, timbre, variantSeed);
    /* 反馈低通增加少量环路延迟，用播放速率校正音高。 */
    var delaySamples = Math.max(2, Math.round(c.sampleRate / freq));
    var renderedFreq = c.sampleRate / (delaySamples + timbre.loss);
    var pitchUnit = variantSeed == null ? Math.random() : seededUnit(variantSeed + 2000);
    var humanize = 1 + (pitchUnit * 2 - 1) * 0.0003;
    var tunedRate = freq / renderedFreq * humanize;
    src.playbackRate.setValueAtTime(tunedRate * (instrument === 'ukulele' ? 1.0005 : 1.0012), when);
    src.playbackRate.exponentialRampToValueAtTime(tunedRate, when + 0.075);
    var gain = c.createGain();
    var attack = touch && touch.light ? timbre.attack * 1.7 : timbre.attack;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    /* 延音由琴弦反馈损耗控制，增益只负责起音和末尾淡出，避免重复衰减。 */
    gain.gain.setValueAtTime(peak, when + dur - 0.06);
    gain.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(gain).connect(c.destination);
    var voice = { source: src, gain: gain, when: when, duration: dur, peak: peak, attack: attack,
      freq: freq, stringIndex: touch ? touch.stringIndex : null };
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
  function strum(freqs, when, direction, volume, group, duration, variantSeed, instrument, stepDuration, articulation) {
    var timbre = stringTimbre(instrument);
    var dur = duration || (instrument === 'ukulele' ? 1.7 : 2.6);
    var order = direction === 'up' ? freqs.slice().reverse() : freqs;
    if (direction === 'up') {
      var touched = Math.min(order.length, instrument === 'ukulele' ? 3 : 4);
      order = order.slice(0, touched);
    }
    /* 换和弦先收住不属于新指法的旧音，其余弦按触弦顺序接管。 */
    if (group) releasePlucks(group, when, 0.025, freqs);
    var seed = variantSeed == null ? Math.floor(Math.random() * 100000) : variantSeed;
    var stringDelay = direction === 'up' ? timbre.upDelay : timbre.downDelay;
    var spread = stringDelay * Math.max(0, order.length - 1) * (0.9 + seededUnit(seed + 17) * 0.2);
    if (articulation && articulation.sixteenth) spread *= direction === 'up' ? 0.65 : 0.55;
    /* 快速细分时在一步前 65% 内扫完，为最后一根弦的起音留出时间。 */
    if (isFinite(stepDuration) && stepDuration > 0 && order.length > 1) {
      spread = Math.min(spread, stepDuration * 0.65);
    }
    var baseVolume = volume == null ? 0.24 : volume;
    var balance = Math.min(1, Math.sqrt(4 / Math.max(1, order.length)));
    var release = articulation && articulation.sixteenth ? 0.014 : 0.035;
    if (isFinite(stepDuration) && stepDuration > 0) release = Math.min(release, stepDuration * 0.22);
    for (var i = 0; i < order.length; i++) {
      var stringSeed = seed * 16 + i;
      var progress = order.length > 1 ? i / (order.length - 1) : 0;
      var contactTime = progress;
      if (i > 0 && i < order.length - 1) contactTime += (seededUnit(stringSeed + 31) - 0.5) * 0.14 / (order.length - 1);
      /* 上扫以高音弦为主，低音弦轻触；每次力度、弦间隔都有小幅变化。 */
      var weight = direction === 'up' ? 1 - progress * 0.65 : 1.12 - progress * 0.22;
      if (articulation && articulation.light && direction !== 'up') weight *= 0.65 + progress * 0.35;
      var strength = 0.92 + seededUnit(stringSeed + 73) * 0.16;
      var touchTime = when + contactTime * spread;
      var physicalIndex = direction === 'up' ? freqs.length - 1 - i : i;
      if (group) releasePlucks(group, touchTime, release, null, physicalIndex);
      pluck(order[i], touchTime, baseVolume * balance * weight * strength, dur, group, stringSeed, instrument,
        { stringIndex: physicalIndex, light: articulation && articulation.light, direction: direction === 'up' ? 'up' : 'down' });
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
  function stroke(mark, when, volume, freqs, accent, group, variantSeed, duration, instrument, stepDuration, timing) {
    var vol = (volume == null ? 0.6 : volume) * (accent ? 1 : 0.7);
    var sixteenth = timing ? timing.subdivision === 4 : isFinite(stepDuration) && stepDuration <= 0.125;
    var position = timing ? timing.position : Math.abs(variantSeed || 0) % 4;
    var light = sixteenth && !accent;
    if (sixteenth && !accent) vol *= [0.88, 0.68, 0.82, 0.62][position % 4];
    var articulation = { sixteenth: sixteenth, light: light };
    if (mark === 'D') {
      strum(freqs, when, 'down', 0.32 * vol, group, duration, variantSeed, instrument, stepDuration, articulation);
    } else if (mark === 'U') {
      strum(freqs, when, 'up', 0.26 * vol, group, duration, variantSeed, instrument, stepDuration, articulation);
    } else if (mark === 'x') {
      if (group) releasePlucks(group, when, 0.012);
      noiseBurst(when, { from: 350, to: 1200, duration: 0.045, q: 0.7, gain: 0.28 * vol }, group, variantSeed);
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
