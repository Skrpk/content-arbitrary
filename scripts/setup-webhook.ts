/**
 * Registers (or inspects, or removes) the Telegram webhook that delivers
 * Approve / Reject button presses.
 *
 * Telegram will not push callbacks anywhere until this is done once per
 * deployment URL, so the approval flow is inert without it.
 *
 *   npm run webhook:set    -- https://your-project.vercel.app
 *   npm run webhook:info
 *   npm run webhook:delete
 */
import 'dotenv/config';
import { TelegramClient } from '../src/lib/telegram/client';
import { createLogger } from '../src/lib/logger';

const WEBHOOK_PATH = '/api/telegram/webhook';

async function main() {
  const command = process.argv[2] ?? 'info';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set.');
    process.exit(1);
  }

  const client = new TelegramClient({
    token,
    baseUrl: process.env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org',
    logger: createLogger({ script: 'setup-webhook' }),
    attempts: 2,
  });

  if (command === 'info') {
    const info = await client.getWebhookInfo();
    console.log(JSON.stringify(info, null, 2));
    if (!info.url) console.log('\nNo webhook registered — approval buttons will not work.');
    return;
  }

  if (command === 'delete') {
    await client.deleteWebhook();
    console.log('Webhook removed. Approval buttons will no longer be delivered.');
    return;
  }

  if (command !== 'set') {
    console.error(`Unknown command "${command}". Use: set <url> | info | delete`);
    process.exit(1);
  }

  const base = process.argv[3];
  if (!base) {
    console.error('Usage: npm run webhook:set -- https://your-project.vercel.app');
    process.exit(1);
  }

  if (!secret) {
    console.error(
      'TELEGRAM_WEBHOOK_SECRET is not set. Generate one with: openssl rand -hex 32\n' +
        '(Only A-Z, a-z, 0-9, _ and - are allowed, so base64 will not work.)',
    );
    process.exit(1);
  }

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    console.error(
      'TELEGRAM_WEBHOOK_SECRET contains characters Telegram rejects.\n' +
        'Allowed: A-Z a-z 0-9 _ -  (1-256 chars). Generate one with: openssl rand -hex 32',
    );
    process.exit(1);
  }

  const url = new URL(WEBHOOK_PATH, base).toString();
  if (!url.startsWith('https://')) {
    console.error('Telegram requires an HTTPS webhook URL.');
    process.exit(1);
  }

  await client.setWebhook(url, secret);
  console.log(`Webhook registered: ${url}`);

  const info = await client.getWebhookInfo();
  console.log(`Confirmed by Telegram: ${info.url}`);
  if (info.last_error_message) {
    console.log(`Last delivery error reported: ${info.last_error_message}`);
  }
}

main().catch((error) => {
  console.error('Webhook setup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
