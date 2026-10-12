'use client';

import { mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { createContext, useContext } from 'react';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * One of the post's own pictures, placed in the text: a block the editor can
 * drag between paragraphs, with a caption typed under it. It names the media
 * by position (`m0`, `m1`…) — the server sends the real file — so the editor
 * only ever shows a picture of it.
 */

export interface EditorMedia {
  ref: string;
  kind: 'photo' | 'video';
  previewUrl: string | null;
}

/** The post's media by ref, for the blocks to show. */
export const EditorMediaContext = createContext<Map<string, EditorMedia>>(new Map());

export const PostMedia = Node.create({
  name: 'postMedia',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      ref: { default: null },
      caption: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-post-media]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-post-media': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PostMediaView, {
      // Typing in the caption is the field's, not the document's.
      stopEvent: ({ event }) => (event.target as HTMLElement | null)?.tagName === 'INPUT',
    });
  },
});

function PostMediaView({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
  const ref = String(node.attrs.ref);
  const media = useContext(EditorMediaContext).get(ref);

  return (
    <NodeViewWrapper
      style={{
        margin: '0.9rem 0',
        borderRadius: '0.5rem',
        outline: selected ? `2px solid ${theme.button}` : 'none',
        outlineOffset: '2px',
      }}
    >
      <div contentEditable={false} style={{ position: 'relative' }}>
        <div
          data-drag-handle
          title="Drag to move"
          style={{
            cursor: 'grab',
            background: '#111111',
            borderRadius: '0.5rem',
            display: 'flex',
            justifyContent: 'center',
            maxHeight: '22rem',
            overflow: 'hidden',
          }}
        >
          {media?.previewUrl ? (
            // X's own picture of the post; nothing of ours to optimise.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={media.previewUrl}
              alt=""
              referrerPolicy="no-referrer"
              draggable={false}
              style={{ display: 'block', maxWidth: '100%', maxHeight: '22rem', objectFit: 'contain' }}
            />
          ) : (
            <div style={{ color: '#bbbbbb', padding: '3rem 1rem' }}>
              {media?.kind === 'video' ? '▶ video' : 'picture'} (no preview)
            </div>
          )}
        </div>
        {media?.kind === 'video' ? (
          <span style={badge({ left: '0.5rem' })}>▶ video</span>
        ) : null}
        <button
          type="button"
          onClick={() => deleteNode()}
          title="Take out of the post"
          style={{ ...badge({ right: '0.5rem' }), border: 'none', cursor: 'pointer', top: '0.5rem', bottom: 'auto' }}
        >
          ✕ Remove
        </button>
        <input
          type="text"
          value={node.attrs.caption ?? ''}
          placeholder="Caption (optional)"
          maxLength={1024}
          onChange={(event) => updateAttributes({ caption: event.target.value || null })}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            marginTop: '0.35rem',
            padding: '0.35rem 0.5rem',
            border: 'none',
            borderBottom: `1px solid ${theme.hint}`,
            background: 'transparent',
            color: theme.hint,
            fontSize: '0.85rem',
            fontFamily: 'inherit',
            textAlign: 'center',
          }}
        />
      </div>
    </NodeViewWrapper>
  );
}

function badge(position: { left?: string; right?: string }) {
  return {
    position: 'absolute',
    bottom: '2.6rem',
    ...position,
    padding: '0.15rem 0.5rem',
    borderRadius: '0.35rem',
    background: 'rgba(0, 0, 0, 0.65)',
    color: '#ffffff',
    fontSize: '0.75rem',
  } as const;
}
