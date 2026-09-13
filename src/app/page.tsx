/**
 * Intentionally minimal and secret-free. This app is a scheduled job, not a
 * website; the only public surface is this placeholder. All real information
 * lives behind /api/status, which requires a secret.
 */
export default function HomePage() {
  return (
    <main style={{ maxWidth: '40rem', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>content-arbitrary</h1>
      <p style={{ color: '#555' }}>
        Scheduled worker that mirrors new photos and videos from an X account into a Telegram
        channel. There is nothing to see here — operational data is available at{' '}
        <code>/api/status</code> with a valid admin secret.
      </p>
    </main>
  );
}
