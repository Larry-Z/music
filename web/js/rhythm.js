/* 节奏训练器：从 /api/rhythms 拉取节奏型，用扫弦合成音播放。 */
(function (global) {
  'use strict';

  var BPM_STORAGE_KEY = 'music.rhythm.bpm';

  var state = {
    patterns: [],
    chords: [],
    instruments: [],
    legend: [],
    filter: 'all',
    selected: null,
    bpm: 75,
    chordIndex: 0
  };

  var clock = null;
  var pending = [];
  var uiTimer = null;
  var el = {};

  /* 把和弦指法换算成频率：按和弦自己的乐器调弦（尤克里里 4 弦 / 吉他 6 弦），
   * 复用和弦库的实现，避免两份调弦表不一致。 */
  function chordFreqs(chord) {
    return global.Chords.chordFreqs(chord);
  }

  function selectedChord() {
    return state.chords[state.chordIndex] || null;
  }

  function currentPattern() { return state.selected; }

  function totalSteps(p) { return p.beats * p.subdivision * p.bars; }

  function timeSignature(p) { return p.beats + '/' + p.unit; }

  function patternMatchesFilter(p) {
    return state.filter === 'all' || p.instrument === 'both' || p.instrument === state.filter;
  }

  function isAccent(p, step) {
    for (var i = 0; i < p.accents.length; i++) {
      if (p.accents[i] === step) return true;
    }
    return false;
  }

  function renderList() {
    var html = '';
    for (var i = 0; i < state.patterns.length; i++) {
      var p = state.patterns[i];
      if (!patternMatchesFilter(p)) continue;
      var cls = 'pattern-item' + (state.selected && state.selected.id === p.id ? ' is-active' : '');
      html += '<button class="' + cls + '" data-id="' + p.id + '">' +
        '<span class="pi-name">' + p.name + '</span>' +
        '<span class="pi-sub">' + timeSignature(p) + ' · ' + p.difficulty + ' · ' + instrumentLabel(p.instrument) +
        '</span></button>';
    }
    el.list.innerHTML = html || '<p class="muted">该分类下暂无节奏型</p>';
  }

  function instrumentLabel(v) {
    if (v === 'both') return '吉他 / 尤克里里';
    for (var i = 0; i < state.instruments.length; i++) {
      if (state.instruments[i].key === v) return state.instruments[i].label;
    }
    return v === 'guitar' ? '吉他' : v === 'ukulele' ? '尤克里里' : v;
  }

  function markClass(mark) {
    return mark === 'D' ? 'is-down' : mark === 'U' ? 'is-up' : mark === 'x' ? 'is-mute' : 'is-rest';
  }

  function markLabel(mark) {
    return mark === '-' ? '·' : mark === 'x' ? 'x' : mark;
  }

  function renderDetail() {
    var p = currentPattern();
    if (!p) return;
    el.title.textContent = p.name + (p.nameEn ? ' · ' + p.nameEn : '');
    el.desc.textContent = p.description;
    el.meta.innerHTML =
      '<span class="tag">拍号 ' + timeSignature(p) + '</span>' +
      '<span class="tag">细分 ' + subdivisionLabel(p.unit, p.subdivision) + '</span>' +
      '<span class="tag">' + p.bars + ' 小节</span>' +
      '<span class="tag">' + instrumentLabel(p.instrument) + '</span>' +
      '<span class="tag">' + p.difficulty + '</span>';

    var html = '';
    for (var s = 0; s < p.steps.length; s++) {
      var sub = s % p.subdivision;
      var cls = 'step ' + markClass(p.steps[s]);
      if (sub === 0) cls += ' is-beat-start';
      if (isAccent(p, s)) cls += ' is-accent';
      var beatIndex = Math.floor(s / p.subdivision) % p.beats + 1;
      var barIndex = Math.floor(s / (p.beats * p.subdivision)) + 1;
      if (sub === 0 && beatIndex === 1 && barIndex > 1) cls += ' is-bar-start';
      var beatLabel = p.bars > 1 ? barIndex + ':' + beatIndex : String(beatIndex);
      var label = sub === 0 ? beatLabel : beatLabel + '.' + sub;
      html += '<div class="' + cls + '" data-step="' + s + '">' +
        '<span class="s-mark">' + markLabel(p.steps[s]) + '</span>' +
        '<span class="s-idx">' + label + '</span></div>';
    }
    el.grid.innerHTML = html;
    el.toggle.disabled = compatibleChordIndexes().length === 0;
  }

  function subdivisionLabel(unit, sub) {
    if (sub === 3) return '三连音';
    return (unit * sub) + ' 分音符';
  }

  function renderLegend() {
    var html = '';
    for (var i = 0; i < state.legend.length; i++) {
      html += '<span><b>' + state.legend[i].symbol + '</b> ' + state.legend[i].label + '</span>';
    }
    el.legend.innerHTML = html;
  }

  function compatibleChordIndexes() {
    var p = currentPattern();
    var instrument = null;
    if (p && p.instrument !== 'both') instrument = p.instrument;
    else if (state.filter !== 'all') instrument = state.filter;
    var indexes = [];
    for (var i = 0; i < state.chords.length; i++) {
      if (!instrument || state.chords[i].instrument === instrument) indexes.push(i);
    }
    return indexes;
  }

  function renderChordOptions() {
    var html = '';
    var byInstrument = {};
    var order = [];
    var compatible = compatibleChordIndexes();
    var previous = selectedChord();
    for (var i = 0; i < compatible.length; i++) {
      var key = state.chords[compatible[i]].instrument;
      if (!byInstrument[key]) { byInstrument[key] = []; order.push(key); }
      byInstrument[key].push(compatible[i]);
    }
    for (var k = 0; k < order.length; k++) {
      var label = instrumentLabel(order[k]);
      html += '<optgroup label="' + label + '">';
      var groupIndexes = byInstrument[order[k]];
      for (var j = 0; j < groupIndexes.length; j++) {
        var c = state.chords[groupIndexes[j]];
        html += '<option value="' + groupIndexes[j] + '">' + c.name + '</option>';
      }
      html += '</optgroup>';
    }
    el.chord.innerHTML = html;
    var selectedIndex = -1;
    for (var m = 0; m < compatible.length; m++) {
      var candidate = state.chords[compatible[m]];
      if (previous && candidate.name === previous.name && candidate.instrument === previous.instrument) {
        selectedIndex = compatible[m];
        break;
      }
    }
    if (selectedIndex === -1) {
      var preferred = currentPattern() && currentPattern().instrument !== 'both' ? currentPattern().instrument : 'ukulele';
      for (var n = 0; n < compatible.length; n++) {
        var chord = state.chords[compatible[n]];
        if (chord.name === 'C' && chord.instrument === preferred) { selectedIndex = compatible[n]; break; }
      }
    }
    if (selectedIndex === -1 && compatible.length) selectedIndex = compatible[0];
    state.chordIndex = selectedIndex;
    el.chord.disabled = selectedIndex === -1;
    el.chord.value = String(state.chordIndex);
  }

  function setBpm(value) {
    var v = Math.round(Number(value));
    if (!isFinite(v)) v = state.bpm;
    state.bpm = Math.min(240, Math.max(30, v));
    el.bpm.value = state.bpm;
    el.bpmSlider.value = state.bpm;
    try { global.localStorage.setItem(BPM_STORAGE_KEY, String(state.bpm)); } catch (e) { /* 禁用本地存储时忽略 */ }
  }

  function loadBpm() {
    try {
      var saved = global.localStorage.getItem(BPM_STORAGE_KEY);
      if (saved !== null && saved !== '') return saved;
    } catch (e) { /* 禁用本地存储时使用默认值 */ }
    return state.bpm;
  }

  function secondsPerStep() {
    var p = currentPattern();
    var sub = p ? p.subdivision : 1;
    return 60 / state.bpm / sub;
  }

  /* 保留琴弦的自然共鸣；下一次扫弦会在音频层平滑接管上一组弦音。 */
  function strokeDuration(chord) {
    return chord.instrument === 'guitar' ? 1.8 : 1.4;
  }

  function onStep(step, time) {
    var p = currentPattern();
    if (!p) return;
    var steps = totalSteps(p);
    var effective = step % steps;
    var accent = isAccent(p, effective);
    var chord = selectedChord();
    if (chord) {
      global.MusicAudio.stroke(p.steps[effective], time, 0.75, chordFreqs(chord), accent,
        'rhythm', effective, strokeDuration(chord), chord.instrument);
    }
    pending.push({ step: effective, time: time });
  }

  function paintPending() {
    var now = global.MusicAudio.context().currentTime;
    var last = null;
    while (pending.length && pending[0].time <= now) last = pending.shift();
    if (!last) return;
    var nodes = el.grid.children;
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('is-current');
    var node = nodes[last.step];
    if (node) node.classList.add('is-current');
  }

  function buildClock() {
    if (clock) clock.stop();
    clock = global.Metronome.createClock({
      secondsPerStep: secondsPerStep,
      onStep: onStep,
      onStart: function () {
        pending = [];
        if (uiTimer) global.clearInterval(uiTimer);
        uiTimer = global.setInterval(paintPending, 16);
      },
      onStop: function () {
        global.MusicAudio.cancelGroup('rhythm');
        if (uiTimer) { global.clearInterval(uiTimer); uiTimer = null; }
        pending = [];
        var nodes = el.grid.children;
        for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('is-current');
      }
    });
  }

  function toggle() {
    if (!currentPattern() || !selectedChord()) return;
    if (!clock) buildClock();
    if (clock.running) {
      clock.stop();
      el.toggle.textContent = '播放节奏';
      el.toggle.classList.remove('is-running');
    } else {
      global.MusicAudio.unlock();
      clock.start();
      el.toggle.textContent = '停止';
      el.toggle.classList.add('is-running');
    }
  }

  function select(id) {
    var found = null;
    for (var i = 0; i < state.patterns.length; i++) {
      if (state.patterns[i].id === id) { found = state.patterns[i]; break; }
    }
    if (!found) return;
    if (clock && clock.running) { clock.stop(); el.toggle.textContent = '播放节奏'; el.toggle.classList.remove('is-running'); }
    state.selected = found;
    renderChordOptions();
    renderList();
    renderDetail();
    buildClock();
  }

  function init() {
    el.list = document.getElementById('pattern-list');
    el.title = document.getElementById('pattern-title');
    el.desc = document.getElementById('pattern-desc');
    el.meta = document.getElementById('pattern-meta');
    el.grid = document.getElementById('pattern-grid');
    el.legend = document.getElementById('stroke-legend');
    el.toggle = document.getElementById('rhythm-toggle');
    el.bpm = document.getElementById('rhythm-bpm');
    el.bpmSlider = document.getElementById('rhythm-bpm-slider');
    el.minus = document.getElementById('rhythm-minus');
    el.plus = document.getElementById('rhythm-plus');
    el.chord = document.getElementById('rhythm-chord');
    el.filters = document.getElementById('rhythm-filters');

    el.list.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.pattern-item');
      if (btn) select(btn.dataset.id);
    });
    el.filters.addEventListener('click', function (ev) {
      var chip = ev.target.closest('.chip');
      if (!chip) return;
      var nodes = el.filters.querySelectorAll('.chip');
      for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('is-active');
      chip.classList.add('is-active');
      state.filter = chip.dataset.instrument;
      if (state.selected && patternMatchesFilter(state.selected)) {
        renderChordOptions();
        renderList();
        renderDetail();
        return;
      }
      for (var k = 0; k < state.patterns.length; k++) {
        if (patternMatchesFilter(state.patterns[k])) { select(state.patterns[k].id); return; }
      }
    });
    el.toggle.addEventListener('click', toggle);
    el.bpm.addEventListener('change', function () { setBpm(el.bpm.value); });
    el.bpmSlider.addEventListener('input', function () { setBpm(el.bpmSlider.value); });
    el.minus.addEventListener('click', function () { setBpm(state.bpm - 1); });
    el.plus.addEventListener('click', function () { setBpm(state.bpm + 1); });
    el.chord.addEventListener('change', function () {
      state.chordIndex = parseInt(el.chord.value, 10) || 0;
    });

    setBpm(loadBpm());
    renderLegend();

    /* 节奏型与和弦库并行加载，和弦用于试听扫弦的音高。 */
    function fetchJSON(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error(url + ' 返回 HTTP ' + r.status);
        return r.json();
      });
    }

    Promise.all([
      fetchJSON('/api/rhythms'),
      fetchJSON('/api/chords')
    ]).then(function (res) {
      var rhythms = res[0];
      var chords = res[1];
      state.patterns = rhythms.patterns || [];
      state.legend = rhythms.strokeLegend || [];
      state.chords = chords.chords || [];
      state.instruments = chords.instruments || [];
      renderLegend();
      renderList();
      if (state.patterns.length) select(state.patterns[0].id);
    }).catch(function (err) {
      el.title.textContent = '节奏型加载失败';
      el.desc.textContent = String(err);
      el.toggle.disabled = true;
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.code !== 'Space') return;
      var tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'button' || tag === 'textarea') return;
      var panel = document.getElementById('panel-rhythm');
      if (!panel.classList.contains('is-active')) return;
      ev.preventDefault();
      toggle();
    });
  }

  /* 供其他面板调用：切换标签页时静默停止。 */
  function stopTransport() {
    if (clock && clock.running) {
      clock.stop();
      el.toggle.textContent = '播放节奏';
      el.toggle.classList.remove('is-running');
    }
  }

  global.Rhythm = { init: init, stop: stopTransport, state: state };
})(window);
