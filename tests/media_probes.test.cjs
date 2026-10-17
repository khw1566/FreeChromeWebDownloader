const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('size probes skip YouTube/segments and use HEAD without downloading bodies', async () => {
  const event = { addListener() {} };
  const chrome = { webRequest: { onBeforeRequest: event, onHeadersReceived: event }, tabs: { onRemoved: event, onUpdated: event }, downloads: { onChanged: event }, runtime: { onMessage: event, sendMessage: async () => {} } };
  const requests = [];
  let canceled = 0;
  const context = vm.createContext({ chrome, importScripts() {}, URL, AbortSignal, console,
    fetch: async (url, options) => { requests.push(options); return { ok: true, headers: { get: () => '1000' }, body: { cancel: async () => { canceled++; } } }; } });
  vm.runInContext(fs.readFileSync('background.js', 'utf8') + '\nglobalThis.mediaTracker = tracker;', context);
  const tracker = context.mediaTracker;
  await tracker.calculateSize({ url: 'https://rr1.googlevideo.com/videoplayback?range=0-1', size: 0 });
  await tracker.calculateSize({ url: 'https://example.com/segment.m4s', size: 0 });
  assert.equal(requests.length, 0);
  assert.equal(await tracker.fetchContentLength('https://example.com/video.mp4'), 1000);
  assert.equal(requests[0].method, 'HEAD');
  assert.equal(canceled, 1);
});
