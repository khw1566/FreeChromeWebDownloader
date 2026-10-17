class VideoConverter {
  /**
   * 동영상 URL 또는 File로부터 오디오를 추출하여 WAV 또는 MP3 파일로 변환 및 다운로드
   * @param {string|File} source - 비디오 URL 또는 File 객체
   * @param {string} filename - 저장할 파일명
   * @param {string} format - 'wav' 또는 'mp3'
   * @param {number} bitrateKbps - MP3인 경우 비트레이트 (128, 192, 256, 320)
   * @param {Function} onProgress - 진행 상황 콜백
   */
  static async extractAudio(source, filename, format = 'wav', bitrateKbps = 192, onProgress) {
    if (onProgress) onProgress(10, 'fetching');

    let arrayBuffer;
    if (source instanceof File) {
      arrayBuffer = await source.arrayBuffer();
    } else {
      const res = await fetch(source);
      if (!res.ok) throw new Error('Failed to fetch video stream');
      arrayBuffer = await res.arrayBuffer();
    }

    if (onProgress) onProgress(35, 'decoding');

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      if (onProgress) onProgress(70, 'encoding');

      const cleanName = (filename || 'audio').replace(/\.[^/.]+$/, '');
      let audioBlob;
      let downloadName;

      if (format.toLowerCase() === 'mp3') {
        audioBlob = Mp3Encoder.encode(audioBuffer, bitrateKbps);
        downloadName = `${cleanName}.mp3`;
      } else {
        audioBlob = WavEncoder.encode(audioBuffer);
        downloadName = `${cleanName}.wav`;
      }

      if (onProgress) onProgress(95, 'saving');
      this.triggerDownload(audioBlob, downloadName);
      if (onProgress) onProgress(100, 'done');
      return true;
    } finally {
      if (audioCtx.state !== 'closed') {
        await audioCtx.close();
      }
    }
  }

  /**
   * 비디오의 일부 구간을 GIF 애니메이션으로 변환하여 다운로드
   * @param {string|File} source - 비디오 URL 또는 File 객체
   * @param {string} filename - 저장할 파일명
   * @param {number} maxDurationSec - 최대 캡처 시간(초)
   * @param {number} fps - 초당 프레임 수 (5, 8, 12, 15 등)
   * @param {number} width - 출력 가로 해상도 (픽셀)
   * @param {Function} onProgress - 진행률 콜백
   */
  static async convertToGif(source, filename, maxDurationSec = 5, fps = 10, width = 320, onProgress) {
    if (onProgress) onProgress(5, 'loading');

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;

    let videoUrl = '';
    if (source instanceof File) {
      videoUrl = URL.createObjectURL(source);
    } else {
      videoUrl = source;
    }
    video.src = videoUrl;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video metadata'));
    });

    const duration = Math.min(video.duration || maxDurationSec, maxDurationSec);
    const targetWidth = Math.max(120, Math.min(640, width || 320));
    const targetHeight = Math.round((video.videoHeight / video.videoWidth) * targetWidth) || 180;
    const actualFps = Math.max(2, Math.min(24, fps || 10));
    const totalFrames = Math.floor(duration * actualFps);
    const frameInterval = 1 / actualFps;

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const encoder = new GifEncoder(targetWidth, targetHeight, Math.round(1000 / actualFps));

    for (let f = 0; f < totalFrames; f++) {
      const seekTime = f * frameInterval;
      video.currentTime = seekTime;

      await new Promise((resolve) => {
        video.onseeked = () => resolve();
      });

      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      encoder.addFrame(ctx);

      const percent = Math.round(10 + (f / totalFrames) * 75);
      if (onProgress) onProgress(percent, 'capturing');
    }

    if (onProgress) onProgress(88, 'encoding');
    const gifBlob = encoder.finish();

    if (source instanceof File) {
      URL.revokeObjectURL(videoUrl);
    }

    const cleanName = (filename || 'animation').replace(/\.[^/.]+$/, '');
    const downloadName = `${cleanName}.gif`;

    this.triggerDownload(gifBlob, downloadName);
    if (onProgress) onProgress(100, 'done');
    return true;
  }

  static triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
