import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // DATE as YYYY-MM-DD
pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT ids

export type Pool = pg.Pool;
export type Db = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, ssl = false): pg.Pool {
  return new pg.Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : undefined, max: 5 });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const REQUIRED_TABLES = ['contacts', 'leads', 'members', 'message_logs', 'scheduled_messages'];

/**
 * The importer writes into the WhatsApp agent's database. It checks that the agent's schema exists
 * and adds only its own bookkeeping (history_import_runs + message_logs.import_run_id), idempotently.
 */
export async function prepareSchema(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [REQUIRED_TABLES],
  );
  const missing = REQUIRED_TABLES.filter((t) => !rows.some((r) => r.table_name === t));
  if (missing.length) {
    throw new Error(`Database is missing the agent's tables (${missing.join(', ')}). Run the agent's "npm run migrate" first.`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS history_import_runs (
      id           BIGSERIAL PRIMARY KEY,
      source       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
      options      JSONB NOT NULL DEFAULT '{}'::jsonb,
      stats        JSONB,
      error        TEXT,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at  TIMESTAMPTZ
    );
    ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS import_run_id BIGINT REFERENCES history_import_runs(id) ON DELETE SET NULL;
  `);
}
