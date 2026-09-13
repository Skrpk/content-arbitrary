/**
 * Applies Drizzle migrations. Run with `npm run db:migrate`.
 *
 * Uses its own short-lived connection rather than the pooled app client, since
 * migrations run once from a CLI and should close cleanly when finished.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false });

  try {
    await migrate(drizzle(sql), { migrationsFolder: './src/db/migrations' });
    console.log('Migrations applied successfully.');
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
