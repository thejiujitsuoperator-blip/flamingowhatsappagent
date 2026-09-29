import pg from 'pg';

// Return DATE columns as plain "YYYY-MM-DD" strings instead of JS Dates (avoids timezone shifts).
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC -> number (amounts are small, 2-decimal values).
pg.types.setTypeParser(1700, (v) => Number(v));
// BIGINT (ids, counts) -> number.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool | pg.PoolClient;
export type Pool = pg.Pool;

export function createPool(connectionString: string, ssl = false): pg.Pool {
  return new pg.Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
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
