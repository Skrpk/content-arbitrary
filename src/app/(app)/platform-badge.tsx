/**
 * Marks a source that is not an X account — a feed, a Telegram or YouTube channel, a website — on
 * the Mini App and website pages. An X account, the usual case, goes unmarked.
 */
const BADGES = {
  rss: { label: 'RSS', colour: '#f26522' },
  telegram: { label: 'Telegram', colour: '#229ed9' },
  youtube: { label: 'YouTube', colour: '#e62117' },
  website: { label: 'Web', colour: '#5b6b7a' },
} as const;

export function PlatformBadge({ platform }: { platform: 'x' | 'rss' | 'telegram' | 'youtube' | 'website' }) {
  if (platform === 'x') return null;
  const badge = BADGES[platform];
  return (
    <span
      style={{
        marginLeft: '0.4rem',
        padding: '0.05rem 0.4rem',
        borderRadius: '0.3rem',
        background: badge.colour,
        color: '#ffffff',
        fontSize: '0.7rem',
        fontWeight: 700,
        verticalAlign: 'middle',
      }}
    >
      {badge.label}
    </span>
  );
}
