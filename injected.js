(function() {
  const MEDIA_PATTERNS = ['.mp4', '.mp3', '.webm', '.m4a', '.ogg', '.wav', '.flac', '.aac', '.m3u8', '.ts', '.mpd', '.m4s', '.flv', 'mime=video', 'mime=audio', 'videoplayback'];

  function checkUrl(url) {
    if (!url || typeof url !== 'string') return;
    const lower = url.toLowerCase();
    const isMedia = MEDIA_PATTERNS.some(pat => lower.includes(pat));
    if (isMedia) {
      window.postMessage({
        type: 'MEDIA_DOWNLOADER_DETECTED',
        url: url
      }, '*');
    }
  }

  // 브라우저 Fetch/XHR 통신은 background.js의 chrome.webRequest에서 안전하게 처리되므로,
  // 메인 월드의 fetch/xhr 프로토타입 변조를 제거하여 SPA 및 일반 웹사이트의 통신 장애를 방지합니다.

  // 복사 및 드래그 방지 기본 완화 (Main World Context)
  function unlockCopyMainWorld() {
    try {
      ['contextmenu', 'selectstart', 'dragstart', 'copy'].forEach(evt => {
        if (document['on' + evt]) document['on' + evt] = null;
        if (window['on' + evt]) window['on' + evt] = null;
        if (document.body && document.body['on' + evt]) document.body['on' + evt] = null;
      });
    } catch (e) {}
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'MEDIA_DOWNLOADER_UNLOCK_COPY') {
      unlockCopyMainWorld();
    }
  });
})();
