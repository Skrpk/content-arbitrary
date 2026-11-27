'use client';

import type { EmojiData } from 'emoji-picker-react';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { theme } from '@/lib/telegram/webapp-client';

/**
 * The toolbar's emoji button: a picker with search, categories, skin tones
 * and recent ones, that puts an emoji where the cursor is. It stays open for
 * several in a row, and closes on a click elsewhere or Escape.
 *
 * Native emoji, as Telegram shows them — the picker loads no images. It is
 * loaded only when first opened, and searches in Ukrainian and English alike.
 */

const EmojiPicker = dynamic(() => import('emoji-picker-react'), {
  ssr: false,
  loading: () => <div style={{ width: 340, height: 400, padding: '1rem', color: theme.hint, fontSize: '0.85rem' }}>Loading…</div>,
});

/** Ukrainian names with the English ones, so either finds an emoji; categories in English, as the rest of the editor. */
async function loadEmojiData(): Promise<EmojiData> {
  const [{ default: en }, { default: uk }] = await Promise.all([
    import('emoji-picker-react/data/emojis-en'),
    import('emoji-picker-react/data/emojis-uk'),
  ]);
  const ukNames = new Map<string, string[]>();
  for (const list of Object.values(uk.emojis)) for (const emoji of list) ukNames.set(emoji.u, emoji.n);
  const emojis = Object.fromEntries(
    Object.entries(en.emojis).map(([category, list]) => [
      category,
      list.map((emoji) => ({ ...emoji, n: [...new Set([...emoji.n, ...(ukNames.get(emoji.u) ?? [])])] })),
    ]),
  );
  return { ...en, emojis };
}

/** The picker in the editor's colours, in the website and in Telegram alike. */
const pickerColors = {
  '--epr-bg-color': theme.bg,
  '--epr-category-label-bg-color': theme.bg,
  '--epr-text-color': theme.text,
  '--epr-category-label-text-color': theme.hint,
  '--epr-search-input-bg-color': theme.secondaryBg,
  '--epr-search-input-bg-color-active': theme.secondaryBg,
  '--epr-search-input-text-color': theme.text,
  '--epr-search-input-placeholder-color': theme.hint,
  '--epr-search-border-color': 'transparent',
  '--epr-search-border-color-active': theme.button,
  '--epr-highlight-color': theme.button,
  '--epr-category-icon-active-color': theme.button,
  '--epr-hover-bg-color': theme.secondaryBg,
  '--epr-focus-bg-color': theme.secondaryBg,
  '--epr-picker-border-color': theme.border,
  '--epr-skin-tone-picker-menu-color': theme.bg,
} as CSSProperties;

export function EmojiButton({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button
        type="button"
        title="Emoji"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        style={{
          minWidth: '2rem',
          padding: '0.25rem 0.5rem',
          border: 'none',
          borderRadius: '0.35rem',
          background: open ? theme.button : 'transparent',
          color: open ? theme.buttonText : theme.text,
          cursor: 'pointer',
          fontSize: '0.85rem',
        }}
      >
        🙂
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.35rem)',
            left: 0,
            zIndex: 5,
            borderRadius: '0.6rem',
            boxShadow: '0 8px 28px rgba(0, 0, 0, 0.3)',
          }}
        >
          <EmojiPicker
            emojiData={loadEmojiData}
            onEmojiClick={(data) => onPick(data.emoji)}
            colorScheme="auto"
            width={340}
            height={400}
            autoFocusSearch
            previewConfig={{ showPreview: false }}
            style={pickerColors}
          />
        </div>
      )}
    </div>
  );
}
