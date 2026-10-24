/* 四小节编辑器与真实模块的播放、持久化回归验证。 */
'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var harness = require('./browser-harness').harness;

function plain(value) { return JSON.parse(JSON.stringify(value)); }

async function setup(storage) {
  var h = harness(), clock, options, strokes = [], cancellations = 0;
  var instruments = [
    { key: 'ukulele', label: '尤克里里', strings: 4, openMidi: [67, 60, 64, 69] },
    { key: 'guitar', label: '吉他', strings: 6, openMidi: [40, 45, 50, 55, 59, 64] }
  ];
  var chords = [];
  instruments.forEach(function (instrument) {
    ['C', 'Am', 'F', 'G'].forEach(function (name, i) {
      chords.push({ name: name, instrument: instrument.key, frets: Array(instrument.strings).fill(i) });
    });
  });
  var patterns = [
    { id: 'quarter', name: '四分', instrument: 'both', beats: 4, unit: 4, subdivision: 1, bars: 1, steps: ['D', 'D', 'D', 'D'], accents: [0] },
    { id: 'folk', name: '民谣', instrument: 'both', beats: 4, unit: 4, subdivision: 2, bars: 1, steps: ['D', '-', 'D', 'U', '-', 'U', 'D', 'U'], accents: [0, 4] },
    { id: 'waltz', name: '三拍', instrument: 'both', beats: 3, unit: 4, subdivision: 2, bars: 1, steps: ['D', '-', 'D', 'U', 'D', 'U'], accents: [0] }
  ];
  storage = storage || {};
  h.window.localStorage = { getItem: function (key) { return storage[key] || null; }, setItem: function (key, value) { storage[key] = value; } };
  h.window.fetch = function (url) {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(url === '/api/chords' ? { instruments: instruments, chords: chords } : { patterns: patterns, strokeLegend: [] }); } });
  };
  ['audio', 'data', 'chords', 'metronome', 'rhythm'].forEach(h.load);
  h.window.MusicAudio.stroke = function (mark, time, volume, freqs, accent, group, seed, duration, instrument) {
    strokes.push({ mark: mark, time: time, freqs: plain(freqs), accent: accent, instrument: instrument });
  };
  h.window.MusicAudio.cancelGroup = function (group) { if (group === 'rhythm') cancellations++; };
  h.window.Metronome.createClock = function (opts) {
    options = opts;
    clock = { running: false, start: function () { this.running = true; opts.onStart(); }, stop: function () { this.running = false; opts.onStop(); } };
    return clock;
  };
  h.window.Rhythm.init();
  await new Promise(function (resolve) { setImmediate(resolve); });
  function event(dataset, value) {
    var node = { dataset: dataset, value: value, className: '', innerHTML: '', setAttribute: function () {} };
    return { target: { closest: function () { return node; } } };
  }
  return {
    h: h, state: h.window.Rhythm.state, strokes: strokes, storage: storage,
    mode: function (mode) { h.nodes['rhythm-mode'].emit('click', event({ mode: mode })); },
    count: function (count) { h.nodes['loop-count'].value = String(count); h.nodes['loop-count'].emit('change'); },
    cell: function (bar, step) { h.nodes['loop-bars'].emit('click', event({ bar: String(bar), step: String(step) })); },
    chord: function (bar, name) { h.nodes['loop-bars'].emit('change', event({ bar: String(bar), edit: 'chord' }, name)); },
    preset: function (bar, id) { h.nodes['loop-bars'].emit('change', event({ bar: String(bar), edit: 'pattern' }, id)); },
    clear: function (bar) { h.nodes['loop-bars'].emit('click', event({ bar: String(bar), edit: 'clear' })); },
    template: function (id) { h.nodes['pattern-list'].emit('click', event({ id: id })); },
    start: function () { h.nodes['rhythm-toggle'].emit('click'); },
    step: function (step, time) { options.onStep(step, time, options.secondsPerStep()); },
    paint: function (time) { h.context.currentTime = time; h.intervals.values().next().value(); },
    running: function () { return clock.running; },
    duration: function () { return options.secondsPerStep(); },
    cancelled: function () { return cancellations; }
  };
}

