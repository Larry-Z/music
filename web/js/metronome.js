/* 节拍器：前瞻式（lookahead）调度，避免 setInterval 抖动。
 * 同时导出 createClock，供节奏训练器复用同一套时钟。 */
(function (global) {
  'use strict';

  var LOOKAHEAD_MS = 25;      /* 调度器轮询间隔 */
  var SCHEDULE_AHEAD = 0.12;  /* 提前排程的音频时间窗口（秒） */
  var MIN_STEP_SECONDS = 0.05;
  var MAX_STEPS_PER_TICK = Math.ceil(SCHEDULE_AHEAD / MIN_STEP_SECONDS) + 1;
  var BPM_STORAGE_KEY = 'music.metronome.bpm';

  /**
   * 通用步进时钟。
   * @param {object} opts
   *   opts.secondsPerStep() -> number  每一步的时长
   *   opts.onStep(step, time, duration) 在音频时间 time 播放第 step 步
   *   opts.onSkip(skipped)              可选，跳过漏拍后清理声音与 UI
   */
  function createClock(opts) {
    var timer = null;
    var nextTime = 0;
    var step = 0;
    var clock = { running: false, step: 0 };

    function stepDuration() {
      var duration = opts.secondsPerStep();
      return isFinite(duration) ? Math.max(MIN_STEP_SECONDS, duration) : MIN_STEP_SECONDS;
    }

    function tick() {
      if (!clock.running) return;
      var c = global.MusicAudio.context();
      var horizon = c.currentTime + SCHEDULE_AHEAD;
      var attempts = 0;
      while (clock.running && nextTime < horizon && attempts < MAX_STEPS_PER_TICK) {
        attempts++;
        var duration = stepDuration();
        var now = c.currentTime;
        /* 卡顿后直接跳到尚未过期的步骤，保持拍位，不集中补播漏拍。 */
        if (nextTime < now) {
          var skipped = Math.ceil((now - nextTime) / duration);
          nextTime += skipped * duration;
          step += skipped;
          clock.step = step;
          if (opts.onSkip) opts.onSkip(skipped);
          continue;
        }
        opts.onStep(step, nextTime, duration);
        nextTime += duration;
        step++;
        clock.step = step;
      }
      if (clock.running) timer = global.setTimeout(tick, LOOKAHEAD_MS);
    }

    clock.start = function () {
      if (clock.running) return;
      var c = global.MusicAudio.unlock();
      clock.running = true;
      step = 0;
      clock.step = 0;
      nextTime = c.currentTime + 0.12;
      if (opts.onStart) opts.onStart();
      tick();
    };

    clock.stop = function () {
      if (timer) { global.clearTimeout(timer); timer = null; }
      clock.running = false;
      if (opts.onStop) opts.onStop();
    };

    return clock;
  }

  var NOTE_VALUES = { 2: '二分', 4: '四分', 8: '八分', 16: '十六分', 32: '三十二分', 64: '六十四分' };

  var state = {
    bpm: 75,
    beats: 4,
    unit: 4,
    subdivision: 1,
    accent: true,
    countIn: true,
    volume: 0.7,
    sound: 'click',
    countInSteps: 0,
    taps: []
  };

  var clock = null;
  var el = {};
  var uiTimer = null;
  /* 已排程但尚未响起的步骤，用于让视觉跟随音频。 */
  var pending = [];

  function stepsPerBar() { return state.beats * state.subdivision; }

  function secondsPerStep() {
    return 60 / state.bpm / state.subdivision;
  }

  function subdivisionLabel(unit, subdivision) {
    if (subdivision === 3) return '三连音';
    return (NOTE_VALUES[unit * subdivision] || (unit * subdivision) + ' 分') + '音符';
  }

  function renderSubdivisionLabels() {
    var nodes = el.subdiv.querySelectorAll('button[data-sub]');
    for (var i = 0; i < nodes.length; i++) {
      var sub = parseInt(nodes[i].dataset.sub, 10);
      nodes[i].textContent = subdivisionLabel(state.unit, sub).replace('音符', '');
      nodes[i].setAttribute('aria-pressed', sub === state.subdivision ? 'true' : 'false');
    }
  }

  function renderDots() {
    var html = '';
    for (var i = 0; i < state.beats; i++) {
      html += '<div class="beat-dot' + (i === 0 && state.accent ? ' is-accent' : '') +
        '" data-beat="' + i + '">' + (i + 1) + '</div>';
    }
    el.dots.innerHTML = html;
  }

  function renderReadout() {
    el.readout.textContent = state.bpm + ' BPM · ' + state.beats + '/' + state.unit +
      ' · ' + subdivisionLabel(state.unit, state.subdivision) + (state.accent ? ' · 首拍重音' : '');
  }

  function clearDots() {
    var nodes = el.dots.children;
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('is-beat', 'is-sub');
  }

  function onStep(step, time) {
    var inCountIn = step < state.countInSteps;
    var effective = inCountIn ? step : step - state.countInSteps;
    var beatIndex = Math.floor(effective / state.subdivision) % state.beats;
    var subIndex = effective % state.subdivision;
    var isDownbeat = subIndex === 0 && beatIndex === 0;
    var accent = state.accent && isDownbeat;
    /* 细分小节线：每个正拍（细分 0）都稍微加强，非首拍不重音。 */
    if (!inCountIn || subIndex === 0) {
      global.MusicAudio.click(time, accent, state.volume * (subIndex === 0 ? 1 : 0.72), state.sound, 'metronome');
    }
    if (inCountIn && subIndex !== 0) return;
    pending.push({
      step: effective,
      beatIndex: beatIndex,
      subIndex: subIndex,
      countIn: inCountIn,
      time: time
    });
  }

  function paintPending() {
    var c = global.MusicAudio.context();
    var now = c.currentTime;
    var last = null;
    while (pending.length && pending[0].time <= now) last = pending.shift();
    if (!last) return;
    clearDots();
    var node = el.dots.children[last.beatIndex];
    if (node) node.classList.add(last.subIndex === 0 ? 'is-beat' : 'is-sub');
    if (last.countIn) {
      el.readout.textContent = '预备拍 ' + (last.beatIndex + 1) + ' / ' + state.beats;
    } else {
      renderReadout();
    }
  }

  function buildClock() {
    if (clock) clock.stop();
    clock = createClock({
      secondsPerStep: secondsPerStep,
      onStep: onStep,
      onSkip: function () {
        global.MusicAudio.cancelGroup('metronome');
        pending = [];
        clearDots();
      },
      onStart: function () {
        pending = [];
        state.countInSteps = state.countIn ? stepsPerBar() : 0;
        if (uiTimer) global.clearInterval(uiTimer);
        uiTimer = global.setInterval(paintPending, 16);
      },
      onStop: function () {
        global.MusicAudio.cancelGroup('metronome');
        if (uiTimer) { global.clearInterval(uiTimer); uiTimer = null; }
        pending = [];
        clearDots();
        renderReadout();
      }
    });
  }

  function setBpm(value) {
    var v = Math.round(Number(value));
    if (!isFinite(v)) v = state.bpm;
    state.bpm = Math.min(260, Math.max(30, v));
    el.bpm.value = state.bpm;
    el.bpmSlider.value = state.bpm;
    renderReadout();
    try { global.localStorage.setItem(BPM_STORAGE_KEY, String(state.bpm)); } catch (e) { /* 禁用本地存储时忽略 */ }
  }

  function loadBpm() {
    try {
      var saved = global.localStorage.getItem(BPM_STORAGE_KEY);
      if (saved !== null && saved !== '') return saved;
    } catch (e) { /* 禁用本地存储时使用默认值 */ }
    return state.bpm;
  }

  function toggle() {
    if (!clock) buildClock();
    if (clock.running) {
      clock.stop();
      el.toggle.textContent = '开始';
      el.toggle.classList.remove('is-running');
    } else {
      global.MusicAudio.unlock();
      clock.start();
      el.toggle.textContent = '停止';
      el.toggle.classList.add('is-running');
    }
  }

  function tap() {
    var now = performance.now();
    if (state.taps.length && now - state.taps[state.taps.length - 1] > 2000) state.taps = [];
    state.taps.push(now);
    if (state.taps.length > 6) state.taps.shift();
    if (state.taps.length < 2) return;
    var total = state.taps[state.taps.length - 1] - state.taps[0];
    var avg = total / (state.taps.length - 1);
    if (avg > 0) setBpm(60000 / avg);
  }

  function init() {
    el.bpm = document.getElementById('metro-bpm');
    el.bpmSlider = document.getElementById('metro-bpm-slider');
    el.minus = document.getElementById('metro-minus');
    el.plus = document.getElementById('metro-plus');
    el.tap = document.getElementById('metro-tap');
    el.beats = document.getElementById('metro-beats');
    el.unit = document.getElementById('metro-unit');
    el.subdiv = document.getElementById('metro-subdiv');
    el.sound = document.getElementById('metro-sound');
    el.volume = document.getElementById('metro-volume');
    el.accent = document.getElementById('metro-accent');
    el.countIn = document.getElementById('metro-countin');
    el.dots = document.getElementById('metro-dots');
    el.readout = document.getElementById('metro-readout');
    el.toggle = document.getElementById('metro-toggle');

    for (var i = 1; i <= 12; i++) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = i + ' 拍';
      el.beats.appendChild(opt);
    }
    el.beats.value = state.beats;

    el.bpm.addEventListener('change', function () { setBpm(el.bpm.value); });
    el.bpmSlider.addEventListener('input', function () { setBpm(el.bpmSlider.value); });
    el.minus.addEventListener('click', function () { setBpm(state.bpm - 1); });
    el.plus.addEventListener('click', function () { setBpm(state.bpm + 1); });
    el.tap.addEventListener('click', tap);

    el.beats.addEventListener('change', function () {
      state.beats = parseInt(el.beats.value, 10) || 4;
      renderDots();
      renderReadout();
    });
    el.unit.addEventListener('change', function () {
      state.unit = parseInt(el.unit.value, 10) || 4;
      renderSubdivisionLabels();
      renderReadout();
    });
    el.subdiv.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-sub]');
      if (!btn) return;
      var nodes = el.subdiv.querySelectorAll('button');
      for (var k = 0; k < nodes.length; k++) nodes[k].classList.remove('is-active');
      btn.classList.add('is-active');
      state.subdivision = parseInt(btn.dataset.sub, 10);
      renderSubdivisionLabels();
      renderReadout();
    });
    el.sound.addEventListener('change', function () { state.sound = el.sound.value; });
    el.volume.addEventListener('input', function () {
      state.volume = parseInt(el.volume.value, 10) / 100;
    });
    el.accent.addEventListener('change', function () {
      state.accent = el.accent.checked;
      renderDots();
      renderReadout();
    });
    el.countIn.addEventListener('change', function () { state.countIn = el.countIn.checked; });
    el.toggle.addEventListener('click', toggle);

    document.addEventListener('keydown', function (ev) {
      if (ev.code !== 'Space' || ev.repeat) return;
      var tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'button' || tag === 'textarea') return;
      var panel = document.getElementById('panel-metronome');
      if (!panel.classList.contains('is-active')) return;
      ev.preventDefault();
      toggle();
    });

    setBpm(loadBpm());
    renderDots();
    renderSubdivisionLabels();
    renderReadout();
    buildClock();
  }

  /* 供其他面板调用：切换标签页时静默停止。 */
  function stopTransport() {
    if (clock && clock.running) {
      clock.stop();
      el.toggle.textContent = '开始';
      el.toggle.classList.remove('is-running');
    }
  }

  global.Metronome = {
    init: init,
    createClock: createClock,
    stop: stopTransport,
    state: state
  };
})(window);
