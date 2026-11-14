import { redirect } from 'next/navigation';
import { currentWebViewer } from '@/lib/accounts/current';
import { safeReturnTo } from '@/lib/accounts/web';
import { getEnv } from '@/lib/env';
import { telegramLoginProvider } from '@/lib/accounts/telegram';
import { reviewAccess } from '@/lib/accounts/review-access';
import { SITE_NAME, SITE_URL } from '@/lib/site';

/**
 * Sign in. Telegram, as OpenID Connect — and more are more buttons here: each
 * goes to its own /api/auth/<provider>/start. While it is configured, app
 * reviewers' username and password too (src/lib/accounts/review-access.ts).
 */

const ERRORS: Record<string, string> = {
  denied: 'Sign-in was cancelled.',
  expired: 'That sign-in took too long or was started elsewhere. Please try again.',
  failed: 'Sign-in failed. Please try again.',
  'not-a-reviewer': 'This Telegram account does not review any channel here.',
  'review-failed': 'Wrong username or password.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo) ?? '/queue';
  if (await currentWebViewer()) redirect(returnTo);

  const error = params.error ? (ERRORS[params.error] ?? ERRORS.failed) : null;
  const env = getEnv();
  const configured = telegramLoginProvider(env) !== null;
  // App reviewers' way in, while it is configured; open already after a failed try.
  const reviewers = reviewAccess(env) !== null;
  const reviewOpen = params.review === '1';

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
          border: '1px solid var(--z-border)',
          borderRadius: '1.25rem',
          padding: '2rem 1.5rem',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '2rem', fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 0.5rem' }}>
          <span style={{ padding: '0 0.15em', background: 'var(--z-mark)', color: 'var(--z-mark-ink)' }}>{SITE_NAME}</span>
        </h1>
        <p style={{ color: 'var(--tg-theme-hint-color)', fontSize: '0.9rem', margin: '0 0 1.25rem' }}>
          Sign in to review your channels&apos; posts.
        </p>

        {configured ? (
          <a
            href={`/api/auth/telegram/start?returnTo=${encodeURIComponent(returnTo)}`}
            style={{
              display: 'block',
              padding: '0.7rem 0',
              borderRadius: '999px',
              background: 'var(--tg-theme-button-color)',
              color: 'var(--tg-theme-button-text-color)',
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

        {reviewers ? (
          <details open={reviewOpen} style={{ margin: '1rem 0 0', textAlign: 'left', fontSize: '0.85rem' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--tg-theme-hint-color)' }}>App reviewer access</summary>
            <form method="post" action="/api/auth/review" style={{ display: 'grid', gap: '0.5rem', marginTop: '0.6rem' }}>
              <input type="hidden" name="returnTo" value={returnTo} />
              <input name="username" autoComplete="username" placeholder="Username" required style={fieldStyle} />
              <input name="password" type="password" autoComplete="current-password" placeholder="Password" required style={fieldStyle} />
              <button
                type="submit"
                style={{ padding: '0.6rem 0', borderRadius: '999px', border: 'none', background: 'var(--tg-theme-button-color)', color: 'var(--tg-theme-button-text-color)', fontWeight: 600 }}
              >
                Sign in
              </button>
            </form>
          </details>
        ) : null}

        <p style={{ color: 'var(--tg-theme-hint-color)', fontSize: '0.75rem', margin: '1rem 0 0' }}>
          By signing in you agree to the <a href={`${SITE_URL}/terms`} style={{ color: 'inherit' }}>Terms of Service</a> and the{' '}
          <a href={`${SITE_URL}/privacy`} style={{ color: 'inherit' }}>Privacy Policy</a>.
        </p>
      </section>
    </main>
  );
}

const fieldStyle = {
  padding: '0.55rem 0.65rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--tg-theme-hint-color)',
  background: 'var(--tg-theme-bg-color)',
  color: 'var(--tg-theme-text-color)',
  fontSize: '0.9rem',
} as const;
