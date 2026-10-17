importScripts('native_bridge.js');
class MediaTracker {
  constructor() {
    this.mediaStore = new Map();
    this.supportedExtensions = [
      '.mp4', '.mp3', '.webm', '.m4a', '.ogg', '.wav', '.flac', '.aac',
      '.m3u8', '.ts', '.mpd', '.m4s', '.flv', '.mov', '.avi', '.wmv'
    ];
    this.activeDownloads = new Map();
  }

  initListeners() {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => this.handleBeforeRequest(details),
      { urls: ['<all_urls>'] }
    );

    chrome.webRequest.onHeadersReceived.addListener(
      (details) => this.handleHeadersReceived(details),
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.mediaStore.delete(tabId);
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === 'loading') {
        this.mediaStore.delete(tabId);
      }
    });

    chrome.downloads.onChanged.addListener((delta) => {
      this.handleDownloadChanged(delta);
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!['GET_MEDIA_LIST', 'ADD_DOM_MEDIA', 'DOWNLOAD_MEDIA'].includes(message?.action)) return false;
      this.handleRuntimeMessage(message, sender, sendResponse);
      return true;
    });
  }

  handleDownloadChanged(delta) {
    if (!delta) return;
    const downloadId = delta.id;
    if (this.activeDownloads.has(downloadId)) {
      const mediaUrl = this.activeDownloads.get(downloadId);
      if (delta.bytesReceived && delta.totalBytes && delta.totalBytes.current > 0) {
        const percent = Math.floor((delta.bytesReceived.current / delta.totalBytes.current) * 100);
        this.broadcastProgress(mediaUrl, percent, delta.bytesReceived.current, delta.totalBytes.current);
      } else if (delta.state && delta.state.current === 'complete') {
        this.broadcastProgress(mediaUrl, 100, 0, 0);
        this.activeDownloads.delete(downloadId);
      }
    }
  }

  handleBeforeRequest(details) {
    if (!details || details.tabId < 0) return;
    const url = details.url;
    if (!url || url.startsWith('chrome-extension://') || url.startsWith('chrome://')) return;

    if (this.isMediaUrl(url)) {
      this.addMediaItem(details.tabId, {
        url: url,
        contentType: this.inferContentType(url),
        size: 0,
        type: this.inferMediaType(url),
        title: this.extractFilename(url),
        isHls: url.includes('.m3u8')
      });
    }
  }

  handleHeadersReceived(details) {
    if (!details || details.tabId < 0) return;
    const url = details.url;
    if (!url || url.startsWith('chrome-extension://') || url.startsWith('chrome://')) return;

    let contentType = '';
    let contentLength = 0;

    if (details.responseHeaders) {
      for (const header of details.responseHeaders) {
        const name = header.name.toLowerCase();
        if (name === 'content-type') {
          contentType = header.value.toLowerCase();
        } else if (name === 'content-length') {
          contentLength = parseInt(header.value, 10) || 0;
        } else if (name === 'content-range') {
          const match = header.value.match(/\/(\d+)$/);
          if (match) {
            contentLength = parseInt(match[1], 10);
          }
        }
      }
    }

    const isMediaMime = contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType.includes('application/x-mpegurl') ||
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/dash+xml');

    if (isMediaMime || this.isMediaUrl(url)) {
      const type = (contentType.includes('audio') || this.inferMediaType(url) === 'audio') ? 'audio' : 'video';

      this.addMediaItem(details.tabId, {
        url: url,
        contentType: contentType || this.inferContentType(url),
        size: contentLength,
        type: type,
        title: this.extractFilename(url),
        isHls: contentType.includes('mpegurl') || url.includes('.m3u8')
      });
    }
  }

  isMediaUrl(url) {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    const cleanUrl = lowerUrl.split('?')[0].split('#')[0];

    if (cleanUrl.endsWith('.ts') && !lowerUrl.includes('m3u8')) {
      return false;
    }

    if (this.supportedExtensions.some(ext => cleanUrl.endsWith(ext))) {
      return true;
    }

    if (lowerUrl.includes('mime=video') ||
        lowerUrl.includes('mime=audio') ||
        lowerUrl.includes('.m3u8') ||
        lowerUrl.includes('.mpd') ||
        lowerUrl.includes('playlist.m3u8') ||
        lowerUrl.includes('manifest.m3u8')) {
      return true;
    }

    return false;
  }

  inferMediaType(url) {
    const lower = url.toLowerCase();
    if (lower.includes('mime=audio') || lower.includes('audio') || lower.endsWith('.mp3') || lower.endsWith('.m4a') || lower.endsWith('.wav')) {
      return 'audio';
    }
    return 'video';
  }

  inferContentType(url) {
    const cleanUrl = url.toLowerCase().split('?')[0];
    if (cleanUrl.endsWith('.mp4')) return 'video/mp4';
    if (cleanUrl.endsWith('.mp3')) return 'audio/mpeg';
    if (cleanUrl.endsWith('.webm')) return 'video/webm';
    if (cleanUrl.endsWith('.m4a')) return 'audio/mp4';
    if (cleanUrl.endsWith('.m3u8')) return 'application/x-mpegURL (HLS)';
    if (cleanUrl.endsWith('.mpd')) return 'application/dash+xml';
    return 'video/mp4';
  }

  extractFilename(url) {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      const segment = pathname.substring(pathname.lastIndexOf('/') + 1);
      if (segment && segment.includes('.') && segment.length < 60) {
        return decodeURIComponent(segment);
      }
    } catch (e) {}
    return 'media_' + Math.floor(Math.random() * 10000);
  }

  addMediaItem(tabId, mediaInfo) {
    if (!this.mediaStore.has(tabId)) {
      this.mediaStore.set(tabId, new Map());
    }
    const tabMediaMap = this.mediaStore.get(tabId);

    if (tabMediaMap.has(mediaInfo.url)) {
      const existing = tabMediaMap.get(mediaInfo.url);
      if (mediaInfo.size > existing.size) {
        existing.size = mediaInfo.size;
      }
    } else {
      tabMediaMap.set(mediaInfo.url, mediaInfo);
      this.updateBadge(tabId, tabMediaMap.size);

      // 팝업 열려 있을 경우 실시간 리스트 추가 알림
      chrome.runtime.sendMessage({
        action: 'MEDIA_DETECTED',
        tabId: tabId,
        mediaItem: mediaInfo
      }).catch(() => {});

      // 용량 비동기 추산 실행
      this.calculateSize(mediaInfo);
    }
  }

  async calculateSize(mediaInfo) {
    if (mediaInfo.size > 0) return;
    // Hidden YouTube tracks and segment requests need no separate size probes.
    // Those probes compete with playback and native downloads for bandwidth.
    try {
      const parsed = new URL(mediaInfo.url);
      if (/(^|\.)googlevideo\.com$/i.test(parsed.hostname) || /\.(m4s|ts)$/i.test(parsed.pathname)) return;
    } catch { return; }

    if (mediaInfo.isHls) {
      try {
        const estSize = await this.estimateHlsSize(mediaInfo.url);
        if (estSize > 0) {
          mediaInfo.size = estSize;
          this.notifySizeUpdated(mediaInfo.url, estSize);
        }
      } catch (e) {}
    } else {
      try {
        const size = await this.fetchContentLength(mediaInfo.url);
        if (size > 0) {
          mediaInfo.size = size;
          this.notifySizeUpdated(mediaInfo.url, size);
        }
      } catch (e) {}
    }
  }

  async estimateHlsSize(m3u8Url) {
    const res = await fetch(m3u8Url);
    let text = await res.text();

    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    if (text.includes('#EXT-X-STREAM-INF')) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
          const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;

          const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';
          if (nextLine && !nextLine.startsWith('#')) {
            const subUrl = nextLine.startsWith('http') ? nextLine : baseUrl + nextLine;
            const subRes = await fetch(subUrl);
            const subText = await subRes.text();

            let duration = 0;
            const extinfMatches = subText.match(/#EXTINF:([\d.]+)/g);
            if (extinfMatches) {
              extinfMatches.forEach(m => {
                const val = parseFloat(m.replace('#EXTINF:', ''));
                if (!isNaN(val)) duration += val;
              });
            }

            if (bandwidth > 0 && duration > 0) {
              return Math.floor((bandwidth / 8) * duration);
            }

            text = subText;
            break;
          }
        }
      }
    }

    // 단일 세그먼트 샘플링
    const lines = text.split('\n');
    const segmentUrls = [];
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const segUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
        segmentUrls.push(segUrl);
      }
    });

    if (segmentUrls.length > 0) {
      try {
        const sampleUrl = segmentUrls[0];
        const sampleRes = await fetch(sampleUrl, { method: 'HEAD' });
        const len = sampleRes.headers.get('content-length');
        if (len) {
          return parseInt(len, 10) * segmentUrls.length;
        }
      } catch (e) {}
    }

    return 0;
  }

  async fetchContentLength(url) {
    let response;
    try {
      response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return 0;
      const length = response.headers.get('content-length');
      return length ? parseInt(length, 10) : 0;
    } catch (e) {
      return 0;
    } finally {
      // Never leave a full media response downloading to measure its size.
      await response?.body?.cancel().catch(() => {});
    }
  }

  notifySizeUpdated(url, size) {
    chrome.runtime.sendMessage({
      action: 'MEDIA_SIZE_UPDATED',
      url: url,
      size: size
    }).catch(() => {});
  }

  broadcastProgress(url, percent, loadedBytes, totalBytes) {
    chrome.runtime.sendMessage({
      action: 'DOWNLOAD_PROGRESS',
      url: url,
      percent: percent,
      loadedBytes: loadedBytes,
      totalBytes: totalBytes
    }).catch(() => {});
  }

  updateBadge(tabId, count) {
    if (count > 0) {
      chrome.action.setBadgeText({ tabId, text: count.toString() });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#000000' });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  }

  handleRuntimeMessage(message, sender, sendResponse) {
    const action = message.action;

    if (action === 'GET_MEDIA_LIST') {
      const tabId = message.tabId;
      const tabMediaMap = this.mediaStore.get(tabId);
      const list = tabMediaMap ? Array.from(tabMediaMap.values()) : [];
      sendResponse({ success: true, mediaList: list });
    } else if (action === 'ADD_DOM_MEDIA') {
      const tabId = (sender.tab && sender.tab.id) ? sender.tab.id : message.tabId;
      if (tabId && message.items && Array.isArray(message.items)) {
        message.items.forEach(item => this.addMediaItem(tabId, item));
      }
      sendResponse({ success: true });
    } else if (action === 'DOWNLOAD_MEDIA') {
      if (message.isHls || /\.(m3u8|mpd)(?:[?#]|$)/i.test(message.url) || message.url.includes('googlevideo.com/')) {
        sendResponse({ success: false, error: '분할 스트림은 상단의 현재 페이지 다운로드를 사용해 주세요.' });
        return;
      }
      if (message.isHls || message.url.includes('.m3u8')) {
        this.downloadHlsStream(message.url, message.filename)
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err.message }));
      } else {
        this.robustDownload(message.url, message.filename)
          .then(downloadId => sendResponse({ success: true, downloadId }))
          .catch(err => sendResponse({ success: false, error: err.message }));
      }
    }
  }

  async robustDownload(url, filename) {
    try {
      const downloadId = await this.downloadFile(url, filename);
      this.activeDownloads.set(downloadId, url);
      return downloadId;
    } catch (err) {
      console.warn('Direct download failed, trying fetch fallback:', err);
    }

    const response = await fetch(url);
    const total = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body.getReader();
    let loaded = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total > 0) {
        const percent = Math.floor((loaded / total) * 100);
        this.broadcastProgress(url, percent, loaded, total);
      }
    }

    const blob = new Blob(chunks);
    const fileReader = new FileReader();

    return new Promise((resolve, reject) => {
      fileReader.onloadend = () => {
        const dataUrl = fileReader.result;
        chrome.downloads.download({
          url: dataUrl,
          filename: filename || 'media_file',
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else {
            this.broadcastProgress(url, 100, loaded, total);
            resolve(downloadId);
          }
        });
      };
      fileReader.onerror = reject;
      fileReader.readAsDataURL(blob);
    });
  }

  async downloadFile(url, filename) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: url,
        filename: filename || undefined,
        saveAs: true
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(downloadId);
        }
      });
    });
  }

  async downloadHlsStream(m3u8Url, filename) {
    this.broadcastProgress(m3u8Url, 1, 0, 0);

    const response = await fetch(m3u8Url);
    let text = await response.text();

    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    if (text.includes('#EXT-X-STREAM-INF')) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';
          if (nextLine && !nextLine.startsWith('#')) {
            const subUrl = nextLine.startsWith('http') ? nextLine : baseUrl + nextLine;
            const subRes = await fetch(subUrl);
            text = await subRes.text();
            break;
          }
        }
      }
    }

    const segmentUrls = [];
    const lines = text.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const segUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
        segmentUrls.push(segUrl);
      }
    });

    if (segmentUrls.length === 0) {
      throw new Error('No TS segments found in m3u8 playlist');
    }

    const chunks = [];
    const totalSegs = segmentUrls.length;

    for (let i = 0; i < totalSegs; i++) {
      try {
        const segRes = await fetch(segmentUrls[i]);
        const buffer = await segRes.arrayBuffer();
        chunks.push(new Uint8Array(buffer));
        
        // HLS 세그먼트 진행률 방송
        const percent = Math.floor(((i + 1) / totalSegs) * 100);
        this.broadcastProgress(m3u8Url, percent, i + 1, totalSegs);
      } catch (e) {
        console.warn('Failed to fetch segment:', segmentUrls[i]);
      }
    }

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combinedBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    const blob = new Blob([combinedBuffer], { type: 'video/mp2t' });
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onloadend = () => {
        const dataUrl = reader.result;
        let outName = filename ? filename.replace(/\.m3u8$/i, '.ts') : 'stream_video.ts';
        if (!outName.endsWith('.ts')) outName += '.ts';

        chrome.downloads.download({
          url: dataUrl,
          filename: outName,
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else {
            this.broadcastProgress(m3u8Url, 100, totalLength, totalLength);
            resolve(downloadId);
          }
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

const tracker = new MediaTracker();
tracker.initListeners();
