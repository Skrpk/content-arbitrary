import { Analytics } from '@vercel/analytics/next';
import { Geologica, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import type { Locale } from './i18n';
import './marketing.css';

/*
 * Apart from document.tsx because next/font only runs under Next's compiler:
 * the layouts import this, and the pages, which tests render, do not.
 */

/**
 * The site's two faces: headlines, and the feed's and labels' monospace. Both
 * have Cyrillic, are served from the site's own origin and swap in over the
 * system font, so the text is readable before they arrive. Body text stays
 * the system's.
 */
const display = Geologica({ subsets: ['latin', 'cyrillic'], variable: '--font-display', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin', 'cyrillic'], variable: '--font-mono', display: 'swap' });

/**
 * The `<html>` of a public page in one language. Each language has its own
 * root layout so that `lang` is right in the server-rendered HTML, which is
 * what search engines and screen readers go by.
 *
 * Visits are counted here and only here: the Mini App and the website editor
 * have documents of their own, and what people do in them is not measured.
 */
export function MarketingDocument({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html lang={locale} className={`${display.variable} ${mono.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
