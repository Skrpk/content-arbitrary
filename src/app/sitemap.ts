import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { LOCALES, localePath } from '@/marketing/i18n';

/**
 * Every public page, in every language, each listing its translations so
 * search engines treat them as one page in several languages. Blog posts join
 * this list when the blog exists.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [''];
  const absolute = (path: string) => new URL(path, SITE_URL).toString();

  return pages.flatMap((path) =>
    LOCALES.map((locale) => ({
      url: absolute(localePath(locale, path)),
      changeFrequency: 'monthly' as const,
      priority: 1,
      alternates: {
        languages: Object.fromEntries(
          LOCALES.map((other) => [other, absolute(localePath(other, path))]),
        ),
      },
    })),
  );
}
