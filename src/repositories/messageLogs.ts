import type { Db } from '../db/pool.js';

export type MessageSource = 'CUSTOMER' | 'AGENT' | 'AUTOMATED' | 'HUMAN' | 'SYSTEM' | 'ADMIN_NOTIFICATION';

export interface MessageLog {
  id: number;
  contact_id: number | null;
  direction: 'INBOUND' | 'OUTBOUND';
  source: MessageSource;
  body: string;
  wa_message_id: string | null;
  scheduled_message_id: number | null;
  tool_calls: unknown;
  status: 'OK' | 'FAILED' | 'IGNORED';
  error: string | null;
  created_at: Date;
}

export async function insertMessageLog(
  db: Db,
  log: Pick<MessageLog, 'contact_id' | 'direction' | 'source' | 'body'> &
    Partial<Pick<MessageLog, 'wa_message_id' | 'scheduled_message_id' | 'tool_calls' | 'status' | 'error'>>,
): Promise<MessageLog | null> {
  const { rows } = await db.query<MessageLog>(
    `INSERT INTO message_logs (contact_id, direction, source, body, wa_message_id, scheduled_message_id, tool_calls, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      log.contact_id,
      log.direction,
      log.source,
      log.body,
      log.wa_message_id ?? null,
      log.scheduled_message_id ?? null,
      log.tool_calls === undefined ? null : JSON.stringify(log.tool_calls),
      log.status ?? 'OK',
      log.error ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function messageIdExists(db: Db, waMessageId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM message_logs WHERE wa_message_id = $1', [waMessageId]);
  return (rowCount ?? 0) > 0;
}

/** Most recent successful messages for a contact, oldest first (for LLM context). */
export async function recentMessages(db: Db, contactId: number, limit: number): Promise<MessageLog[]> {
  const { rows } = await db.query<MessageLog>(
    `SELECT * FROM (
       SELECT * FROM message_logs
        WHERE contact_id = $1 AND status = 'OK' AND source <> 'ADMIN_NOTIFICATION'
        ORDER BY created_at DESC, id DESC LIMIT $2
     ) t ORDER BY created_at ASC, id ASC`,
    [contactId, limit],
  );
  return rows;
}

export async function countAutomatedSince(db: Db, contactId: number, since: Date): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM message_logs
      WHERE contact_id = $1 AND source = 'AUTOMATED' AND status = 'OK' AND created_at >= $2`,
    [contactId, since],
  );
  return rows[0]!.n;
}
