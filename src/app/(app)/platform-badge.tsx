/**
 * Marks a source that is not an X account — a feed, a Telegram channel — on
 * the Mini App and website pages. An X account, the usual case, goes unmarked.
 */
export function PlatformBadge({ platform }: { platform: 'x' | 'rss' | 'telegram' }) {
  if (platform === 'x') return null;
  return (
    <span
      style={{
        marginLeft: '0.4rem',
        padding: '0.05rem 0.4rem',
        borderRadius: '0.3rem',
        background: platform === 'rss' ? '#f26522' : '#229ed9',
        color: '#ffffff',
        fontSize: '0.7rem',
        fontWeight: 700,
        verticalAlign: 'middle',
      }}
    >
      {platform === 'rss' ? 'RSS' : 'Telegram'}
    </span>
  );
}
