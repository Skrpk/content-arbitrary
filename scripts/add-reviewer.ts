/**
 * Adds a person as a reviewer of a workspace, or takes them off it. A reviewer
 * gets the workspace's review messages in their own private chat, and may act
 * on them with the bot and on the review website.
 *
 *   npm run reviewer -- list --workspace 3
 *   npm run reviewer -- add --workspace 3 --telegram-id 123456789 [--name "Olena"]
 *   npm run reviewer -- remove --workspace 3 --telegram-id 123456789
 *
 * `telegram-id` is the person's numeric Telegram user id (see
 * [@userinfobot](https://t.me/userinfobot)). They must have sent the bot /start
 * at least once, or their review messages will not reach them.
 *
 * Removing a reviewer deletes only their membership of this workspace. If they
 * are the workspace's named reviewer (telegram_admin_chat_id), change that too.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { addWorkspaceMember, removeWorkspaceMember, telegramIdsOfMembers } from '../src/lib/accounts/users';
import { getDb, getSql } from '../src/lib/db';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  const workspaceId = Number(option('workspace'));
  const telegramId = option('telegram-id');
  const db = getDb();

  if (!['list', 'add', 'remove'].includes(command ?? '') || !Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('usage: reviewer <list|add|remove> --workspace <id> [--telegram-id <id>] [--name <name>]');
  }

  const [workspace] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      adminChatId: workspaces.telegramAdminChatId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) throw new Error(`workspace ${workspaceId} does not exist`);

  if (command === 'list') {
    const members = await telegramIdsOfMembers(db, workspaceId);
    console.log(`${workspace.name} (${workspace.id}), named reviewer: ${workspace.adminChatId ?? 'none'}`);
    for (const id of members) console.log(`  ${id}${id === workspace.adminChatId ? '  (named)' : ''}`);
    return;
  }

  if (!telegramId || !/^\d+$/.test(telegramId)) {
    throw new Error('--telegram-id must be a numeric Telegram user id');
  }

  if (command === 'add') {
    await addWorkspaceMember(db, workspaceId, {
      id: telegramId,
      name: option('name') ?? null,
    });
    console.log(`Added ${telegramId} as a reviewer of ${workspace.name} (${workspace.id}).`);
    return;
  }

  const removed = await removeWorkspaceMember(db, workspaceId, telegramId);
  console.log(
    removed
      ? `Removed ${telegramId} from ${workspace.name} (${workspace.id}).`
      : `${telegramId} was not a reviewer of ${workspace.name} (${workspace.id}).`,
  );
}

main()
  .then(() => getSql().end())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await getSql()
      .end()
      .catch(() => {});
    process.exit(1);
  });
