(() => {
if (globalThis.__mediaDownloaderScanner) {
  globalThis.__mediaDownloaderScanner.scannedUrls.clear();
  globalThis.__mediaDownloaderScanner.scan();
  return;
}
class DOMMediaScanner {
  constructor() {
    this.scannedUrls = new Set();
    this.supportedExtensions = ['.mp4', '.mp3', '.webm', '.m4a', '.ogg', '.wav', '.flac', '.aac', '.m3u8', '.ts', '.mpd', '.m4s', '.flv'];
    this.isCopyProtectionUnlocked = false;
    this.initInjectedScript();
    this.initMessageListener();
    this.bindMediaEvents();
  }

  initInjectedScript() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('injected.js');
      script.onload = function() {
        this.remove();
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {}
  }

  initMessageListener() {
    window.addEventListener('message', (event) => {
      if (event.source === window && event.data && event.data.type === 'MEDIA_DOWNLOADER_DETECTED') {
        const url = event.data.url;
        if (this.isValidMediaUrl(url)) {
          const type = this.inferType(url);
          chrome.runtime.sendMessage({
            action: 'ADD_DOM_MEDIA',
            items: [this.createItem(url, type)]
          });
        }
      }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.action === 'SET_COPY_PROTECTION_BYPASS') {
        if (message.enabled) {
          this.unlockCopyAndSelection();
        } else {
          this.lockCopyAndSelection();
        }
        sendResponse({ success: true, enabled: this.isCopyProtectionUnlocked });
      } else if (message && message.action === 'GET_COPY_PROTECTION_STATUS') {
        sendResponse({ enabled: !!this.isCopyProtectionUnlocked });
      }
    });
  }

  unlockCopyAndSelection() {
    this.isCopyProtectionUnlocked = true;

    // 1. 강제 선택 및 복사 허용 스타일 주입
    const styleId = '__media_downloader_unlock_style__';
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        html, body, p, span, div, article, section, h1, h2, h3, h4, h5, h6, pre, code {
          -webkit-user-select: text !important;
          -moz-user-select: text !important;
          -ms-user-select: text !important;
          user-select: text !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    // 2. 우클릭 및 텍스트 선택/복사 차단 방지 리스너 등록
    if (!this.copyUnlockListenerAttached) {
      this.copyUnlockListenerAttached = true;
      this.copyUnlockHandler = (e) => {
        if (!this.isCopyProtectionUnlocked) return;
        if (e.defaultPrevented) {
          e.stopPropagation();
        }
      };

      ['contextmenu', 'copy', 'cut'].forEach(eventType => {
        window.addEventListener(eventType, this.copyUnlockHandler, true);
      });
    }

    // 3. 인라인 우클릭/선택 차단 속성만 제거
    const clearInlineRestrictions = () => {
      if (document.oncontextmenu) document.oncontextmenu = null;
      if (document.onselectstart) document.onselectstart = null;
      if (document.ondragstart) document.ondragstart = null;
      if (document.body && document.body.oncontextmenu) document.body.oncontextmenu = null;
      if (document.body && document.body.onselectstart) document.body.onselectstart = null;
    };

    if (document.body) {
      clearInlineRestrictions();
    } else {
      document.addEventListener('DOMContentLoaded', clearInlineRestrictions, { once: true });
    }
  }

  lockCopyAndSelection() {
    this.isCopyProtectionUnlocked = false;

    // 주입했던 스타일 태그 제거
    const styleId = '__media_downloader_unlock_style__';
    const style = document.getElementById(styleId);
    if (style) {
      style.remove();
    }
  }

  bindMediaEvents() {
    // 1. 미디어 재생 관련 이벤트 감지 시 디바운스 스캔
    document.addEventListener('play', () => this.debouncedScan(), true);
    document.addEventListener('playing', () => this.debouncedScan(), true);

    // 2. 비디오/오디오 컨트롤러 클릭 시에만 스캔 트리거 (일반 사이트 버튼 클릭 간섭 방지)
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (target && (target.closest('video') || target.closest('audio') || target.closest('[class*="player"]') || target.closest('[id*="player"]'))) {
        this.debouncedScan();
      }
    }, false);
  }

  debouncedScan() {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scan();
    }, 400);
  }

  scan() {
    const mediaItems = [];

    const videoElements = document.querySelectorAll('video');
    const audioElements = document.querySelectorAll('audio');
    const sourceElements = document.querySelectorAll('source');
    const linkElements = document.querySelectorAll('a[href]');
    const embedElements = document.querySelectorAll('embed[src], object[data]');

    videoElements.forEach(el => {
      if (el.src && this.isValidMediaUrl(el.src)) mediaItems.push(this.createItem(el.src, 'video'));
      if (el.currentSrc && this.isValidMediaUrl(el.currentSrc)) mediaItems.push(this.createItem(el.currentSrc, 'video'));
    });

    audioElements.forEach(el => {
      if (el.src && this.isValidMediaUrl(el.src)) mediaItems.push(this.createItem(el.src, 'audio'));
      if (el.currentSrc && this.isValidMediaUrl(el.currentSrc)) mediaItems.push(this.createItem(el.currentSrc, 'audio'));
    });

    sourceElements.forEach(srcEl => {
      if (srcEl.src && this.isValidMediaUrl(srcEl.src)) {
        const type = (srcEl.type && srcEl.type.includes('audio')) ? 'audio' : 'video';
        mediaItems.push(this.createItem(srcEl.src, type, srcEl.type));
      }
    });

    linkElements.forEach(aEl => {
      const href = aEl.href;
      if (href && this.isMediaExtension(href) && this.isValidMediaUrl(href)) {
        const type = this.inferType(href);
        mediaItems.push(this.createItem(href, type));
      }
    });

    embedElements.forEach(el => {
      const src = el.src || el.data;
      if (src && this.isValidMediaUrl(src)) {
        mediaItems.push(this.createItem(src, this.inferType(src)));
      }
    });

    try {
      const resources = performance.getEntriesByType('resource');
      resources.forEach(res => {
        const name = res.name;
        if (name && (this.isMediaExtension(name) || this.isMediaKeyword(name)) && this.isValidMediaUrl(name)) {
          const type = this.inferType(name);
          mediaItems.push(this.createItem(name, type));
        }
      });
    } catch (e) {}

    if (mediaItems.length > 0) {
      chrome.runtime.sendMessage({
        action: 'ADD_DOM_MEDIA',
        items: mediaItems
      });
    }
  }

  isMediaExtension(url) {
    const cleanUrl = url.toLowerCase().split('?')[0].split('#')[0];
    return this.supportedExtensions.some(ext => cleanUrl.endsWith(ext));
  }

  isMediaKeyword(url) {
    const lower = url.toLowerCase();
    return lower.includes('videoplayback') || lower.includes('mime=video') || lower.includes('mime=audio') || lower.includes('.m3u8') || lower.includes('.mpd');
  }

  inferType(url) {
    const lower = url.toLowerCase();
    if (lower.includes('mime=audio') || lower.includes('audio') || lower.endsWith('.mp3') || lower.endsWith('.m4a') || lower.endsWith('.wav')) {
      return 'audio';
    }
    return 'video';
  }

  isValidMediaUrl(url) {
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) return false;
    if (this.scannedUrls.has(url)) return false;
    this.scannedUrls.add(url);
    return true;
  }

  createItem(url, defaultType, mimeType) {
    const filename = this.extractFilename(url);
    return {
      url: url,
      contentType: mimeType || (defaultType === 'video' ? 'video/mp4' : 'audio/mpeg'),
      size: 0,
      type: defaultType,
      title: filename
    };
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

  observe() {
    const observer = new MutationObserver(() => {
      this.debouncedScan();
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data']
    });
  }
}

const scanner = new DOMMediaScanner();
globalThis.__mediaDownloaderScanner = scanner;
scanner.scan();
scanner.observe();
})();
