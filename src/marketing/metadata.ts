import type { Metadata, Viewport } from 'next';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import { CONTENT } from './content';
import { LOCALES, OG_LOCALE, languageAlternates, localePath, type Locale } from './i18n';

/**
 * Metadata for a public page in one language: its canonical URL, the same
 * page in every other language for `hreflang`, and the social preview.
 */
export function marketingMetadata(locale: Locale, path = ''): Metadata {
  const { meta } = CONTENT[locale];

  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: `${meta.title} — ${SITE_NAME}`,
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
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.description,
    },
    robots: { index: true, follow: true },
    formatDetection: { telephone: false },
  };
}

export const marketingViewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1621' },
  ],
};
