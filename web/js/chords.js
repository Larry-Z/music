/* 和弦库：从 /api/chords 拉取尤克里里 / 吉他和弦指法，
 * 用内联 SVG 绘制指法图，点击用 Karplus-Strong 合成拨弦试听。 */
(function (global) {
  'use strict';

  /* 各乐器标准调弦的 MIDI 音高（最粗的弦在前）。 */
  var STRING_MIDI = {
    ukulele: [67, 60, 64, 69],           /* G4 C4 E4 A4 */
    guitar: [40, 45, 50, 55, 59, 64]     /* E2 A2 D3 G3 B3 E4 */
  };

  var ROOT_LABEL = { 'A#': 'Bb' };

  var NUT_Y = 40;
  var FRET_H = 22;
  var FRET_ROWS = 5;

  var state = {
    chords: [],
    instruments: [],
    qualities: [],
    instrument: 'ukulele',
    root: 'all',
    quality: 'all'
  };

  var el = {};

  function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  /* 把和弦指法换算成频率列表（从最粗的弦到最细的弦），不弹的弦跳过。 */
  function chordFreqs(chord) {
    var tuning = STRING_MIDI[chord.instrument] || STRING_MIDI.ukulele;
    var out = [];
    for (var i = 0; i < chord.frets.length; i++) {
      if (chord.frets[i] < 0 || i >= tuning.length) continue;
      out.push(midiToFreq(tuning[i] + chord.frets[i]));
    }
    if (!out.length) out.push(midiToFreq(60));
    return out;
  }

  /* 生成一张指法图的 SVG 字符串，支持 4 弦（尤克里里）与 6 弦（吉他）。
   * chord.baseFret > 1 时指法图从该品位起显示，并在左侧标注「nfr」。 */
  function diagram(chord) {
    var n = chord.frets.length;
    var spacing = n > 4 ? 22 : 24;
    var padX = 18;
    var width = padX * 2 + (n - 1) * spacing;
    var top = NUT_Y;
    var bottom = NUT_Y + FRET_H * FRET_ROWS;
    var height = bottom + 12;
    var left = padX;
    var right = padX + (n - 1) * spacing;
    var base = chord.baseFret > 0 ? chord.baseFret : 1;

    function stringX(i) { return padX + i * spacing; }
    function fretY(fret) { return NUT_Y + (fret - base + 0.5) * FRET_H; }

    var parts = [];

    /* 品丝横线；第 1 品处是琴枕，画粗线 */
    for (var r = 0; r <= FRET_ROWS; r++) {
      var y = NUT_Y + r * FRET_H;
      var isNut = r === 0 && base === 1;
      parts.push('<line x1="' + left + '" y1="' + y + '" x2="' + right + '" y2="' + y +
        '" stroke="' + (isNut ? '#93a4c4' : '#2a3a5c') + '" stroke-width="' + (isNut ? 3 : 1) + '"/>');
    }
    /* 琴弦竖线 */
    for (var s = 0; s < n; s++) {
      parts.push('<line x1="' + stringX(s) + '" y1="' + top + '" x2="' + stringX(s) + '" y2="' + bottom +
        '" stroke="#93a4c4" stroke-width="1.2" opacity="0.75"/>');
    }
    /* 高把位和弦标注起始品位 */
    if (base > 1) {
      parts.push('<text x="' + (left - 6) + '" y="' + (NUT_Y + FRET_H * 0.7) +
        '" fill="#93a4c4" font-size="11" text-anchor="end">' + base + 'fr</text>');
    }

    /* 横按 */
    if (chord.barre > 0) {
      var barred = [];
      for (var b = 0; b < n; b++) {
        if (chord.frets[b] === chord.barre) barred.push(b);
      }
      if (barred.length > 1) {
        var by = fretY(chord.barre);
        parts.push('<rect x="' + (stringX(barred[0]) - 8) + '" y="' + (by - 8) + '" width="' +
          (stringX(barred[barred.length - 1]) - stringX(barred[0]) + 16) +
          '" height="16" rx="8" fill="#2563eb"/>');
      }
    }

    /* 按弦点 / 空弦 / 不弹 */
    for (var i = 0; i < n; i++) {
      var fret = chord.frets[i];
      var x = stringX(i);
      if (fret < 0) {
        parts.push('<text x="' + x + '" y="' + (top - 10) +
          '" fill="#ef4444" font-size="13" text-anchor="middle">×</text>');
      } else if (fret === 0) {
        parts.push('<circle cx="' + x + '" cy="' + (top - 16) +
          '" r="5" fill="none" stroke="#93a4c4" stroke-width="1.6"/>');
      } else {
        var cy = fretY(fret);
        parts.push('<circle cx="' + x + '" cy="' + cy + '" r="8.5" fill="#22d3ee"/>');
        if (chord.fingers[i] > 0) {
          parts.push('<text x="' + x + '" y="' + (cy + 4) +
            '" fill="#06263a" font-size="11" font-weight="700" text-anchor="middle">' +
            chord.fingers[i] + '</text>');
        }
      }
    }

    return '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height +
      '" role="img" aria-label="' + chord.name + ' 指法图">' + parts.join('') + '</svg>';
  }

  function instrumentLabel(key) {
    for (var i = 0; i < state.instruments.length; i++) {
      if (state.instruments[i].key === key) return state.instruments[i].label;
    }
    return key;
  }

  function currentChords() {
    return state.chords.filter(function (c) { return c.instrument === state.instrument; });
  }

  function renderInstrumentFilters() {
    var html = '';
    for (var i = 0; i < state.instruments.length; i++) {
      var in_ = state.instruments[i];
      html += '<button class="chip' + (state.instrument === in_.key ? ' is-active' : '') +
        '" data-instrument="' + in_.key + '">' + in_.label +
        ' <small>' + in_.tuning.join('-') + '</small></button>';
    }
    el.instruments.innerHTML = html;
  }

  function renderInstrumentHeading() {
    for (var i = 0; i < state.instruments.length; i++) {
      var instrument = state.instruments[i];
      if (instrument.key !== state.instrument) continue;
      el.title.textContent = instrument.label + '和弦库';
      el.desc.textContent = '标准 ' + instrument.tuning.join('-') + ' 调弦常用和弦指法。点击和弦图即可试听。';
      return;
    }
  }

  function renderFilters() {
    var list = currentChords();
    var roots = [];
    for (var i = 0; i < list.length; i++) {
      if (roots.indexOf(list[i].root) === -1) roots.push(list[i].root);
    }
    var html = '<button class="chip' + (state.root === 'all' ? ' is-active' : '') + '" data-root="all">全部调</button>';
    for (var k = 0; k < roots.length; k++) {
      html += '<button class="chip' + (state.root === roots[k] ? ' is-active' : '') + '" data-root="' +
        roots[k] + '">' + (ROOT_LABEL[roots[k]] || roots[k]) + '</button>';
    }
    el.roots.innerHTML = html;

    var qhtml = '<button class="chip' + (state.quality === 'all' ? ' is-active' : '') + '" data-quality="all">全部类型</button>';
    for (var q = 0; q < state.qualities.length; q++) {
      qhtml += '<button class="chip' + (state.quality === state.qualities[q].key ? ' is-active' : '') +
        '" data-quality="' + state.qualities[q].key + '">' + state.qualities[q].label + '</button>';
    }
    el.qualities.innerHTML = qhtml;
  }

  function visibleChords() {
    return currentChords().filter(function (c) {
      if (state.root !== 'all' && c.root !== state.root) return false;
      if (state.quality !== 'all' && c.quality !== state.quality) return false;
      return true;
    });
  }

  function displayNotes(chord) {
    return chord.notes.map(function (note) {
      return chord.root === 'A#' && note === 'A#' ? 'Bb' : note;
    });
  }

  function renderGrid() {
    var list = visibleChords();
    if (!list.length) {
      el.grid.innerHTML = '<p class="muted">该筛选条件下没有和弦，换个调或类型试试。</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      html += '<button type="button" class="chord-card" data-name="' + c.name + '" data-instrument="' + c.instrument +
        '" title="点击试听 ' + c.name + '">' +
        '<h4>' + c.name + '</h4>' + diagram(c) +
        '<span class="cc-notes">' + displayNotes(c).join(' · ') + '</span></button>';
    }
    el.grid.innerHTML = html;
  }

  function play(card) {
    var chord = null;
    for (var i = 0; i < state.chords.length; i++) {
      var c = state.chords[i];
      if (c.name === card.dataset.name && c.instrument === card.dataset.instrument) { chord = c; break; }
    }
    if (!chord) return;
    var ctx = global.MusicAudio.unlock();
    global.MusicAudio.cancelGroup('chord-preview');
    global.MusicAudio.strum(chordFreqs(chord), ctx.currentTime + 0.02, 'down', 0.26, 'chord-preview',
      chord.instrument === 'guitar' ? 1.8 : 1.4, null, chord.instrument);
    card.classList.add('is-playing');
    global.setTimeout(function () { card.classList.remove('is-playing'); }, 500);
  }

  function selectInstrument(key) {
    state.instrument = key;
    /* 换乐器后原来的调可能不存在，回到「全部调」 */
    state.root = 'all';
    renderInstrumentFilters();
    renderInstrumentHeading();
    renderFilters();
    renderGrid();
  }

  function init() {
    el.instruments = document.getElementById('chord-instruments');
    el.roots = document.getElementById('chord-roots');
    el.qualities = document.getElementById('chord-qualities');
    el.grid = document.getElementById('chord-grid');
    el.title = document.getElementById('chord-title');
    el.desc = document.getElementById('chord-desc');

    el.instruments.addEventListener('click', function (ev) {
      var chip = ev.target.closest('.chip');
      if (chip) selectInstrument(chip.dataset.instrument);
    });
    el.roots.addEventListener('click', function (ev) {
      var chip = ev.target.closest('.chip');
      if (!chip) return;
      state.root = chip.dataset.root;
      renderFilters();
      renderGrid();
    });
    el.qualities.addEventListener('click', function (ev) {
      var chip = ev.target.closest('.chip');
      if (!chip) return;
      state.quality = chip.dataset.quality;
      renderFilters();
      renderGrid();
    });
    el.grid.addEventListener('click', function (ev) {
      var card = ev.target.closest('.chord-card');
      if (card) play(card);
    });

    fetch('/api/chords').then(function (r) {
      if (!r.ok) throw new Error('/api/chords 返回 HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      state.chords = data.chords || [];
      state.instruments = data.instruments || [];
      state.qualities = data.qualities || [];
      if (!state.instruments.length) throw new Error('接口没有返回乐器信息');
      if (!state.chords.length) throw new Error('接口没有返回和弦数据');
      var known = state.instruments.some(function (i) { return i.key === state.instrument; });
      if (!known) state.instrument = state.instruments[0].key;
      renderInstrumentFilters();
      renderInstrumentHeading();
      renderFilters();
      renderGrid();
    }).catch(function (err) {
      el.grid.innerHTML = '<p class="muted">和弦数据加载失败：' + String(err) + '</p>';
    });
  }

  function stopPreview() {
    global.MusicAudio.cancelGroup('chord-preview');
    if (!el.grid) return;
    var cards = el.grid.querySelectorAll('.is-playing');
    for (var i = 0; i < cards.length; i++) cards[i].classList.remove('is-playing');
  }

  global.Chords = {
    init: init,
    stop: stopPreview,
    diagram: diagram,
    chordFreqs: chordFreqs,
    stringMidi: STRING_MIDI,
    instrumentLabel: instrumentLabel,
    state: state
  };
})(window);
