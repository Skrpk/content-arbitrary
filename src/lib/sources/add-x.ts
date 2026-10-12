import type { Source } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { normalizeXUsername } from '@/lib/sources/normalize';
import { addSource } from '@/lib/sources/repository';
import type { XClient } from '@/lib/x/client';

/**
 * Add an X account as a source — the one path for /addsource and the
 * Sources page alike.
 *
 * X is asked first: it is the authority on whether the account exists and on
 * its numeric id, which is what the source is stored under — a handle can be
 * renamed or taken over. Nothing the account has posted is sent: the source
 * follows it from now on.
 */

export type AddXResult =
  | { ok: true; source: Source; created: boolean; username: string }
  | { ok: false; reason: string };

export async function addXSource(
  db: Database,
  input: { username: string; workspaceId: number; xClient: XClient; logger?: Logger },
): Promise<AddXResult> {
  const normalized = normalizeXUsername(input.username);
  if (!normalized.ok) {
    return {
      ok: false,
      reason:
        normalized.reason === 'reserved'
          ? 'That looks like an x.com page, not an account.'
          : normalized.reason === 'empty'
            ? 'Give the account’s @handle or its x.com link.'
            : 'That is not a valid X handle. Handles are 1–15 characters: letters, digits and underscore.',
    };
  }

  let user: { id: string; username: string };
  try {
    user = await input.xClient.getUserByUsername(normalized.username);
  } catch (error) {
    input.logger?.warn('command.addsource_resolve_failed', {
      username: normalized.username,
      error: describeError(error),
    });
    return {
      ok: false,
      reason: `Could not find @${normalized.username} on X. The account may not exist, or it may be protected or suspended.`,
    };
  }

  const result = await addSource(db, {
    platform: 'x',
    externalId: user.id,
    username: user.username,
    workspaceId: input.workspaceId,
  });

  if (result.created) {
    input.logger?.info('command.source_added', {
      workspaceId: input.workspaceId,
      username: user.username,
      externalId: user.id,
    });
  }
  return { ok: true, source: result.source, created: result.created, username: user.username };
}
