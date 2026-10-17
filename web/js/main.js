/* 应用入口：标签页切换、URL hash 深链、各功能模块初始化。 */
(function (global) {
  'use strict';

  var PANELS = ['tuner', 'metronome', 'rhythm', 'chords'];

  function activate(name) {
    if (PANELS.indexOf(name) === -1) name = PANELS[0];
    var tabs = document.getElementById('tabs');
    var nodes = tabs.querySelectorAll('.tab');
    for (var i = 0; i < nodes.length; i++) {
      var active = nodes[i].dataset.panel === name;
      nodes[i].classList.toggle('is-active', active);
      nodes[i].setAttribute('aria-selected', active ? 'true' : 'false');
    }
    var panels = document.querySelectorAll('.panel');
    for (var k = 0; k < panels.length; k++) {
      var panelActive = panels[k].id === 'panel-' + name;
      panels[k].classList.toggle('is-active', panelActive);
      panels[k].setAttribute('aria-hidden', panelActive ? 'false' : 'true');
    }
    /* 离开面板时立即释放麦克风并停止对应声音。 */
    if (name !== 'tuner') global.Tuner.stop();
    if (name !== 'metronome') global.Metronome.stop();
    if (name !== 'rhythm') global.Rhythm.stop();
    if (name !== 'chords') global.Chords.stop();
    return name;
  }

  function initTabs() {
    document.getElementById('tabs').addEventListener('click', function (ev) {
      var btn = ev.target.closest('.tab');
      if (!btn) return;
      global.location.hash = activate(btn.dataset.panel);
    });
    global.addEventListener('hashchange', function () {
      activate(global.location.hash.replace('#', ''));
    });
    activate(global.location.hash.replace('#', ''));
  }

  function initFooter() {
    var info = document.getElementById('footer-info');
    fetch('/api/health').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      info.textContent = 'Go 后端 v' + data.version + ' · Web Audio API 前端 · 无构建步骤';
    }).catch(function () { /* 保留默认文案 */ });
  }

  function init() {
    global.Tuner.init();
    global.Metronome.init();
    global.Rhythm.init();
    global.Chords.init();
    initTabs();
    initFooter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
