import zhCN, { type LocaleKey } from './zh-CN';
import enUS from './en-US';

export type Locale = 'zh-CN' | 'en-US';

const locales: Record<Locale, Record<LocaleKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

let currentLocale: Locale = 'zh-CN';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(key: LocaleKey): string {
  return locales[currentLocale][key] ?? locales['en-US'][key] ?? key;
}

export { zhCN, enUS };
export type { LocaleKey };
