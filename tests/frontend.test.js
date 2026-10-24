/* 浏览器模块回归验证：使用 Node 内置测试工具和可控的 DOM、音频、时钟。 */
'use strict';

var assert = require('node:assert/strict');
var browser = require('./browser-harness');
var harness = browser.harness;
var element = browser.element;
var renderAudio = require('../scripts/render-audio').render;
var test = require('node:test');

function settle() { return new Promise(function (resolve) { setImmediate(resolve); }); }

test('延迟回调跳过漏拍，保持拍位且不补排过期声音', function () {
  var h = harness(); h.load('audio'); h.load('metronome');
  var events = [], skips = [];
  var duration = 60 / 240 / 4;
  var clock = h.window.Metronome.createClock({
    secondsPerStep: function () { return duration; },
    onStep: function (step, time, length) { events.push({ step: step, time: time, duration: length }); },
    onSkip: function (count) { skips.push(count); }
  });
  clock.start(); h.tick(0.025);
  var before = events.length;
  h.tick(10);
  var recovered = events.slice(before);
  assert.equal(skips.length, 1);
  assert.ok(skips[0] > 150);
  assert.ok(recovered.length > 0 && recovered.length <= 3);
  recovered.forEach(function (event) {
    assert.ok(event.time >= 10 && event.time < 10.12);
    assert.ok(Math.abs(event.time - (0.12 + event.step * duration)) < 1e-9);
  });
  duration = 0.1;
  h.tick(10.1);
  assert.equal(events[events.length - 1].duration, 0.1);
  clock.stop();
  assert.equal(h.timers.size, 0);
});

test('步骤回调中停止时钟后，不再排程或留下定时器', function () {
  var h = harness(); h.load('audio'); h.load('metronome');
  var steps = 0;
  var clock = h.window.Metronome.createClock({ secondsPerStep: function () { return 0.05; },
    onStep: function () { steps++; clock.stop(); } });
  clock.start(); h.tick(0.025);
  assert.equal(steps, 1);
  assert.equal(clock.running, false);
  assert.equal(h.timers.size, 0);
});

test('高速交替扫弦的每根弦都在下一次扫弦前起音', function () {
  var h = harness(); h.load('audio');
  var duration = 60 / 240 / 4;
  var freqs = [82.4, 110, 146.8, 196, 246.9, 329.6];
  h.window.MusicAudio.stroke('D', 0.1, 0.75, freqs, true, 'rhythm', 0, 1.8, 'guitar', duration);
  var first = h.sources.slice(0, 6);
  h.window.MusicAudio.stroke('U', 0.1 + duration, 0.75, freqs, false, 'rhythm', 1, 1.8, 'guitar', duration);
  first.forEach(function (source, index) {
    assert.ok(source.startTime + 0.002 < 0.1 + duration);
    assert.ok(h.gains[index].gain.events.some(function (event) { return event.type === 'linear' && event.value > 0.1; }));
  });
  assert.ok(first[5].startTime - first[0].startTime < duration);
  assert.ok(h.sources[6].startTime < h.sources[9].startTime);
});

test('上扫以高音弦为主，并保留未触碰的低音弦共鸣', function () {
  var h = harness(); h.load('audio');
  var frequencies = [82.4, 110, 146.8, 196, 246.9, 329.6];
  h.window.MusicAudio.strum(frequencies, 0.1, 'down', 0.24, 'rhythm', 2.6, 0, 'guitar');
  var bass = h.sources.slice(0, 2), treble = h.sources.slice(2, 6);
  h.window.MusicAudio.strum(frequencies, 0.5, 'up', 0.24, 'rhythm', 2.6, 1, 'guitar');
  assert.equal(h.sources.length, 10);
  bass.forEach(function (source) { assert.equal(source.stops.length, 1); });
  treble.forEach(function (source) { assert.equal(source.stops.length, 2); });
  h.window.MusicAudio.stroke('x', 0.8, 0.75, frequencies, true, 'rhythm', 2, null, 'guitar');
  bass.forEach(function (source) { assert.ok(source.stops[source.stops.length - 1] < 0.83); });
});

