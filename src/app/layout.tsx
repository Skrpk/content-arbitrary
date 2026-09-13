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
      <body
        style={{
          margin: 0,
          padding: '3rem 1.5rem',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  );
}
