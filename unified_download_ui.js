class UnifiedDownloadUI {
  constructor(controller, tab) {
    this.controller = controller;
    this.tab = tab;
    this.media = [];
    this.pages = new Map();
    this.selected = new Set();
    this.jobs = new Map();
    this.submitting = false;
    if (/^https?:\/\//i.test(tab.url || '')) {
      this.pages.set(tab.url, { url: tab.url, title: tab.title || tab.url, source: 'current-page', type: 'video', contentType: '현재 페이지 영상', size: 0 });
    }
  }

  async init() {
    const saved = await chrome.storage.session.get('mediaSelection_' + this.tab.id);
    const state = saved['mediaSelection_' + this.tab.id];
    if (state?.pageUrl === this.tab.url) {
      (state.pages || []).forEach(item => this.pages.set(item.url, item));
      this.selected = new Set(state.selected || []);
    }
    document.getElementById('selectAllMedia').addEventListener('change', event => {
      this.visibleItems().forEach(item => event.target.checked ? this.selected.add(item.url) : this.selected.delete(item.url));
      this.saveSelection();
      this.renderList();
    });
    document.getElementById('downloadSelectedBtn').addEventListener('click', () => {
      this.enqueue(this.visibleItems().filter(item => this.selected.has(item.url)));
    });
    document.getElementById('downloadFormat').addEventListener('change', () => {
      document.getElementById('pageQuality').disabled = this.format() === 'mp3';
      this.renderList();
    });
    document.getElementById('helperStatusBtn').addEventListener('click', async () => {
      try {
        const response = await chrome.runtime.sendMessage({ action: 'HELPER_STATUS' });
        this.notice(response.success ? '보조 프로그램 연결 완료 · ' + response.folder : response.error);
      } catch (error) { this.notice(error.message); }
    });
    document.getElementById('addVideoUrlsBtn').addEventListener('click', () => this.addUrls());
    chrome.runtime.onMessage.addListener(message => {
      if (message.action === 'DOWNLOAD_JOB_UPDATED' && message.job.tabId === this.tab.id) {
        this.jobs.set(message.job.id, message.job);
        this.renderJobs();
        this.updateButtons();
      } else if (message.action === 'MEDIA_DETECTED' && message.tabId === this.tab.id) {
        const index = this.media.findIndex(item => item.url === message.mediaItem.url);
        if (index < 0) this.media.push(message.mediaItem);
        else this.media[index] = message.mediaItem;
        this.renderList();
      } else if (message.action === 'MEDIA_SIZE_UPDATED') {
        const item = this.media.find(item => item.url === message.url);
        if (item) { item.size = message.size; this.renderList(); }
      }
    });
    await Promise.all([this.loadMedia(), this.refreshJobs()]);
    // DownloadDelta does not carry bytesReceived; query actual Chrome counters.
    this.pollTimer = setInterval(() => this.refreshJobs(), 1000);
    window.addEventListener('unload', () => clearInterval(this.pollTimer), { once: true });
  }

  notice(text) { document.getElementById('downloadNotice').textContent = text || ''; }
  format() { return document.getElementById('downloadFormat').value; }
  saveSelection() {
    chrome.storage.session.set({ ['mediaSelection_' + this.tab.id]: { pageUrl: this.tab.url, pages: [...this.pages.values()], selected: [...this.selected] } });
  }

  async loadMedia() {
    const response = await chrome.runtime.sendMessage({ action: 'GET_MEDIA_LIST', tabId: this.tab.id });
    if (response?.success) this.media = response.mediaList || [];
    this.renderList();
  }

  async rescan() {
    try {
      await chrome.scripting.executeScript({ target: { tabId: this.tab.id, allFrames: true }, files: ['content.js'] });
      await this.loadMedia();
    } catch (error) { this.notice('이 페이지는 다시 스캔할 수 없습니다: ' + error.message); }
  }

  addUrls() {
    const input = document.getElementById('videoUrls');
    const lines = input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 100) { this.notice('영상 주소를 1~100개 입력해 주세요.'); return; }
    try {
      // Validate the whole batch before adding any entries.
      const urls = lines.map(line => {
        const url = new URL(line);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('http 또는 https 영상 주소만 입력하세요.');
        return url;
      });
      let count = 0;
      urls.forEach(url => {
        if (!this.pages.has(url.href)) {
          this.pages.set(url.href, { url: url.href, title: url.href, source: 'page', type: 'video', contentType: '영상 페이지', size: 0 });
          count++;
        }
        this.selected.add(url.href);
      });
      input.value = '';
      this.saveSelection();
      this.renderList();
      this.notice(count + '개 영상 주소를 추가했습니다. 선택 다운로드를 누르세요.');
    } catch (error) { this.notice('주소를 확인해 주세요: ' + error.message); }
  }

  visibleItems() {
    const pages = [...this.pages.values()];
    const pageUrls = new Set(pages.map(item => item.url));
    const files = this.media.filter(item => {
      // Googlevideo requests are fragments/tracks of the current-page entry.
      try { if (/(^|\.)googlevideo\.com$/i.test(new URL(item.url).hostname)) return false; } catch { return false; }
      return !pageUrls.has(item.url);
    }).sort((a, b) => (b.size || 0) - (a.size || 0));
    return [...pages, ...files].filter(item =>
      (this.controller.currentFilter === 'all' || item.type === this.controller.currentFilter) &&
      (!this.controller.hideSmallFiles || !item.size || item.size >= this.controller.minSizeBytes));
  }

  isBusy(item, format) {
    return [...this.jobs.values()].some(job => job.itemKey === item.url && job.format === format && ['queued', 'starting', 'downloading', 'processing'].includes(job.state));
  }

  async enqueue(items, format = this.format()) {
    if (!items.length || this.submitting) return;
    this.submitting = true;
    this.updateButtons();
    try {
      const response = await chrome.runtime.sendMessage({ action: 'QUEUE_DOWNLOADS', tabId: this.tab.id, items, format, quality: document.getElementById('pageQuality').value });
      if (!response?.success) throw new Error(response?.error || '다운로드를 시작하지 못했습니다.');
      this.mergeJobs(response.jobs || []);
      this.notice(response.added + '개 다운로드를 추가했습니다.' + (response.skipped ? ' 진행 중인 ' + response.skipped + '개는 건너뛰었습니다.' : '') + ' 최대 3개씩 동시에 처리합니다.');
    } catch (error) { this.notice(error.message); }
    finally { this.submitting = false; this.updateButtons(); }
  }

  mergeJobs(jobs) {
    jobs.forEach(job => {
      const existing = this.jobs.get(job.id);
      if (!existing || (job.updatedAt || 0) >= (existing.updatedAt || 0)) this.jobs.set(job.id, job);
    });
    this.renderJobs();
    this.updateButtons();
  }

  async refreshJobs() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'GET_DOWNLOAD_JOBS', tabId: this.tab.id });
      if (response?.success) this.mergeJobs(response.jobs || []);
    } catch { /* Popup teardown or extension reload. */ }
    finally { this.refreshing = false; }
  }

  updateButtons() {
    const items = this.visibleItems();
    const selected = items.filter(item => this.selected.has(item.url));
    const checkbox = document.getElementById('selectAllMedia');
    checkbox.checked = items.length > 0 && selected.length === items.length;
    checkbox.indeterminate = selected.length > 0 && selected.length < items.length;
    document.getElementById('selectionCount').textContent = selected.length + '개 선택';
    document.getElementById('downloadSelectedBtn').disabled = this.submitting || selected.length === 0;
    document.querySelectorAll('#mediaList .media-item').forEach(row => {
      const item = items.find(candidate => candidate.url === row.dataset.url);
      if (!item) return;
      row.querySelector('.download-btn').disabled = this.submitting || this.isBusy(item, this.format());
      row.querySelector('.mp3-btn').disabled = this.submitting || this.isBusy(item, 'mp3');
    });
  }

  renderList() {
    const list = document.getElementById('mediaList');
    list.replaceChildren();
    const items = this.visibleItems();
    document.getElementById('emptyState').style.display = items.length ? 'none' : 'flex';
    const escape = value => this.controller.escapeHtml(value);
    items.forEach(item => {
      const row = document.createElement('li');
      row.className = 'media-item';
      row.dataset.url = item.url;
      const page = ['page', 'current-page'].includes(item.source);
      const type = page ? item.contentType : item.contentType + ' · ' + (item.size > 0 ? this.controller.formatBytes(item.size) : '크기 미확인');
      row.innerHTML = `<div class="media-header">
        <input class="media-select" type="checkbox" aria-label="${escape(item.title)} 선택" ${this.selected.has(item.url) ? 'checked' : ''}>
        <div class="media-info"><div class="media-title" title="${escape(item.url)}">${escape(item.title)}</div>
        <div class="media-meta">${escape(type)}</div></div>
        <span class="source-tag">${page ? '페이지' : item.type === 'audio' ? '음원' : '파일'}</span>
      </div>
      <div class="media-actions">
        ${!page && item.type === 'video' && !item.isHls && !/\.(m3u8|mpd)(?:[?#]|$)/i.test(item.url) ? '<button class="btn-action gif-btn" type="button">GIF</button>' : ''}
        <button class="btn-action copy-btn" type="button">URL 복사</button>
        <button class="btn-action mp3-btn" type="button">MP3</button>
        <button class="btn-action primary download-btn" type="button">${this.format() === 'mp3' ? 'MP3 다운로드' : '다운로드'}</button>
      </div>`;
      row.querySelector('.media-select').addEventListener('change', event => {
        if (event.target.checked) this.selected.add(item.url); else this.selected.delete(item.url);
        this.saveSelection();
        this.updateButtons();
      });
      row.querySelector('.download-btn').addEventListener('click', () => this.enqueue([item]));
      row.querySelector('.mp3-btn').addEventListener('click', () => this.enqueue([item], 'mp3'));
      row.querySelector('.gif-btn')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await VideoConverter.convertToGif(item.url, item.title, 5, percent => { button.textContent = percent + '%'; });
          this.notice('GIF 저장을 완료했습니다.');
        } catch (error) { this.notice('GIF 변환 실패: ' + error.message); }
        finally { button.disabled = false; button.textContent = 'GIF'; }
      });
      row.querySelector('.copy-btn').addEventListener('click', () => navigator.clipboard.writeText(item.url).then(() => this.notice('주소를 복사했습니다.'), error => this.notice(error.message)));
      list.appendChild(row);
    });
    this.updateButtons();
  }

  renderJobs() {
    const jobs = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    const section = document.getElementById('downloadJobsSection');
    section.hidden = !jobs.length;
    const done = jobs.filter(job => job.state === 'complete').length;
    const failed = jobs.filter(job => job.state === 'error').length;
    document.getElementById('batchProgressText').textContent = `완료 ${done}/${jobs.length}` + (failed ? ` · 실패 ${failed}` : '');
    const totalBar = document.getElementById('batchProgress');
    totalBar.max = Math.max(1, jobs.length);
    totalBar.value = done + failed;
    const list = document.getElementById('downloadJobsList');
    const visible = new Set(jobs.map(job => job.id));
    [...list.children].forEach(row => { if (!visible.has(row.dataset.jobId)) row.remove(); });
    jobs.forEach(job => {
      let row = [...list.children].find(candidate => candidate.dataset.jobId === job.id);
      if (!row) {
        row = document.createElement('li');
        row.className = 'download-job';
        row.dataset.jobId = job.id;
        row.innerHTML = '<div class="job-header"><span class="media-title"></span><span class="source-tag"></span></div><progress max="100" aria-label="다운로드 진행률"></progress><div class="job-status"></div>';
        list.appendChild(row);
      }
      row.querySelector('.media-title').textContent = job.title;
      row.querySelector('.source-tag').textContent = job.format === 'mp3' ? 'MP3' : '영상 / 원본';
      row.dataset.state = job.state;
      const bar = row.querySelector('progress');
      if (job.state === 'complete') bar.value = 100;
      else if (job.state === 'queued' || job.state === 'error') bar.value = 0;
      else if (job.percent == null || job.state === 'processing') bar.removeAttribute('value');
      else bar.value = Math.min(99, Math.max(0, job.percent));
      const labels = { queued: '대기 중', starting: (job.stage || '연결') + ' 중…', downloading: job.paused ? '일시 정지' : (job.percent == null ? '다운로드 중…' : `다운로드 ${job.percent}%${job.stage ? ' · ' + job.stage : ''}`), processing: (job.stage || (job.format === 'mp3' ? 'MP3 변환' : '영상 처리')) + ' 중…', complete: '저장 완료 · ' + (job.folder || ''), error: '실패 · ' + (job.error || '알 수 없는 오류') };
      const details = [];
      if (job.state === 'downloading') {
        if (job.height) details.push(job.height + 'p');
        if (job.totalBytes > 0) details.push(this.controller.formatBytes(job.downloadedBytes || 0) + ' / ' + this.controller.formatBytes(job.totalBytes));
        if (job.speed > 0) details.push(this.controller.formatBytes(job.speed) + '/s');
        if (Number.isFinite(job.eta) && job.eta >= 0) details.push('남은 시간 ' + this.formatTime(job.eta));
      }
      row.querySelector('.job-status').textContent = (labels[job.state] || job.state) + (details.length ? ' · ' + details.join(' · ') : '');
    });
  }

  formatTime(seconds) {
    const rounded = Math.ceil(seconds);
    const minutes = Math.floor(rounded / 60);
    return minutes ? minutes + '분 ' + (rounded % 60) + '초' : rounded + '초';
  }
}
