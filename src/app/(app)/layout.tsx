import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Root layout for the Telegram Mini Apps (review, schedule, settings).
 *
 * A root layout of its own, separate from the marketing site's: these pages
 * are tools opened inside Telegram, in English, and must never be indexed.
 */
export const metadata: Metadata = {
  title: 'content-arbitrary',
  robots: { index: false, follow: false },
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Padding belongs to each page: the Mini App needs the full viewport. */}
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
