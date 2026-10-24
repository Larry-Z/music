/* 导出与页面相同的扫弦音，便于比较音色与检查混音峰值；无需第三方依赖。
 * 用法：node scripts/render-audio.js [输出目录] [可选的 audio.js 路径]
 * 数据来自本地运行的 /api/chords 与 /api/rhythms。 */
'use strict';

var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');
var browser = require('../tests/browser-harness');

function filterCoefficients(node, time, rate) {
  var omega = 2 * Math.PI * node.frequency.valueAtTime(time) / rate;
  var cos = Math.cos(omega), alpha = Math.sin(omega) / (2 * (node.Q.value || 1));
  var a = Math.pow(10, node.gain.value / 40);
  var b0, b1, b2, a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  if (node.type === 'peaking') {
    b0 = 1 + alpha * a; b1 = -2 * cos; b2 = 1 - alpha * a;
    a0 = 1 + alpha / a; a2 = 1 - alpha / a;
  } else if (node.type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha;
  } else {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function render(h, seconds) {
  var rate = h.context.sampleRate;
  var output = new Float32Array(Math.ceil(seconds * rate));
  h.sources.forEach(function (source) {
    if (!source.buffer) throw new Error('导出器只支持缓冲音源');
    var data = source.buffer.getChannelData(0), position = source.offset * source.buffer.sampleRate;
    var stop = source.stops[source.stops.length - 1];
    var end = Math.min(output.length, Math.ceil((stop == null ? seconds : stop) * rate));
    var chain = [], node = source.connections[0];
    while (node && node !== h.context.destination) {
      chain.push({ node: node, memory: [0, 0, 0, 0], coefficients: node.type ? filterCoefficients(node, 0, rate) : null });
      node = node.connections[0];
    }
    for (var sample = Math.ceil(source.startTime * rate); sample < end && position < data.length - 1; sample++) {
      var time = sample / rate, index = Math.floor(position), fraction = position - index;
      var value = data[index] * (1 - fraction) + data[index + 1] * fraction;
      for (var k = 0; k < chain.length; k++) {
        var stage = chain[k], filter = stage.node;
        if (!filter.type) { value *= filter.gain.valueAtTime(time); continue; }
        var coeff = filter.frequency.events.length ? filterCoefficients(filter, time, rate) : stage.coefficients;
        var m = stage.memory;
        var filtered = coeff[0] * value + coeff[1] * m[0] + coeff[2] * m[1] - coeff[3] * m[2] - coeff[4] * m[3];
        m[1] = m[0]; m[0] = value; m[3] = m[2]; m[2] = filtered;
        value = filtered;
      }
      output[sample] += value;
      position += source.playbackRate.valueAtTime(time) * source.buffer.sampleRate / rate;
    }
  });
  return output;
}

function writeWAV(file, samples, rate) {
  var buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples.length * 2, 40);
  var peak = 0, energy = 0;
  for (var i = 0; i < samples.length; i++) {
    if (!isFinite(samples[i])) throw new Error('混音出现无效采样');
    peak = Math.max(peak, Math.abs(samples[i])); energy += samples[i] * samples[i];
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buffer);
  return { file: path.basename(file), peak: peak, rms: Math.sqrt(energy / samples.length) };
}

async function main() {
  var directory = process.argv[2] || '/tmp/music-audio-preview';
  var libraries = await Promise.all(['/api/chords', '/api/rhythms'].map(async function (url) {
    var response = await fetch('http://localhost:8080' + url);
    if (!response.ok) throw new Error(url + ' 返回 HTTP ' + response.status);
    return response.json();
  }));
  var library = libraries[0];
  var pattern = libraries[1].patterns.find(function (p) { return p.id === 'folk-ddu-udu'; });
  fs.mkdirSync(directory, { recursive: true });
  var report = [];
  ['guitar', 'ukulele'].forEach(function (instrument) {
    function setup() {
      var h = browser.harness();
      if (process.argv[3]) vm.runInContext(fs.readFileSync(process.argv[3], 'utf8'), h.window);
      else h.load('audio');
      h.load('chords'); return h;
    }
    function chord(name) { return library.chords.find(function (c) { return c.instrument === instrument && c.name === name; }); }
    var h = setup();
    var freqs = h.window.Chords.chordFreqs(chord('C'), library.instruments);
    h.window.MusicAudio.strum(freqs, 0.1, 'down', 0.26, 'preview', null, 0, instrument);
    h.window.MusicAudio.strum(freqs, 3.2, 'up', 0.26, 'preview', null, 1, instrument);
    report.push(writeWAV(path.join(directory, instrument + '-strum.wav'), render(h, 6.2), h.context.sampleRate));
    h = setup();
    ['down', 'up', 'down', 'up'].forEach(function (direction, index) {
      /* 相同和弦、相同输入音量，单独比较方向造成的音色差异。 */
      h.window.MusicAudio.strum(freqs, 0.1 + index * 1.8, direction, 0.26, 'direction-preview', 1.6, 0, instrument);
    });
    report.push(writeWAV(path.join(directory, instrument + '-down-up.wav'), render(h, 7.2), h.context.sampleRate));
    h = setup();
    var length = 60 / 75 / pattern.subdivision;
    ['C', 'Am', 'F', 'G'].forEach(function (name, bar) {
      var frequencies = h.window.Chords.chordFreqs(chord(name), library.instruments);
      pattern.steps.forEach(function (mark, step) {
        var index = bar * pattern.steps.length + step;
        h.window.MusicAudio.stroke(mark, 0.1 + index * length, 0.75, frequencies, pattern.accents.indexOf(step) !== -1,
          'rhythm', index, null, instrument, length, { subdivision: pattern.subdivision, position: step % pattern.subdivision });
      });
    });
    report.push(writeWAV(path.join(directory, instrument + '-rhythm.wav'), render(h, 15.5), h.context.sampleRate));
    var sixteenth = libraries[1].patterns.find(function (p) { return p.id === 'sixteenth-alternate'; });
    [75, 120, 180].forEach(function (bpm) {
      var fast = setup();
      var interval = 60 / bpm / sixteenth.subdivision;
      ['C', 'Am', 'F', 'G'].forEach(function (name, bar) {
        var frequencies = fast.window.Chords.chordFreqs(chord(name), library.instruments);
        sixteenth.steps.forEach(function (mark, step) {
          var index = bar * sixteenth.steps.length + step;
          fast.window.MusicAudio.stroke(mark, 0.1 + index * interval, 0.75, frequencies, sixteenth.accents.indexOf(step) !== -1,
            'rhythm', index, null, instrument, interval, { subdivision: 4, position: step % 4 });
        });
      });
      report.push(writeWAV(path.join(directory, instrument + '-sixteenth-' + bpm + '.wav'),
        render(fast, 0.1 + interval * 64 + 3), fast.context.sampleRate));
    });
  });
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch(function (error) { console.error(error); process.exitCode = 1; });
module.exports = { render: render, writeWAV: writeWAV };
