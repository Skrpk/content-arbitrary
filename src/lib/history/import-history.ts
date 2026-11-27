import { createHash } from 'node:crypto';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import {
  completeHistoryImport,
  countStoredHistoryItems,
  createHistoryImport,
  failHistoryImport,
  upsertPublicationHistoryItems,
  type HistoryImportCounts,
} from '@/lib/history/repository';
import type {
  HistoricalPublicationItem,
  HistoryFile,
  HistoryImportIssue,
  ParsedPublicationHistory,
  PublicationHistoryAdapter,
} from '@/lib/history/types';

/**
 * The largest export read. Files are read whole and parsed in memory, and a
 * JavaScript string tops out near 512 MB; a chat export's JSON holds text
 * only (media files sit beside it), so this is tens of thousands of posts.
 */
export const HISTORY_MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface HistoryImportReport {
  /** The audit record; null on a dry run, which writes nothing. */
  importId: number | null;
  dryRun: boolean;
  adapter: string;
  platform: string;
  publicationKey: string;
  publicationName: string | null;
  /**
   * On a dry run, `imported` is what would be new and `unchanged` what is
   * already stored; whether a stored item would change is not worked out.
   */
  counts: HistoryImportCounts;
  content: { textOnly: number; withPhoto: number; withVideo: number; otherMedia: number };
  firstPublishedAt: Date | null;
  lastPublishedAt: Date | null;
  skippedByReason: Record<string, number>;
  failedByReason: Record<string, number>;
  warningsByReason: Record<string, number>;
}

/**
 * Read an export with `adapter` and store it as the workspace's publication
 * history. Knows nothing of any one export format: the adapter turns the file
 * into canonical items, and this stores them and reports on it.
 *
 * Every real run leaves an audit record in `publication_history_imports`,
 * `completed` or `failed`, never left `processing` by an error. The items
 * themselves are written all or nothing.
 */
export async function importPublicationHistory(input: {
  db: Database;
  workspaceId: number;
  adapter: PublicationHistoryAdapter;
  file: HistoryFile;
  dryRun?: boolean;
  signal?: AbortSignal;
  logger?: Logger;
}): Promise<HistoryImportReport> {
  const { db, adapter, file } = input;
  const fileSha256 = createHash('sha256').update(file.bytes).digest('hex');

  if (input.dryRun) {
    return dryRunReport(db, { workspaceId: input.workspaceId, adapterType: adapter.type, parsed: await adapter.parse(file) });
  }

  return storeParsedPublicationHistory({
    db,
    workspaceId: input.workspaceId,
    source: { adapter: adapter.type, originalFilename: file.name, fileSha256, metadata: { fileSizeBytes: file.bytes.byteLength } },
    // Parsed once the import is on record, so a file that does not parse is recorded as a failed import.
    parsed: () => adapter.parse(file),
    signal: input.signal,
    logger: input.logger,
  });
}

/**
 * What storing a parsed history would do, writing nothing: `imported` is
 * what would be new and `unchanged` what is already stored.
 */
export async function dryRunReport(
  db: Database,
  input: { workspaceId: number; adapterType: string; parsed: ParsedPublicationHistory },
): Promise<HistoryImportReport> {
  const { parsed, items, duplicates } = dedupe(input.parsed);
  const stored = await countStoredHistoryItems(db, {
    workspaceId: input.workspaceId,
    platform: parsed.platform,
    publicationKey: parsed.publicationKey,
    externalIds: items.map((item) => item.externalId),
  });
  return report(null, true, input.adapterType, parsed, items, duplicates, {
    imported: items.length - stored,
    updated: 0,
    unchanged: stored,
  });
}

/**
 * Store a publication's history, however it was read — an export file, or a
 * public channel's own pages (src/lib/onboarding/telegram-history.ts) — as
 * the workspace's publication history.
 *
 * Every call leaves an audit record in `publication_history_imports`,
 * `completed` or `failed`, never left `processing` by an error. The items are
 * written all or nothing, and upserted by their external id, so storing the
 * same history again updates rather than duplicates.
 */
