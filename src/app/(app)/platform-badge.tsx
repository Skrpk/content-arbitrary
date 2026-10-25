/**
 * Marks where a source is — X, a feed, a Telegram or YouTube channel, a website — on the Mini App
 * and website pages.
 */
const BADGES = {
  // Black like X's own mark, outlined so it still shows on a dark theme.
  x: { label: 'X', colour: '#000000' },
  rss: { label: 'RSS', colour: '#f26522' },
  telegram: { label: 'Telegram', colour: '#229ed9' },
  youtube: { label: 'YouTube', colour: '#e62117' },
  website: { label: 'Web', colour: '#5b6b7a' },
} as const;

export function PlatformBadge({ platform }: { platform: 'x' | 'rss' | 'telegram' | 'youtube' | 'website' }) {
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
        ...(platform === 'x' ? { boxShadow: 'inset 0 0 0 1px rgba(127, 127, 127, 0.6)' } : {}),
      }}
    >
      {badge.label}
    </span>
  );
}
