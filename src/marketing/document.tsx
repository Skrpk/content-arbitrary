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
      <body>
        <a className="skip-link" href="#main">
          {CONTENT[locale].skipLink}
        </a>
        <SiteHeader locale={locale} />
        <main id="main">{children}</main>
        <SiteFooter locale={locale} />
      </body>
    </html>
  );
}
