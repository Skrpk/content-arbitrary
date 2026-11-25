'use client';

import { useState } from 'react';
import { readJson, type PanelTools } from '@/components/panel-tools';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * Settings' preview channel, per channel: where Send to preview, in the
 * Approve dialog, puts a post to see it in Telegram before it goes out.
 * The server looks the channel up and checks the bot can post there before
 * keeping it (src/lib/review/preview-channel.ts).
 */

export interface PreviewChannel {
  chatId: string;
  title: string | null;
}

interface Channel {
  id: number;
  name: string;
  previewChannel: PreviewChannel | null;
}

const fieldStyle = {
  flex: 1,
  minWidth: '12rem',
  boxSizing: 'border-box',
  padding: '0.5rem 0.6rem',
  borderRadius: '0.5rem',
  border: `1px solid ${theme.hint}`,
  background: theme.bg,
  color: theme.text,
  fontSize: '0.9rem',
} as const;

const buttonStyle = (primary: boolean, disabled: boolean) => ({
  padding: '0.5rem 0.9rem',
  border: primary ? 'none' : `1px solid ${theme.hint}`,
  borderRadius: '0.5rem',
  background: primary ? theme.button : 'transparent',
  color: primary ? theme.buttonText : theme.text,
  fontWeight: primary ? 600 : 400,
  opacity: disabled ? 0.6 : 1,
  cursor: disabled ? 'default' : 'pointer',
});

export function PreviewChannelSettings({
  channels,
  request,
  confirm,
  onSaved,
}: { channels: Channel[]; onSaved: (channelId: number, previewChannel: PreviewChannel | null) => void } & Pick<
  PanelTools,
  'request' | 'confirm'
>) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const save = async (channel: Channel, value: string | null) => {
    setBusy((all) => new Set(all).add(channel.id));
    setMessage(null);
    try {
      const body = await readJson<{ previewChannel: PreviewChannel | null }>(
        await request('/api/telegram/webapp/channels', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: channel.id, previewChannel: value }),
        }),
      );
      onSaved(channel.id, body.previewChannel);
      setDrafts((all) => {
        const next = { ...all };
        delete next[channel.id];
        return next;
      });
      setMessage({
        text: body.previewChannel
          ? `${channel.name}: previews go to ${body.previewChannel.title ?? body.previewChannel.chatId}.`
          : `${channel.name}: no preview channel.`,
        error: false,
      });
    } catch (error: unknown) {
      setMessage({ text: `${channel.name}: ${error instanceof Error ? error.message : 'could not save'}`, error: true });
    } finally {
      setBusy((all) => {
        const next = new Set(all);
        next.delete(channel.id);
        return next;
      });
    }
  };

  return (
    <section style={{ background: theme.secondaryBg, borderRadius: '0.6rem', padding: '0.75rem 0.9rem', marginBottom: '1.25rem' }}>
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>👁 Preview channel</div>
      <div style={{ color: theme.hint, fontSize: '0.8rem', marginBottom: '0.5rem' }}>
        Where <b>Send to preview</b>, in the Approve dialog, puts a post: to see it in Telegram exactly as it will go out, as
        often as you edit it, before you schedule or publish it. A channel only you see, with the bot as an administrator
        who may post. Give its @username, t.me link, or id (-100…).
      </div>
      {channels.map((channel) => {
        const working = busy.has(channel.id);
        const draft = drafts[channel.id];
        const current = channel.previewChannel;
        return (
          <div key={channel.id} style={{ marginTop: '0.5rem', opacity: working ? 0.6 : 1 }}>
            {channels.length > 1 ? <div style={{ fontSize: '0.85rem', marginBottom: '0.25rem' }}>📢 {channel.name}</div> : null}
            {current && draft === undefined ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ flex: 1, minWidth: '10rem' }}>{current.title ?? current.chatId}</span>
                <button type="button" disabled={working} onClick={() => setDrafts((all) => ({ ...all, [channel.id]: '' }))} style={buttonStyle(false, working)}>
                  Change
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => {
                    void (async () => {
                      if (await confirm(`Remove ${channel.name}'s preview channel? Send to preview is off until you set another.`)) {
                        await save(channel, null);
                      }
                    })();
                  }}
                  style={buttonStyle(false, working)}
                >
                  Remove
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                <input
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="@username, t.me link or channel id"
                  value={draft ?? ''}
                  onChange={(event) => setDrafts((all) => ({ ...all, [channel.id]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (draft ?? '').trim()) void save(channel, draft!.trim());
                  }}
                  style={fieldStyle}
                />
                <button
                  type="button"
                  disabled={working || !(draft ?? '').trim()}
                  onClick={() => void save(channel, draft!.trim())}
                  style={buttonStyle(true, working || !(draft ?? '').trim())}
                >
                  {working ? 'Checking…' : 'Save'}
                </button>
                {current ? (
                  <button
                    type="button"
                    disabled={working}
                    onClick={() =>
                      setDrafts((all) => {
                        const next = { ...all };
                        delete next[channel.id];
                        return next;
                      })
                    }
                    style={buttonStyle(false, working)}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      {message ? (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: message.error ? '#e53935' : theme.hint }}>{message.text}</p>
      ) : null}
    </section>
  );
}
