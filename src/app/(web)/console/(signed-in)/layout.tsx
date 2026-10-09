import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentWebViewer } from '@/lib/accounts/current';
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
          padding: '0.6rem 1rem',
          background: 'var(--tg-theme-bg-color)',
          borderBottom: '1px solid var(--tg-theme-secondary-bg-color)',
        }}
      >
        <strong>Story Radar</strong>
        <NavLinks />
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--tg-theme-hint-color)', fontSize: '0.85rem' }}>
          {viewer.user.displayName ?? 'Signed in'}
        </span>
        <form method="post" action="/api/auth/logout" style={{ margin: 0 }}>
          <button
            type="submit"
            style={{
              padding: '0.3rem 0.7rem',
              border: '1px solid var(--tg-theme-hint-color)',
              borderRadius: '0.45rem',
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
