import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Root layout for the review website, served on its own subdomain
 * (WEB_APP_URL). Its own root, like the Mini Apps': a tool behind a sign-in,
 * in English, never indexed.
 *
 * The pages share their components with the Mini Apps, which take their
 * colours from Telegram's `--tg-theme-*` variables. Here those are set from
 * the browser's light or dark preference instead, so the same components look
 * right outside Telegram.
 */
export const metadata: Metadata = {
  title: 'Story Radar',
  robots: { index: false, follow: false },
};

const themeVariables = `
:root {
  color-scheme: light dark;
  --tg-theme-bg-color: #ffffff;
  --tg-theme-text-color: #16181a;
  --tg-theme-hint-color: #6b7177;
  --tg-theme-link-color: #2481cc;
  --tg-theme-button-color: #2481cc;
  --tg-theme-button-text-color: #ffffff;
  --tg-theme-secondary-bg-color: #f2f3f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --tg-theme-bg-color: #17191c;
    --tg-theme-text-color: #eceef0;
    --tg-theme-hint-color: #9aa1a8;
    --tg-theme-link-color: #6ab3f3;
    --tg-theme-button-color: #3e88d6;
    --tg-theme-button-text-color: #ffffff;
    --tg-theme-secondary-bg-color: #23262a;
  }
}
body { background: var(--tg-theme-bg-color); color: var(--tg-theme-text-color); }
button:disabled { cursor: default; }
`;

export default function WebLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{themeVariables}</style>
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