test('突然接管扫弦会取消尚未起音的旧弦，停止分组也会取消未来声音', function () {
  var h = harness(); h.load('audio');
  h.window.MusicAudio.strum([82.4, 110, 146.8, 196, 246.9, 329.6], 1, 'down', 0.24, 'rhythm');
  h.window.MusicAudio.strum([], 1.01, 'up', 0, 'rhythm');
  assert.equal(h.sources[5].stops[h.sources[5].stops.length - 1], 1.01);
  assert.ok(!h.gains[5].gain.events.some(function (event) { return event.value > 0.001; }));
  h.window.MusicAudio.click(2, true, 0.7, 'click', 'metronome');
  var metro = h.sources[h.sources.length - 1];
  h.window.MusicAudio.cancelGroup('rhythm');
  h.sources.slice(0, 6).forEach(function (source) { assert.equal(source.stops[source.stops.length - 1], undefined); });
  assert.equal(metro.stops.length, 1);
  h.window.MusicAudio.cancelGroup('metronome');
  assert.equal(metro.stops.length, 2);
});

test('节拍器空格长按只启动一次，离开面板时取消已排程声音', function () {
  var h = harness(); h.load('audio'); h.load('metronome'); h.window.Metronome.init();
  h.nodes['panel-metronome'] = element(); h.nodes['panel-metronome'].classList.add('is-active');
  function space(repeat) { h.document.emit('keydown', { code: 'Space', repeat: repeat, target: { tagName: 'BODY' }, preventDefault: function () {} }); }
  space(false); h.tick(0.025);
  space(true); space(true);
  assert.equal(h.nodes['metro-toggle'].textContent, '停止');
  h.window.Metronome.stop();
  assert.equal(h.nodes['metro-toggle'].textContent, '开始');
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
  h.sources.forEach(function (source) { assert.equal(source.stops[source.stops.length - 1], undefined); });
});

