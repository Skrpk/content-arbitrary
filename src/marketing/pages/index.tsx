import type { Metadata } from 'next';
import { type Locale } from '../i18n';
import { MarketingPage } from '../document';
import { marketingMetadata } from '../metadata';
import { about } from './about';
import { privacy } from './privacy';
import type { PublicPage } from './shared';
import { terms } from './terms';

/**
 * The public site's pages beyond the landing, each in every language at the
 * same path: /about, /uk/about. The sitemap and the footer list them from here.
 */

export const PUBLIC_PAGES = { about, privacy, terms } as const satisfies Record<string, Record<Locale, PublicPage>>;

export type PublicPageKey = keyof typeof PUBLIC_PAGES;

export const PUBLIC_PAGE_PATHS = (Object.keys(PUBLIC_PAGES) as PublicPageKey[]).map((key) => `/${key}`);

export function publicPageMetadata(locale: Locale, key: PublicPageKey): Metadata {
  const { title, description } = PUBLIC_PAGES[key][locale];
  return marketingMetadata(locale, `/${key}`, { title, description });
}

export function PublicPageView({ locale, page: key }: { locale: Locale; page: PublicPageKey }) {
  const page = PUBLIC_PAGES[key][locale];
  return (
    <MarketingPage locale={locale} path={`/${key}`}>
      <article className="container container--narrow public-page">
        <h1>{page.title}</h1>
        {page.effective ? <p className="public-page__effective">{page.effective}</p> : null}
        {page.body}
      </article>
    </MarketingPage>
  );
}
