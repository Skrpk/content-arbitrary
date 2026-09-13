/**
 * Verifies the Telegram side of the configuration before you rely on the cron.
 *
 * Checks, in order:
 *   1. the bot token is valid                          (getMe)
 *   2. the chat id resolves and the bot can see it     (getChat)
 *   3. the bot is an administrator that may post       (getChatMember)
 *   4. an actual message can be delivered              (sendMessage)
 *
 * Run with: npm run telegram:check
 */
import 'dotenv/config';
import { TelegramClient, telegramMessageSchema } from '../src/lib/telegram/client';
import { createLogger } from '../src/lib/logger';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env');
    process.exit(1);
  }

  const client = new TelegramClient({
    token,
    baseUrl: process.env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org',
    logger: createLogger({ script: 'telegram-check' }),
    attempts: 2,
  });

  const me = await client.getMe();
  console.log(`[1/4] Bot token is valid: @${me.username ?? me.id}`);

  const chat = await client.getChat(chatId);
  console.log(`[2/4] Chat resolved: ${chat.title ?? chat.username ?? chat.id} (type: ${chat.type}, id: ${chat.id})`);
  if (String(chat.id) !== chatId.replace(/^@/, '') && !chatId.startsWith('@')) {
    console.log(`      Note: numeric id is ${chat.id} — prefer this value in TELEGRAM_CHAT_ID.`);
  }

  const member = await client.getChatMember(chatId, me.id);
  console.log(`[3/4] Bot status in chat: ${member.status}`);
  if (member.status !== 'administrator' && member.status !== 'creator') {
    console.error('      FAIL: the bot must be an administrator of the channel.');
    process.exit(1);
  }
  if (chat.type === 'channel' && member.can_post_messages === false) {
    console.error('      FAIL: the bot lacks the "Post Messages" admin permission.');
    process.exit(1);
  }

  const sent = await client.call(
    'sendMessage',
    {
      chat_id: chatId,
      text: 'content-arbitrary: configuration check succeeded. You can delete this message.',
      disable_notification: true,
    },
    telegramMessageSchema,
  );
  console.log(`[4/4] Test message delivered. message_id=${sent.message_id}`);
  console.log('\nAll checks passed.');
}

main().catch((error) => {
  console.error('\nTelegram check failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