export async function storeParsedPublicationHistory(input: {
  db: Database;
  workspaceId: number;
  /** What it was read from, for the audit record. */
  source: { adapter: string; originalFilename: string; fileSha256: string; metadata?: Record<string, unknown> };
  /** The history, or how to read it — read after the audit record exists, so a failure to read is on record too. */
  parsed: ParsedPublicationHistory | (() => Promise<ParsedPublicationHistory>);
  signal?: AbortSignal;
  logger?: Logger;
}): Promise<HistoryImportReport> {
  const { db, source } = input;
  const importId = await createHistoryImport(db, {
    workspaceId: input.workspaceId,
    adapter: source.adapter,
    originalFilename: source.originalFilename,
    fileSha256: source.fileSha256,
  });

  let parsed: ParsedPublicationHistory | undefined;
  try {
    const result = dedupe(typeof input.parsed === 'function' ? await input.parsed() : input.parsed);
    parsed = result.parsed;

    const written = await upsertPublicationHistoryItems(db, {
      workspaceId: input.workspaceId,
      platform: parsed.platform,
      publicationKey: parsed.publicationKey,
      importId,
      items: result.items,
      signal: input.signal,
    });

    const summary = report(importId, false, source.adapter, parsed, result.items, result.duplicates, written);
    await completeHistoryImport(db, importId, {
      platform: parsed.platform,
      publicationKey: parsed.publicationKey,
      counts: summary.counts,
      metadata: {
        publication: parsed.publicationMetadata,
        ...source.metadata,
        skippedByReason: summary.skippedByReason,
        failedByReason: summary.failedByReason,
        warningsByReason: summary.warningsByReason,
      },
    });
    input.logger?.info('history.import_completed', { importId, adapter: source.adapter, ...summary.counts });
    return summary;
  } catch (error) {
    await failHistoryImport(db, importId, {
      errorMessage: describeError(error),
      platform: parsed?.platform,
      publicationKey: parsed?.publicationKey,
    });
    input.logger?.error('history.import_failed', { importId, adapter: source.adapter, error: describeError(error) });
    throw error;
  }
}

/**
 * Keep one item per external id. An export should never repeat one, but one
 * statement cannot upsert the same row twice, so a repeat is reported rather
 * than allowed to fail the import.
 */
function dedupe(parsed: ParsedPublicationHistory) {
  const byId = new Map<string, HistoricalPublicationItem>();
  const duplicates: HistoryImportIssue[] = [];
  for (const item of parsed.items) {
    if (byId.has(item.externalId)) {
      duplicates.push({ externalId: item.externalId, reason: 'duplicate_in_export' });
    }
    byId.set(item.externalId, item);
  }
  return { parsed, items: [...byId.values()], duplicates };
}

function report(
  importId: number | null,
  dryRun: boolean,
  adapterType: string,
  parsed: ParsedPublicationHistory,
  items: HistoricalPublicationItem[],
  duplicates: HistoryImportIssue[],
  written: { imported: number; updated: number; unchanged: number },
): HistoryImportReport {
  const skipped = [...parsed.skipped, ...duplicates];
  const content = { textOnly: 0, withPhoto: 0, withVideo: 0, otherMedia: 0 };
  let first: Date | null = null;
  let last: Date | null = null;

  for (const item of items) {
    const types = new Set(item.media.map((media) => media.type));
    if (types.size === 0) content.textOnly += 1;
    else if (types.has('video')) content.withVideo += 1;
    else if (types.has('photo')) content.withPhoto += 1;
    else content.otherMedia += 1;

    if (!first || item.publishedAt < first) first = item.publishedAt;
    if (!last || item.publishedAt > last) last = item.publishedAt;
  }

  return {
    importId,
    dryRun,
    adapter: adapterType,
    platform: parsed.platform,
    publicationKey: parsed.publicationKey,
    publicationName: parsed.publicationName,
    counts: {
      seen: parsed.itemsSeen,
      ...written,
      skipped: skipped.length,
      failed: parsed.failed.length,
    },
    content,
    firstPublishedAt: first,
    lastPublishedAt: last,
    skippedByReason: countBy(skipped),
    failedByReason: countBy(parsed.failed),
    warningsByReason: countBy(parsed.warnings),
  };
}

function countBy(issues: HistoryImportIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.reason] = (counts[issue.reason] ?? 0) + 1;
  return counts;
}
