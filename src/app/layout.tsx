import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'content-arbitrary',
  description: 'Mirrors photos and videos from an X account into a Telegram channel.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
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
