'use client';

import type { ReactNode } from 'react';
import { theme } from '@/lib/telegram/webapp-client';
import { threadsLength, THREADS_TEXT_LIMIT, type ThreadsText } from '@/lib/threads/text';

/**
 * The editor's Threads tab: what the post goes to Threads with. Until it is
 * edited here it follows the Telegram text, as plain text and cut to fit;
 * once edited it is the post's own, and the Telegram tab no longer changes
 * it — until "Reset to the Telegram text".
 */

export interface ThreadsVersion {
  /** The post's own Threads text; null while it follows Telegram's. */
  own: string | null;
  /** Telegram's text as Threads would take it: cut to fit, perhaps with the whole of it attached. */
  auto: ThreadsText;
  /** Telegram's text before any cut. */
  autoFull: string;
}

/** What the tab's label counts: the own text, or all of Telegram's, so a cut shows before the tab is opened. */
export function threadsCount(version: ThreadsVersion): number {
  return threadsLength(version.own ?? version.autoFull);
}

export function ThreadsTab({
  version,
  channel,
  hasMedia,
  onChange,
  adapt,
}: {
  version: ThreadsVersion;
  channel: string;
  hasMedia: boolean;
  onChange: (own: string | null) => void;
  /** "Adapt for Threads", when the assistant is set up; `busy` while it works. */
  adapt: { run: () => void; busy: boolean } | null;
}) {
  const own = version.own !== null;
  const text = version.own ?? version.auto.text;
  const length = threadsLength(text);
  const over = own && length > THREADS_TEXT_LIMIT;

  return (
    <div style={{ maxWidth: '40rem' }}>
      <p style={{ fontSize: '0.85rem', color: theme.hint, margin: '0 0 0.6rem' }}>
        {own
          ? 'The post’s own text for Threads: changes in the Telegram tab no longer reach it.'
          : 'Follows the Telegram text, as plain text. Edit it here to give Threads its own.'}
      </p>
      <textarea
        value={text}
        rows={12}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Threads text"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '0.7rem',
          borderRadius: '0.5rem',
          border: `1px solid ${over ? '#e53935' : theme.secondaryBg}`,
          background: theme.bg,
          color: theme.text,
          font: 'inherit',
          fontSize: '0.95rem',
          lineHeight: 1.5,
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.5rem' }}>
        {adapt ? (
          <button
            type="button"
            disabled={adapt.busy}
            onClick={adapt.run}
            style={{ padding: '0.45rem 0.85rem', border: 'none', borderRadius: '0.5rem', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', background: theme.secondaryBg, color: theme.text }}
          >
            {adapt.busy ? 'Adapting…' : '✨ Adapt for Threads'}
          </button>
        ) : null}
        {own ? (
          <button type="button" onClick={() => onChange(null)} style={linkButton}>
            Reset to the Telegram text
          </button>
        ) : null}
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: over ? '#e53935' : theme.hint }}>
          {length} / {THREADS_TEXT_LIMIT} characters{over ? ' — too long for Threads' : ''}
        </span>
      </div>
      {!own && version.auto.text !== version.autoFull.trim() ? (
        <p style={{ fontSize: '0.8rem', color: '#e53935', margin: '0.5rem 0 0' }}>
          The Telegram text is {threadsLength(version.autoFull)} characters, so Threads gets it shortened
          {version.auto.attachment ? ', with the whole text attached' : ''}.
        </p>
      ) : null}

      <h3 style={{ fontSize: '0.85rem', color: theme.hint, fontWeight: 600, margin: '1.25rem 0 0.5rem' }}>How it will look</h3>
      <ThreadsPreview channel={channel} text={text} hasMedia={hasMedia} attached={!own && version.auto.attachment !== null ? threadsLength(version.autoFull) : null} />
    </div>
  );
}

/** Near enough a Threads post: who, the text, the pictures, the attachment. */
function ThreadsPreview({ channel, text, hasMedia, attached }: { channel: string; text: string; hasMedia: boolean; attached: number | null }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '2.2rem 1fr',
        gap: '0.6rem',
        padding: '0.8rem',
        border: `1px solid ${theme.secondaryBg}`,
        borderRadius: '0.8rem',
        background: theme.bg,
      }}
    >
      <div style={{ width: '2.2rem', height: '2.2rem', borderRadius: '50%', background: theme.secondaryBg, display: 'grid', placeItems: 'center' }} aria-hidden="true">
        🧵
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{channel}</div>
        <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.92rem', lineHeight: 1.45, marginTop: '0.2rem', overflowWrap: 'anywhere' }}>{text || '…'}</div>
        {hasMedia ? <Placeholder>The post’s photos and videos</Placeholder> : null}
        {attached !== null ? <Placeholder>📄 The whole text attached ({attached} characters)</Placeholder> : null}
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: '0.5rem', padding: '0.5rem 0.6rem', borderRadius: '0.5rem', border: `1px solid ${theme.secondaryBg}`, fontSize: '0.8rem', color: theme.hint }}>
      {children}
    </div>
  );
}

const linkButton = {
  padding: '0.3rem 0.4rem',
  border: 'none',
  background: 'transparent',
  color: theme.link,
  fontSize: '0.85rem',
  cursor: 'pointer',
} as const;
