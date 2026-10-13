'use client';

import { useCallback, useState } from 'react';
import type { PanelTools } from '@/components/panel-tools';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * Add a source of any kind — an X account, a public Telegram channel, an RSS
 * or Atom feed, a YouTube channel — to one of the reviewer's channels. For the Sources page, in
 * the Mini App and on the website alike.
 *
 * The kind is picked, and a pasted link picks it too: an `@name` alone could
 * be an X account or a Telegram channel, a link cannot. The server checks
 * whatever is sent — the account on X, the channel's page, the feed — before
 * storing it, so this form only gets it there.
 */

type Kind = 'x' | 'telegram' | 'rss' | 'youtube';

const KINDS: { key: Kind; label: string; placeholder: string; hint: string; route: string; field: string }[] = [
  {
    key: 'x',
    label: 'X account',
    placeholder: '@username or x.com/username',
    hint: 'Posts with photos or videos; text posts too once you switch that on for it.',
    route: '/api/telegram/webapp/sources/x',
    field: 'username',
  },
  {
    key: 'telegram',
    label: 'Telegram channel',
    placeholder: '@channel or t.me/channel',
    hint: 'A public channel — one with an @username. Private channels cannot be followed.',
    route: '/api/telegram/webapp/sources/telegram',
    field: 'channel',
  },
  {
    key: 'youtube',
    label: 'YouTube',
    placeholder: '@handle or youtube.com/@handle',
    hint: 'New videos from a public YouTube channel. Transcripts are used when available to help Radar understand the video.',
    route: '/api/telegram/webapp/sources/youtube',
    field: 'channel',
  },
  {
    key: 'rss',
    label: 'RSS feed',
    placeholder: 'https://example.com/feed.xml',
    hint: 'The feed’s own URL (RSS 2.0 or Atom), not the site’s home page.',
    route: '/api/telegram/webapp/sources/rss',
    field: 'url',
  },
];

/** The kind a pasted link is unmistakably, or null when it could be either. */
function kindOfLink(value: string): Kind | null {
  const trimmed = value.trim();
  if (/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(trimmed)) return 'x';
  if (/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i.test(trimmed)) return 'telegram';
  // A video's link too: the server explains it is a channel that is followed.
  if (/^(?:https?:\/\/)?(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//i.test(trimmed)) return 'youtube';
  if (/^https?:\/\//i.test(trimmed)) return 'rss';
  return null;
}

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.55rem 0.65rem',
  borderRadius: '0.5rem',
  border: `1px solid ${theme.hint}`,
  background: theme.bg,
  color: theme.text,
  fontSize: '0.95rem',
} as const;

export interface AddedSource {
  workspaceId: number;
  label: string;
}

export function AddSourceForm({
  request,
  channels,
  onAdded,
}: Pick<PanelTools, 'request'> & {
  channels: { id: number; name: string }[];
  /** A source was added, or was there already; the page shows it. */
  onAdded: (added: AddedSource) => void;
}) {
  const [kind, setKind] = useState<Kind>('x');
  const [value, setValue] = useState('');
  const [channel, setChannel] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const chosen = KINDS.find((option) => option.key === kind)!;
  const workspaceId = channel ?? channels[0]?.id ?? null;

  const add = useCallback(async () => {
    if (workspaceId === null || value.trim() === '') return;

    setAdding(true);
    setResult(null);
    try {
      const response = await request(chosen.route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [chosen.field]: value.trim(), workspaceId }),
      });
      const body = (await response.json()) as { error?: string; created?: boolean; source?: { label: string } };
      if (!response.ok || !body.source) throw new Error(body.error ?? `Could not add (${response.status})`);

      setValue('');
      setResult({
        ok: true,
        text: body.created
          ? `✅ ${body.source.label} added. What is there now is not sent — only new posts come to review.`
          : `ℹ️ ${body.source.label} is already in your sources.`,
      });
      onAdded({ workspaceId, label: body.source.label });
    } catch (error: unknown) {
      setResult({ ok: false, text: error instanceof Error ? error.message : 'Could not add the source.' });
    } finally {
      setAdding(false);
    }
  }, [chosen, onAdded, request, value, workspaceId]);

  return (
    <section
      style={{
        background: theme.secondaryBg,
        borderRadius: '0.6rem',
        padding: '0.75rem 0.9rem',
        marginBottom: '1.25rem',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>➕ Add a source</div>

      <div role="radiogroup" aria-label="Kind of source" style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.5rem' }}>
        {KINDS.map((option) => {
          const active = option.key === kind;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setKind(option.key);
                setResult(null);
              }}
              style={{
                flex: 1,
                padding: '0.4rem 0',
                border: 'none',
                borderRadius: '0.45rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                background: active ? theme.button : theme.bg,
                color: active ? theme.buttonText : theme.text,
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <input
        type="text"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={chosen.placeholder}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          const linked = kindOfLink(event.target.value);
          if (linked) setKind(linked);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void add();
        }}
        style={inputStyle}
      />

      {channels.length > 1 ? (
        <select
          value={workspaceId ?? ''}
          onChange={(event) => setChannel(Number(event.target.value))}
          style={{ ...inputStyle, marginTop: '0.5rem' }}
        >
          {channels.map((option) => (
            <option key={option.id} value={option.id}>
              📢 {option.name}
            </option>
          ))}
        </select>
      ) : null}

      <button
        type="button"
        disabled={adding || value.trim() === '' || workspaceId === null}
        onClick={() => {
          void add();
        }}
        style={{
          width: '100%',
          marginTop: '0.5rem',
          padding: '0.55rem 0',
          border: 'none',
          borderRadius: '0.5rem',
          background: theme.button,
          color: theme.buttonText,
          fontWeight: 600,
          cursor: 'pointer',
          opacity: adding || value.trim() === '' ? 0.6 : 1,
        }}
      >
        {adding ? 'Checking…' : `Add ${chosen.label}`}
      </button>

      <div style={{ color: theme.hint, fontSize: '0.8rem', marginTop: '0.4rem' }}>
        {chosen.hint} What it has posted so far is not sent — only new posts come to review.
      </div>

      {result ? (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: result.ok ? theme.text : '#e53935' }}>
          {result.text}
        </p>
      ) : null}
    </section>
  );
}
