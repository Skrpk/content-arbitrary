import { describe, expect, it } from 'vitest';
import { getEnv, redactedEnvSummary, resetEnvCache } from '@/lib/env';
import { createLogger, scrub } from '@/lib/logger';
import { withEnv } from './helpers';

describe('environment validation', () => {
  it('accepts a valid configuration', async () => {
    await withEnv({}, (env) => {
      expect(env.TELEGRAM_CHAT_ID).toBe('-1001234567890');
      expect(env.MAX_POSTS_PER_RUN).toBe(5);
    });
  });

  it('rejects a missing DATABASE_URL', async () => {
    await expect(withEnv({ DATABASE_URL: undefined }, () => getEnv())).rejects.toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a DATABASE_URL that is not a postgres URL', async () => {
    await expect(
      withEnv({ DATABASE_URL: 'mysql://user:pass@host/db' }, () => getEnv()),
    ).rejects.toThrow(/postgres/);
  });

  it('rejects a malformed bot token', async () => {
    await expect(withEnv({ TELEGRAM_BOT_TOKEN: 'nonsense' }, () => getEnv())).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it('accepts a numeric channel id', async () => {
    await withEnv({ TELEGRAM_CHAT_ID: '-1009876543210' }, (env) => {
      expect(env.TELEGRAM_CHAT_ID).toBe('-1009876543210');
    });
  });

  it('accepts an @channelusername', async () => {
    await withEnv({ TELEGRAM_CHAT_ID: '@mychannel' }, (env) => {
      expect(env.TELEGRAM_CHAT_ID).toBe('@mychannel');
    });
  });

  it('rejects a chat id that is neither form', async () => {
    await expect(withEnv({ TELEGRAM_CHAT_ID: 'my channel' }, () => getEnv())).rejects.toThrow(
      /TELEGRAM_CHAT_ID/,
    );
  });

  it('rejects a CRON_SECRET that is too short to be safe', async () => {
    await expect(withEnv({ CRON_SECRET: 'short' }, () => getEnv())).rejects.toThrow(/CRON_SECRET/);
  });

  it('requires either X_USER_ID or X_USERNAME', async () => {
    await expect(
      withEnv({ X_USER_ID: undefined, X_USERNAME: undefined }, () => getEnv()),
    ).rejects.toThrow(/X_USER_ID or X_USERNAME/);
  });

  it('accepts X_USERNAME alone', async () => {
    await withEnv({ X_USER_ID: undefined, X_USERNAME: 'someaccount' }, (env) => {
      expect(env.X_USERNAME).toBe('someaccount');
      expect(env.X_USER_ID).toBeUndefined();
    });
  });

  it('rejects MAX_POSTS_PER_RUN greater than X_FETCH_LIMIT', async () => {
    await expect(
      withEnv({ MAX_POSTS_PER_RUN: '50', X_FETCH_LIMIT: '10' }, () => getEnv()),
    ).rejects.toThrow(/must not exceed X_FETCH_LIMIT/);
  });

  it('rejects an X_FETCH_LIMIT outside the range the API accepts', async () => {
    await expect(withEnv({ X_FETCH_LIMIT: '200' }, () => getEnv())).rejects.toThrow(
      /between 5 and 100/,
    );
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['', true], // empty falls back to the default, which is true
  ])('parses INCLUDE_SOURCE_LINK=%s as %s', async (raw, expected) => {
    await withEnv({ INCLUDE_SOURCE_LINK: raw }, (env) => {
      expect(env.INCLUDE_SOURCE_LINK).toBe(expected);
    });
  });

  it('defaults DRY_RUN to true when unset, so a fresh deploy cannot post by accident', async () => {
    await withEnv({ DRY_RUN: undefined }, (env) => {
      expect(env.DRY_RUN).toBe(true);
    });
  });

  it('caches the parsed configuration', async () => {
    await withEnv({}, () => {
      expect(getEnv()).toBe(getEnv());
    });
    resetEnvCache();
  });
});

describe('redactedEnvSummary', () => {
  it('reports secrets only as booleans, never as values', async () => {
    await withEnv({}, (env) => {
      const summary = redactedEnvSummary(env);
      const serialised = JSON.stringify(summary);

      expect(summary.hasTelegramBotToken).toBe(true);
      expect(summary.hasXBearerToken).toBe(true);

      expect(serialised).not.toContain(env.TELEGRAM_BOT_TOKEN);
      expect(serialised).not.toContain(env.X_BEARER_TOKEN);
      expect(serialised).not.toContain(env.CRON_SECRET);
      expect(serialised).not.toContain(env.DATABASE_URL);
    });
  });
});

describe('log scrubbing', () => {
  it('masks a Telegram bot token', () => {
    const token = '123456789:AAHxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012';
    expect(scrub(`failed with ${token}`)).not.toContain(token);
  });

  it('masks a bot token embedded in an API URL', () => {
    const url = 'https://api.telegram.org/bot123456789:AAHxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012/sendPhoto';
    expect(scrub(url)).not.toContain('AAHxyz');
  });

  it('masks a bearer token', () => {
    expect(scrub('authorization: Bearer AAAAAAAAAAAAAAAAAAAAAMLheAAAAAAA0%2B')).not.toContain(
      'AAAAAAAAAAAAAAAAAAAAAMLheAAAAAAA',
    );
  });

  it('masks credentials in a postgres connection string', () => {
    const scrubbed = scrub('postgresql://admin:hunter2@db.example.com/prod');
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).not.toContain('admin');
  });

  it('leaves ordinary text alone', () => {
    expect(scrub('published post 1234567890 as message 42')).toBe(
      'published post 1234567890 as message 42',
    );
  });

  it('redacts secret-looking keys in structured log data', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);

    try {
      createLogger({ run: 1 }).info('test.event', {
        telegramBotToken: '123456789:AAHsecretsecretsecretsecret',
        apiKey: 'super-secret',
        xPostId: '999',
      });
    } finally {
      console.log = original;
    }

    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[0]).not.toContain('super-secret');
    expect(lines[0]).toContain('"xPostId":"999"');
  });

  it('scrubs a token that leaks through an Error message', () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => lines.push(line);

    try {
      createLogger({}).error('test.failure', {
        error: new Error('request to bot123456789:AAHsecretsecretsecretsecret failed'),
      });
    } finally {
      console.error = original;
    }

    expect(lines[0]).not.toContain('AAHsecret');
  });
});
