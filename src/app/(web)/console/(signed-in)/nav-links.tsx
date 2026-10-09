'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The website's sections. Paths are the website's own; see next.config.ts. */
const SECTIONS = [
  { href: '/queue', label: 'Review queue' },
  { href: '/stats', label: 'Source stats' },
  { href: '/settings', label: 'Settings' },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav style={{ display: 'flex', gap: '0.25rem' }}>
      {SECTIONS.map((section) => {
        const active = pathname === section.href || pathname.endsWith(`/console${section.href}`);
        return (
          <Link
            key={section.href}
            href={section.href}
            style={{
              padding: '0.3rem 0.6rem',
              borderRadius: '0.45rem',
              fontSize: '0.9rem',
              textDecoration: 'none',
              color: active ? 'var(--tg-theme-button-text-color)' : 'var(--tg-theme-text-color)',
              background: active ? 'var(--tg-theme-button-color)' : 'transparent',
            }}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