test('两个面板共享接口请求，节奏面板可独立使用接口调弦且过滤空格重复', async function () {
  var h = harness(), calls = [];
  var instrument = { key: 'test-instrument', label: '测试乐器', tuning: ['A3', 'E4', 'A4'], openMidi: [57, 64, 69], strings: 3 };
  var chord = { instrument: instrument.key, name: 'A', root: 'A', quality: 'major', frets: [0, 0, 4], fingers: [0, 0, 1], notes: ['A', 'E', 'C#'], baseFret: 1 };
  var chords = { instruments: [instrument], qualities: [], chords: [chord] };
  var pattern = { id: 'test', name: '测试节奏', instrument: 'both', beats: 4, unit: 4, subdivision: 4, bars: 1, steps: Array(16).fill('D'), accents: [0] };
  h.window.fetch = function (url) { calls.push(url); return Promise.resolve({ ok: true, json: function () { return Promise.resolve(url === '/api/chords' ? chords : { patterns: [pattern], strokeLegend: [] }); } }); };
  ['audio', 'data', 'chords', 'metronome', 'rhythm'].forEach(h.load);
  h.window.Rhythm.init(); h.window.Chords.init();
  await settle();
  assert.equal(calls.filter(function (url) { return url === '/api/chords'; }).length, 1);
  h.window.Chords.state.instruments = [];
  h.nodes['panel-rhythm'] = element(); h.nodes['panel-rhythm'].classList.add('is-active');
  h.document.emit('keydown', { code: 'Space', target: { tagName: 'BODY' }, preventDefault: function () {} });
  h.tick(0.025);
  var played = h.sources[0].buffer;
  assert.ok(played, '节奏面板应使用自己的接口数据播放');
  h.document.emit('keydown', { code: 'Space', repeat: true, target: { tagName: 'BODY' } });
  assert.equal(h.nodes['rhythm-toggle'].textContent, '停止');
  h.window.Rhythm.stop();
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('数据加载失败后允许重试，成功后共享解析结果', async function () {
  var h = harness(), calls = 0;
  h.window.fetch = function () {
    calls++;
    return Promise.resolve(calls === 1 ? { ok: false, status: 503 } : { ok: true, json: function () { return Promise.resolve({ chords: [] }); } });
  };
  h.load('data');
  var failed = h.window.MusicData.load('/api/chords');
  assert.equal(failed, h.window.MusicData.load('/api/chords'));
  await assert.rejects(failed, /503/);
  var data = await h.window.MusicData.load('/api/chords');
  assert.equal(await h.window.MusicData.load('/api/chords'), data);
  assert.equal(calls, 2);
});

test('试听频率来自接口，保持弦序并跳过不弹的弦，未知乐器保持静音', function () {
  var h = harness(); h.load('chords');
  var instruments = [{ key: 'custom', openMidi: [67, 60, 64, 69] }];
  var freqs = h.window.Chords.chordFreqs({ instrument: 'custom', frets: [0, -1, 2, 0] }, instruments);
  assert.equal(freqs.length, 3);
  [67, 66, 69].forEach(function (midi, i) { assert.ok(Math.abs(freqs[i] - 440 * Math.pow(2, (midi - 69) / 12)) < 1e-9); });
  assert.equal(h.window.Chords.chordFreqs({ instrument: 'unknown', frets: [0, 0, 0, 0] }, instruments).length, 0);
});

test('取消麦克风请求后，晚返回的流立即释放且不启动检测', async function () {
  var h = harness(), resolve, stops = 0;
  h.window.navigator.mediaDevices = { getUserMedia: function () { return new Promise(function (done) { resolve = done; }); } };
  h.load('audio'); h.load('tuner'); h.window.Tuner.init();
  h.nodes['tuner-toggle'].emit('click');
  assert.equal(h.window.Tuner.state.starting, true);
  h.window.Tuner.stop();
  resolve({ getTracks: function () { return [{ stop: function () { stops++; } }]; } });
  await settle();
  assert.equal(stops, 1); assert.equal(h.window.Tuner.state.running, false); assert.equal(h.timers.size, 0);
});

test('拨弦衰减后结算并冻结读数，下一次拨弦重新拾音', function () {
  var h = harness(); h.load('tuner'); h.window.Tuner.init();
  var freq = 440 * Math.pow(2, 12 / 1200);
  var state = h.window.Tuner.state;
  state.buffer = new Float32Array(4096);
  state.analyser = { context: { sampleRate: 48000 }, getFloatTimeDomainData: function (buffer) {
    for (var i = 0; i < buffer.length; i++) buffer[i] = freq ? 0.15 * Math.sin(2 * Math.PI * freq * i / 48000) : 0;
  } };
  for (var i = 0; i < 12; i++) h.window.Tuner.analyze();
  freq = 0;
  for (var j = 0; j < 4; j++) h.window.Tuner.analyze();
  assert.equal(state.verdict.label, 'A4'); assert.ok(Math.abs(state.verdict.cents - 12) < 2);
  var frozen = h.nodes['tuner-freq'].textContent;
  for (var k = 0; k < 10; k++) h.window.Tuner.analyze();
  assert.equal(h.nodes['tuner-freq'].textContent, frozen);
  freq = 440; h.window.Tuner.analyze();
  assert.equal(state.sessionActive, true); assert.equal(state.samples.length, 1);
});

test('两种乐器在常用采样率下合成的单音保持准确音高', function () {
  [44100, 48000].forEach(function (rate) {
    ['guitar', 'ukulele'].forEach(function (instrument) {
      var frequencies = instrument === 'guitar' ? [82.406889, 146.832384, 329.627557, 659.255114] : [261.625565, 391.995436, 440, 659.255114];
      frequencies.forEach(function (frequency) {
        var h = harness(); h.context.sampleRate = rate; h.load('audio'); h.load('tuner');
        h.window.MusicAudio.pluck(frequency, 0.01, 0.6, 1, 'measure', 0, instrument);
        var audio = renderAudio(h, 1.05);
        var frame = audio.slice(Math.floor(rate * 0.16), Math.floor(rate * 0.16) + 4096);
        var detected = h.window.Tuner.detectPitch(frame, rate, 55, 900);
        assert.ok(detected.freq > 0, instrument + ' 应能识别到基频');
        var cents = 1200 * Math.log2(detected.freq / frequency);
        assert.ok(Math.abs(cents) < 3, instrument + ' ' + frequency + ' Hz 偏差 ' + cents + ' 音分');
      });
    });
  });
});

test('尼龙弦的泛音更柔和、衰减更快，钢弦保留更多明亮泛音', function () {
  function energy(data, start, end) {
    var sum = 0;
    for (var i = start; i < end; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / (end - start));
  }
  function centroid(data) {
    var sum = 0, moment = 0, length = 4096;
    for (var harmonic = 1; harmonic <= 16; harmonic++) {
      var re = 0, im = 0;
      for (var i = 0; i < length; i++) {
        var value = data[960 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1)));
        var phase = 2 * Math.PI * 440 * harmonic * i / 48000;
        re += value * Math.cos(phase); im += value * Math.sin(phase);
      }
      var power = re * re + im * im;
      sum += power; moment += power * harmonic;
    }
    return moment / sum;
  }
  var traits = {};
  ['guitar', 'ukulele'].forEach(function (instrument) {
    var h = harness(); h.load('audio');
    h.window.MusicAudio.pluck(440, 0.01, 0.3, 1.6, 'measure', 0, instrument);
    var data = h.sources[0].buffer.getChannelData(0);
    traits[instrument] = { brightness: centroid(data), tail: energy(data, 38400, 43200) / energy(data, 480, 4800) };
  });
  assert.ok(traits.guitar.brightness > traits.ukulele.brightness * 1.1);
  assert.ok(traits.guitar.tail > traits.ukulele.tail * 2);
});

