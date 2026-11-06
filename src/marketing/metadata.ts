import type { Metadata, Viewport } from 'next';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import { CONTENT } from './content';
import { LOCALES, OG_LOCALE, languageAlternates, localePath, type Locale } from './i18n';

/**
 * Metadata for a public page in one language: its canonical URL, the same
 * page in every other language for `hreflang`, and the social preview. A page
 * beyond the landing names its own `title` and `description`.
 */
export function marketingMetadata(
  locale: Locale,
  path = '',
  page?: { title: string; description: string },
): Metadata {
  const meta = page ?? CONTENT[locale].meta;

  return {
    metadataBase: new URL(SITE_URL),
    title: page
      ? { absolute: pageTitle(page.title) }
      : {
          default: pageTitle(meta.title),
          template: `%s — ${SITE_NAME}`,
        },
    description: meta.description,
    applicationName: SITE_NAME,
    alternates: {
      canonical: localePath(locale, path),
      languages: languageAlternates(path),
    },
    openGraph: {
      type: 'website',
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.filter((other) => other !== locale).map((other) => OG_LOCALE[other]),
      url: localePath(locale, path),
      siteName: SITE_NAME,
      title: meta.title,
      description: meta.description,
      // The landing's image is a file beside it; a page's own metadata would otherwise leave it with none.
      ...(page ? { images: [{ url: '/logo.png', width: 512, height: 512, alt: SITE_NAME }] } : {}),
    },
    twitter: {
      card: page ? 'summary' : 'summary_large_image',
      title: meta.title,
      description: meta.description,
    },
    robots: { index: true, follow: true },
    formatDetection: { telephone: false },
  };
}

/** A page's title in search results: with the site's name, unless it says it already. */
export function pageTitle(title: string): string {
  return title.includes(SITE_NAME) ? title : `${title} — ${SITE_NAME}`;
}

export const marketingViewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1621' },
  ],
};
