import type { Source } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { addSource } from '@/lib/sources/repository';
import { profileLookup, type ThreadsCallOptions } from '@/lib/threads/client';
import { NO_THREADS_READER, threadsReaderFor, type ThreadsReading } from '@/lib/threads/reader';
import { normalizeThreadsUsername } from '@/lib/threads/source';

/**
 * Add a public Threads account as a source — the one path for /addthreads and
 * the Sources page alike.
 *
 * The profile is looked up once first, with the account that will read it,
 * so one Threads will not show — private, under 100 followers, a typo — is
 * turned away rather than stored to fail on every sync. Nothing it has posted
 * is sent: the source follows it from now on.
 */

export type AddThreadsResult =
  | { ok: true; source: Source; created: boolean; username: string; name: string | null }
  | { ok: false; reason: string };

export const THREADS_NOT_CONFIGURED = 'Threads is not set up here: the Threads app is not configured.';

export const NOT_A_READABLE_PROFILE =
  'Threads does not show that account: it may be private, have fewer than 100 followers, or not exist. ' +
  'Until Zmistik’s Threads app is approved by Meta, only Threads’ own official accounts can be read.';

export async function addThreadsSource(
  db: Database,
  input: { account: string; workspaceId: number; reading: ThreadsReading | null; logger?: Logger } & ThreadsCallOptions,
): Promise<AddThreadsResult> {
  const checked = normalizeThreadsUsername(input.account);
  if (!checked.ok) {
    return {
      ok: false,
      reason:
        checked.reason === 'post'
          ? 'That is a link to a post. Give the account instead — its @username or threads.com/@username link.'
          : checked.reason === 'empty'
            ? 'Give the account’s @username or its threads.com link.'
            : 'That is not a Threads @username or profile link.',
    };
  }
  if (!input.reading) return { ok: false, reason: THREADS_NOT_CONFIGURED };

  const reader = await threadsReaderFor(db, input.reading, input.workspaceId);
  if (!reader) return { ok: false, reason: NO_THREADS_READER };

  let profile;
  try {
    profile = await profileLookup(reader.token, checked.username, input);
  } catch (error) {
    input.logger?.warn('threads.add_failed', { error: describeError(error) });
    return { ok: false, reason: `Could not look the account up on Threads: ${error instanceof Error ? error.message : 'unreachable'}` };
  }
  if (!profile) return { ok: false, reason: NOT_A_READABLE_PROFILE };

  const username = profile.username.toLowerCase();
  const result = await addSource(db, { platform: 'threads', externalId: username, username, workspaceId: input.workspaceId });
  input.logger?.info('threads.source_added', {
    workspaceId: input.workspaceId,
    sourceId: result.source.id,
    account: username,
    created: result.created,
  });
  return { ok: true, source: result.source, created: result.created, username, name: profile.name };
}
