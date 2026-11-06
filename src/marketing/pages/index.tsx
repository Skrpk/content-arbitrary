import type { Metadata } from 'next';
import Link from 'next/link';
import { CONTACT_URL } from '@/lib/site';
import { CONTENT } from '../content';
import { localePath, type Locale } from '../i18n';
import { MarketingPage } from '../document';
import { marketingMetadata } from '../metadata';
import { about } from './about';
import { privacy } from './privacy';
import type { PublicPage } from './shared';
import { terms } from './terms';
import { USE_CASE_KEYS, USE_CASE_PAGES, type UseCaseKey } from './use-cases';

/**
 * The public site's pages beyond the landing, each in every language at the
 * same path: /about, /uk/about. The sitemap and the footer list them from here.
 */

export const PUBLIC_PAGES = { about, privacy, terms, ...USE_CASE_PAGES } as const satisfies Record<
  string,
  Record<Locale, PublicPage>
>;

export type PublicPageKey = keyof typeof PUBLIC_PAGES;

export const PUBLIC_PAGE_PATHS = (Object.keys(PUBLIC_PAGES) as PublicPageKey[]).map((key) => `/${key}`);

export function publicPageMetadata(locale: Locale, key: PublicPageKey): Metadata {
  const { title, description } = PUBLIC_PAGES[key][locale];
  return marketingMetadata(locale, `/${key}`, { title, description });
}

export function PublicPageView({ locale, page: key }: { locale: Locale; page: PublicPageKey }) {
  const page: PublicPage = PUBLIC_PAGES[key][locale];
  return (
    <MarketingPage locale={locale} path={`/${key}`}>
      <article className="container container--narrow public-page">
        <h1>{page.title}</h1>
        {page.effective ? <p className="public-page__effective">{page.effective}</p> : null}
        {page.body}
        {USE_CASE_KEYS.includes(key as UseCaseKey) ? <UseCaseClose locale={locale} current={key} /> : null}
      </article>
    </MarketingPage>
  );
}

/** How a page on one task ends: the way to start, and the other tasks. */
function UseCaseClose({ locale, current }: { locale: Locale; current: PublicPageKey }) {
  const text = CONTENT[locale];
  return (
    <>
      <section className="page-cta">
        <h2>{text.cta.title}</h2>
        <p>{text.cta.text}</p>
        <a className="button" href={CONTACT_URL} rel="noopener">
          {text.cta.button}
        </a>
      </section>
      <nav aria-label={text.useCases.title}>
        <h2>{text.useCases.more}</h2>
        <ul>
          {USE_CASE_KEYS.filter((key) => key !== current).map((key) => (
            <li key={key}>
              <Link href={localePath(locale, `/${key}`)}>{USE_CASE_PAGES[key][locale].title}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
