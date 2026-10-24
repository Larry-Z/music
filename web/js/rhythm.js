/* 节奏训练器：从 /api/rhythms 拉取节奏型，用扫弦合成音播放。 */
(function (global) {
  'use strict';

  var BPM_STORAGE_KEY = 'music.rhythm.bpm';
  var LOOP_STORAGE_KEY = 'music.rhythm.loop';
  var SAVED_LOOPS_KEY = 'music.rhythm.savedLoops';
  var DEFAULT_LOOP_BARS = 4;
  var MAX_LOOP_BARS = 32;
  var MARKS = ['D', 'U', 'x', '-'];

  var state = {
    patterns: [],
    chords: [],
    instruments: [],
    legend: [],
    filter: 'all',
    selected: null,
    bpm: 75,
    chordIndex: 0,
    loop: { enabled: false, instrument: 'ukulele', beats: 4, unit: 4, subdivision: 2, bars: [] },
    savedLoops: [],
    activeSavedId: ''
  };

  var clock = null;
  var pending = [];
  var uiTimer = null;
  var el = {};
  var activeLoopBar = -1;
  var activeLoopStep = -1;

  /* 把和弦指法换算成频率：按和弦自己的乐器调弦（尤克里里 4 弦 / 吉他 6 弦），
   * 复用和弦库的实现，避免两份调弦表不一致。 */
  function chordFreqs(chord) {
    return global.Chords.chordFreqs(chord, state.instruments);
  }

  function selectedChord() {
    return state.chords[state.chordIndex] || null;
  }

  function currentPattern() { return state.selected; }

  function chordIndexFor(name, instrument) {
    for (var i = 0; i < state.chords.length; i++) {
      if (state.chords[i].name === name && state.chords[i].instrument === instrument) return i;
    }
    return -1;
  }

  function loopChord(bar) {
    return state.chords[chordIndexFor(bar.chord, state.loop.instrument)] || null;
  }

  function loopStepsPerBar() { return state.loop.beats * state.loop.subdivision; }

  function templateMatchesLoop(p) {
    return p.beats === state.loop.beats && p.unit === state.loop.unit && state.loop.subdivision % p.subdivision === 0 &&
      (p.instrument === 'both' || p.instrument === state.loop.instrument);
  }

  function applyTemplate(bar, p, barIndex) {
    var count = p.beats * p.subdivision;
    var offset = (barIndex % p.bars) * count;
    var factor = state.loop.subdivision / p.subdivision;
    bar.steps = [];
    for (var s = 0; s < loopStepsPerBar(); s++) bar.steps.push('-');
    for (var i = 0; i < count; i++) bar.steps[i * factor] = p.steps[offset + i];
    bar.accents = p.accents.filter(function (index) { return index >= offset && index < offset + count; })
      .map(function (index) { return (index - offset) * factor; });
    if (bar.accents.indexOf(0) === -1) bar.accents.unshift(0);
    bar.patternId = p.id;
  }

  function ensureLoop() {
    if (state.loop.bars.length) return;
    var p = currentPattern();
    var chord = selectedChord() || state.chords[0];
    state.loop.instrument = chord ? chord.instrument : state.instruments[0].key;
    state.loop.beats = p.beats; state.loop.unit = p.unit; state.loop.subdivision = p.subdivision;
    var names = ['C', 'Am', 'F', 'G'];
    for (var i = 0; i < DEFAULT_LOOP_BARS; i++) {
      var name = chordIndexFor(names[i], state.loop.instrument) >= 0 ? names[i] : chord.name;
      var bar = { chord: name, steps: [], accents: [], patternId: '' };
      applyTemplate(bar, p, i);
      state.loop.bars.push(bar);
    }
  }

  function saveLoop() {
    try { global.localStorage.setItem(LOOP_STORAGE_KEY, JSON.stringify(state.loop)); } catch (err) { /* 本地存储不可用时仍可练习 */ }
    if (state.activeSavedId && state.loop.enabled) savedMessage('已修改，点击「更新已选节奏」保存到该版本。');
  }

  function validatedLoop(saved) {
    if (!saved || !Array.isArray(saved.bars) || saved.bars.length < 1 || saved.bars.length > MAX_LOOP_BARS ||
        [1, 2, 3, 4].indexOf(saved.subdivision) === -1 || !state.instruments.some(function (in_) { return in_.key === saved.instrument; }) ||
        !state.patterns.some(function (p) { return p.beats === saved.beats && p.unit === saved.unit; })) return null;
    var count = saved.beats * saved.subdivision;
    var bars = [];
    for (var i = 0; i < saved.bars.length; i++) {
      var bar = saved.bars[i];
      if (!bar || !Array.isArray(bar.steps) || bar.steps.length !== count ||
          !bar.steps.every(function (mark) { return MARKS.indexOf(mark) !== -1; }) ||
          chordIndexFor(bar.chord, saved.instrument) < 0 || !Array.isArray(bar.accents) ||
          bar.accents.indexOf(0) === -1 || !bar.accents.every(function (index) { return Math.floor(index) === index && index >= 0 && index < count; })) return null;
      bars.push({ chord: bar.chord, steps: bar.steps.slice(), accents: bar.accents.slice(), patternId: typeof bar.patternId === 'string' ? bar.patternId : '' });
    }
    return { enabled: saved.enabled === true, instrument: saved.instrument, beats: saved.beats,
      unit: saved.unit, subdivision: saved.subdivision, bars: bars };
  }

  function loadLoop() {
    try {
      var saved = validatedLoop(JSON.parse(global.localStorage.getItem(LOOP_STORAGE_KEY)));
      if (saved) state.loop = saved;
    } catch (err) { /* 损坏或旧版本的设置使用默认值 */ }
  }

  function savedMessage(text, error) {
    el.saveStatus.textContent = text;
    el.saveStatus.classList.toggle('is-error', !!error);
  }

  function savedEntry(id) {
    for (var i = 0; i < state.savedLoops.length; i++) if (state.savedLoops[i].id === id) return state.savedLoops[i];
    return null;
  }

  function renderSavedLoops(selectedId) {
    el.savedSelect.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = state.savedLoops.length ? '选择已保存的节奏' : '暂无已保存的节奏';
    el.savedSelect.appendChild(placeholder);
    for (var i = 0; i < state.savedLoops.length; i++) {
      var entry = state.savedLoops[i];
      var loop = validatedLoop(entry.loop);
      var option = document.createElement('option');
      option.value = entry.id;
      /* 名称由用户输入，只通过文本属性写入，避免作为 HTML 解释。 */
      option.textContent = entry.name + (loop ? ' · ' + instrumentLabel(loop.instrument) + ' · ' + loop.bars.length + ' 小节 · ' + timeSignature(loop) + ' · ' + entry.bpm + ' BPM' : ' · 数据不兼容');
      el.savedSelect.appendChild(option);
    }
    el.savedSelect.value = savedEntry(selectedId) ? selectedId : '';
    updateSavedButtons();
  }

  function updateSavedButtons() {
    var selected = savedEntry(el.savedSelect.value);
    el.savedSelect.disabled = state.savedLoops.length === 0;
    el.savedLoad.disabled = !selected;
    el.savedDelete.disabled = !selected;
    el.savedUpdate.disabled = !selected || selected.id !== state.activeSavedId;
  }

  function loadSavedLoops() {
    try {
      var stored = JSON.parse(global.localStorage.getItem(SAVED_LOOPS_KEY));
      if (stored && stored.version === 1 && Array.isArray(stored.items)) {
        var ids = [];
        for (var i = 0; i < stored.items.length; i++) {
          var entry = stored.items[i];
          if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9-]+$/.test(entry.id) || ids.indexOf(entry.id) !== -1 ||
              typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 60 ||
              Math.floor(entry.bpm) !== entry.bpm || entry.bpm < 30 || entry.bpm > 240 || !entry.loop) continue;
          ids.push(entry.id);
          state.savedLoops.push({ id: entry.id, name: entry.name, bpm: entry.bpm, loop: entry.loop });
        }
      }
    } catch (err) { savedMessage('无法读取已保存的节奏，请检查浏览器存储设置。', true); }
    renderSavedLoops('');
  }

  function writeSavedLoops(items) {
    try {
      global.localStorage.setItem(SAVED_LOOPS_KEY, JSON.stringify({ version: 1, items: items }));
      state.savedLoops = items;
      return true;
    } catch (err) {
      savedMessage('保存失败：浏览器存储不可用或空间不足，请检查设置后重试。', true);
      return false;
    }
  }

  function saveNamedLoop(update) {
    var loop = validatedLoop(state.loop);
    if (!loop || !state.loop.enabled) return;
    var name = el.saveName.value.trim();
    if (!name || name.length > 60) { savedMessage('请填写节奏名称，最多 60 个字。', true); el.saveName.focus(); return; }
    var active = update ? savedEntry(state.activeSavedId) : null;
    if (update && (!active || el.savedSelect.value !== active.id)) return;
    for (var i = 0; i < state.savedLoops.length; i++) {
      if (state.savedLoops[i].name === name && (!active || state.savedLoops[i].id !== active.id)) {
        savedMessage('已有同名节奏，请换个名称，或载入该节奏后更新。', true); return;
      }
    }
    loop.enabled = true;
    var entry = { id: active ? active.id : 'loop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9), name: name, bpm: state.bpm, loop: loop };
    var items = state.savedLoops.slice();
    if (active) items[items.indexOf(active)] = entry;
    else items.unshift(entry);
    if (!writeSavedLoops(items)) return;
    state.activeSavedId = entry.id; el.saveName.value = name;
    renderSavedLoops(entry.id);
    savedMessage((update ? '已更新「' : '已保存「') + name + '」。保存在当前浏览器。');
  }

  function loadNamedLoop() {
    var entry = savedEntry(el.savedSelect.value);
    if (!entry) return;
    var loop = validatedLoop(entry.loop);
    if (!loop) { savedMessage('该节奏与当前和弦或拍号数据不兼容，无法载入。', true); return; }
    stopTransport();
    loop.enabled = true; state.loop = loop; state.activeSavedId = entry.id;
    setBpm(entry.bpm); el.saveName.value = entry.name;
    renderDetail(); saveLoop(); renderSavedLoops(entry.id);
    savedMessage('已载入「' + entry.name + '」。');
  }

  function deleteNamedLoop() {
    var entry = savedEntry(el.savedSelect.value);
    if (!entry) return;
    var items = state.savedLoops.filter(function (item) { return item.id !== entry.id; });
    if (!writeSavedLoops(items)) return;
    if (state.activeSavedId === entry.id) state.activeSavedId = '';
    renderSavedLoops('');
    savedMessage('已删除「' + entry.name + '」。当前编辑内容仍保留。');
  }

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
    el.grid.hidden = state.loop.enabled;
    el.singleChord.hidden = state.loop.enabled;
    el.loopEditor.hidden = !state.loop.enabled;
    var modes = el.mode.querySelectorAll('button');
    for (var m = 0; m < modes.length; m++) {
      var active = modes[m].dataset.mode === (state.loop.enabled ? 'loop' : 'pattern');
      modes[m].classList.toggle('is-active', active);
      modes[m].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (state.loop.enabled) {
      el.title.textContent = '自定义和弦与扫弦循环';
      el.desc.textContent = '选择音色和循环小节数，每小节独立设置和弦与扫弦。播完最后一小节后回到第 1 小节，修改设置会暂停播放。';
      el.meta.innerHTML = '<span class="tag">拍号 ' + timeSignature(state.loop) + '</span><span class="tag">细分 ' +
        subdivisionLabel(state.loop.unit, state.loop.subdivision) + '</span><span class="tag">' + state.loop.bars.length +
        ' 小节循环</span><span class="tag">' + instrumentLabel(state.loop.instrument) + '音色</span>';
      renderLoop();
      return;
    }
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

  function renderLoop() {
    var loop = state.loop;
    var instruments = '', signatures = '', seen = [];
    for (var i = 0; i < state.instruments.length; i++) {
      var instrument = state.instruments[i];
      var sound = instrument.key === 'guitar' ? '木吉他 · 钢弦' : instrument.key === 'ukulele' ? '尤克里里 · 尼龙弦' : instrument.label;
      instruments += '<option value="' + instrument.key + '">' + sound + '</option>';
    }
    for (var p = 0; p < state.patterns.length; p++) {
      var signature = timeSignature(state.patterns[p]);
      if (seen.indexOf(signature) !== -1) continue;
      seen.push(signature);
      signatures += '<option value="' + signature + '">' + signature + '</option>';
    }
    el.loopInstrument.innerHTML = instruments; el.loopInstrument.value = loop.instrument;
    el.loopSignature.innerHTML = signatures; el.loopSignature.value = timeSignature(loop);
    el.loopSubdivision.value = String(loop.subdivision);
    el.loopCount.value = String(loop.bars.length);
    var options = '';
    for (var c = 0; c < state.chords.length; c++) {
      if (state.chords[c].instrument === loop.instrument) options += '<option value="' + state.chords[c].name + '">' + state.chords[c].name + '</option>';
    }
    var templates = '<option value="">自定义</option>';
    for (var t = 0; t < state.patterns.length; t++) {
      if (templateMatchesLoop(state.patterns[t])) templates += '<option value="' + state.patterns[t].id + '">' + state.patterns[t].name + '</option>';
    }
    var html = '';
    for (var b = 0; b < loop.bars.length; b++) {
      var bar = loop.bars[b];
      html += '<div class="loop-bar" id="loop-bar-' + b + '"><h4>第 ' + (b + 1) + ' 小节</h4>' +
        '<div class="loop-bar-controls"><label class="field"><span>和弦</span><select id="loop-chord-' + b + '" data-bar="' + b + '" data-edit="chord">' + options + '</select></label>' +
        '<label class="field"><span>扫弦节奏</span><select id="loop-pattern-' + b + '" data-bar="' + b + '" data-edit="pattern">' + templates + '</select></label>' +
        '<button type="button" class="btn" data-bar="' + b + '" data-edit="clear">清空</button></div>' +
        '<div class="loop-step-grid" style="--subdivision:' + loop.subdivision + '">';
      for (var beat = 0; beat < loop.beats; beat++) {
        html += '<div><span class="loop-beat-label">第 ' + (beat + 1) + ' 拍</span><div class="loop-beat-steps">';
        for (var sub = 0; sub < loop.subdivision; sub++) {
          var step = beat * loop.subdivision + sub;
          html += '<button type="button" id="loop-step-' + b + '-' + step + '" data-bar="' + b + '" data-step="' + step + '" class="' +
            loopStepClass(bar, step) + '" aria-label="' + loopStepLabel(b, step) + '">' + loopStepContent(bar, step) + '</button>';
        }
        html += '</div></div>';
      }
      html += '</div></div>';
    }
    el.loopBars.innerHTML = html;
    el.loopCards = []; el.loopCells = [];
    for (var k = 0; k < loop.bars.length; k++) {
      var chordSelect = document.getElementById('loop-chord-' + k);
      chordSelect.value = loop.bars[k].chord;
      document.getElementById('loop-pattern-' + k).value = loop.bars[k].patternId;
      el.loopCards.push(document.getElementById('loop-bar-' + k));
      for (var s = 0; s < loopStepsPerBar(); s++) el.loopCells.push(document.getElementById('loop-step-' + k + '-' + s));
    }
    activeLoopBar = -1; activeLoopStep = -1;
    el.toggle.disabled = !loop.bars.every(function (bar) { return loopChord(bar) !== null; });
  }

  function loopStepClass(bar, step) {
    return 'step ' + markClass(bar.steps[step]) + (bar.accents.indexOf(step) !== -1 ? ' is-accent' : '');
  }

  function loopStepContent(bar, step) {
    return '<span class="s-mark">' + markLabel(bar.steps[step]) + '</span><span class="s-idx">' +
      (Math.floor(step / state.loop.subdivision) + 1) + (step % state.loop.subdivision ? '.' + step % state.loop.subdivision : '') + '</span>';
  }

  function loopStepLabel(barIndex, step) {
    var labels = { D: '下扫', U: '上扫', x: '闷音', '-': '空拍' };
    return '第 ' + (barIndex + 1) + ' 小节，第 ' + (Math.floor(step / state.loop.subdivision) + 1) + ' 拍，第 ' +
      (step % state.loop.subdivision + 1) + ' 格：' + labels[state.loop.bars[barIndex].steps[step]] + '，点击切换';
  }

  function resizeLoop(beats, unit, subdivision) {
    var previousSub = state.loop.subdivision;
    for (var b = 0; b < state.loop.bars.length; b++) {
      var previous = state.loop.bars[b].steps;
      var steps = [];
      for (var i = 0; i < beats * subdivision; i++) steps.push('-');
      for (var s = 0; s < previous.length; s++) {
        var target = Math.floor(s / previousSub) * subdivision + Math.min(subdivision - 1, Math.round((s % previousSub) * subdivision / previousSub));
        if (target < steps.length && previous[s] !== '-') steps[target] = previous[s];
      }
      state.loop.bars[b].steps = steps;
      state.loop.bars[b].accents = [0]; state.loop.bars[b].patternId = '';
    }
    state.loop.beats = beats; state.loop.unit = unit; state.loop.subdivision = subdivision;
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
    if (state.activeSavedId && state.loop.enabled) savedMessage('速度已修改，点击「更新已选节奏」保存到该版本。');
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
    var sub = state.loop.enabled ? state.loop.subdivision : p ? p.subdivision : 1;
    return 60 / state.bpm / sub;
  }

  /* 保留琴弦的自然共鸣；下一次扫弦会在音频层平滑接管上一组弦音。 */
  function strokeDuration(chord) {
    return chord.instrument === 'guitar' ? 2.6 : 1.7;
  }

  function onStep(step, time, duration) {
    if (state.loop.enabled) {
      var count = loopStepsPerBar();
      var loopStep = step % (count * state.loop.bars.length);
      var barIndex = Math.floor(loopStep / count);
      var localStep = loopStep % count;
      var bar = state.loop.bars[barIndex];
      var loopChord_ = loopChord(bar);
      if (loopChord_) global.MusicAudio.stroke(bar.steps[localStep], time, 0.75, chordFreqs(loopChord_),
        bar.accents.indexOf(localStep) !== -1, 'rhythm', step, strokeDuration(loopChord_), loopChord_.instrument, duration,
        { subdivision: state.loop.subdivision, position: localStep % state.loop.subdivision });
      pending.push({ step: loopStep, bar: barIndex, chord: loopChord_ ? loopChord_.name : '', loop: true, time: time });
      return;
    }
    var p = currentPattern();
    if (!p) return;
    var steps = totalSteps(p);
    var effective = step % steps;
    var accent = isAccent(p, effective);
    var chord = selectedChord();
    if (chord) {
      global.MusicAudio.stroke(p.steps[effective], time, 0.75, chordFreqs(chord), accent,
        'rhythm', step, strokeDuration(chord), chord.instrument, duration,
        { subdivision: p.subdivision, position: effective % p.subdivision });
    }
    pending.push({ step: effective, time: time });
  }

  function paintPending() {
    var now = global.MusicAudio.context().currentTime;
    var last = null;
    while (pending.length && pending[0].time <= now) last = pending.shift();
    if (!last) return;
    if (last.loop) {
      if (activeLoopStep >= 0) el.loopCells[activeLoopStep].classList.remove('is-current');
      el.loopCells[last.step].classList.add('is-current');
      if (activeLoopBar !== last.bar) {
        if (activeLoopBar >= 0) el.loopCards[activeLoopBar].classList.remove('is-current-bar');
        el.loopCards[last.bar].classList.add('is-current-bar');
        el.playbackStatus.textContent = '第 ' + (last.bar + 1) + ' / ' + state.loop.bars.length + ' 小节 · ' + last.chord;
      }
      activeLoopStep = last.step; activeLoopBar = last.bar;
      return;
    }
    var nodes = el.grid.children;
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('is-current');
    var node = nodes[last.step];
    if (node) node.classList.add('is-current');
  }

  function clearLoopLights() {
    if (activeLoopStep >= 0 && el.loopCells[activeLoopStep]) el.loopCells[activeLoopStep].classList.remove('is-current');
    if (activeLoopBar >= 0 && el.loopCards[activeLoopBar]) el.loopCards[activeLoopBar].classList.remove('is-current-bar');
    activeLoopBar = -1; activeLoopStep = -1;
  }

  function buildClock() {
    if (clock) clock.stop();
    clock = global.Metronome.createClock({
      secondsPerStep: secondsPerStep,
      onStep: onStep,
      onSkip: function () {
        global.MusicAudio.cancelGroup('rhythm');
        pending = [];
        clearLoopLights();
      },
      onStart: function () {
        pending = [];
        clearLoopLights();
        el.playbackStatus.textContent = state.loop.enabled ? state.loop.bars.length + ' 小节循环播放中' : '';
        if (uiTimer) global.clearInterval(uiTimer);
        uiTimer = global.setInterval(paintPending, 16);
      },
      onStop: function () {
        global.MusicAudio.cancelGroup('rhythm');
        if (uiTimer) { global.clearInterval(uiTimer); uiTimer = null; }
        pending = [];
        clearLoopLights();
        el.playbackStatus.textContent = state.loop.enabled ? state.loop.bars.length + ' 小节循环已停止' : '';
        var nodes = el.grid.children;
        for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('is-current');
      }
    });
  }

  function toggle() {
    if (!currentPattern() || (state.loop.enabled ? state.loop.bars.length < 1 || state.loop.bars.length > MAX_LOOP_BARS ||
        !state.loop.bars.every(function (bar) { return loopChord(bar) !== null; }) : !selectedChord())) return;
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
    el.mode = document.getElementById('rhythm-mode');
    el.singleChord = document.getElementById('rhythm-single-chord');
    el.loopEditor = document.getElementById('rhythm-loop-editor');
    el.loopBars = document.getElementById('loop-bars');
    el.loopInstrument = document.getElementById('loop-instrument');
    el.loopCount = document.getElementById('loop-count');
    el.loopSignature = document.getElementById('loop-signature');
    el.loopSubdivision = document.getElementById('loop-subdivision');
    el.loopFill = document.getElementById('loop-fill');
    el.playbackStatus = document.getElementById('rhythm-playback-status');
    el.saveName = document.getElementById('loop-name');
    el.savedSelect = document.getElementById('loop-saved');
    el.savedLoad = document.getElementById('loop-load');
    el.savedDelete = document.getElementById('loop-delete');
    el.savedUpdate = document.getElementById('loop-update');
    el.saveStatus = document.getElementById('loop-save-status');
    document.getElementById('loop-save').addEventListener('click', function () { saveNamedLoop(false); });
    el.savedUpdate.addEventListener('click', function () { saveNamedLoop(true); });
    el.savedLoad.addEventListener('click', loadNamedLoop);
    el.savedDelete.addEventListener('click', deleteNamedLoop);
    el.savedSelect.addEventListener('change', updateSavedButtons);
    el.loopCells = []; el.loopCards = [];

    el.mode.addEventListener('click', function (ev) {
      var button = ev.target.closest('button[data-mode]');
      if (!button || !currentPattern() || !state.chords.length || !state.instruments.length) return;
      var enabled = button.dataset.mode === 'loop';
      if (state.loop.enabled === enabled) return;
      stopTransport();
      ensureLoop();
      state.loop.enabled = enabled;
      renderDetail(); saveLoop();
      el.playbackStatus.textContent = '';
    });
    el.loopInstrument.addEventListener('change', function () {
      var instrument = el.loopInstrument.value;
      if (!state.instruments.some(function (in_) { return in_.key === instrument; })) return;
      stopTransport();
      for (var b = 0; b < state.loop.bars.length; b++) {
        if (chordIndexFor(state.loop.bars[b].chord, instrument) === -1) {
          var candidates = state.chords.filter(function (chord) { return chord.instrument === instrument; });
          state.loop.bars[b].chord = chordIndexFor('C', instrument) >= 0 ? 'C' : candidates.length ? candidates[0].name : '';
        }
        state.loop.bars[b].patternId = '';
      }
      state.loop.instrument = instrument;
      renderDetail(); saveLoop();
    });
    el.loopCount.addEventListener('change', function () {
      var count = Number(el.loopCount.value);
      if (Math.floor(count) !== count || count < 1 || count > MAX_LOOP_BARS || !state.loop.bars.length) {
        el.loopCount.value = String(state.loop.bars.length);
        return;
      }
      if (count === state.loop.bars.length) return;
      stopTransport();
      while (state.loop.bars.length < count) {
        var previous = state.loop.bars[state.loop.bars.length - 1];
        state.loop.bars.push({ chord: previous.chord, steps: previous.steps.slice(), accents: previous.accents.slice(), patternId: previous.patternId });
      }
      state.loop.bars = state.loop.bars.slice(0, count);
      renderDetail(); saveLoop();
    });
    el.loopSignature.addEventListener('change', function () {
      var parts = el.loopSignature.value.split('/');
      var beats = Number(parts[0]), unit = Number(parts[1]);
      if (!state.patterns.some(function (p) { return p.beats === beats && p.unit === unit; })) return;
      stopTransport(); resizeLoop(beats, unit, state.loop.subdivision);
      renderDetail(); saveLoop();
    });
    el.loopSubdivision.addEventListener('change', function () {
      var sub = Number(el.loopSubdivision.value);
      if ([1, 2, 3, 4].indexOf(sub) === -1) return;
      stopTransport(); resizeLoop(state.loop.beats, state.loop.unit, sub);
      renderDetail(); saveLoop();
    });
    el.loopFill.addEventListener('click', function () {
      var p = currentPattern();
      if (!p || !state.loop.bars.length) return;
      stopTransport();
      state.loop.beats = p.beats; state.loop.unit = p.unit; state.loop.subdivision = p.subdivision;
      for (var b = 0; b < state.loop.bars.length; b++) applyTemplate(state.loop.bars[b], p, b);
      renderDetail(); saveLoop();
    });
    el.loopBars.addEventListener('change', function (ev) {
      var select = ev.target.closest('select[data-edit]');
      if (!select) return;
      var index = Number(select.dataset.bar);
      if (Math.floor(index) !== index || index < 0 || index >= state.loop.bars.length) return;
      var bar = state.loop.bars[index];
      if (select.dataset.edit === 'chord') {
        if (chordIndexFor(select.value, state.loop.instrument) < 0) return;
        stopTransport(); bar.chord = select.value;
      } else {
        var p = state.patterns.filter(function (p) { return p.id === select.value && templateMatchesLoop(p); })[0];
        if (!p) { bar.patternId = ''; saveLoop(); return; }
        stopTransport(); applyTemplate(bar, p, index); renderLoop();
      }
      saveLoop();
    });
    el.loopBars.addEventListener('click', function (ev) {
      var button = ev.target.closest('button[data-bar]');
      if (!button) return;
      var index = Number(button.dataset.bar);
      if (Math.floor(index) !== index || index < 0 || index >= state.loop.bars.length) return;
      var bar = state.loop.bars[index];
      if (button.dataset.edit === 'clear') {
        stopTransport();
        bar.steps = bar.steps.map(function () { return '-'; }); bar.patternId = '';
        renderLoop(); saveLoop(); return;
      }
      var step = Number(button.dataset.step);
      if (Math.floor(step) !== step || step < 0 || step >= bar.steps.length) return;
      stopTransport();
      bar.steps[step] = MARKS[(MARKS.indexOf(bar.steps[step]) + 1) % MARKS.length];
      bar.patternId = '';
      button.className = loopStepClass(bar, step);
      button.innerHTML = loopStepContent(bar, step);
      button.setAttribute('aria-label', loopStepLabel(index, step));
      document.getElementById('loop-pattern-' + index).value = '';
      saveLoop();
    });

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
        stopTransport();
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
    Promise.all([
      global.MusicData.load('/api/rhythms'),
      global.MusicData.load('/api/chords')
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
      loadLoop();
      loadSavedLoops();
      if (state.selected) renderDetail();
    }).catch(function (err) {
      el.title.textContent = '节奏型加载失败';
      el.desc.textContent = String(err);
      el.toggle.disabled = true;
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.code !== 'Space' || ev.repeat) return;
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
