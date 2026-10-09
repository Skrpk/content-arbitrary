import { redirect } from 'next/navigation';
import { currentWebViewer } from '@/lib/accounts/current';
import { safeReturnTo } from '@/lib/accounts/web';
import { getEnv } from '@/lib/env';
import { telegramLoginProvider } from '@/lib/accounts/telegram';

/**
 * Sign in. One way for now — Telegram, as OpenID Connect — and more are more
 * buttons here: each goes to its own /api/auth/<provider>/start.
 */

const ERRORS: Record<string, string> = {
  denied: 'Sign-in was cancelled.',
  expired: 'That sign-in took too long or was started elsewhere. Please try again.',
  failed: 'Sign-in failed. Please try again.',
  'not-a-reviewer': 'This Telegram account does not review any channel here.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo) ?? '/queue';
  if (await currentWebViewer()) redirect(returnTo);

  const error = params.error ? (ERRORS[params.error] ?? ERRORS.failed) : null;
  const configured = telegramLoginProvider(getEnv()) !== null;

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        boxSizing: 'border-box',
      }}
    >
      <section
        style={{
          width: '100%',
          maxWidth: '22rem',
          background: 'var(--tg-theme-secondary-bg-color)',
          borderRadius: '0.8rem',
          padding: '1.5rem',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.25rem' }}>Story Radar</h1>
        <p style={{ color: 'var(--tg-theme-hint-color)', fontSize: '0.9rem', margin: '0 0 1.25rem' }}>
          Sign in to review your channels&apos; posts.
        </p>

        {configured ? (
          <a
            href={`/api/auth/telegram/start?returnTo=${encodeURIComponent(returnTo)}`}
            style={{
              display: 'block',
              padding: '0.7rem 0',
              borderRadius: '0.55rem',
              background: '#2aabee',
              color: '#ffffff',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Log in with Telegram
          </a>
        ) : (
          <p style={{ fontSize: '0.9rem' }}>Sign-in is not set up yet.</p>
        )}

        {error ? <p style={{ color: '#e53935', fontSize: '0.85rem', margin: '1rem 0 0' }}>{error}</p> : null}
      </section>
    </main>
  );
}
