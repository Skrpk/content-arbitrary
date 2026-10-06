import { createHash } from 'node:crypto';
import { truncateToLength } from '@/lib/telegram/format-caption';

/**
 * The exact text that is embedded, for a past publication and for a new post,
 * and the fingerprint that says whether a stored vector still matches it.
 *
 * Both sides get the same treatment so that what is compared is the writing
 * and its subject. Only the title and the text go in: platform, content type,
 * dates, ids and metrics are the same across a publication's history or are
 * not meaning at all, and would pull every vector the same way — or, since a
 * new post comes from X and the history from Telegram, apart by platform.
 *
 * Change anything here that alters the text and bump EMBEDDING_TEXT_VERSION:
 * it is part of the fingerprint, so every stored vector is then redone.
 */

export const EMBEDDING_TEXT_VERSION = 'emb1';

/**
 * Where the text is cut. The models take 8,192 tokens; Cyrillic can run close
 * to a token per character, so 6,000 characters stays under the limit for any
 * language while keeping every ordinary post whole.
 */
export const EMBEDDING_TEXT_MAX = 6000;

/** What a past publication is embedded as, or null when it has no text to embed. */
export function buildHistoryEmbeddingText(item: { title: string | null; text: string | null }): string | null {
  const title = normalise(item.title ?? '');
  const text = normalise(item.text ?? '');
  // An export may repeat the title as the text's first line.
  const parts = text.startsWith(title) ? [text] : [title, text];
  return finish(parts.filter((part) => part !== '').join('\n\n'));
}

/** What a new post is embedded as, or null when it has no text — media alone is not embedded yet. */
export function buildCandidateEmbeddingText(text: string | null): string | null {
  return finish(normalise(text ?? ''));
}

/** SHA-256 of the embedded text and the version of how it was built. */
export function embeddingFingerprint(embeddingText: string): string {
  return createHash('sha256').update(`${EMBEDDING_TEXT_VERSION}\n${embeddingText}`).digest('hex');
}

/** Whitespace evened out, so a reformatted export with the same words is the same text. */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function finish(text: string): string | null {
  if (text === '') return null;
  return text.length <= EMBEDDING_TEXT_MAX ? text : truncateToLength(text, EMBEDDING_TEXT_MAX);
}
