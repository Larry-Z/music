/* 可控浏览器与音频桩，供回归验证和离线音频导出共用。 */
'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

function element() {
  var classes = new Set();
  var listeners = {};
  return {
    value: '', textContent: '', innerHTML: '', style: {}, children: [],
    classList: {
      add: function (name) { classes.add(name); },
      remove: function (name) { classes.delete(name); },
      contains: function (name) { return classes.has(name); },
      toggle: function (name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
    },
    addEventListener: function (name, fn) { listeners[name] = fn; },
    emit: function (name, event) { if (listeners[name]) listeners[name](event); },
    appendChild: function (child) { this.children.push(child); },
    setAttribute: function () {},
    focus: function () { this.focused = true; },
    querySelectorAll: function () { return []; }
  };
}

function audioParam(initial) {
  return {
    events: [], value: initial == null ? 1 : initial,
    valueAtTime: function (time) {
      var value = this.value, previousTime = 0;
      for (var i = 0; i < this.events.length; i++) {
        var event = this.events[i];
        if (event.time > time) {
          if (event.type === 'linear') return value + (event.value - value) * (time - previousTime) / (event.time - previousTime);
          if (event.type === 'ramp' && value > 0 && event.value > 0) {
            return value * Math.pow(event.value / value, (time - previousTime) / (event.time - previousTime));
          }
          return value;
        }
        value = event.value; previousTime = event.time;
      }
      return value;
    },
    setValueAtTime: function (value, time) { this.events.push({ type: 'set', value: value, time: time }); },
    exponentialRampToValueAtTime: function (value, time) { this.events.push({ type: 'ramp', value: value, time: time }); },
    linearRampToValueAtTime: function (value, time) { this.events.push({ type: 'linear', value: value, time: time }); },
    cancelScheduledValues: function (time) { this.events = this.events.filter(function (event) { return event.time < time; }); },
    cancelAndHoldAtTime: function (time) {
      var value = this.valueAtTime(time);
      this.cancelScheduledValues(time);
      this.events.push({ type: 'hold', value: value, time: time });
    }
  };
}

function harness() {
  var nodes = {};
  var timers = new Map();
  var intervals = new Map();
  var timerID = 0;
  var listeners = {};
  var sources = [];
  var gains = [];
  function audioNode() {
    return { frequency: audioParam(440), gain: audioParam(), Q: {}, playbackRate: audioParam(), connections: [],
      connect: function (target) { this.connections.push(target); return target; }, disconnect: function () {} };
  }
  function sourceNode() {
    var node = audioNode();
    node.stops = [];
    node.start = function (time, offset) { this.startTime = time; this.offset = offset || 0; };
    node.stop = function (time) { this.stops.push(time); };
    sources.push(node);
    return node;
  }
  var context = {
    currentTime: 0, sampleRate: 48000, state: 'running', destination: {},
    createOscillator: sourceNode, createBufferSource: sourceNode,
    createGain: function () { var node = audioNode(); gains.push(node); return node; },
    createBiquadFilter: audioNode,
    createBuffer: function (channels, length, rate) {
      var data = new Float32Array(length);
      return { duration: length / rate, sampleRate: rate, getChannelData: function () { return data; } };
    }
  };
  var document = element();
  document.getElementById = function (id) { if (!nodes[id]) nodes[id] = element(); return nodes[id]; };
  document.createElement = element;
  var sandbox = {
    document: document, performance: { now: function () { return 0; } }, navigator: {},
    AudioContext: function () { return context; },
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    setTimeout: function (fn) { timers.set(++timerID, fn); return timerID; },
    clearTimeout: function (id) { timers.delete(id); },
    setInterval: function (fn) { intervals.set(++timerID, fn); return timerID; },
    clearInterval: function (id) { intervals.delete(id); },
    addEventListener: function (name, fn) { listeners[name] = fn; }, removeEventListener: function () {},
    fetch: function () { return Promise.reject(new Error('测试未提供接口数据')); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return {
    window: sandbox, document: document, nodes: nodes, context: context, sources: sources, gains: gains,
    timers: timers, intervals: intervals,
    load: function (name) { vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/js/', name + '.js'), 'utf8'), sandbox); },
    tick: function (time) {
      context.currentTime = time;
      var entry = timers.entries().next().value;
      assert.ok(entry, '应有待执行的时钟回调');
      timers.delete(entry[0]);
      entry[1]();
    }
  };
}

module.exports = { harness: harness, element: element };