test('四个小节的和弦和扫弦独立生效，第五小节回到第一小节', async function () {
  var t = await setup(); t.mode('loop');
  assert.deepEqual(plain(t.state.loop.bars.map(function (bar) { return bar.chord; })), ['C', 'Am', 'F', 'G']);
  t.cell(0, 1); t.cell(0, 2); t.cell(0, 2); t.cell(0, 3); t.cell(0, 3); t.cell(0, 3);
  t.chord(1, 'G'); t.clear(2);
  assert.deepEqual(plain(t.state.loop.bars[0].steps), ['D', 'U', 'x', '-']);
  assert.deepEqual(plain(t.state.loop.bars[1].steps), ['D', 'D', 'D', 'D']);
  t.start();
  for (var step = 0; step < 20; step++) t.step(step, 0.1 + step * 0.1);
  assert.deepEqual(t.strokes.slice(0, 4).map(function (stroke) { return stroke.mark; }), ['D', 'U', 'x', '-']);
  assert.deepEqual(t.strokes.slice(8, 12).map(function (stroke) { return stroke.mark; }), ['-', '-', '-', '-']);
  assert.deepEqual(t.strokes.slice(16, 20).map(function (stroke) { return stroke.mark; }), ['D', 'U', 'x', '-']);
  for (var i = 0; i < t.strokes.length; i++) {
    var bar = t.state.loop.bars[Math.floor(i / 4) % 4];
    var chord = t.state.chords.find(function (chord) { return chord.name === bar.chord && chord.instrument === 'ukulele'; });
    assert.deepEqual(t.strokes[i].freqs, plain(t.h.window.Chords.chordFreqs(chord, t.state.instruments)));
  }
  t.paint(0.1);
  assert.equal(t.h.nodes['loop-bar-0'].classList.contains('is-current-bar'), true);
  t.paint(0.5);
  assert.equal(t.h.nodes['loop-bar-1'].classList.contains('is-current-bar'), true);
  t.paint(1.701);
  assert.equal(t.h.nodes['loop-bar-0'].classList.contains('is-current-bar'), true);
  t.h.window.Rhythm.stop();
  assert.equal(t.h.nodes['loop-bar-0'].classList.contains('is-current-bar'), false);
  assert.equal(t.h.intervals.size, 0);
});

test('播放中编辑会暂停并取消旧排程，切换练习方式保留四小节编辑', async function () {
  var t = await setup(); t.mode('loop'); t.start(); t.step(0, 10);
  var before = t.cancelled();
  t.cell(1, 0);
  assert.equal(t.running(), false); assert.ok(t.cancelled() > before);
  assert.equal(t.h.nodes['rhythm-toggle'].textContent, '播放节奏');
  assert.equal(t.h.intervals.size, 0);
  var bars = plain(t.state.loop.bars);
  t.mode('pattern'); assert.equal(t.h.nodes['rhythm-loop-editor'].hidden, true);
  t.mode('loop'); assert.deepEqual(plain(t.state.loop.bars), bars);
  t.start(); t.mode('loop'); assert.equal(t.running(), true, '点击当前模式不应中断播放');
  t.h.window.Rhythm.stop();
});

test('细分变更保留拍内动作，节奏型可填入更细的网格，拍号决定小节边界', async function () {
  var t = await setup(); t.mode('loop');
  t.h.nodes['loop-subdivision'].value = '2'; t.h.nodes['loop-subdivision'].emit('change');
  assert.deepEqual(plain(t.state.loop.bars[0].steps), ['D', '-', 'D', '-', 'D', '-', 'D', '-']);
  t.preset(1, 'folk');
  assert.deepEqual(plain(t.state.loop.bars[1].steps), ['D', '-', 'D', 'U', '-', 'U', 'D', 'U']);
  t.h.nodes['loop-subdivision'].value = '4'; t.h.nodes['loop-subdivision'].emit('change');
  t.preset(0, 'quarter');
  assert.deepEqual(plain(t.state.loop.bars[0].steps), ['D', '-', '-', '-', 'D', '-', '-', '-', 'D', '-', '-', '-', 'D', '-', '-', '-']);
  assert.ok(Math.abs(t.duration() - 0.2) < 1e-9);
  t.h.nodes['loop-signature'].value = '3/4'; t.h.nodes['loop-signature'].emit('change');
  assert.ok(t.state.loop.bars.every(function (bar) { return bar.steps.length === 12; }));
  t.start(); t.step(12, 0.1); t.paint(0.1);
  assert.equal(t.h.nodes['loop-bar-1'].classList.contains('is-current-bar'), true);
  t.h.window.Rhythm.stop();
});