test('240 BPM 连续交替扫弦没有削波，零音量扫弦保持静音', function () {
  ['guitar', 'ukulele'].forEach(function (instrument) {
    var h = harness(); h.load('audio');
    var frequencies = instrument === 'guitar' ? [82.4, 123.47, 164.81, 207.65, 246.94, 329.63] : [392, 261.63, 329.63, 523.25];
    for (var i = 0; i < 16; i++) h.window.MusicAudio.stroke(i % 2 ? 'U' : 'D', 0.1 + i * 0.0625, 0.75, frequencies, i % 4 === 0, 'rhythm', i, null, instrument, 0.0625);
    var samples = renderAudio(h, 3.5), peak = 0;
    for (var s = 0; s < samples.length; s++) {
      assert.ok(isFinite(samples[s])); peak = Math.max(peak, Math.abs(samples[s]));
    }
    assert.ok(peak > 0.05 && peak < 0.95, instrument + ' 混音峰值 ' + peak);
    var silent = harness(); silent.load('audio');
    silent.window.MusicAudio.stroke('D', 0.1, 0, frequencies, true, 'rhythm', 0, null, instrument, 0.0625);
    assert.equal(silent.sources.length, 0);
  });
});

test('十六分扫弦按各弦触弦时刻接管，同音高的不同弦也独立释放', function () {
  var h = harness(); h.load('audio');
  var frequencies = [82.4, 110, 164.81, 196, 246.94, 164.81];
  h.window.MusicAudio.stroke('D', 0.1, 0.75, frequencies, true, 'rhythm', 0, null, 'guitar', 0.2, { subdivision: 4, position: 0 });
  var first = h.sources.slice();
  h.window.MusicAudio.stroke('D', 0.3, 0.75, frequencies, false, 'rhythm', 2, null, 'guitar', 0.2, { subdivision: 4, position: 2 });
  var next = h.sources.slice(6);
  first.forEach(function (source, i) {
    var held = h.gains[i].gain.events.find(function (event) { return event.type === 'hold'; });
    assert.ok(Math.abs(held.time - next[i].startTime) < 1e-9, '旧弦应在自己的触弦时刻释放');
    var end = source.stops[source.stops.length - 1];
    assert.ok(end - held.time < 0.03, '释放不能持续到下一次十六分扫弦');
  });
  assert.ok(first[5].stops[1] > first[2].stops[1], '同音高的两根弦应分别接管');
  assert.ok(next[5].startTime - next[0].startTime < 0.04, '十六分扫弦应紧凑地展开');
});

