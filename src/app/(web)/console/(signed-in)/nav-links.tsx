'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The website's sections. Paths are the website's own; see next.config.ts. */
const SECTIONS = [
  { href: '/queue', label: 'Review queue' },
  { href: '/scheduled', label: 'Scheduled' },
  { href: '/sources', label: 'Sources' },
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
              borderRadius: '4px',
              fontSize: '0.9rem',
              textDecoration: 'none',
              fontWeight: active ? 700 : 500,
              // Where you are is under the marker, as the picks in the feed are.
              color: active ? 'var(--z-mark-ink)' : 'var(--tg-theme-text-color)',
              background: active ? 'var(--z-mark)' : 'transparent',
            }}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
