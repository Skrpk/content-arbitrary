/**
 * Where the public site's pages are, in every language: `/`, `/about`,
 * `/uk/about`. Plain strings, no pages, so next.config.ts can read them to
 * send the site's first address on to SITE_URL. Kept in step with
 * PUBLIC_PAGES in ./pages (tests/marketing-seo.test.ts).
 */

export const PUBLIC_PAGE_KEYS = [
  'about',
  'privacy',
  'terms',
  'rss-to-telegram',
  'schedule-telegram-posts',
  'x-to-telegram',
  'translate-telegram-posts',
  'youtube-to-telegram',
  'website-to-telegram',
] as const;

/** Every public page's path, in every language; the languages are i18n.ts's LOCALES. */
export const PUBLIC_SITE_PATHS: readonly string[] = ['', ...PUBLIC_PAGE_KEYS.map((key) => `/${key}`)].flatMap((path) => [
  path || '/',
  `/uk${path}`,
]);
