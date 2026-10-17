const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.MEDIA_TEST_MODULES ? path.join(process.env.MEDIA_TEST_MODULES, 'playwright') : 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MEDIA_TEST_CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 580 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://extension.test/**', route => {
      const file = path.resolve(new URL(route.request().url()).pathname.slice(1));
      assert.ok(file.startsWith(process.cwd() + path.sep));
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
      route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] });
    });
    await page.addInitScript(() => {
      const listeners = [];
      const state = { jobs: [], queued: [] };
      const storage = { appLanguage: 'ko' };
      const get = (keys, callback) => { if (callback) callback(storage); return Promise.resolve(storage); };
      window.fixture = { state, dispatch: message => listeners.forEach(fn => fn(message)) };
      window.chrome = {
        i18n: { getUILanguage: () => 'ko' },
        storage: { local: { get, set: async data => Object.assign(storage, data) }, session: { get, set: async data => Object.assign(storage, data) } },
        tabs: { query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=fixture', title: '현재 페이지 테스트 영상' }], sendMessage: async () => ({ enabled: false }) },
        scripting: { executeScript: async () => {} },
        runtime: {
          getURL: file => 'https://extension.test/' + file,
          onMessage: { addListener: fn => listeners.push(fn) },
          sendMessage: async message => {
            if (message.action === 'HELPER_STATUS') return { success: true, folder: 'Downloads/Media Downloader' };
            if (message.action === 'GET_MEDIA_LIST') return { success: true, mediaList: [
              { url: 'https://example.com/video.mp4', title: '일반 영상.mp4', size: 5000000, contentType: 'video/mp4', type: 'video' },
              { url: 'https://example.com/music.m4a', title: '일반 음원.m4a', size: 200000, contentType: 'audio/mp4', type: 'audio' }
            ] };
            if (message.action === 'GET_DOWNLOAD_JOBS') return { success: true, jobs: state.jobs };
            if (message.action === 'QUEUE_DOWNLOADS') {
              state.queued.push(message);
              const jobs = message.items.map(item => ({ id: String(state.jobs.length++) + item.url, tabId: 1, itemKey: item.url, title: item.title, format: message.format, state: 'queued', createdAt: Date.now(), updatedAt: Date.now(), percent: null }));
              state.jobs = state.jobs.filter(Boolean).concat(jobs);
              return { success: true, added: jobs.length, jobs: state.jobs };
            }
          }
        }
      };
    });
    await page.goto('https://extension.test/popup.html');
    await page.locator('#mediaList .media-item').last().waitFor();
    assert.equal(await page.locator('#mediaList .media-item').count(), 3);
    await page.locator('#selectAllMedia').check();
    assert.equal(await page.locator('#selectionCount').textContent(), '3개 선택');
    await page.locator('#downloadFormat').selectOption('mp3');
    assert.equal(await page.locator('#pageQuality').isDisabled(), true);
    await page.locator('#downloadSelectedBtn').click();
    await page.locator('.download-job').last().waitFor();
    assert.equal(await page.locator('.download-job').count(), 3);
    assert.equal(await page.evaluate(() => fixture.state.queued[0].format), 'mp3');
    await page.evaluate(() => {
      const updates = [{ state: 'downloading', percent: 47, speed: 1048576, eta: 65, totalBytes: 10485760, downloadedBytes: 5000000, height: 1080 }, { state: 'processing', percent: null, stage: 'MP3 변환' }, { state: 'complete', percent: 100, folder: 'Downloads/Media Downloader' }];
      fixture.state.jobs.forEach((job, index) => {
        Object.assign(job, updates[index], { updatedAt: Date.now() });
        fixture.dispatch({ action: 'DOWNLOAD_JOB_UPDATED', job });
      });
    });
    assert.equal(await page.locator('.download-job progress').nth(0).getAttribute('value'), '47');
    assert.equal(await page.locator('.download-job progress').nth(1).getAttribute('value'), null);
    assert.equal(await page.locator('.download-job progress').nth(2).getAttribute('value'), '100');
    assert.match(await page.locator('.job-status').first().textContent(), /1 MB\/s/);
    assert.match(await page.locator('.job-status').first().textContent(), /남은 시간 1분 5초/);
    assert.match(await page.locator('#batchProgressText').textContent(), /완료 1\/3/);
    await page.screenshot({ path: 'tests/popup-progress.png', fullPage: true });
    await page.locator('.add-urls summary').click();
    await page.locator('#videoUrls').fill('https://www.youtube.com/watch?v=second\nhttps://vimeo.com/123456');
    await page.locator('#addVideoUrlsBtn').click();
    assert.equal(await page.locator('#mediaList .media-item').count(), 5);
    // Invalid batch must not partially modify the list.
    await page.locator('#videoUrls').fill('https://example.com/valid\nfile:///bad');
    await page.locator('#addVideoUrlsBtn').click();
    assert.equal(await page.locator('#mediaList .media-item').count(), 5);
    await page.locator('[data-filter="audio"]').click();
    assert.equal(await page.locator('#mediaList .media-item').count(), 1);
    assert.equal(await page.locator('#selectionCount').textContent(), '1개 선택');
    assert.deepEqual(errors, []);
    console.log('Popup GUI: bulk selection, MP3 format, file progress, processing bar, multi-URL input and filtering passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
