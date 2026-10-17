class VideoConverterController {
  constructor(i18n) {
    this.i18n = i18n;
    this.currentFile = null;
    this.targetFormat = 'mp3';
    this.gifFps = 10;
    this.gifDuration = 5;
    this.gifResolution = 320;
    this.mp3Bitrate = 192;
  }

  init() {
    this.bindEvents();
  }

  bindEvents() {
    const dropZone = document.getElementById('videoDropZone');
    const fileInput = document.getElementById('videoFileInput');
    const formatBtns = document.querySelectorAll('.btn-video-format');
    const fpsBtns = document.querySelectorAll('.btn-fps');
    const durationBtns = document.querySelectorAll('.btn-duration');
    const resBtns = document.querySelectorAll('.btn-res');
    const bitrateBtns = document.querySelectorAll('.btn-bitrate');
    const convertBtn = document.getElementById('videoConvertBtn');

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());

      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });

      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
      });

      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          this.handleFileSelect(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.handleFileSelect(e.target.files[0]);
        }
      });
    }

    if (formatBtns) {
      formatBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          formatBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.targetFormat = btn.getAttribute('data-format');
          this.updateOptionsVisibility();
        });
      });
    }

    if (fpsBtns) {
      fpsBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          fpsBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.gifFps = parseInt(btn.getAttribute('data-fps'), 10);
        });
      });
    }

    if (durationBtns) {
      durationBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          durationBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.gifDuration = parseInt(btn.getAttribute('data-duration'), 10);
        });
      });
    }

    if (resBtns) {
      resBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          resBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.gifResolution = parseInt(btn.getAttribute('data-res'), 10);
        });
      });
    }

    if (bitrateBtns) {
      bitrateBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          bitrateBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.mp3Bitrate = parseInt(btn.getAttribute('data-bitrate'), 10);
        });
      });
    }

    if (convertBtn) {
      convertBtn.addEventListener('click', () => this.convertAndDownload());
    }
  }

  updateOptionsVisibility() {
    const gifSettings = document.getElementById('gifSettingsPanel');
    const audioSettings = document.getElementById('audioSettingsPanel');

    if (this.targetFormat === 'gif') {
      if (gifSettings) gifSettings.style.display = 'flex';
      if (audioSettings) audioSettings.style.display = 'none';
    } else if (this.targetFormat === 'mp3') {
      if (gifSettings) gifSettings.style.display = 'none';
      if (audioSettings) audioSettings.style.display = 'flex';
    } else {
      // wav
      if (gifSettings) gifSettings.style.display = 'none';
      if (audioSettings) audioSettings.style.display = 'none';
    }
  }

  handleFileSelect(file) {
    if (!file || !file.type.startsWith('video/')) {
      alert(this.i18n.t('select_video_first'));
      return;
    }

    this.currentFile = file;

    const previewCard = document.getElementById('videoPreviewCard');
    const previewVideo = document.getElementById('previewVideo');
    const nameEl = document.getElementById('videoPreviewFileName');
    const sizeEl = document.getElementById('videoPreviewFileSize');

    if (previewCard && previewVideo && nameEl && sizeEl) {
      previewCard.style.display = 'flex';
      nameEl.textContent = file.name;
      sizeEl.textContent = this.formatBytes(file.size);

      previewVideo.src = URL.createObjectURL(file);
      previewVideo.muted = true;
      previewVideo.currentTime = 0.5;
    }
  }

  async convertAndDownload() {
    if (!this.currentFile) {
      alert(this.i18n.t('select_video_first'));
      return;
    }

    const convertBtn = document.getElementById('videoConvertBtn');
    const btnSpan = convertBtn ? convertBtn.querySelector('span') : null;
    const originalText = btnSpan ? btnSpan.textContent : '';

    if (convertBtn && btnSpan) {
      convertBtn.disabled = true;
      btnSpan.textContent = this.i18n.t('converting');
    }

    try {
      const baseName = this.currentFile.name.substring(0, this.currentFile.name.lastIndexOf('.')) || this.currentFile.name;

      if (this.targetFormat === 'gif') {
        await VideoConverter.convertToGif(
          this.currentFile,
          baseName,
          this.gifDuration,
          this.gifFps,
          this.gifResolution,
          (p) => {
            if (btnSpan) btnSpan.textContent = `${p}%`;
          }
        );
      } else {
        // mp3 or wav
        await VideoConverter.extractAudio(
          this.currentFile,
          baseName,
          this.targetFormat,
          this.mp3Bitrate,
          (p) => {
            if (btnSpan) btnSpan.textContent = `${p}%`;
          }
        );
      }

      if (btnSpan) {
        btnSpan.textContent = this.i18n.t('convert_success');
        setTimeout(() => {
          btnSpan.textContent = originalText;
          if (convertBtn) convertBtn.disabled = false;
        }, 1500);
      }
    } catch (err) {
      console.error('Video conversion failed:', err);
      alert(err && err.message ? err.message : this.i18n.t('convert_error'));
      if (btnSpan) btnSpan.textContent = originalText;
      if (convertBtn) convertBtn.disabled = false;
    }
  }

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}
