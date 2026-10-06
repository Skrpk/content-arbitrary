import type { HistoricalMediaItem, HistoryContentType } from '@/db/schema';

export type { HistoricalMediaItem, HistoryContentType };

/**
 * A publication's past item in platform-neutral form — a Telegram post today,
 * a newsletter issue or an article tomorrow. Every adapter produces these and
 * nothing downstream knows which export they came from.
 */
export interface HistoricalPublicationItem {
  /** The item's id on its platform, always as text. */
  externalId: string;
  contentType: HistoryContentType;
  title: string | null;
  /** Plain text, formatting removed; null when there is none. */
  text: string | null;
  publishedAt: Date;
  editedAt: Date | null;
  canonicalUrl: string | null;
  media: HistoricalMediaItem[];
  metrics: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/** Something in the export that was not imported, and why. */
export interface HistoryImportIssue {
  /** The source's id for it, when it has one. */
  externalId: string | null;
  /** Short and stable, so issues can be counted by reason. */
  reason: string;
}

/** One publication's history, as read from one export. */
export interface ParsedPublicationHistory {
  /** Where it was published, e.g. `telegram`. */
  platform: string;
  /** Which channel, newsletter or feed on that platform. */
  publicationKey: string;
  /** A name to show people, e.g. the channel title. */
  publicationName: string | null;
  /** What the export says about the publication itself. */
  publicationMetadata: Record<string, unknown>;
  /** Every record the export holds, imported or not. */
  itemsSeen: number;
  items: HistoricalPublicationItem[];
  /** Records deliberately left out: service events, empty messages. */
  skipped: HistoryImportIssue[];
  /** Records that should have been imported but could not be read. */
  failed: HistoryImportIssue[];
  /** Records imported with a caveat, e.g. a date read without its time zone. */
  warnings: HistoryImportIssue[];
}

/** The export file, as uploaded or read from disk. */
export interface HistoryFile {
  name: string;
  /** The raw bytes. An adapter that streams can be given a stream later. */
  bytes: Uint8Array;
}

/**
 * Turns one export format into canonical items. Format specifics live only in
 * the adapter; the import service and the tables never see them.
 */
export interface PublicationHistoryAdapter {
  /** The name it is chosen by on the command line, e.g. `telegram-json`. */
  readonly type: string;
  /** Throws if the file is not this format at all; reports bad records instead. */
  parse(file: HistoryFile): Promise<ParsedPublicationHistory>;
}
