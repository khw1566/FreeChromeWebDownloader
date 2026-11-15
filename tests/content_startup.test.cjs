const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('document_start waits for DOM, detects video, and reinjection replays URLs', () => {
  const listeners = new Map();
  const messages = [];
  let observations = 0;
  const document = {
    readyState: 'loading', documentElement: null, head: null, body: null,
    addEventListener: (name, fn) => listeners.set(name, fn),
    createElement: () => ({ remove() {} }),
    querySelectorAll: selector => selector === 'video' ? [{ src: 'https://example.com/a.m3u8', currentSrc: '' }] : []
  };
  const context = vm.createContext({
    document, window: { addEventListener() {} },
    chrome: { runtime: { getURL: file => file, onMessage: { addListener() {} }, sendMessage: message => { messages.push(message); return Promise.resolve(); } } },
    performance: { getEntriesByType: () => [] },
    MutationObserver: class { observe(target) { assert.ok(target); observations++; } },
    URL, console, setTimeout, clearTimeout
  });
  const source = fs.readFileSync('content.js', 'utf8');
  vm.runInContext(source, context);
  assert.equal(observations, 0);
  document.documentElement = { appendChild() {} };
  listeners.get('DOMContentLoaded')();
  assert.equal(observations, 1);
  assert.equal(messages[0].items[0].isHls, true);
  assert.equal(messages[0].items[0].contentType, 'application/vnd.apple.mpegurl');
  vm.runInContext(source, context);
  assert.equal(messages.length, 2);
  assert.equal(observations, 1);
});
