import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentWebViewer } from '@/lib/accounts/current';
import { SITE_NAME } from '@/lib/site';
import { NavLinks } from './nav-links';

/**
 * Every page behind the sign-in: checked here once, so a page cannot be
 * reached without a session by forgetting to check, and framed with the
 * same header — the sections, who is signed in, and Sign out.
 */
export default async function SignedInLayout({ children }: { children: ReactNode }) {
  const viewer = await currentWebViewer();
  if (!viewer) redirect('/login');

  return (
    <>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.5rem 1rem',
          padding: '0.7rem 1rem',
          background: 'var(--tg-theme-bg-color)',
          borderBottom: '1px solid var(--tg-theme-text-color)',
        }}
      >
        <strong
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontFamily: 'var(--z-display)',
            fontSize: '1.2rem',
            fontWeight: 800,
            letterSpacing: '-0.02em',
          }}
        >
          {/* The site's mark, as on the public site's header. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a 400-byte SVG; nothing for next/image to optimise */}
          <img src="/icon.svg" alt="" width={28} height={28} style={{ transform: 'rotate(-4deg)' }} />
          {SITE_NAME}
        </strong>
        <NavLinks />
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--tg-theme-hint-color)', fontSize: '0.85rem' }}>
          {viewer.user.displayName ?? 'Signed in'}
        </span>
        <form method="post" action="/api/auth/logout" style={{ margin: 0 }}>
          <button
            type="submit"
            style={{
              padding: '0.35rem 0.8rem',
              border: '1px solid var(--tg-theme-hint-color)',
              borderRadius: '999px',
              background: 'transparent',
              color: 'var(--tg-theme-text-color)',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        </form>
      </header>
      <main style={{ maxWidth: '60rem', margin: '0 auto', padding: '1rem', boxSizing: 'border-box' }}>{children}</main>
    </>
  );
}