test('十六分的弱格更轻柔，八分细分不会因为速度快被误用弱格音色', function () {
  var frequencies = [82.4, 110, 146.8, 196, 246.94, 329.63];
  function play(subdivision, position, accent) {
    var h = harness(); h.load('audio');
    h.window.MusicAudio.stroke('D', 0.1, 0.75, frequencies, accent, 'rhythm', position, null, 'guitar', 0.1,
      { subdivision: subdivision, position: position });
    return h;
  }
  var strong = play(4, 0, true), weak = play(4, 1, false), fastEighth = play(2, 1, false);
  var peak = function (h) { return h.gains[0].gain.events.find(function (event) { return event.type === 'linear'; }).value; };
  assert.ok(peak(weak) < peak(strong) * 0.5);
  assert.ok(peak(fastEighth) > peak(weak) * 1.4);
  var attack = function (h) { return h.gains[0].gain.events.find(function (event) { return event.type === 'linear'; }).time - 0.1; };
  assert.ok(attack(weak) > attack(fastEighth));
});

test('连续十六分起音有变化且缓存复用，空拍保持延音、换和弦收住旧音', function () {
  var h = harness(); h.load('audio');
  var frequencies = [82.4, 110, 146.8, 196, 246.94, 329.63], variants = new Set();
  for (var i = 0; i < 24; i++) {
    var before = h.sources.length;
    h.window.MusicAudio.stroke('D', 0.1 + i * 0.1, 0.75, frequencies, true, 'rhythm', i, null, 'guitar', 0.1,
      { subdivision: 4, position: i % 4 });
    variants.add(h.sources[before].buffer);
  }
  assert.ok(variants.size > 1 && variants.size <= 4, '同一根弦应在多个缓存起音间变化');
  var current = h.sources[h.sources.length - 1];
  var stops = current.stops.length;
  h.window.MusicAudio.stroke('-', 2.6, 0.75, frequencies, false, 'rhythm', 24, null, 'guitar', 0.1);
  assert.equal(current.stops.length, stops);
  h.window.MusicAudio.stroke('D', 2.7, 0.75, [87.31, 130.81, 174.61, 220, 261.63, 349.23], true, 'rhythm', 25, null, 'guitar', 0.1);
  assert.ok(current.stops[current.stops.length - 1] < 2.75);
});

test('上下扫在等音高等音量下有不同泛音，普通与十六分轻触都保持音准', function () {
  function brightness(data, frequency) {
    var sum = 0, moment = 0, length = 4096;
    for (var harmonic = 1; harmonic <= 16; harmonic++) {
      var re = 0, im = 0;
      for (var i = 0; i < length; i++) {
        var value = data[960 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1)));
        var phase = 2 * Math.PI * frequency * harmonic * i / 48000;
        re += value * Math.cos(phase); im += value * Math.sin(phase);
      }
      var power = re * re + im * im;
      sum += power; moment += harmonic * power;
    }
    return moment / sum;
  }
  ['guitar', 'ukulele'].forEach(function (instrument) {
    [false, true].forEach(function (light) {
      var traits = {}, frequency = 329.627557;
      ['down', 'up'].forEach(function (direction) {
        var h = harness(); h.load('audio'); h.load('tuner');
        h.window.MusicAudio.pluck(frequency, 0.01, 0.6, 1, 'measure', 0, instrument, { direction: direction, light: light });
        traits[direction] = brightness(h.sources[0].buffer.getChannelData(0), frequency);
        var rendered = renderAudio(h, 1.05);
        var found = h.window.Tuner.detectPitch(rendered.slice(7680, 11776), 48000, 55, 900);
        assert.ok(found.freq > 0 && Math.abs(1200 * Math.log2(found.freq / frequency)) < 3);
      });
      assert.ok(traits.up > traits.down * 1.15, instrument + ' 的上扫应有更多高频泛音，不能仅靠音量区分');
    });
  });
});
