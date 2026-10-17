const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup(saved = []) {
  const ports = [];
  const downloads = new Map();
  const storage = { downloadQueue: saved };
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, fire(data) { this.listeners.forEach(fn => fn(data)); } });
  const chrome = {
    tabs: { get: async id => ({ id, url: 'https://www.youtube.com/watch?v=test', title: 'Test' }) },
    storage: { session: { get: async () => storage, set: async data => Object.assign(storage, JSON.parse(JSON.stringify(data))) } },
    runtime: {
      id: 'test', onMessage: event(), sendMessage: async () => {},
      connectNative: () => {
        const port = { onMessage: event(), onDisconnect: event(), postMessage(data) { this.request = data; }, disconnect() { this.onDisconnect.fire(); } };
        ports.push(port);
        return port;
      }
    },
    downloads: {
      onChanged: event(),
      download: async options => { const id = downloads.size + 1; downloads.set(id, { id, state: 'in_progress', bytesReceived: 10, totalBytes: 100, paused: false, filename: options.filename }); return id; },
      search: async ({ id }) => downloads.has(id) ? [downloads.get(id)] : []
    }
  };
  const context = vm.createContext({ chrome, console, crypto, URL });
  vm.runInContext(fs.readFileSync('native_bridge.js', 'utf8') + '\nglobalThis.queue = downloadQueue;', context);
  await context.queue.ready;
  return { queue: context.queue, ports, downloads, storage };
}
const pages = count => Array.from({ length: count }, (_, i) => ({ url: 'https://example.com/video/' + i, source: 'page', title: 'Video ' + i }));

test('three concurrent jobs, duplicate rejection, failure advances remaining queue', async () => {
  const { queue, ports, storage } = await setup();
  const response = await queue.enqueue({ tabId: 1, format: 'mp3', items: pages(5) });
  await settle();
  assert.equal(response.added, 5);
  assert.equal(ports.length, 3);
  assert.equal([...queue.jobs.values()].filter(job => job.state === 'queued').length, 2);
  assert.equal(ports[0].request.format, 'mp3');
  const duplicates = await queue.enqueue({ tabId: 1, format: 'mp3', items: pages(5) });
  assert.equal(duplicates.skipped, 5);
  ports[0].onMessage.fire({ state: 'error', error: 'fixture failure' });
  await settle();
  assert.equal(ports.length, 4);
  ports[1].onMessage.fire({ state: 'complete', percent: 100 });
  await settle();
  assert.equal(ports.length, 5);
  assert.equal(storage.downloadQueue.filter(job => job.state === 'starting').length, 3);
  assert.equal(storage.downloadQueue.filter(job => job.state === 'error').length, 1);
});

test('direct progress uses actual Chrome counters and interruption releases slot', async () => {
  const { queue, downloads } = await setup();
  await queue.enqueue({ tabId: 1, items: [{ url: 'https://example.com/test.mp4', title: 'test.mp4' }] });
  await settle();
  const job = [...queue.jobs.values()][0];
  assert.equal(job.percent, 10);
  downloads.get(job.downloadId).totalBytes = -1;
  await queue.refreshDirect();
  assert.equal(job.percent, null);
  Object.assign(downloads.get(job.downloadId), { state: 'interrupted', error: 'USER_CANCELED' });
  await queue.refreshDirect();
  assert.equal(job.state, 'error');
  assert.equal(job.error, 'USER_CANCELED');
});

test('Googlevideo is routed to the page and filename is safe', async () => {
  const { queue, ports } = await setup();
  await queue.enqueue({ tabId: 1, items: [{ url: 'https://r1.googlevideo.com/videoplayback?range=1-2' }] });
  await settle();
  assert.equal(ports[0].request.url, 'https://www.youtube.com/watch?v=test');
  assert.equal(queue.filename('CON.mp4'), 'media_CON.mp4');
  assert.equal(queue.filename('../bad:name.mp4'), '.._bad_name.mp4');
});

test('worker restore does not restart disconnected native jobs', async () => {
  const { queue, ports } = await setup([{ id: 'old', tabId: 1, engine: 'native', state: 'downloading', url: 'https://example.com' }]);
  await settle();
  assert.equal(queue.jobs.get('old').state, 'error');
  assert.equal(ports.length, 0);
});

test('entire invalid batch rejected without partial enqueue', async () => {
  const { queue } = await setup();
  await assert.rejects(() => queue.enqueue({ tabId: 1, items: [...pages(1), { url: 'file:///C:/secret' }] }));
  assert.equal(queue.jobs.size, 0);
});
