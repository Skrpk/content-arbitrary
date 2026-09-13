/**
 * Minimal structured logger.
 *
 * Vercel's runtime log viewer parses one JSON object per line, so that is what
 * we emit. Every entry carries the `runId` of the sync that produced it, which
 * makes a single invocation trivial to isolate in the logs.
 *
 * Secrets must never reach this module. `scrub()` is a defence in depth: even
 * if a bot token or bearer token ends up inside an error message from a
 * third-party library, it is masked before it is written.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const TOKEN_PATTERNS: RegExp[] = [
  // Telegram bot tokens: 123456789:AAExxxxxxxxxxxxxxxxxxx
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  // Bearer / token query params and headers
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(bot)\d{6,12}:[A-Za-z0-9_-]{20,}/g,
  // Postgres connection strings with credentials
  /(postgres(?:ql)?:\/\/)[^:@\s]+:[^@\s]+@/gi,
];

export function scrub(value: string): string {
  let output = value;
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, (match, prefix?: string) =>
      prefix ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  return output;
}

function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max depth]';
  if (typeof value === 'string') return scrub(value);
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Belt and braces: drop anything that is named like a secret outright.
      if (/token|secret|password|authorization|apikey|api_key/i.test(key)) {
        output[key] = '[REDACTED]';
        continue;
      }
      output[key] = scrubDeep(item, depth + 1);
    }
    return output;
  }
  return value;
}

export interface Logger {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

function write(level: LogLevel, event: string, bindings: Record<string, unknown>, data?: Record<string, unknown>) {
  const entry = {
    level,
    event,
    time: new Date().toISOString(),
    ...(scrubDeep(bindings) as Record<string, unknown>),
    ...(data ? (scrubDeep(data) as Record<string, unknown>) : {}),
  };

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (event, data) => write('debug', event, bindings, data),
    info: (event, data) => write('info', event, bindings, data),
    warn: (event, data) => write('warn', event, bindings, data),
    error: (event, data) => write('error', event, bindings, data),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger({ app: 'content-arbitrary' });
