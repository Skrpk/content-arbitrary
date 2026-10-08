import { createHash } from 'node:crypto';
import type { ImageUnderstanding } from '@/lib/media/understanding';
import { truncateToLength } from '@/lib/telegram/format-caption';

/**
 * The exact text that is embedded, for a past publication and for a new post,
 * and the fingerprint that says whether a stored vector still matches it.
 *
 * Both sides get the same treatment so that what is compared is the writing
 * and its subject. The title and the text go in, and — when its first image
 * has been understood — what that image shows: a post that says only "wow"
 * under a photo of an aurora is about the aurora. Platform, content type,
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

/**
 * A post or publication as one piece of text: title, text, then what its
 * image shows. Every section is left out when empty, and without an image
 * the result is exactly the title and text as they were always embedded — so
 * adding image understanding changes the vectors of image posts only, and an
 * image-only post, which had nothing to embed, now has.
 *
 *   <title>
 *
 *   <text>
 *
 *   IMAGE: View from the ISS of a green aurora over Earth's night side.
 *   IMAGE TYPE: photo
 *   IMAGE TOPICS: aurora, ISS, Earth observation
 *   IMAGE ENTITIES: Earth, ISS
 *   VISIBLE TEXT: …
 */
export function buildSemanticContentRepresentation(content: {
  title?: string | null;
  text?: string | null;
  image?: ImageUnderstanding | null;
}): string | null {
  const title = normalise(content.title ?? '');
  const text = normalise(content.text ?? '');
  // An export may repeat the title as the text's first line.
  const parts = text.startsWith(title) ? [text] : [title, text];
  if (content.image) parts.push(renderImageUnderstanding(content.image));
  return finish(parts.filter((part) => part !== '').join('\n\n'));
}

/** What an image shows, as the labelled lines the semantic representation carries. */
export function renderImageUnderstanding(image: ImageUnderstanding): string {
  return [
    `IMAGE: ${normalise(image.summary)}`,
    `IMAGE TYPE: ${image.contentType}`,
    image.topics.length > 0 ? `IMAGE TOPICS: ${image.topics.join(', ')}` : '',
    image.entities.length > 0 ? `IMAGE ENTITIES: ${image.entities.join(', ')}` : '',
    image.visibleText ? `VISIBLE TEXT: ${normalise(image.visibleText)}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** What a past publication is embedded as, or null when it has nothing to embed. */
export function buildHistoryEmbeddingText(
  item: { title: string | null; text: string | null },
  image?: ImageUnderstanding | null,
): string | null {
  return buildSemanticContentRepresentation({ title: item.title, text: item.text, image });
}

/** What a new post is embedded as, or null when it has neither text nor an understood image. */
export function buildCandidateEmbeddingText(text: string | null, image?: ImageUnderstanding | null): string | null {
  return buildSemanticContentRepresentation({ text, image });
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
