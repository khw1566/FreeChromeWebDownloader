class ImageConverterController {
  constructor(i18n) {
    this.i18n = i18n;
    this.currentFile = null;
    this.targetFormat = 'png';
    this.quality = 0.9;
  }

  init() {
    this.bindEvents();
  }

  bindEvents() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('imageFileInput');
    const formatBtns = document.querySelectorAll('.btn-format');
    const qualitySlider = document.getElementById('qualitySlider');
    const qualityDisplay = document.getElementById('qualityValDisplay');
    const convertBtn = document.getElementById('convertBtn');

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
          e.target.classList.add('active');
          this.targetFormat = e.target.getAttribute('data-format');

          const qualityRow = document.getElementById('qualityRow');
          if (qualityRow) {
            // PNG는 무손실 압축이므로 퀄리티 슬라이더 필요성 낮음
            qualityRow.style.display = (this.targetFormat === 'png') ? 'none' : 'flex';
          }
        });
      });
    }

    if (qualitySlider && qualityDisplay) {
      qualitySlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        this.quality = val / 100;
        qualityDisplay.textContent = `${val}%`;
      });
    }

    if (convertBtn) {
      convertBtn.addEventListener('click', () => this.convertAndDownload());
    }
  }

  handleFileSelect(file) {
    if (!file || !file.type.startsWith('image/')) {
      alert(this.i18n.t('select_image_first'));
      return;
    }

    this.currentFile = file;

    const previewCard = document.getElementById('imagePreviewCard');
    const previewImg = document.getElementById('previewImage');
    const nameEl = document.getElementById('previewFileName');
    const sizeEl = document.getElementById('previewFileSize');

    if (previewCard && previewImg && nameEl && sizeEl) {
      previewCard.style.display = 'flex';
      nameEl.textContent = file.name;
      sizeEl.textContent = this.formatBytes(file.size);

      const reader = new FileReader();
      reader.onload = (e) => {
        previewImg.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }
  }

  async convertAndDownload() {
    if (!this.currentFile) {
      alert(this.i18n.t('select_image_first'));
      return;
    }

    const convertBtn = document.getElementById('convertBtn');
    const btnSpan = convertBtn ? convertBtn.querySelector('span') : null;
    const originalText = btnSpan ? btnSpan.textContent : '';

    if (convertBtn && btnSpan) {
      convertBtn.disabled = true;
      btnSpan.textContent = this.i18n.t('converting');
    }

    try {
      const baseName = this.currentFile.name.substring(0, this.currentFile.name.lastIndexOf('.')) || this.currentFile.name;
      const mimeType = this.getMimeType(this.targetFormat);
      const dataUrl = await this.convertImage(this.currentFile, mimeType, this.quality);
      const newFileName = `${baseName}.${this.getFileExtension(this.targetFormat)}`;

      const downloadLink = document.createElement('a');
      downloadLink.href = dataUrl;
      downloadLink.download = newFileName;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);

      if (btnSpan) {
        btnSpan.textContent = this.i18n.t('convert_success');
        setTimeout(() => {
          btnSpan.textContent = originalText;
          if (convertBtn) convertBtn.disabled = false;
        }, 1500);
      }
    } catch (err) {
      console.error('Conversion failed:', err);
      alert(err && err.message ? err.message : this.i18n.t('convert_error'));
      if (btnSpan) btnSpan.textContent = originalText;
      if (convertBtn) convertBtn.disabled = false;
    }
  }

  convertImage(file, targetMimeType, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context not available'));
          return;
        }

        // 투명도 배경 처리 (JPEG 변환 시 흰색 배경)
        if (targetMimeType === 'image/jpeg') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        ctx.drawImage(img, 0, 0);

        try {
          // 브라우저 Canvas가 해당 targetMimeType 인코딩을 지원하는지 검증
          const testDataUrl = canvas.toDataURL(targetMimeType, quality);
          if (targetMimeType !== 'image/png' && testDataUrl.startsWith('data:image/png')) {
            // 브라우저가 해당 포맷(예: AVIF)을 지원하지 않아 비압축 PNG로 Fallback된 경우
            reject(new Error(this.i18n.t('avif_not_supported')));
            return;
          }

          // toBlob을 사용하여 Blob 생성 후 DataURL 반환
          if (canvas.toBlob) {
            canvas.toBlob((blob) => {
              if (!blob) {
                resolve(testDataUrl);
                return;
              }
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            }, targetMimeType, quality);
          } else {
            resolve(testDataUrl);
          }
        } catch (e) {
          reject(e);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Failed to load image'));
      };

      img.src = objectUrl;
    });
  }

  getMimeType(format) {
    switch (format) {
      case 'jpeg':
      case 'jpg':
        return 'image/jpeg';
      case 'webp':
        return 'image/webp';
      case 'png':
      default:
        return 'image/png';
    }
  }

  getFileExtension(format) {
    if (format === 'jpeg') return 'jpg';
    return format;
  }

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}