test('左侧选择仅选择模板，显式填充才替换四小节，乐器切换使用正确调弦', async function () {
  var t = await setup(); t.mode('loop'); t.cell(0, 0);
  var bars = plain(t.state.loop.bars);
  t.template('folk'); assert.deepEqual(plain(t.state.loop.bars), bars);
  t.h.nodes['loop-fill'].emit('click');
  assert.equal(t.state.loop.subdivision, 2);
  assert.ok(t.state.loop.bars.every(function (bar) { return bar.patternId === 'folk' && bar.steps.length === 8; }));
  t.h.nodes['loop-instrument'].value = 'guitar'; t.h.nodes['loop-instrument'].emit('change');
  t.start(); t.step(0, 0.1);
  assert.equal(t.strokes[0].instrument, 'guitar'); assert.equal(t.strokes[0].freqs.length, 6);
  t.h.window.Rhythm.stop();
});

test('刷新后恢复四小节设置，损坏的本地数据不会破坏练习', async function () {
  var t = await setup(); t.mode('loop'); t.chord(3, 'Am'); t.cell(2, 1);
  var restored = await setup(t.storage);
  assert.deepEqual(plain(restored.state.loop), plain(t.state.loop));
  assert.equal(restored.h.nodes['rhythm-loop-editor'].hidden, false);
  var broken = plain(t.state.loop); broken.bars[0].steps[0] = '<invalid>';
  var fallback = await setup({ 'music.rhythm.loop': JSON.stringify(broken) });
  assert.equal(fallback.state.loop.enabled, false);
  assert.equal(fallback.h.nodes['rhythm-toggle'].disabled, false);
  fallback.mode('loop'); assert.equal(fallback.state.loop.bars.length, 4);
});

test('命名保存生成独立版本，刷新后可恢复和弦、扫弦与速度', async function () {
  var t = await setup(); t.mode('loop'); t.cell(0, 0); t.chord(3, 'Am');
  t.h.nodes['rhythm-bpm'].value = '96'; t.h.nodes['rhythm-bpm'].emit('change');
  t.h.nodes['loop-name'].value = '练习 A'; t.h.nodes['loop-save'].emit('click');
  var first = plain(t.state.savedLoops[0]);
  assert.equal(first.bpm, 96); assert.equal(first.loop.bars[3].chord, 'Am');
  assert.equal(first.loop.bars[0].steps[0], 'U');
  t.cell(0, 0);
  assert.deepEqual(plain(t.state.savedLoops[0]), first);
  t.h.nodes['loop-name'].value = '练习 B'; t.h.nodes['loop-save'].emit('click');
  assert.equal(t.state.savedLoops.length, 2);
  assert.notEqual(t.state.savedLoops[0].id, first.id);
  var restored = await setup(t.storage);
  assert.equal(restored.state.savedLoops.length, 2);
  restored.h.nodes['loop-saved'].value = first.id; restored.h.nodes['loop-saved'].emit('change');
  restored.start(); var before = restored.cancelled();
  restored.h.nodes['loop-load'].emit('click');
  assert.equal(restored.running(), false); assert.ok(restored.cancelled() > before);
  assert.deepEqual(plain(restored.state.loop), first.loop);
  assert.equal(restored.state.bpm, first.bpm);
  assert.equal(restored.h.nodes['loop-name'].value, '练习 A');
  assert.equal(restored.h.nodes['loop-update'].disabled, false);
});

test('更新只覆盖已载入版本，删除后保留当前编辑内容', async function () {
  var t = await setup(); t.mode('loop');
  t.h.nodes['loop-name'].value = 'A'; t.h.nodes['loop-save'].emit('click');
  var firstId = t.state.savedLoops[0].id;
  t.h.nodes['loop-name'].value = 'B'; t.h.nodes['loop-save'].emit('click');
  var second = plain(t.state.savedLoops[0]);
  t.h.nodes['loop-saved'].value = firstId; t.h.nodes['loop-saved'].emit('change');
  assert.equal(t.h.nodes['loop-update'].disabled, true);
  t.h.nodes['loop-update'].emit('click');
  assert.deepEqual(plain(t.state.savedLoops[0]), second);
  t.h.nodes['loop-load'].emit('click'); t.cell(1, 1);
  t.h.nodes['loop-name'].value = 'A 修订'; t.h.nodes['loop-update'].emit('click');
  assert.equal(t.state.savedLoops.length, 2);
  assert.deepEqual(plain(t.state.savedLoops[0]), second);
  assert.equal(t.state.savedLoops[1].id, firstId);
  assert.equal(t.state.savedLoops[1].name, 'A 修订');
  assert.equal(t.state.savedLoops[1].loop.bars[1].steps[1], 'U');
  var draft = plain(t.state.loop);
  t.h.nodes['loop-delete'].emit('click');
  assert.deepEqual(plain(t.state.loop), draft);
  assert.equal(t.state.savedLoops.length, 1);
  assert.equal(t.state.activeSavedId, '');
  assert.equal(t.h.nodes['loop-update'].disabled, true);
});

