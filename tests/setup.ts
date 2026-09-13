/**
 * Baseline environment for the unit tests.
 *
 * Individual tests override what they care about via `withEnv()`; everything
 * here exists only so that `getEnv()` validates successfully.
 */
process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/test';
process.env.X_USER_ID ??= '1234567890';
process.env.X_USERNAME ??= 'testaccount';
process.env.X_BEARER_TOKEN ??= 'test-bearer-token';
process.env.TELEGRAM_BOT_TOKEN ??= '123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
process.env.TELEGRAM_CHAT_ID ??= '-1001234567890';
process.env.CRON_SECRET ??= 'test-cron-secret-value';
process.env.DRY_RUN ??= 'false';
