class I18nManager {
  constructor() {
    this.currentLang = 'ko';
    this.dictionary = {};
  }

  async init() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['appLanguage'], async (result) => {
        if (result.appLanguage) {
          this.currentLang = result.appLanguage;
        } else {
          const browserLang = chrome.i18n.getUILanguage();
          this.currentLang = browserLang.startsWith('ko') ? 'ko' : 'en';
        }
        await this.loadDictionary(this.currentLang);
        resolve(this.currentLang);
      });
    });
  }

  async loadDictionary(lang) {
    try {
      const url = chrome.runtime.getURL(`locales/${lang}.json`);
      const response = await fetch(url);
      this.dictionary = await response.json();
      this.currentLang = lang;
      await chrome.storage.local.set({ appLanguage: lang });
    } catch (error) {
      console.error('Failed to load locale dictionary:', error);
    }
  }

  async setLanguage(lang) {
    if (this.currentLang === lang) return;
    await this.loadDictionary(lang);
  }

  t(key) {
    return this.dictionary[key] || key;
  }

  applyToDOM() {
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key && this.dictionary[key]) {
        if (el.tagName === 'INPUT' && el.type === 'placeholder') {
          el.placeholder = this.dictionary[key];
        } else {
          el.textContent = this.dictionary[key];
        }
      }
    });
  }
}

if (typeof module !== 'undefined') {
  module.exports = I18nManager;
}
