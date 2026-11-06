import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from './chrome';
import { CONTENT } from './content';
import type { Locale } from './i18n';
import './marketing.css';

/**
 * The `<html>` of a public page in one language. Each language has its own
 * root layout so that `lang` is right in the server-rendered HTML, which is
 * what search engines and screen readers go by.
 */
export function MarketingDocument({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}

/**
 * What every public page has around it. Part of the page, not the layout: the
 * header's language switch goes to the same page in the other language, and
 * only the page knows which it is.
 */
export function MarketingPage({ locale, path = '', children }: { locale: Locale; path?: string; children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        {CONTENT[locale].skipLink}
      </a>
      <SiteHeader locale={locale} path={path} />
      <main id="main">{children}</main>
      <SiteFooter locale={locale} />
    </>
  );
}
