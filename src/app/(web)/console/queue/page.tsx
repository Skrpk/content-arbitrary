import { redirect } from 'next/navigation';
import { currentWebViewer } from '@/lib/accounts/current';
import { WebQueue } from './web-queue';

/**
 * The review queue on the website: the same queue as the Mini App's, with
 * room to read it — picture beside text — and keys to work through it.
 */
export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const viewer = await currentWebViewer();
  if (!viewer) redirect('/login?returnTo=/queue');

  const wanted = Number((await searchParams).workspace);
  const name = viewer.user.displayName ?? 'Signed in';

  return (
    <>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.6rem 1rem',
          background: 'var(--tg-theme-bg-color)',
          borderBottom: '1px solid var(--tg-theme-secondary-bg-color)',
        }}
      >
        <strong style={{ flex: 1 }}>Story Radar · Review queue</strong>
        <span style={{ color: 'var(--tg-theme-hint-color)', fontSize: '0.85rem' }}>{name}</span>
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
      <main style={{ maxWidth: '60rem', margin: '0 auto', padding: '1rem', boxSizing: 'border-box' }}>
        <WebQueue initialWorkspaceId={Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null} />
      </main>
    </>
  );
}
