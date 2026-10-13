'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PanelTools } from '@/components/panel-tools';
import type { AssistantHistoryMessage, AssistantSource, AssistantStreamEvent } from '@/lib/assistant/events';
import type { RichDocument } from '@/lib/rich/document';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * The post editor's AI assistant: a chat beside the post. Ask it to shorten,
 * rewrite or retitle the post and the change lands in the editor at once,
 * with an undo under it; ask it to check the facts and it searches the web
 * and answers with its sources. Nothing is saved: the editor's own Save does
 * that, as for any change. The conversation lives here, for as long as the
 * editor is open.
 */

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** While the answer is coming in. */
  pending?: boolean;
  searches?: string[];
  searching?: boolean;
  editing?: boolean;
  sources?: AssistantSource[];
  /** The post before and after the change, for undo and redo. */
  edit?: { summary: string; before: unknown; after: RichDocument; undone: boolean };
  error?: string;
}

export function AssistantPanel({
  postId,
  request,
  openLink,
  getDraft,
  setDraft,
  onClose,
}: Pick<PanelTools, 'request' | 'openLink'> & {
  postId: number;
  /** The editor's document as it is now. */
  getDraft: () => unknown;
  /** Put a document in the editor, as an edit the editor's own undo also reverses. */
  setDraft: (doc: unknown) => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);

  // Under the post on a narrow screen, so opening it brings it into view.
  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  useEffect(() => () => abort.current?.abort(), []);

  const update = (id: number, change: (message: ChatMessage) => ChatMessage) =>
    setMessages((all) => all.map((message) => (message.id === id ? change(message) : message)));

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    const history = messages.filter((item) => !item.pending).map(historyOf);
    const userId = nextId.current++;
    const replyId = nextId.current++;
    setMessages((all) => [
      ...all,
      { id: userId, role: 'user', text: message },
      { id: replyId, role: 'assistant', text: '', pending: true },
    ]);
    setInput('');
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;

    try {
      const response = await request('/api/telegram/webapp/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postId, draft: getDraft(), message, history }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `The assistant could not answer (${response.status}).`);
      }
      await readEvents(response.body, (event) => {
        switch (event.type) {
          case 'text':
            update(replyId, (item) => ({ ...item, text: item.text + event.delta, searching: false }));
            break;
          case 'search':
            update(replyId, (item) => ({
              ...item,
              searching: event.queries.length === 0,
              searches: [...(item.searches ?? []), ...event.queries],
            }));
            break;
          case 'editing':
            update(replyId, (item) => ({ ...item, editing: true }));
            break;
          case 'edit': {
            const before = getDraft();
            setDraft(event.doc);
            update(replyId, (item) => ({
              ...item,
              editing: false,
              edit: { summary: event.summary, before, after: event.doc, undone: false },
            }));
            break;
          }
          case 'sources':
            update(replyId, (item) => ({ ...item, sources: event.sources }));
            break;
          case 'done':
            setRemaining(event.remaining);
            break;
          case 'error':
            update(replyId, (item) => ({ ...item, error: event.message }));
            break;
        }
      });
    } catch (reason: unknown) {
      const stopped = reason instanceof DOMException && reason.name === 'AbortError';
      update(replyId, (item) => ({
        ...item,
        error: stopped ? 'Stopped.' : reason instanceof Error ? reason.message : 'The assistant could not answer.',
      }));
    } finally {
      update(replyId, (item) => ({ ...item, pending: false, searching: false, editing: false }));
      setBusy(false);
      abort.current = null;
    }
  };

  const toggleEdit = (message: ChatMessage) => {
    if (!message.edit) return;
    setDraft(message.edit.undone ? message.edit.after : message.edit.before);
    update(message.id, (item) => ({ ...item, edit: item.edit && { ...item.edit, undone: !item.edit.undone } }));
  };

  return (
    <aside ref={panel} className="assistant-panel" style={{ background: theme.secondaryBg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.8rem' }}>
        <strong style={{ fontSize: '0.95rem' }}>✨ AI assistant</strong>
        {remaining !== null ? (
          <span style={{ color: theme.hint, fontSize: '0.75rem' }}>{remaining} left today</span>
        ) : null}
        <button type="button" onClick={onClose} title="Close" style={{ ...plainButton, marginLeft: 'auto', color: theme.hint }}>
          ✕
        </button>
      </div>

      <div className="assistant-messages">
        {messages.length === 0 ? (
          <p style={{ color: theme.hint, fontSize: '0.85rem', margin: '0.25rem 0' }}>
            Ask it to change the post — “make it shorter”, “add a headline”, “fix the grammar” — and the change appears in
            the editor, with an undo. Or ask it to check the facts: it searches the web and says what it found. Nothing is
            saved until you save.
          </p>
        ) : null}
        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.id} className="assistant-bubble assistant-user" style={{ background: theme.button, color: theme.buttonText }}>
              {message.text}
            </div>
          ) : (
            <div key={message.id} className="assistant-bubble" style={{ background: theme.bg, color: theme.text }}>
              {message.searches && message.searches.length > 0 ? (
                <div style={{ color: theme.hint, fontSize: '0.78rem', marginBottom: '0.3rem' }}>
                  🔎 {message.searches.join(' · ')}
                </div>
              ) : null}
              {message.searching ? <div style={{ color: theme.hint, fontSize: '0.8rem' }}>🔎 Searching the web…</div> : null}
              {message.text ? <div style={{ whiteSpace: 'pre-wrap' }}>{withLinks(message.text, openLink)}</div> : null}
              {message.editing ? <div style={{ color: theme.hint, fontSize: '0.8rem' }}>✍️ Rewriting the post…</div> : null}
              {message.pending && !message.text && !message.searching && !message.editing ? (
                <div style={{ color: theme.hint, fontSize: '0.8rem' }}>Thinking…</div>
              ) : null}
              {message.edit ? (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginTop: '0.4rem', fontSize: '0.82rem' }}>
                  <span style={{ color: theme.hint }}>
                    {message.edit.undone ? '↩️ Undone: ' : '✅ Changed: '}
                    {message.edit.summary || 'the post'}
                  </span>
                  <button type="button" onClick={() => toggleEdit(message)} style={{ ...plainButton, color: theme.link, marginLeft: 'auto' }}>
                    {message.edit.undone ? 'Redo' : 'Undo'}
                  </button>
                </div>
              ) : null}
              {message.sources && message.sources.length > 0 ? (
                <ol style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem', fontSize: '0.8rem' }}>
                  {message.sources.map((source) => (
                    <li key={source.url}>
                      <button type="button" onClick={() => openLink(withoutTracking(source.url))} style={{ ...plainButton, color: theme.link, textAlign: 'left' }}>
                        {source.title || hostOf(source.url)}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : null}
              {message.error ? <div style={{ color: '#e53935', fontSize: '0.82rem', marginTop: '0.3rem' }}>{message.error}</div> : null}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
        style={{ display: 'flex', gap: '0.4rem', padding: '0.6rem 0.8rem' }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send(input);
            }
          }}
          placeholder="Ask to change the post or check a fact…"
          rows={2}
          maxLength={2000}
          style={{
            flex: 1,
            resize: 'vertical',
            padding: '0.45rem 0.55rem',
            border: `1px solid ${theme.hint}`,
            borderRadius: '0.45rem',
            background: theme.bg,
            color: theme.text,
            font: 'inherit',
            fontSize: '0.9rem',
          }}
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()} style={{ ...sendButton, background: theme.bg, color: theme.text }}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} style={{ ...sendButton, background: theme.button, color: theme.buttonText, opacity: input.trim() ? 1 : 0.5 }}>
            Send
          </button>
        )}
      </form>
    </aside>
  );
}

