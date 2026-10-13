'use client';

import Highlight from '@tiptap/extension-highlight';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { uploadPresigned } from '@vercel/blob/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readJson, type PanelTools } from '@/components/panel-tools';
import { ASSISTANT_CSS, AssistantPanel } from '@/components/rich-editor/assistant-panel';
import { EditorMediaContext, PostMedia, type EditorMedia } from '@/components/rich-editor/post-media';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * The full post editor: a post written as a Telegram rich message —
 * headings, bold and italic, lists, quotations, and the post's own pictures
 * placed anywhere between paragraphs, each with its caption.
 *
 * Only what a rich message can show is on offer (no code, no tables); photos
 * and videos can be uploaded too, when a Blob store is set up
 * (src/lib/uploads). The server checks the document again before storing it and
 * makes the Telegram HTML itself. Saving makes the post go out as written
 * here; "Back to the plain post" drops it.
 */

interface EditorData {
  postId: number;
  status: string;
  channel: string;
  sourceLabel: string | null;
  url: string;
  isRich: boolean;
  doc: unknown;
  media: EditorMedia[];
  footer: string | null;
  limits: { text: number; media: number };
  /** Whether the AI assistant is set up. */
  assistant?: boolean;
  /** Where and how large uploads may be; null when the Blob store is not set up. */
  uploads?: { pathPrefix: string; maxBytes: { photo: number; video: number } } | null;
}

/** What the store and Telegram take, as the server says (src/lib/uploads/uploads.ts). */
const UPLOAD_KINDS: Record<string, 'photo' | 'video'> = {
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
  'video/mp4': 'video',
};

export function PostEditor({
  postId,
  request,
  confirm,
  openLink,
  onDone,
}: PanelTools & { postId: number; onDone: () => void }) {
  const [data, setData] = useState<EditorData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request(`/api/telegram/webapp/rich?post=${postId}`)
      .then((response) => readJson<EditorData>(response))
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the post.');
      });
    return () => {
      cancelled = true;
    };
  }, [postId, request]);

  if (error) return <p style={{ color: theme.hint }}>{error}</p>;
  if (!data) return <p style={{ color: theme.hint }}>Loading…</p>;
  return <LoadedEditor data={data} request={request} confirm={confirm} openLink={openLink} onDone={onDone} />;
}

