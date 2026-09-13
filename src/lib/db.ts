import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '@/lib/env';
import * as schema from '@/db/schema';

/**
 * Serverless-friendly Postgres access.
 *
 * Why postgres.js rather than Prisma or the Neon HTTP driver:
 *   - no query engine binary to ship (smaller, faster cold starts than Prisma);
 *   - real interactive transactions and session-level advisory locks, which the
 *     Neon *HTTP* driver cannot do — and we need both for idempotency;
 *   - works unchanged against Neon, Vercel Postgres, Supabase or plain Postgres.
 *
 * A single lazily-created client is cached on `globalThis` so that warm Lambda
 * invocations reuse the connection instead of opening a new one each time.
 */

type GlobalWithDb = typeof globalThis & {
  __contentArbitrarySql?: postgres.Sql;
  __contentArbitraryDb?: PostgresJsDatabase<typeof schema>;
};

const globalRef = globalThis as GlobalWithDb;

export function getSql(): postgres.Sql {
  if (globalRef.__contentArbitrarySql) return globalRef.__contentArbitrarySql;

  const client = postgres(getEnv().DATABASE_URL, {
    /**
     * Serverless functions are short-lived and highly concurrent, so the pool
     * stays small to avoid exhausting the database's connection slots.
     *
     * It must be at least 2, not 1: `acquireSyncLock` reserves one connection
     * for the whole run to hold the session-level advisory lock, and the sync's
     * own queries need a second. With max: 1 the reservation starves every
     * subsequent query and the run deadlocks until the function times out.
     */
    max: 2,
    idle_timeout: 20,
    connect_timeout: 15,
    // Required for transaction-mode poolers (PgBouncer, Neon pooled endpoints),
    // which do not support the extended protocol's prepared statements.
    prepare: false,
  });

  globalRef.__contentArbitrarySql = client;
  return client;
}

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (globalRef.__contentArbitraryDb) return globalRef.__contentArbitraryDb;

  const db = drizzle(getSql(), { schema });
  globalRef.__contentArbitraryDb = db;
  return db;
}

export { schema };
export type Database = PostgresJsDatabase<typeof schema>;
