// Opt-in Windows integration: real unpacked extension, Chrome downloads and native IPC.
// Requires native/install.ps1 to have connected this checkout's extension ID.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.MEDIA_TEST_MODULES ? path.join(process.env.MEDIA_TEST_MODULES, 'playwright') : 'playwright');

(async () => {
  const root = process.cwd();
  const fixture = path.join(root, 'tests/fixtures/sample.wav');
  assert.ok(fs.existsSync(fixture), 'Run native/test_mp3_integration.py to generate the fixture');
  const video = path.join(root, 'tests/fixtures/sample.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const server = http.createServer((req, res) => {
    if (['/sample.wav', '/sample.mp4'].includes(req.url)) {
      const body = fs.readFileSync(req.url === '/sample.mp4' ? video : fixture);
      res.writeHead(200, { 'Content-Type': req.url === '/sample.mp4' ? 'video/mp4' : 'audio/wav', 'Content-Length': body.length });
      res.end(body);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><video src="/sample.mp4" controls></video>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  const profile = fs.mkdtempSync(path.join(root, 'tests/fixtures/chrome-profile-'));
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.MEDIA_TEST_CHROME,
      headless: true, acceptDownloads: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('video').readyState > 0);
    const tabId = await worker.evaluate(async base => (await chrome.tabs.query({ url: base + '/*' }))[0].id, base);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const status = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'HELPER_STATUS' }));
    assert.equal(status.success, true, JSON.stringify(status));
    const detected = await popup.evaluate(tabId => chrome.runtime.sendMessage({ action: 'GET_MEDIA_LIST', tabId }), tabId);
    assert.ok(detected.mediaList.some(item => item.url === base + '/sample.mp4'), 'Real document_start scanner detects media');
    const runJob = async (item, format) => {
      const started = await popup.evaluate(({ tabId, item, format }) => chrome.runtime.sendMessage({
        action: 'QUEUE_DOWNLOADS', tabId, items: [item], format, quality: '720'
      }), { tabId, item, format });
      assert.equal(started.success, true, JSON.stringify(started));
      const added = started.jobs.find(job => job.itemKey === item.url && job.format === format);
      let finished;
      for (let attempt = 0; attempt < 600; attempt++) {
        const response = await popup.evaluate(tabId => chrome.runtime.sendMessage({ action: 'GET_DOWNLOAD_JOBS', tabId }), tabId);
        finished = response.jobs.find(job => job.id === added.id);
        if (['complete', 'error'].includes(finished.state)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(finished.state, 'complete', JSON.stringify(finished));
    };
    await runJob({ url: base + '/sample.mp4', title: 'extension-integration.mp4' }, 'video');
    await runJob({ url: base + '/sample.wav', title: 'extension-integration.wav' }, 'mp3');
    if (process.env.MEDIA_TEST_YOUTUBE_URL) {
      await runJob({ url: process.env.MEDIA_TEST_YOUTUBE_URL, source: 'page', title: 'YouTube integration' }, 'video');
    }
    console.log('Real extension: DOM detection, native IPC, Chrome file download and native MP3 passed' +
      (process.env.MEDIA_TEST_YOUTUBE_URL ? '; real YouTube download passed' : ''));
  } finally {
    if (context) await context.close();
    assert.ok(profile.startsWith(path.join(root, 'tests/fixtures/chrome-profile-')));
    fs.rmSync(profile, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