function LoadedEditor({
  data,
  request,
  confirm,
  openLink,
  onDone,
}: PanelTools & { data: EditorData; onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [media, setMedia] = useState<EditorMedia[]>(data.media);
  const [uploading, setUploading] = useState<{ name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The editor is set up once; pasting and dropping reach the upload as it is now through this.
  const uploadFromEditor = useRef<((files: File[], at?: number) => void) | null>(null);
  const mediaByRef = useMemo(() => new Map(media.map((item) => [item.ref, item])), [media]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          isAllowedUri: (url) => /^https?:\/\//i.test(url),
        },
      }),
      Highlight,
      PostMedia,
    ],
    content: data.doc as object,
    editorProps: {
      attributes: { class: 'rich-editor-content' },
      // An image copied from another site, or a file from the computer: uploaded, and placed
      // where the cursor is — or where it was dropped.
      handlePaste: (_view, event) => {
        const files = mediaFiles(event.clipboardData?.files);
        if (files.length === 0 || !uploadFromEditor.current) return false;
        event.preventDefault();
        uploadFromEditor.current(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : mediaFiles(event.dataTransfer?.files);
        if (files.length === 0 || !uploadFromEditor.current) return false;
        event.preventDefault();
        uploadFromEditor.current(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    // The toolbar and the counts below read the editor as it renders.
    shouldRerenderOnTransaction: true,
    onUpdate: () => setDirty(true),
  });

  const state = editor ? toolbarState(editor) : null;

  // Leaving with unsaved changes asks first, as any editor does.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async (thenLeave: boolean) => {
    if (!editor) return;
    setSaving(true);
    setMessage(null);
    try {
      await readJson(
        await request('/api/telegram/webapp/rich', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ postId: data.postId, doc: editor.getJSON() }),
        }),
      );
      setDirty(false);
      setMessage({ ok: true, text: 'Saved. It will go out as laid out here.' });
      if (thenLeave) onDone();
    } catch (reason: unknown) {
      setMessage({ ok: false, text: reason instanceof Error ? reason.message : 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  const dropRich = async () => {
    if (!(await confirm('Go back to the plain post? This layout is discarded; the post goes out as it came in.'))) return;
    setSaving(true);
    try {
      await readJson(
        await request('/api/telegram/webapp/rich', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ postId: data.postId }),
        }),
      );
      setDirty(false);
      onDone();
    } catch (reason: unknown) {
      setMessage({ ok: false, text: reason instanceof Error ? reason.message : 'Could not change it back.' });
      setSaving(false);
    }
  };

  /** Upload the chosen files one by one, straight to the store, and put each in the post at the cursor. */
  const uploadFiles = async (files: File[], at?: number) => {
    const limits = data.uploads;
    if (!limits || !editor || uploading) return;
    setMessage(null);
    if (at !== undefined) editor.commands.setTextSelection(at);
    for (const file of files) {
      const kind = UPLOAD_KINDS[file.type];
      if (!kind) {
        setMessage({ ok: false, text: `${file.name}: only JPEG, PNG and WebP photos and MP4 videos.` });
        continue;
      }
      if (file.size > limits.maxBytes[kind]) {
        setMessage({ ok: false, text: `${file.name} is ${megabytes(file.size)}; a ${kind} can be up to ${megabytes(limits.maxBytes[kind])}.` });
        continue;
      }
      setUploading({ name: file.name });
      setMessage({ ok: true, text: `Uploading ${file.name}…` });
      try {
        const blob = await uploadPresigned(`${limits.pathPrefix}${safeFileName(file.name)}`, file, {
          access: 'public',
          handleUploadUrl: '/api/telegram/webapp/uploads',
          clientPayload: JSON.stringify({ postId: data.postId }),
          multipart: file.size > 8 * 1024 * 1024,
          // No onUploadProgress: with it the SDK streams the body, which a browser may refuse for an
          // upload, and its retry then finds the stream already read. Sent whole, a retry resends it.
        });
        const recorded = await readJson<{ ref: string; kind: 'photo' | 'video'; url: string }>(
          await request('/api/telegram/webapp/uploads/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ postId: data.postId, url: blob.url }),
          }),
        );
        setMedia((all) => [
          ...all,
          {
            ref: recorded.ref,
            kind: recorded.kind,
            previewUrl: recorded.kind === 'photo' ? recorded.url : null,
            videoUrl: recorded.kind === 'video' ? recorded.url : null,
            uploaded: true,
          },
        ]);
        editor.chain().focus().insertContent({ type: 'postMedia', attrs: { ref: recorded.ref, caption: null } }).run();
        setMessage(null);
      } catch (reason: unknown) {
        setMessage({ ok: false, text: `${file.name}: ${reason instanceof Error ? reason.message : 'could not upload.'}` });
      }
    }
    setUploading(null);
  };

  useEffect(() => {
    uploadFromEditor.current = data.uploads ? (files, at) => void uploadFiles(files, at) : null;
  });

  const leave = async () => {
    if (!dirty || (await confirm('Leave without saving your changes?'))) onDone();
  };

  const used = new Set(state?.mediaRefs ?? []);
  const length = state?.length ?? 0;

  return (
    <EditorMediaContext.Provider value={mediaByRef}>
      <style>{EDITOR_CSS + ASSISTANT_CSS}</style>
      <div className={assistantOpen ? 'editor-shell with-assistant' : 'editor-shell'}>
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0.25rem 0.75rem', marginBottom: '0.75rem' }}>
            <h1 style={{ fontSize: '1.1rem', margin: 0 }}>Edit post</h1>
            <span style={{ color: theme.hint, fontSize: '0.85rem' }}>
              📢 {data.channel} · {data.sourceLabel ?? 'unknown source'}
              {data.status === 'scheduled' ? ' · 🕒 scheduled' : ''}
            </span>
            <span style={{ display: 'flex', gap: '0.25rem', marginLeft: 'auto' }}>
              {data.url ? (
                <button type="button" onClick={() => openLink(data.url)} style={linkButton}>
                  Original ↗
                </button>
              ) : null}
              {data.assistant && !assistantOpen ? (
                <button type="button" disabled={!editor} onClick={() => setAssistantOpen(true)} style={{ ...linkButton, fontWeight: 600 }}>
                  ✨ AI assistant
                </button>
              ) : null}
            </span>
          </div>

          <Toolbar editor={editor} state={state} />

          <div
            style={{
              border: `1px solid ${theme.secondaryBg}`,
              borderRadius: '0 0 0.6rem 0.6rem',
              padding: '0.5rem 1rem 1rem',
              background: theme.bg,
            }}
          >
            <EditorContent editor={editor} />
            {data.footer ? (
              <p style={{ color: theme.hint, fontSize: '0.85rem', borderTop: `1px dashed ${theme.hint}`, paddingTop: '0.5rem', margin: '0.75rem 0 0' }}>
                {data.footer} <span style={{ fontSize: '0.75rem' }}>— the channel&apos;s footer, added when published</span>
              </p>
            ) : null}
          </div>

          {media.length > 0 || data.uploads ? (
            <section style={{ marginTop: '1rem' }}>
              <div style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                {media.length > 0
                  ? 'The post’s pictures — put one where the cursor is, or drag it in the text:'
                  : 'Add a photo or a video of your own:'}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {media.map((media) => {
                  const placed = used.has(media.ref);
                  return (
                    <button
                      key={media.ref}
                      type="button"
                      disabled={placed || !editor}
                      onClick={() =>
                        editor?.chain().focus().insertContent({ type: 'postMedia', attrs: { ref: media.ref, caption: null } }).run()
                      }
                      title={placed ? 'Already in the post' : 'Insert at the cursor'}
                      style={{
                        position: 'relative',
                        width: '6.5rem',
                        height: '6.5rem',
                        padding: 0,
                        border: `1px solid ${theme.hint}`,
                        borderRadius: '0.45rem',
                        overflow: 'hidden',
                        background: '#111111',
                        cursor: placed ? 'default' : 'pointer',
                        opacity: placed ? 0.45 : 1,
                      }}
                    >
                      {media.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={media.previewUrl} alt="" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : media.videoUrl ? (
                        <video src={media.videoUrl} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span style={{ color: '#bbbbbb', fontSize: '0.75rem' }}>{media.kind}</span>
                      )}
                      <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', color: '#ffffff', fontSize: '0.7rem' }}>
                        {placed ? 'in the post' : media.kind === 'video' ? '+ video' : '+ insert'}
                      </span>
                    </button>
                  );
                })}
                {data.uploads ? (
                  <button
                    type="button"
                    disabled={!editor || uploading !== null}
                    onClick={() => fileInput.current?.click()}
                    title="Upload a JPEG, PNG or WebP photo, or an MP4 video"
                    style={{
                      width: '6.5rem',
                      height: '6.5rem',
                      border: `1px dashed ${theme.hint}`,
                      borderRadius: '0.45rem',
                      background: 'transparent',
                      color: theme.text,
                      fontSize: '0.8rem',
                      cursor: uploading ? 'default' : 'pointer',
                    }}
                  >
                    {uploading ? 'Uploading…' : '⬆ Upload photo or video'}
                  </button>
                ) : null}
                <input
                  ref={fileInput}
                  type="file"
                  accept={Object.keys(UPLOAD_KINDS).join(',')}
                  multiple
                  hidden
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    void uploadFiles(files);
                  }}
                />
              </div>
            </section>
          ) : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginTop: '1.25rem' }}>
            <button type="button" disabled={saving || !editor} onClick={() => void save(true)} style={{ ...mainButton, background: theme.button, color: theme.buttonText }}>
              {saving ? 'Saving…' : 'Save and back to the queue'}
            </button>
            <button type="button" disabled={saving || !editor} onClick={() => void save(false)} style={{ ...mainButton, background: theme.secondaryBg, color: theme.text }}>
              Save
            </button>
            <button type="button" disabled={saving} onClick={() => void leave()} style={linkButton}>
              Back without saving
            </button>
            {data.isRich ? (
              <button type="button" disabled={saving} onClick={() => void dropRich()} style={{ ...linkButton, color: '#e53935' }}>
                Back to the plain post
              </button>
            ) : null}
            <span style={{ marginLeft: 'auto', color: length > data.limits.text ? '#e53935' : theme.hint, fontSize: '0.8rem' }}>
              {length.toLocaleString('en')} / {data.limits.text.toLocaleString('en')} characters
            </span>
          </div>
          {message ? (
            <p style={{ color: message.ok ? theme.hint : '#e53935', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>{message.text}</p>
          ) : null}
        </div>
        {assistantOpen && editor ? (
          <AssistantPanel
            postId={data.postId}
            request={request}
            openLink={openLink}
            getDraft={() => editor.getJSON()}
            setDraft={(doc) => editor.commands.setContent(doc as object)}
            onClose={() => setAssistantOpen(false)}
          />
        ) : null}
      </div>
    </EditorMediaContext.Provider>
  );
}

