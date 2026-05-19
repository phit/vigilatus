import fs from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

const i18n = i18next.createInstance();

const localesDir = path.join(__dirname, '..', '..', 'locales');

i18n.init({
  resources: {
    en: { translation: JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'translation.json'), 'utf8')) },
    de: { translation: JSON.parse(fs.readFileSync(path.join(localesDir, 'de', 'translation.json'), 'utf8')) },
  },
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLanguage(lang: string): void {
  if (lang === 'system') {
    const sys = Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0];
    void i18n.changeLanguage(sys in (i18n.options.resources ?? {}) ? sys : 'en');
  } else {
    void i18n.changeLanguage(lang);
  }
}

export const t = i18n.t.bind(i18n);
