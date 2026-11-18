/**
 * Gives a channel a draft channel — or takes it away. Approved posts then go
 * to the draft channel first, and on to the channel from their buttons there
 * (src/lib/drafts/drafts.ts).
 *
 *   npx tsx scripts/draft-channel.ts --workspace 2 --channel @vector --draft -1001234567890
 *   npx tsx scripts/draft-channel.ts --workspace 2 --off
 *
 * `channel` is where posts end up and `draft` where they are previewed; each
 * an id or a public @username. The bot must be an administrator of both: one
 * that may post in the channel, and post, edit and delete in the draft
 * channel. Checked before anything is changed. `channel` may be left out to
 * keep the channel the workspace has.
 *
 * Replies and edits in the draft channel reach the app only once the webhook
 * asks for channel posts: run setup-webhook again after the first deploy.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { workspaces } from '../src/db/schema';
import { getDb, getSql } from '../src/lib/db';
import { TelegramClient } from '../src/lib/telegram/client';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const workspaceId = Number(option('workspace'));
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error('usage: draft-channel --workspace <id> [--channel <id or @name>] (--draft <id or @name> | --off)');
  }
  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`no workspace ${workspaceId}`);

  if (process.argv.includes('--off')) {
    await db.update(workspaces).set({ draftChatId: null, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
    console.log(`${workspace.name}: no draft channel; approved posts go straight to the channel.`);
    return;
  }

  const draftArg = option('draft');
  if (!draftArg) throw new Error('--draft is required, or --off');
  const client = new TelegramClient({ attempts: 2 });
  const me = await client.getMe();

  const check = async (ref: string, role: 'channel' | 'draft') => {
    const chat = await client.getChat(ref);
    const member = await client.getChatMember(String(chat.id), me.id);
    const problems = [
      member.status !== 'administrator' ? 'is not an administrator' : null,
      member.status === 'administrator' && !member.can_post_messages ? 'may not post' : null,
      role === 'draft' && member.status === 'administrator' && !member.can_edit_messages ? 'may not edit messages' : null,
      role === 'draft' && member.status === 'administrator' && !member.can_delete_messages ? 'may not delete messages' : null,
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(`@${me.username} in ${chat.title ?? ref}: ${problems.join(', ')}`);
    console.log(`  ✓ ${role}: ${chat.title ?? chat.username} (${chat.id})`);
    return String(chat.id);
  };

  const channelArg = option('channel') ?? workspace.telegramChatId;
  if (!channelArg) throw new Error(`${workspace.name} has no channel; pass --channel`);
  const channel = await check(channelArg, 'channel');
  const draft = await check(draftArg, 'draft');
  if (channel === draft) throw new Error('the draft channel must be another channel than the channel itself');

  await db
    .update(workspaces)
    .set({ telegramChatId: channel, draftChatId: draft, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
  console.log(`${workspace.name}: approved posts go to the draft channel first, then on to the channel.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getSql().end());
