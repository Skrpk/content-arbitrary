import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from './chrome';
import { CONTENT } from './content';
import type { Locale } from './i18n';

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