/** The photos and videos among pasted or dropped files; the rest are the editor's to handle as usual. */
function mediaFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'));
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A name the store keeps as it is: letters, digits, dots and dashes; it adds its own random part. */
function safeFileName(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(-80);
  return cleaned.replace(/^[-.]+/, '') || 'upload';
}

/** What the toolbar shows as on, and what the page counts — read from the editor as it changes. */
function toolbarState(editor: Editor) {
  const refs: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'postMedia' && node.attrs.ref) refs.push(String(node.attrs.ref));
  });
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    highlight: editor.isActive('highlight'),
    link: editor.isActive('link'),
    h1: editor.isActive('heading', { level: 1 }),
    h2: editor.isActive('heading', { level: 2 }),
    h3: editor.isActive('heading', { level: 3 }),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    blockquote: editor.isActive('blockquote'),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    mediaRefs: refs,
    length: editor.state.doc.textContent.length,
  };
}

function Toolbar({ editor, state }: { editor: Editor | null; state: ReturnType<typeof toolbarState> | null }) {
  if (!editor || !state) return null;
  const run = (action: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => action(editor.chain().focus()).run();

  const setLink = () => {
    const current = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt('Link address (https://…). Empty to remove the link.', current ?? 'https://');
    if (href === null) return;
    if (href.trim() === '' || href.trim() === 'https://') run((chain) => chain.extendMarkRange('link').unsetLink());
    else if (/^https?:\/\/\S+$/i.test(href.trim())) run((chain) => chain.extendMarkRange('link').setLink({ href: href.trim() }));
    else window.alert('A link must start with http:// or https://');
  };

  const buttons: { label: string; title: string; active?: boolean; disabled?: boolean; onClick: () => void; style?: object }[][] = [
    [
      { label: 'B', title: 'Bold (⌘B)', active: state.bold, onClick: () => run((c) => c.toggleBold()), style: { fontWeight: 700 } },
      { label: 'I', title: 'Italic (⌘I)', active: state.italic, onClick: () => run((c) => c.toggleItalic()), style: { fontStyle: 'italic' } },
      { label: 'U', title: 'Underline (⌘U)', active: state.underline, onClick: () => run((c) => c.toggleUnderline()), style: { textDecoration: 'underline' } },
      { label: 'S', title: 'Strikethrough', active: state.strike, onClick: () => run((c) => c.toggleStrike()), style: { textDecoration: 'line-through' } },
      { label: '▬', title: 'Highlight', active: state.highlight, onClick: () => run((c) => c.toggleHighlight()) },
      { label: '🔗', title: 'Link', active: state.link, onClick: setLink },
    ],
    [
      { label: 'H1', title: 'Heading', active: state.h1, onClick: () => run((c) => c.toggleHeading({ level: 1 })) },
      { label: 'H2', title: 'Subheading', active: state.h2, onClick: () => run((c) => c.toggleHeading({ level: 2 })) },
      { label: 'H3', title: 'Small heading', active: state.h3, onClick: () => run((c) => c.toggleHeading({ level: 3 })) },
    ],
    [
      { label: '• List', title: 'Bulleted list', active: state.bulletList, onClick: () => run((c) => c.toggleBulletList()) },
      { label: '1. List', title: 'Numbered list', active: state.orderedList, onClick: () => run((c) => c.toggleOrderedList()) },
      { label: '❝ Quote', title: 'Quotation', active: state.blockquote, onClick: () => run((c) => c.toggleBlockquote()) },
      { label: '— Divider', title: 'Divider', onClick: () => run((c) => c.setHorizontalRule()) },
    ],
    [
      { label: '↶', title: 'Undo (⌘Z)', disabled: !state.canUndo, onClick: () => run((c) => c.undo()) },
      { label: '↷', title: 'Redo (⇧⌘Z)', disabled: !state.canRedo, onClick: () => run((c) => c.redo()) },
    ],
  ];

  return (
    <div
      style={{
        position: 'sticky',
        top: '3.1rem',
        zIndex: 1,
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.35rem 0.75rem',
        padding: '0.45rem 0.6rem',
        background: theme.secondaryBg,
        borderRadius: '0.6rem 0.6rem 0 0',
      }}
    >
      {buttons.map((group, index) => (
        <div key={index} style={{ display: 'flex', gap: '0.2rem' }}>
          {group.map((button) => (
            <button
              key={button.label}
              type="button"
              title={button.title}
              disabled={button.disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={button.onClick}
              style={{
                minWidth: '2rem',
                padding: '0.25rem 0.5rem',
                border: 'none',
                borderRadius: '0.35rem',
                background: button.active ? theme.button : 'transparent',
                color: button.active ? theme.buttonText : theme.text,
                opacity: button.disabled ? 0.4 : 1,
                cursor: button.disabled ? 'default' : 'pointer',
                fontSize: '0.85rem',
                ...button.style,
              }}
            >
              {button.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

const mainButton = {
  padding: '0.55rem 1rem',
  border: 'none',
  borderRadius: '0.5rem',
  fontWeight: 600,
  fontSize: '0.9rem',
  cursor: 'pointer',
} as const;

const linkButton = {
  padding: '0.3rem 0.4rem',
  border: 'none',
  background: 'transparent',
  color: theme.link,
  fontSize: '0.85rem',
  cursor: 'pointer',
} as const;

/** The text as it will read in Telegram, near enough: headings, quotations, lists, dividers. */
const EDITOR_CSS = `
.rich-editor-content { outline: none; min-height: 18rem; font-size: 1rem; line-height: 1.55; }
.rich-editor-content > * + * { margin-top: 0.6rem; }
.rich-editor-content p { margin: 0.6rem 0 0; }
.rich-editor-content h1 { font-size: 1.6rem; margin: 1rem 0 0.4rem; font-family: Georgia, serif; }
.rich-editor-content h2 { font-size: 1.3rem; margin: 0.9rem 0 0.3rem; font-family: Georgia, serif; }
.rich-editor-content h3 { font-size: 1.1rem; margin: 0.8rem 0 0.2rem; }
.rich-editor-content blockquote { margin: 0.6rem 0; padding: 0.3rem 0.8rem; border-left: 3px solid var(--tg-theme-button-color); background: var(--tg-theme-secondary-bg-color); border-radius: 0 0.4rem 0.4rem 0; }
.rich-editor-content blockquote p { margin: 0; }
.rich-editor-content ul, .rich-editor-content ol { padding-left: 1.4rem; }
.rich-editor-content li p { margin: 0.15rem 0; }
.rich-editor-content hr { border: none; border-top: 1px solid var(--tg-theme-hint-color); margin: 1rem 0; }
.rich-editor-content mark { background: #f6d860; color: #111111; border-radius: 0.2rem; padding: 0 0.1rem; }
.rich-editor-content a { color: var(--tg-theme-link-color); }
.rich-editor-content .ProseMirror-selectednode { outline: none; }
`;
