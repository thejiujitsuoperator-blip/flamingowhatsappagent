import type { Db } from '../db/pool.js';

export type ScheduledKind =
  | 'PAYMENT_REMINDER_BEFORE'
  | 'PAYMENT_REMINDER_DUE'
  | 'PAYMENT_REMINDER_OVERDUE'
  | 'LEAD_FOLLOW_UP'
  | 'CUSTOM_FOLLOW_UP';

export const PAYMENT_KINDS: ScheduledKind[] = ['PAYMENT_REMINDER_BEFORE', 'PAYMENT_REMINDER_DUE', 'PAYMENT_REMINDER_OVERDUE'];
export const FOLLOW_UP_KINDS: ScheduledKind[] = ['LEAD_FOLLOW_UP', 'CUSTOM_FOLLOW_UP'];

export interface ScheduledMessage {
  id: number;
  contact_id: number;
  kind: ScheduledKind;
  dedupe_key: string;
  body: string;
  send_at: Date;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'CANCELLED' | 'SKIPPED' | 'FAILED';
  related_payment_id: number | null;
  related_lead_id: number | null;
  meta: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  status_reason: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type NewScheduledMessage = Pick<ScheduledMessage, 'contact_id' | 'kind' | 'dedupe_key' | 'body' | 'send_at'> &
  Partial<Pick<ScheduledMessage, 'related_payment_id' | 'related_lead_id' | 'meta'>>;

/**
 * Inserts a scheduled message unless one with the same dedupe key already exists
 * (in any status). This is what guarantees "never send duplicate reminders".
 * Returns null when it was a duplicate.
 */
export async function scheduleOnce(db: Db, m: NewScheduledMessage): Promise<ScheduledMessage | null> {
  const { rows } = await db.query<ScheduledMessage>(
    `INSERT INTO scheduled_messages (contact_id, kind, dedupe_key, body, send_at, related_payment_id, related_lead_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [
      m.contact_id,
      m.kind,
      m.dedupe_key,
      m.body,
      m.send_at,
      m.related_payment_id ?? null,
      m.related_lead_id ?? null,
      JSON.stringify(m.meta ?? {}),
    ],
  );
  return rows[0] ?? null;
}

/**
 * Atomically claims due messages (PENDING -> SENDING) so concurrent dispatchers
 * never pick up the same row.
 */
export async function claimDueMessages(db: Db, now: Date, limit = 20): Promise<ScheduledMessage[]> {
  const { rows } = await db.query<ScheduledMessage>(
    `UPDATE scheduled_messages SET status = 'SENDING', attempts = attempts + 1, updated_at = NOW()
      WHERE id IN (
        SELECT id FROM scheduled_messages
         WHERE status = 'PENDING' AND send_at <= $1
         ORDER BY send_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [now, limit],
  );
  return rows;
}

/** Messages stuck in SENDING (e.g. process crashed mid-send) are returned to the queue. */
export async function releaseStaleSending(db: Db, olderThanMinutes = 10): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE scheduled_messages SET status = 'PENDING', updated_at = NOW()
      WHERE status = 'SENDING' AND updated_at < NOW() - make_interval(mins => $1::int)`,
    [olderThanMinutes],
  );
  return rowCount ?? 0;
}

export async function markSent(db: Db, id: number): Promise<void> {
  await db.query(`UPDATE scheduled_messages SET status = 'SENT', sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
}

export async function markSkipped(db: Db, id: number, reason: string): Promise<void> {
  await db.query(
    `UPDATE scheduled_messages SET status = 'SKIPPED', status_reason = $2, updated_at = NOW() WHERE id = $1`,
    [id, reason],
  );
}

export async function deferMessage(db: Db, id: number, sendAt: Date, reason: string): Promise<void> {
  await db.query(
    `UPDATE scheduled_messages SET status = 'PENDING', send_at = $2, status_reason = $3, updated_at = NOW() WHERE id = $1`,
    [id, sendAt, reason],
  );
}

/** Records a failed attempt: retried up to `maxAttempts`, then marked FAILED. */
export async function markAttemptFailed(db: Db, msg: ScheduledMessage, error: string, maxAttempts = 3): Promise<void> {
  if (msg.attempts >= maxAttempts) {
    await db.query(
      `UPDATE scheduled_messages SET status = 'FAILED', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [msg.id, error],
    );
  } else {
    await db.query(
      `UPDATE scheduled_messages SET status = 'PENDING', last_error = $2,
              send_at = NOW() + make_interval(mins => 5 * $3::int), updated_at = NOW()
        WHERE id = $1`,
      [msg.id, error, msg.attempts],
    );
  }
}

async function cancelWhere(db: Db, where: string, values: unknown[], reason: string): Promise<number> {
  values.push(reason);
  const { rowCount } = await db.query(
    `UPDATE scheduled_messages SET status = 'CANCELLED', status_reason = $${values.length}, updated_at = NOW()
      WHERE status = 'PENDING' AND ${where}`,
    values,
  );
  return rowCount ?? 0;
}

export function cancelForContact(db: Db, contactId: number, reason: string, kinds?: ScheduledKind[]): Promise<number> {
  return kinds
    ? cancelWhere(db, 'contact_id = $1 AND kind = ANY($2)', [contactId, kinds], reason)
    : cancelWhere(db, 'contact_id = $1', [contactId], reason);
}

export function cancelForLead(db: Db, leadId: number, reason: string): Promise<number> {
  return cancelWhere(db, 'related_lead_id = $1 AND kind = ANY($2)', [leadId, FOLLOW_UP_KINDS], reason);
}

export function cancelForPayments(db: Db, paymentIds: number[], reason: string): Promise<number> {
  if (!paymentIds.length) return Promise.resolve(0);
  return cancelWhere(db, 'related_payment_id = ANY($1)', [paymentIds], reason);
}

export async function listPendingForContact(db: Db, contactId: number): Promise<ScheduledMessage[]> {
  const { rows } = await db.query<ScheduledMessage>(
    `SELECT * FROM scheduled_messages WHERE contact_id = $1 AND status = 'PENDING' ORDER BY send_at ASC`,
    [contactId],
  );
  return rows;
}
