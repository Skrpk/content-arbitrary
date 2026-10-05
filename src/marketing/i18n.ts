/**
 * The public site's languages.
 *
 * English is the default and lives at the root (`/`); every other language
 * gets a path prefix (`/uk`). Plain paths with no redirect by browser
 * language: search engines crawl each version on its own URL, and `hreflang`
 * links tell them the pages are translations of one another.
 */

export const LOCALES = ['en', 'uk'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** `/`, or `/uk`, followed by `path` (which starts with `/` or is empty). */
export function localePath(locale: Locale, path = ''): string {
  const prefix = locale === DEFAULT_LOCALE ? '' : `/${locale}`;
  return `${prefix}${path}` || '/';
}

/** `hreflang` → path, for every language, plus the default for everyone else. */
export function languageAlternates(path = ''): Record<string, string> {
  return {
    ...Object.fromEntries(LOCALES.map((locale) => [locale, localePath(locale, path)])),
    'x-default': localePath(DEFAULT_LOCALE, path),
  };
}

/** Open Graph wants a territory too. */
export const OG_LOCALE: Record<Locale, string> = { en: 'en_US', uk: 'uk_UA' };
