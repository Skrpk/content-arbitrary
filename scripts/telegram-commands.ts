/**
 * Registers the bot's command menu — the list beside the message field — from
 * BOT_COMMANDS, for every private chat with the bot.
 *
 *   npm run telegram:commands
 *
 * Safe to re-run: Telegram replaces the whole list each time. Anyone who opens
 * the bot sees the menu, but commands still answer only a channel's reviewer.
 */
import 'dotenv/config';
import { z } from 'zod';
import { TelegramClient } from '../src/lib/telegram/client';
import { BOT_COMMANDS } from '../src/lib/telegram/commands';
import { createLogger } from '../src/lib/logger';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set.');
    process.exit(1);
  }

  const client = new TelegramClient({
    token,
    baseUrl: process.env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org',
    logger: createLogger({ script: 'telegram-commands' }),
    attempts: 2,
  });

  const scope = { type: 'all_private_chats' };
  await client.call('setMyCommands', { commands: BOT_COMMANDS, scope }, z.literal(true));
  const registered = await client.call(
    'getMyCommands',
    { scope },
    z.array(z.object({ command: z.string(), description: z.string() })),
  );

  console.log(`Registered ${registered.length} commands:`);
  for (const entry of registered) console.log(`  /${entry.command} — ${entry.description}`);
}

main().catch((error) => {
  console.error('Registering commands failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
