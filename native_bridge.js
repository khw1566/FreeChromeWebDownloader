// One queue for page videos, detected files and MP3 conversions.
class DownloadQueue {
  constructor() {
    this.jobs = new Map();
    this.ports = new Map();
    this.limit = 3;
    this.saving = Promise.resolve();
    this.ready = this.restore();
    chrome.downloads.onChanged.addListener(() => this.ready.then(() => this.refreshDirect()).catch(console.error));
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== chrome.runtime.id || sender.tab) return false;
      if (message?.action === 'HELPER_STATUS') {
        chrome.runtime.sendNativeMessage('com.media_downloader.helper', { action: 'status' }, result => {
          const error = chrome.runtime.lastError;
          reply(error ? { success: false, error: '보조 프로그램 연결 실패. README.md의 설치 안내를 확인하세요.' } : result);
        });
        return true;
      }
      if (!['QUEUE_DOWNLOADS', 'GET_DOWNLOAD_JOBS'].includes(message?.action)) return false;
      this.ready.then(async () => {
        if (message.action === 'QUEUE_DOWNLOADS') return this.enqueue(message);
        await this.refreshDirect();
        return { success: true, jobs: this.snapshot(message.tabId) };
      }).then(reply, error => reply({ success: false, error: error.message }));
      return true;
    });
  }

  async restore() {
    const saved = await chrome.storage.session.get('downloadQueue');
    for (const job of saved.downloadQueue || []) {
      if (this.isActive(job) && job.engine === 'native') {
        job.state = 'error';
        job.error = '연결이 끊겼습니다. 저장 폴더를 확인한 후 다시 시도하세요.';
      }
      if (job.state === 'starting' && !job.downloadId) {
        job.state = 'error';
        job.error = '다운로드 시작이 중단되었습니다. 다시 시도하세요.';
      }
      this.jobs.set(job.id, job);
    }
    await this.refreshDirect();
    this.pump();
  }

  isActive(job) { return ['starting', 'downloading', 'processing'].includes(job.state); }
  snapshot(tabId) { return [...this.jobs.values()].filter(job => job.tabId === tabId); }

  async persist() {
    const snapshot = [...this.jobs.values()].map(job => ({ ...job }));
    this.saving = this.saving.catch(() => {}).then(() => chrome.storage.session.set({ downloadQueue: snapshot }));
    await this.saving;
  }

  update(job, data) {
    Object.assign(job, data, { updatedAt: Date.now() });
    this.persist().catch(console.error);
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_JOB_UPDATED', job: { ...job } }).catch(() => {});
  }

  async enqueue(message) {
    const tab = await chrome.tabs.get(message.tabId);
    if (!Array.isArray(message.items) || !message.items.length || message.items.length > 100) throw new Error('한 번에 1~100개 항목을 선택해 주세요.');
    const format = message.format || 'video';
    const quality = message.quality || '1080';
    if (!['video', 'mp3'].includes(format) || !['best', '1080', '720'].includes(quality)) throw new Error('다운로드 형식 또는 화질이 올바르지 않습니다.');
    const prepared = message.items.map(item => {
      const url = new URL(item.source === 'current-page' ? tab.url : item.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('웹 영상 주소만 사용할 수 있습니다.');
      const page = ['page', 'current-page'].includes(item.source);
      const youtubeStream = /(^|\.)googlevideo\.com$/i.test(url.hostname);
      const downloadUrl = youtubeStream ? tab.url : url.href;
      if (!/^https?:\/\//i.test(downloadUrl || '')) throw new Error('영상 페이지 주소를 찾을 수 없습니다.');
      return {
        itemKey: item.url, url: downloadUrl, title: String(item.title || tab.title || 'media').slice(0, 300),
        engine: page || youtubeStream || format === 'mp3' || item.isHls || /\.(m3u8|mpd)(?:[?#]|$)/i.test(url.href) || /mpegurl|dash\+xml/i.test(item.contentType || '') ? 'native' : 'direct',
        source: item.source || 'media', format, quality, tabId: tab.id
      };
    });
    const added = [];
    let skipped = 0;
    for (const item of prepared) {
      if ([...this.jobs.values()].some(job => job.url === item.url && job.format === format && (job.state === 'queued' || this.isActive(job)))) {
        skipped++;
        continue;
      }
      const job = { ...item, id: crypto.randomUUID(), state: 'queued', percent: null, createdAt: Date.now() };
      this.jobs.set(job.id, job);
      added.push(job);
    }
    const history = [...this.jobs.values()].filter(job => ['complete', 'error'].includes(job.state));
    history.slice(0, Math.max(0, history.length - 200)).forEach(job => this.jobs.delete(job.id));
    await this.persist();
    this.pump();
    return { success: true, added: added.length, skipped, jobs: this.snapshot(tab.id) };
  }

  pump() {
    let available = this.limit - [...this.jobs.values()].filter(job => this.isActive(job)).length;
    for (const job of this.jobs.values()) {
      if (available <= 0) break;
      if (job.state !== 'queued') continue;
      available--;
      this.update(job, { state: 'starting', percent: null });
      this.saving.then(() => job.engine === 'native' ? this.startNative(job) : this.startDirect(job))
        .catch(error => this.finish(job, { state: 'error', error: error.message }));
    }
  }

  finish(job, data) {
    this.update(job, data);
    const port = this.ports.get(job.id);
    this.ports.delete(job.id);
    if (port) port.disconnect();
    this.pump();
  }

  startNative(job) {
    const port = chrome.runtime.connectNative('com.media_downloader.helper');
    this.ports.set(job.id, port);
    port.onMessage.addListener(data => {
      const progress = { state: data.state, percent: data.percent ?? null, folder: data.folder, error: data.error, stage: data.stage,
        speed: data.speed ?? null, eta: data.eta ?? null, totalBytes: data.totalBytes ?? null,
        downloadedBytes: data.downloadedBytes ?? null, height: data.height ?? null };
      if (['complete', 'error'].includes(data.state)) this.finish(job, progress);
      else if (['starting', 'downloading', 'processing'].includes(data.state)) this.update(job, progress);
    });
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message;
      if (!this.ports.has(job.id)) return;
      this.finish(job, { state: 'error', error: reason?.includes('host not found') ? '보조 프로그램이 등록되지 않았습니다. 연결 확인을 눌러 주세요.' : reason || '보조 프로그램 연결이 종료되었습니다.' });
    });
    port.postMessage({ action: 'download', url: job.url, quality: job.quality, format: job.format });
  }

  async startDirect(job) {
    const filename = this.filename(job.title);
    const downloadId = await chrome.downloads.download({ url: job.url, filename: 'Media Downloader/' + filename, saveAs: false, conflictAction: 'uniquify' });
    this.update(job, { downloadId, state: 'downloading', percent: null });
    await this.refreshDirect();
  }

  filename(title) {
    const name = String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
    return (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) ? 'media_' + (name || 'file') : name;
  }

  async refreshDirect() {
    const active = [...this.jobs.values()].filter(job => job.engine === 'direct' && job.downloadId != null && this.isActive(job));
    await Promise.all(active.map(async job => {
      const [download] = await chrome.downloads.search({ id: job.downloadId });
      if (!this.isActive(job)) return;
      if (!download || download.state === 'interrupted') this.finish(job, { state: 'error', error: download?.error || '다운로드가 취소되거나 중단되었습니다.' });
      else if (download.state === 'complete') this.finish(job, { state: 'complete', percent: 100, folder: download.filename });
      else {
        const percent = download.totalBytes > 0 ? Math.min(99, Math.floor(download.bytesReceived / download.totalBytes * 100)) : null;
        if (percent !== job.percent || job.paused !== download.paused) this.update(job, { percent, paused: download.paused });
      }
    }));
  }
}
const downloadQueue = new DownloadQueue();