test('同名和空名称会提示，名称中的 HTML 按文本显示', async function () {
  var t = await setup(); t.mode('loop');
  t.h.nodes['loop-name'].value = ' '; t.h.nodes['loop-save'].emit('click');
  assert.equal(t.state.savedLoops.length, 0);
  assert.equal(t.h.nodes['loop-name'].focused, true);
  var name = '<b>我的练习</b>';
  t.h.nodes['loop-name'].value = name; t.h.nodes['loop-save'].emit('click');
  var option = t.h.nodes['loop-saved'].children[t.h.nodes['loop-saved'].children.length - 1];
  assert.ok(option.textContent.indexOf(name) === 0); assert.equal(option.innerHTML, '');
  t.h.nodes['loop-save'].emit('click');
  assert.equal(t.state.savedLoops.length, 1);
  assert.ok(t.h.nodes['loop-save-status'].textContent.indexOf('同名') !== -1);
});

test('存储失败不改变保存列表或旧版本，并给出失败提示', async function () {
  var t = await setup(); t.mode('loop');
  t.h.nodes['loop-name'].value = 'A'; t.h.nodes['loop-save'].emit('click');
  var oldItems = plain(t.state.savedLoops), stored = t.storage['music.rhythm.savedLoops'];
  var setItem = t.h.window.localStorage.setItem;
  t.h.window.localStorage.setItem = function (key, value) {
    if (key === 'music.rhythm.savedLoops') throw new Error('quota');
    setItem(key, value);
  };
  t.cell(0, 0); t.h.nodes['loop-update'].emit('click');
  assert.deepEqual(plain(t.state.savedLoops), oldItems);
  assert.equal(t.storage['music.rhythm.savedLoops'], stored);
  assert.equal(t.h.nodes['loop-save-status'].classList.contains('is-error'), true);
  t.h.nodes['loop-name'].value = 'B'; t.h.nodes['loop-save'].emit('click');
  assert.deepEqual(plain(t.state.savedLoops), oldItems);
  t.h.nodes['loop-delete'].emit('click');
  assert.deepEqual(plain(t.state.savedLoops), oldItems);
});

test('不兼容的已保存版本保留在列表，载入失败保留当前循环', async function () {
  var t = await setup(); t.mode('loop');
  var loop = plain(t.state.loop); loop.instrument = 'retired';
  var stored = { version: 1, items: [{ id: 'loop-old', name: '旧练习', bpm: 75, loop: loop }] };
  var restored = await setup({ 'music.rhythm.savedLoops': JSON.stringify(stored) });
  restored.mode('loop'); var draft = plain(restored.state.loop);
  restored.h.nodes['loop-saved'].value = 'loop-old'; restored.h.nodes['loop-saved'].emit('change');
  restored.h.nodes['loop-load'].emit('click');
  assert.deepEqual(plain(restored.state.loop), draft);
  assert.equal(restored.state.savedLoops.length, 1);
  assert.ok(restored.h.nodes['loop-save-status'].textContent.indexOf('不兼容') !== -1);
  restored.h.nodes['loop-name'].value = '新练习'; restored.h.nodes['loop-save'].emit('click');
  assert.equal(restored.state.savedLoops.length, 2);
  assert.equal(restored.state.savedLoops[1].id, 'loop-old');
});

test('小节增减保留已有编辑，新增小节是独立副本，边界输入有效', async function () {
  var t = await setup(); t.mode('loop'); t.cell(3, 1);
  var original = plain(t.state.loop.bars);
  t.start(); var cancelled = t.cancelled(); t.count(6);
  assert.equal(t.running(), false); assert.ok(t.cancelled() > cancelled);
  assert.equal(t.state.loop.bars.length, 6);
  assert.deepEqual(plain(t.state.loop.bars.slice(0, 4)), original);
  assert.deepEqual(plain(t.state.loop.bars[4]), original[3]);
  t.cell(4, 1);
  assert.equal(t.state.loop.bars[3].steps[1], 'U');
  assert.equal(t.state.loop.bars[4].steps[1], 'x');
  assert.equal(t.state.loop.bars[5].steps[1], 'U');
  t.count(3); assert.deepEqual(plain(t.state.loop.bars), original.slice(0, 3));
  t.count(1); t.mode('pattern'); t.mode('loop');
  assert.equal(t.state.loop.bars.length, 1);
  t.count(32); assert.equal(t.state.loop.bars.length, 32);
  [0, 33, 2.5, '', 'bad'].forEach(function (count) {
    t.count(count); assert.equal(t.state.loop.bars.length, 32); assert.equal(t.h.nodes['loop-count'].value, '32');
  });
});

