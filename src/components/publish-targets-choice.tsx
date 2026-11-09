'use client';

import { theme } from '@/lib/telegram/webapp-client';
import type { PublishTarget } from '@/lib/publish/targets';

/**
 * Where a post goes, ticked: Telegram, Threads, or both — for a channel with
 * a Threads account. At least one stays ticked: unticking the last does nothing.
 */
export function PublishTargetsChoice({
  value,
  onChange,
  disabled,
}: {
  value: PublishTarget[];
  onChange: (targets: PublishTarget[]) => void;
  disabled?: boolean;
}) {
  const toggle = (target: PublishTarget, on: boolean) => {
    const next = on ? [...new Set([...value, target])] : value.filter((item) => item !== target);
    if (next.length > 0) onChange((['telegram', 'threads'] as const).filter((item) => next.includes(item)));
  };
  return (
    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '0.4rem 0' }}>
      {(['telegram', 'threads'] as const).map((target) => (
        <label key={target} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.9rem' }}>
          <input
            type="checkbox"
            checked={value.includes(target)}
            disabled={disabled}
            onChange={(event) => toggle(target, event.target.checked)}
            style={{ accentColor: theme.button }}
          />
          {target === 'telegram' ? 'Telegram' : 'Threads'}
        </label>
      ))}
    </div>
  );
}
