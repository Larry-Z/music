/* 调音器：麦克风采集 + YIN 风格自相关基频检测 + 音准显示。
 * 检测全部在浏览器完成，Go 后端不参与音频处理。
 *
 * 交互约定：拨弦过程中显示实时音高；声音衰减到静音后，界面**锁定**这一次
 * 拨弦的最终音高并给出「偏高 / 偏低 / 音准正确」的结论，直到下一次拨弦。 */
(function (global) {
  'use strict';

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var IN_TUNE_CENTS = 5;
  var MAX_STRING_DISTANCE = 2;
  /* 连续多少帧没有识别到有效音高就认为这次拨弦结束（每帧约 60ms）。 */
  var SILENT_FRAMES = 4;
  /* 单次拨弦最多保留的采样数，用于求最终音高。 */
  var MAX_SAMPLES = 40;
  /* 实时显示取最近几次采样的中位数，抑制指针抖动。 */
  var LIVE_WINDOW = 3;
  /* 起音瞬间音高通常偏高，结算时丢掉前 30% 的采样。 */
  var ATTACK_SKIP = 0.3;

  /* 调弦预设：从最低弦到最高弦，[显示名, 音名, 八度]。 */
  var PRESETS = {
    guitar: {
      label: '吉他 · 标准调弦 EADGBE',
      strings: [['6弦 E', 'E', 2], ['5弦 A', 'A', 2], ['4弦 D', 'D', 3],
                ['3弦 G', 'G', 3], ['2弦 B', 'B', 3], ['1弦 E', 'E', 4]]
    },
    guitarDropD: {
      label: '吉他 · Drop D (DADGBE)',
      strings: [['6弦 D', 'D', 2], ['5弦 A', 'A', 2], ['4弦 D', 'D', 3],
                ['3弦 G', 'G', 3], ['2弦 B', 'B', 3], ['1弦 E', 'E', 4]]
    },
    guitarHalfDown: {
      label: '吉他 · 降半音 (D#G#C#F#A#D#)',
      strings: [['6弦 D#', 'D#', 2], ['5弦 G#', 'G#', 2], ['4弦 C#', 'C#', 3],
                ['3弦 F#', 'F#', 3], ['2弦 A#', 'A#', 3], ['1弦 D#', 'D#', 4]]
    },
    ukulele: {
      label: '尤克里里 · 标准调弦 GCEA',
      strings: [['4弦 G', 'G', 4], ['3弦 C', 'C', 4], ['2弦 E', 'E', 4], ['1弦 A', 'A', 4]]
    },
    ukuleleLowG: {
      label: '尤克里里 · Low G (GCEA)',
      strings: [['4弦 G', 'G', 3], ['3弦 C', 'C', 4], ['2弦 E', 'E', 4], ['1弦 A', 'A', 4]]
    },
    baritone: {
      label: '尤克里里 · 中音 Baritone DGBE',
      strings: [['4弦 D', 'D', 3], ['3弦 G', 'G', 3], ['2弦 B', 'B', 3], ['1弦 E', 'E', 4]]
    }
  };

  var state = {
    running: false,
    starting: false,
    requestID: 0,
    stream: null,
    source: null,
    analyser: null,
    buffer: null,
    timer: null,
    preset: 'guitar',
    mode: 'auto',
    refA: 440,
    lastHit: -1,
    /* 当前这一次拨弦已采集的读数。 */
    samples: [],
    /* 连续未识别到音高的帧数。 */
    silentFrames: 0,
    /* 是否正处于一次拨弦中。 */
    sessionActive: false,
    /* 本次拨弦结算后的结论。 */
    verdict: null,
    verdictListening: false
  };

  var el = {};

  function midiToFreq(midi, refA) {
    return refA * Math.pow(2, (midi - 69) / 12);
  }

  function freqToNote(freq, refA) {
    var midi = 69 + 12 * Math.log2(freq / refA);
    var rounded = Math.round(midi);
    return {
      midi: rounded,
      cents: (midi - rounded) * 100,
      name: NOTE_NAMES[((rounded % 12) + 12) % 12],
      octave: Math.floor(rounded / 12) - 1
    };
  }

  function labelFor(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  function median(values) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * YIN 风格基频检测：累积均值归一化差值函数 + 抛物线插值。
   * 复杂度 O(n * maxLag)，对 4096 采样点足够实时。
   * @returns {{freq:number, clarity:number, rms:number}}
   */
  function detectPitch(buf, sampleRate, fmin, fmax) {
    var n = buf.length;
    var rms = 0;
    for (var i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.008) return { freq: -1, clarity: 0, rms: rms };

    var tauMin = Math.max(2, Math.floor(sampleRate / fmax));
    var tauMax = Math.min(n - 2, Math.ceil(sampleRate / fmin));
    if (tauMax <= tauMin) return { freq: -1, clarity: 0, rms: rms };

    var window = n - tauMax;
    var d = new Float32Array(tauMax + 1);
    for (var tau = tauMin; tau <= tauMax; tau++) {
      var sum = 0;
      for (var j = 0; j < window; j++) {
        var diff = buf[j] - buf[j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }

    var cmnd = new Float32Array(tauMax + 1);
    cmnd[tauMin] = 1;
    var running = d[tauMin];
    for (var t = tauMin + 1; t <= tauMax; t++) {
      running += d[t];
      cmnd[t] = running > 0 ? d[t] * (t - tauMin + 1) / running : 1;
    }

    var threshold = 0.15;
    var tauEst = -1;
    for (var k = tauMin + 1; k <= tauMax; k++) {
      if (cmnd[k] < threshold) {
        while (k + 1 <= tauMax && cmnd[k + 1] < cmnd[k]) k++;
        tauEst = k;
        break;
      }
    }

    var clarity;
    if (tauEst === -1) {
      var best = Infinity;
      for (var m = tauMin + 1; m <= tauMax; m++) {
        if (cmnd[m] < best) { best = cmnd[m]; tauEst = m; }
      }
      clarity = 1 - best;
      if (clarity < 0.35) return { freq: -1, clarity: clarity, rms: rms };
    } else {
      clarity = 1 - cmnd[tauEst];
    }

    /* 抛物线插值，把周期精度提升到亚采样点级别。 */
    var x0 = cmnd[tauEst - 1], x1 = cmnd[tauEst];
    var x2 = tauEst + 1 <= tauMax ? cmnd[tauEst + 1] : x1;
    var denom = 2 * (2 * x1 - x2 - x0);
    var refined = denom !== 0 ? tauEst + (x2 - x0) / denom : tauEst;

    var freq = sampleRate / refined;
    if (freq < fmin || freq > fmax) return { freq: -1, clarity: clarity, rms: rms };
    return { freq: freq, clarity: clarity, rms: rms };
  }

  function currentPreset() {
    return PRESETS[state.preset] || PRESETS.guitar;
  }

  function presetMidi(string) {
    return 12 * (string[2] + 1) + NOTE_NAMES.indexOf(string[1]);
  }

  function renderStrings(activeIndex) {
    var strings = currentPreset().strings;
    var html = '';
    for (var i = 0; i < strings.length; i++) {
      var cls = 'string-pill';
      if (i === activeIndex) cls += ' is-hit';
      else if (state.mode === 'string' && i === state.lastHit) cls += ' is-target';
      html += '<div class="' + cls + '"><span class="sp-note">' + strings[i][0] +
        '</span><span class="sp-label">' + strings[i][1] + strings[i][2] + '</span></div>';
    }
    el.strings.innerHTML = html;
  }

  function setStatus(text, cls) {
    el.status.textContent = text;
    el.status.className = 'tuner-status ' + (cls || 'idle');
  }

  function setDisplayClass(cls) {
    el.display.className = 'tuner-display' + (cls ? ' ' + cls : '');
  }

  function setVerdict(html, cls) {
    el.verdict.className = 'tuner-verdict' + (cls ? ' ' + cls : '');
    el.verdict.innerHTML = html;
  }

  /* 未开始 / 已停止 / 换预设时复位整个读数区。 */
  function resetReadout() {
    state.lastHit = -1;
    el.note.textContent = '--';
    el.freq.textContent = '-- Hz';
    el.cents.textContent = '-- 音分';
    el.needle.style.left = '50%';
    setDisplayClass('');
    setStatus(state.running ? '聆听中…请拨动一根琴弦' : '等待开始', 'idle');
    setVerdict('', '');
    renderStrings(-1);
    state.samples = [];
    state.silentFrames = 0;
    state.sessionActive = false;
    state.verdict = null;
    state.verdictListening = false;
  }

  /**
   * 把一次检测结果换算成「相对某个目标音的音分偏差」。
   * 自动模式的目标音是最近的十二平均律音；按弦模式的目标音是最近的预设弦。
   */
  function readingFor(freq, clarity) {
    var preset = currentPreset();
    var refA = state.refA;
    var note = freqToNote(freq, refA);

    if (state.mode !== 'string') {
      return {
        refMidi: note.midi, cents: note.cents, freq: freq, clarity: clarity,
        stringIndex: -1, farOff: false
      };
    }

    var bestDist = Infinity;
    var targetIndex = 0;
    for (var i = 0; i < preset.strings.length; i++) {
      var candidateMidi = presetMidi(preset.strings[i]);
      var candidateFreq = midiToFreq(candidateMidi, refA);
      var diff = Math.abs(12 * Math.log2(freq / candidateFreq));
      if (diff < bestDist) { bestDist = diff; targetIndex = i; }
    }
    var targetMidi = presetMidi(preset.strings[targetIndex]);
    var targetFreq = midiToFreq(targetMidi, refA);
    return {
      refMidi: targetMidi,
      cents: 1200 * Math.log2(freq / targetFreq),
      freq: freq,
      clarity: clarity,
      stringIndex: targetIndex,
      farOff: bestDist >= MAX_STRING_DISTANCE
    };
  }

  /* 把一组音分/频率画到界面上，实时与结算共用同一套呈现。 */
  function paint(label, freq, cents, stringIndex, farOff) {
    el.note.textContent = label;
    el.freq.textContent = freq.toFixed(1) + ' Hz';
    el.cents.textContent = (cents >= 0 ? '+' : '') + cents.toFixed(0) + ' 音分';
    el.needle.style.left = Math.max(0, Math.min(100, 50 + cents)) + '%';

    if (farOff) {
      setDisplayClass('');
      setStatus('偏离所选调弦较远，请检查弦或切换到自动识别', 'idle');
    } else if (Math.abs(cents) <= IN_TUNE_CENTS) {
      setDisplayClass('is-in-tune');
      setStatus('✓ ' + label + ' 音准正确', 'ok');
    } else if (cents < 0) {
      setDisplayClass('is-flat');
      setStatus('◀ 偏低 · 请把弦调紧（' + Math.abs(cents).toFixed(0) + ' 音分）', 'flat');
    } else {
      setDisplayClass('is-sharp');
      setStatus('偏高 · 请把弦调松 ▶（' + cents.toFixed(0) + ' 音分）', 'sharp');
    }
    renderStrings(stringIndex);
  }

  /* 实时显示取最近几次同目标音的采样中位数。 */
  function smoothedCents(reading) {
    var values = [];
    for (var i = state.samples.length - 1; i >= 0 && values.length < LIVE_WINDOW; i--) {
      if (state.samples[i].refMidi === reading.refMidi) values.push(state.samples[i].cents);
    }
    if (!values.length) values.push(reading.cents);
    return median(values);
  }

  function pushSample(reading) {
    var last = state.samples[state.samples.length - 1];
    /* 换了另一根弦：清空缓冲，重新开始计一次拨弦。 */
    if (last && Math.abs(last.refMidi - reading.refMidi) >= 2 && reading.clarity >= 0.7) {
      state.samples = [];
    }
    state.samples.push(reading);
    if (state.samples.length > MAX_SAMPLES) state.samples.shift();
    state.sessionActive = true;
    state.silentFrames = 0;
  }

  /**
   * 声音衰减结束：结算这一次拨弦。
   * 取样本中出现最多的目标音，丢掉起音段，用余下采样的中位数作为最终音高。
   */
  function finalizeSession() {
    state.sessionActive = false;
    state.verdictListening = false;
    var samples = state.samples;
    state.samples = [];
    if (!samples.length) return;

    var counts = {};
    var refMidi = samples[samples.length - 1].refMidi;
    var bestCount = 0;
    for (var i = 0; i < samples.length; i++) {
      var key = samples[i].refMidi;
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > bestCount) { bestCount = counts[key]; refMidi = key; }
    }

    var subset = samples.filter(function (s) {
      return s.refMidi === refMidi && s.clarity >= 0.5;
    });
    if (!subset.length) return;
    if (subset.length >= 4) subset = subset.slice(Math.floor(subset.length * ATTACK_SKIP));

    var cents = median(subset.map(function (s) { return s.cents; }));
    var freq = median(subset.map(function (s) { return s.freq; }));
    var last = subset[subset.length - 1];
    var label = labelFor(refMidi);

    state.verdict = {
      label: label, refMidi: refMidi, cents: cents, freq: freq,
      stringIndex: last.stringIndex, farOff: last.farOff
    };
    state.lastHit = last.stringIndex;

    /* 冻结读数：界面保持这次拨弦的最终音高，不再归零。 */
    paint(label, freq, cents, last.stringIndex, last.farOff);

    if (last.farOff) {
      setVerdict('<span class="v-badge">本次拨弦</span>音高偏离所选调弦较远，请确认琴弦或切换到自动识别', '');
    } else if (Math.abs(cents) <= IN_TUNE_CENTS) {
      setVerdict('<span class="v-badge">本次拨弦</span>' + label + ' 音准正确 ✓', 'ok');
    } else if (cents < 0) {
      setVerdict('<span class="v-badge">本次拨弦</span>' + label + ' 偏低 ' +
        Math.abs(cents).toFixed(0) + ' 音分 · 请把弦调紧 ◀', 'flat');
    } else {
      setVerdict('<span class="v-badge">本次拨弦</span>' + label + ' 偏高 ' +
        cents.toFixed(0) + ' 音分 · 请把弦调松 ▶', 'sharp');
    }
  }

  function markListening() {
    if (state.verdictListening) return;
    state.verdictListening = true;
    setVerdict('<span class="v-badge">实时</span>拾音中…拨弦结束后显示本次音高结论', 'is-listening');
  }

  /* 检测范围：最低弦向下留 3 个半音，最高弦向上留 5 个半音。 */
  function detectRange() {
    var midis = currentPreset().strings.map(presetMidi);
    return {
      fmin: midiToFreq(Math.min.apply(null, midis) - 3, state.refA) * 0.9,
      fmax: midiToFreq(Math.max.apply(null, midis) + 5, state.refA) * 1.1
    };
  }

  /* 分析当前这一帧音频（供帧循环与自动化验证复用）。 */
  function analyze() {
    if (!state.analyser) return;
    state.analyser.getFloatTimeDomainData(state.buffer);
    var range = detectRange();
    var result = detectPitch(state.buffer, state.analyser.context.sampleRate, range.fmin, range.fmax);

    if (result.freq > 0 && result.clarity > 0.5) {
      var reading = readingFor(result.freq, result.clarity);
      pushSample(reading);
      markListening();
      paint(labelFor(reading.refMidi), reading.freq, smoothedCents(reading),
        reading.stringIndex, reading.farOff);
      return;
    }

    /* 连续若干帧没有有效音高 → 认为这次拨弦已经结束，给出结论并冻结读数。 */
    state.silentFrames++;
    if (state.silentFrames >= SILENT_FRAMES && state.sessionActive) finalizeSession();
  }

  function frame() {
    if (!state.running) return;
    analyze();
    state.timer = global.setTimeout(frame, 60);
  }

  function start() {
    if (state.running || state.starting) return;
    var c;
    try {
      c = global.MusicAudio.unlock();
    } catch (e) {
      setStatus('浏览器不支持 Web Audio API', 'idle');
      return;
    }
    if (!global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia) {
      setStatus('无法访问麦克风：需要 HTTPS 或 localhost 环境', 'idle');
      return;
    }
    state.starting = true;
    state.requestID++;
    var requestID = state.requestID;
    el.toggle.textContent = '取消请求';
    el.toggle.classList.add('is-running');
    setStatus('正在请求麦克风权限…', 'idle');
    global.navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    }).then(function (stream) {
      if (!state.starting || requestID !== state.requestID) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      var source;
      var analyser;
      try {
        source = c.createMediaStreamSource(stream);
        analyser = c.createAnalyser();
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
      } catch (err) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        throw err;
      }
      state.stream = stream;
      state.source = source;
      state.analyser = analyser;
      state.buffer = new Float32Array(analyser.fftSize);
      state.starting = false;
      state.running = true;
      el.toggle.textContent = '停止聆听';
      el.toggle.classList.add('is-running');
      setStatus('聆听中…请拨动一根琴弦', 'idle');
      frame();
    }).catch(function (err) {
      if (requestID !== state.requestID) return;
      state.starting = false;
      el.toggle.textContent = '开始聆听';
      el.toggle.classList.remove('is-running');
      setStatus('麦克风不可用：' + (err && err.message ? err.message : err), 'idle');
    });
  }

  function stop() {
    state.requestID++;
    state.starting = false;
    state.running = false;
    if (state.timer) { global.clearTimeout(state.timer); state.timer = null; }
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
    if (state.source) {
      try { state.source.disconnect(); } catch (e) { /* 已断开 */ }
      state.source = null;
    }
    state.analyser = null;
    state.buffer = null;
    el.toggle.textContent = '开始聆听';
    el.toggle.classList.remove('is-running');
    resetReadout();
  }

  function init() {
    el.display = document.getElementById('tuner-display');
    el.note = document.getElementById('tuner-note');
    el.freq = document.getElementById('tuner-freq');
    el.cents = document.getElementById('tuner-cents');
    el.needle = document.getElementById('tuner-needle');
    el.status = document.getElementById('tuner-status');
    el.verdict = document.getElementById('tuner-verdict');
    el.strings = document.getElementById('tuner-strings');
    el.toggle = document.getElementById('tuner-toggle');
    var presetSelect = document.getElementById('tuner-preset');
    var modeSelect = document.getElementById('tuner-mode');
    var refInput = document.getElementById('tuner-ref');

    Object.keys(PRESETS).forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PRESETS[key].label;
      presetSelect.appendChild(opt);
    });
    presetSelect.value = state.preset;

    presetSelect.addEventListener('change', function () {
      state.preset = presetSelect.value;
      state.lastHit = -1;
      resetReadout();
    });
    modeSelect.addEventListener('change', function () {
      state.mode = modeSelect.value;
      state.lastHit = -1;
      resetReadout();
    });
    refInput.addEventListener('change', function () {
      var v = parseFloat(refInput.value);
      state.refA = (isFinite(v) && v >= 415 && v <= 466) ? v : 440;
      refInput.value = state.refA;
      resetReadout();
    });
    el.toggle.addEventListener('click', function () {
      if (state.running || state.starting) stop(); else start();
    });
    global.addEventListener('pagehide', stop);

    resetReadout();
  }

  global.Tuner = {
    init: init,
    stop: stop,
    /* 导出给自动化验证复用：analyze 跑一帧检测，state 暴露内部状态。 */
    analyze: analyze,
    state: state,
    detectPitch: detectPitch,
    freqToNote: freqToNote,
    midiToFreq: midiToFreq,
    labelFor: labelFor,
    presets: PRESETS
  };
})(window);
