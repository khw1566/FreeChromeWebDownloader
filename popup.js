class PopupController {
  constructor() {
    this.i18n = new I18nManager();
    this.currentFilter = 'all';
    this.mediaList = [];
    this.currentTabId = null;
    this.hideSmallFiles = true;
    this.minSizeBytes = 100 * 1024; // 100KB 미만 필터링 기준
  }

  async init() {
    const lang = await this.i18n.init();
    this.updateLangButtonLabel(lang);
    this.i18n.applyToDOM();

    this.videoConverter = new VideoConverterController(this.i18n);
    this.videoConverter.init();

    this.imageConverter = new ImageConverterController(this.i18n);
    this.imageConverter.init();

    this.bindEvents();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      this.currentTabId = tab.id;
      this.downloadUI = new UnifiedDownloadUI(this, tab);
      await this.downloadUI.init();
      this.loadCopyProtectionStatus();
    }
  }

  bindEvents() {
    document.getElementById('langToggleBtn').addEventListener('click', () => this.toggleLanguage());
    document.getElementById('rescanBtn').addEventListener('click', () => this.rescanPage());

    // 메인 탭 전환 (미디어 다운로드 / 동영상 변환 / 이미지 변환)
    const mainTabBtns = document.querySelectorAll('.main-tab-btn');
    mainTabBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const currentBtn = e.currentTarget || btn;
        const targetTab = currentBtn.getAttribute('data-tab');
        mainTabBtns.forEach(b => b.classList.remove('active'));
        currentBtn.classList.add('active');

        const mediaSection = document.getElementById('mediaTabSection');
        const videoSection = document.getElementById('videoConverterTabSection');
        const imageSection = document.getElementById('imageConverterTabSection');

        if (mediaSection) mediaSection.classList.remove('active');
        if (videoSection) videoSection.classList.remove('active');
        if (imageSection) imageSection.classList.remove('active');

        if (targetTab === 'media') {
          if (mediaSection) mediaSection.classList.add('active');
        } else if (targetTab === 'video-converter') {
          if (videoSection) videoSection.classList.add('active');
        } else if (targetTab === 'image-converter') {
          if (imageSection) imageSection.classList.add('active');
        }
      });
    });

    const filterBtns = document.querySelectorAll('.btn-filter');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetBtn = e.currentTarget || e.target.closest('.btn-filter');
        if (!targetBtn) return;
        filterBtns.forEach(b => b.classList.remove('active'));
        targetBtn.classList.add('active');
        this.currentFilter = targetBtn.getAttribute('data-filter');
        this.renderList();
      });
    });

    const hideSmallCheckbox = document.getElementById('hideSmallFilesCheck');
    if (hideSmallCheckbox) {
      hideSmallCheckbox.checked = this.hideSmallFiles;
      hideSmallCheckbox.addEventListener('change', (e) => {
        this.hideSmallFiles = e.target.checked;
        this.renderList();
      });
    }

    const copyProtectionCheckbox = document.getElementById('enableCopyProtectionBypassCheck');
    if (copyProtectionCheckbox) {
      copyProtectionCheckbox.addEventListener('change', (e) => {
        this.toggleCopyProtectionBypass(e.target.checked);
      });
    }
  }

  async loadCopyProtectionStatus() {
    if (!this.currentTabId) return;
    const checkbox = document.getElementById('enableCopyProtectionBypassCheck');
    if (!checkbox) return;

    try {
      const response = await chrome.tabs.sendMessage(this.currentTabId, { action: 'GET_COPY_PROTECTION_STATUS' });
      if (response && typeof response.enabled === 'boolean') {
        checkbox.checked = response.enabled;
      }
    } catch (e) {
      checkbox.checked = false;
    }
  }

  async toggleCopyProtectionBypass(enabled) {
    if (!this.currentTabId) return;

    try {
      await chrome.tabs.sendMessage(this.currentTabId, {
        action: 'SET_COPY_PROTECTION_BYPASS',
        enabled: enabled
      });
    } catch (e) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: this.currentTabId },
          files: ['content.js']
        });
        await chrome.tabs.sendMessage(this.currentTabId, {
          action: 'SET_COPY_PROTECTION_BYPASS',
          enabled: enabled
        });
      } catch (err) {
        console.warn('Failed to toggle copy protection bypass:', err);
      }
    }
  }

  updateLangButtonLabel(lang) {
    const btn = document.getElementById('langToggleBtn');
    btn.textContent = lang === 'ko' ? 'EN' : 'KO';
  }

  async toggleLanguage() {
    const nextLang = this.i18n.currentLang === 'ko' ? 'en' : 'ko';
    await this.i18n.setLanguage(nextLang);
    this.updateLangButtonLabel(nextLang);
    this.i18n.applyToDOM();
    this.renderList();
  }

  loadMediaList() { return this.downloadUI?.loadMedia(); }

  rescanPage() { return this.downloadUI?.rescan(); }

  renderList() { return this.downloadUI?.renderList(); }

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const controller = new PopupController();
  controller.init();
});