test('任意小节数按最后一小节回到第一小节，点亮和模板填充适配数量', async function () {
  for (var count of [1, 3, 8, 32]) {
    var t = await setup(); t.mode('loop'); t.count(count);
    t.start();
    var localCount = t.state.loop.beats * t.state.loop.subdivision;
    t.step(localCount * (count - 1), 0.1); t.paint(0.1);
    assert.equal(t.h.nodes['loop-bar-' + (count - 1)].classList.contains('is-current-bar'), true);
    assert.ok(t.h.nodes['rhythm-playback-status'].textContent.indexOf('/ ' + count + ' 小节') !== -1);
    t.step(localCount * count, 0.2); t.paint(0.2);
    assert.equal(t.h.nodes['loop-bar-0'].classList.contains('is-current-bar'), true);
    t.h.window.Rhythm.stop();
    assert.equal(t.h.nodes['loop-bar-0'].classList.contains('is-current-bar'), false);
    t.template('folk'); t.h.nodes['loop-fill'].emit('click');
    assert.equal(t.state.loop.bars.length, count);
    assert.ok(t.state.loop.bars.every(function (bar) { return bar.steps.length === 8 && bar.patternId === 'folk'; }));
  }
});

test('吉他和尤克里里音色选择使用正确弦数，数量与音色保存后可恢复', async function () {
  var t = await setup(); t.mode('loop'); t.count(7); t.cell(6, 0);
  t.h.nodes['loop-instrument'].value = 'guitar'; t.h.nodes['loop-instrument'].emit('change');
  t.start(); t.step(0, 0.1);
  assert.equal(t.strokes[0].instrument, 'guitar'); assert.equal(t.strokes[0].freqs.length, 6);
  t.h.nodes['loop-name'].value = '吉他七小节'; t.h.nodes['loop-save'].emit('click');
  var id = t.state.savedLoops[0].id;
  t.h.nodes['loop-instrument'].value = 'ukulele'; t.h.nodes['loop-instrument'].emit('change');
  assert.equal(t.running(), false);
  assert.equal(t.state.loop.bars[6].steps[0], 'U');
  t.start(); t.step(0, 0.2);
  assert.equal(t.strokes[1].instrument, 'ukulele'); assert.equal(t.strokes[1].freqs.length, 4);
  t.h.window.Rhythm.stop();
  var restored = await setup(t.storage);
  assert.equal(restored.state.loop.bars.length, 7); assert.equal(restored.state.loop.instrument, 'ukulele');
  restored.h.nodes['loop-saved'].value = id; restored.h.nodes['loop-saved'].emit('change');
  restored.h.nodes['loop-load'].emit('click');
  assert.equal(restored.state.loop.bars.length, 7); assert.equal(restored.state.loop.instrument, 'guitar');
  assert.equal(restored.h.nodes['loop-count'].value, '7');
  assert.equal(restored.h.nodes['loop-instrument'].value, 'guitar');
});

test('旧四小节版本继续载入，越界小节数的存储数据不破坏草稿', async function () {
  var t = await setup(); t.mode('loop');
  var legacy = plain(t.state.loop);
  var saved = { version: 1, items: [{ id: 'loop-legacy', name: '旧四小节', bpm: 75, loop: legacy }] };
  var restored = await setup({ 'music.rhythm.savedLoops': JSON.stringify(saved) });
  restored.h.nodes['loop-saved'].value = 'loop-legacy'; restored.h.nodes['loop-saved'].emit('change');
  restored.h.nodes['loop-load'].emit('click');
  assert.deepEqual(plain(restored.state.loop), legacy);
  for (var count of [0, 33]) {
    var invalid = plain(legacy); invalid.bars = Array(count).fill(legacy.bars[0]);
    var fallback = await setup({ 'music.rhythm.loop': JSON.stringify(invalid) });
    assert.equal(fallback.state.loop.enabled, false);
    fallback.mode('loop'); assert.equal(fallback.state.loop.bars.length, 4);
  }
});
