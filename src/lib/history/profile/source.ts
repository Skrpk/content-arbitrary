import { createHash } from 'node:crypto';

/** One past publication, as the profiler reads it. */
export interface ProfileSourceItem {
  /** `publication_history_items.id`: what representative ids refer to. */
  id: number;
  platform: string;
  publicationKey: string;
  externalId: string;
  text: string | null;
  publishedAt: Date;
  /** The types of its media, e.g. ['photo'] — metadata only, never the files. */
  mediaTypes: string[];
}

/**
 * Whether an item says anything about the channel: some text, or some media.
 * A photo with no caption still counts — it is something the channel chose to
 * publish — though only its text, if any, is read.
 */
export function usableForProfile(item: ProfileSourceItem): boolean {
  return Boolean(item.text?.trim()) || item.mediaTypes.length > 0;
}

/**
 * A fingerprint of everything the profile is made from: which items, when,
 * their text and their media types. Any change to any of that changes it; a
 * change the profile does not read — reaction counts — does not. Independent
 * of the order items arrive in.
 */
export function sourceFingerprint(items: ProfileSourceItem[]): string {
  const lines = items
    .map((item) =>
      [
        item.platform,
        item.publicationKey,
        item.externalId,
        item.publishedAt.toISOString(),
        createHash('sha256').update(item.text ?? '').digest('hex'),
        item.mediaTypes.join(','),
      ].join('\u001f'),
    )
    .sort();
  return createHash('sha256').update(`fp1\n${lines.join('\n')}`).digest('hex');
}

/** Facts about the history measured in code, so the model need not estimate them. */
export interface HistoryFacts {
  items: number;
  textItems: number;
  mediaOnlyItems: number;
  firstPublishedAt: Date;
  lastPublishedAt: Date;
  medianTextLength: number;
  /** Shares of the text items, 0–1. */
  withMedia: number;
  withVideo: number;
  withLink: number;
  withEmoji: number;
  multiParagraph: number;
}

export function historyFacts(items: ProfileSourceItem[]): HistoryFacts {
  const texts = items.filter((item) => item.text?.trim());
  const share = (predicate: (item: ProfileSourceItem) => boolean) =>
    texts.length === 0 ? 0 : texts.filter(predicate).length / texts.length;
  const lengths = texts.map((item) => item.text!.length).sort((a, b) => a - b);
  const times = items.map((item) => item.publishedAt.getTime());

  return {
    items: items.length,
    textItems: texts.length,
    mediaOnlyItems: items.length - texts.length,
    firstPublishedAt: new Date(Math.min(...times)),
    lastPublishedAt: new Date(Math.max(...times)),
    medianTextLength: lengths.length === 0 ? 0 : lengths[Math.floor(lengths.length / 2)]!,
    withMedia: share((item) => item.mediaTypes.length > 0),
    withVideo: share((item) => item.mediaTypes.includes('video')),
    withLink: share((item) => /https?:\/\//.test(item.text!)),
    withEmoji: share((item) => /\p{Extended_Pictographic}/u.test(item.text!)),
    multiParagraph: share((item) => /\n\s*\n/.test(item.text!)),
  };
}
