import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { appFontClass } from '@/components/app-fonts';
import { APP_BASE_CSS, WEB_PALETTE_CSS } from '@/components/app-theme';
import { SITE_NAME } from '@/lib/site';

/**
 * Root layout for the review website, served on its own subdomain
 * (WEB_APP_URL). Its own root, like the Mini Apps': a tool behind a sign-in,
 * in English, never indexed.
 *
 * The pages share their components with the Mini Apps, which take their
 * colours from Telegram's `--tg-theme-*` variables. Here those are set from
 * the browser's light or dark preference instead — the public site's paper,
 * ink and marker (src/components/app-theme.ts) — so the same components look
 * right outside Telegram.
 */
export const metadata: Metadata = {
  title: SITE_NAME,
  robots: { index: false, follow: false },
};

export default function WebLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={appFontClass}>
      <head>
        <style>{APP_BASE_CSS + WEB_PALETTE_CSS}</style>
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  );
}
