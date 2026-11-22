'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SCHEDULED_CHANGED_EVENT } from '@/components/scheduled-count';

/** The website's sections. Paths are the website's own; see next.config.ts. */
const SECTIONS = [
  { href: '/queue', label: 'Review queue' },
  { href: '/scheduled', label: 'Scheduled' },
  { href: '/sources', label: 'Sources' },
  { href: '/settings', label: 'Settings' },
];

/** How often the number is read again while the page sits open: the scheduler publishes every minute. */
const RECOUNT_MS = 60_000;

/**
 * How many posts wait for their time, in every channel the viewer reviews.
 * Read again on every page, on coming back to the tab, every minute, and
 * whenever this page schedules or unschedules a post. Null until known, or
 * when it could not be read: then no number is shown rather than a wrong one.
 */
function useScheduledCount(pathname: string): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const recount = () => {
      fetch('/api/telegram/webapp/scheduled?count=1', { credentials: 'same-origin' })
        .then((response) => (response.ok ? (response.json() as Promise<{ count?: unknown }>) : null))
        .then((body) => {
          if (!cancelled) setCount(typeof body?.count === 'number' ? body.count : null);
        })
        .catch(() => {
          if (!cancelled) setCount(null);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') recount();
    };

    recount();
    const timer = setInterval(recount, RECOUNT_MS);
    window.addEventListener(SCHEDULED_CHANGED_EVENT, recount);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(SCHEDULED_CHANGED_EVENT, recount);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pathname]);

  return count;
}

export function NavLinks() {
  const pathname = usePathname();
  const scheduled = useScheduledCount(pathname);

  return (
    <nav style={{ display: 'flex', gap: '0.25rem' }}>
      {SECTIONS.map((section) => {
        const active = pathname === section.href || pathname.endsWith(`/console${section.href}`);
        const count = section.href === '/scheduled' && scheduled ? scheduled : null;
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-label={count ? `${section.label}, ${count} posts` : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
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
            {count ? (
              <span
                style={{
                  minWidth: '1.2rem',
                  padding: '0.05rem 0.35rem',
                  borderRadius: '999px',
                  boxSizing: 'border-box',
                  textAlign: 'center',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1.4,
                  color: active ? 'var(--tg-theme-text-color)' : 'var(--tg-theme-bg-color)',
                  background: active ? 'var(--tg-theme-bg-color)' : 'var(--tg-theme-text-color)',
                }}
              >
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