/** What an earlier message tells the model: its words, and what became of an edit. */
function historyOf(message: ChatMessage): AssistantHistoryMessage {
  if (message.role === 'user') return { role: 'user', text: message.text };
  const notes = [
    message.edit ? `[Changed the post: ${message.edit.summary}]` : null,
    message.edit?.undone ? '[The editor undid that change.]' : null,
    message.error && !message.text ? '[No answer.]' : null,
  ].filter(Boolean);
  return { role: 'assistant', text: [message.text, ...notes].filter(Boolean).join('\n\n') };
}

/** The stream's events, one JSON object per line, as they arrive. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: AssistantStreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as AssistantStreamEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AssistantStreamEvent);
}

/**
 * The reply with its Markdown links — how OpenAI marks what it cites,
 * `([nasa.gov](https://…))` — as small clickable labels, so the text reads.
 */
function withLinks(text: string, openLink: (url: string) => void): ReactNode {
  const pattern = /\(?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)\)?/g;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index));
    const url = withoutTracking(match[2]!);
    parts.push(
      <button
        key={match.index}
        type="button"
        onClick={() => openLink(url)}
        title={url}
        style={{ ...plainButton, color: theme.link, fontSize: '0.8em' }}
      >
        [{match[1]}]
      </button>,
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
}

/** A cited address without the `utm_source=openai` the search adds. */
function withoutTracking(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('utm_source');
    return parsed.toString();
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const plainButton = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
} as const;

const sendButton = {
  alignSelf: 'flex-end',
  padding: '0.5rem 0.8rem',
  border: 'none',
  borderRadius: '0.45rem',
  fontWeight: 600,
  fontSize: '0.85rem',
  cursor: 'pointer',
} as const;

/** The panel's layout: beside the post on a wide screen, under it otherwise. */
export const ASSISTANT_CSS = `
.editor-shell.with-assistant { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
@media (min-width: 1000px) {
  .editor-shell.with-assistant {
    grid-template-columns: minmax(0, 1fr) 23rem;
    width: min(86rem, calc(100vw - 2rem));
    margin-left: calc((100% - min(86rem, calc(100vw - 2rem))) / 2);
  }
  .editor-shell.with-assistant .assistant-panel { position: sticky; top: 3.6rem; height: calc(100vh - 4.6rem); }
}
.assistant-panel { display: flex; flex-direction: column; min-height: 24rem; border-radius: 0.6rem; overflow: hidden; }
.assistant-messages { flex: 1; overflow-y: auto; padding: 0 0.8rem; display: flex; flex-direction: column; gap: 0.5rem; }
.assistant-bubble { padding: 0.5rem 0.7rem; border-radius: 0.6rem; font-size: 0.9rem; line-height: 1.45; max-width: 92%; }
.assistant-user { align-self: flex-end; white-space: pre-wrap; }
`;
