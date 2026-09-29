import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { logger } from '../utils/logger.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Applies any SQL files in /migrations that have not been applied yet (in filename order). */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Serialise concurrent migrators (e.g. two app instances starting together).
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        logger.info({ migration: file }, 'Applied migration');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}

// Allow `npm run migrate`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { createPool } = await import('./pool.js');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const ssl = process.env.DATABASE_SSL === 'true' || process.env.DATABASE_SSL === '1';
  const pool = createPool(process.env.DATABASE_URL, ssl);
  try {
    const applied = await runMigrations(pool);
    logger.info({ applied }, applied.length ? 'Migrations complete' : 'Database already up to date');
  } finally {
    await pool.end();
  }
}
