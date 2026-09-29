import type { Db } from '../db/pool.js';

/**
 * ACTIVE        - the AI answers autonomously
 * NEEDS_HUMAN   - handed off; AI is silent until staff resolves it
 * HUMAN_ACTIVE  - staff is replying manually from the gym's phone; AI is silent
 * PAUSED        - admin asked us to stop messaging this contact entirely
 */
export type ConversationStatus = 'ACTIVE' | 'NEEDS_HUMAN' | 'HUMAN_ACTIVE' | 'PAUSED';

export interface Conversation {
  id: number;
  contact_id: number;
  status: ConversationStatus;
  handoff_reason: string | null;
  handoff_summary: string | null;
  handoff_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function getOrCreateConversation(db: Db, contactId: number): Promise<Conversation> {
  const { rows } = await db.query<Conversation>(
    `INSERT INTO conversations (contact_id) VALUES ($1)
     ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id
     RETURNING *`,
    [contactId],
  );
  return rows[0]!;
}

export async function getConversation(db: Db, contactId: number): Promise<Conversation | null> {
  const { rows } = await db.query<Conversation>('SELECT * FROM conversations WHERE contact_id = $1', [contactId]);
  return rows[0] ?? null;
}

export async function setConversationStatus(
  db: Db,
  contactId: number,
  status: ConversationStatus,
  handoff?: { reason: string; summary?: string | null },
): Promise<Conversation> {
  await getOrCreateConversation(db, contactId);
  const { rows } = await db.query<Conversation>(
    `UPDATE conversations SET
       status = $2,
       handoff_reason = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE COALESCE($3, handoff_reason) END,
       handoff_summary = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE COALESCE($4, handoff_summary) END,
       handoff_at = CASE WHEN $3::text IS NOT NULL THEN NOW() WHEN $2 = 'ACTIVE' THEN NULL ELSE handoff_at END,
       updated_at = NOW()
     WHERE contact_id = $1 RETURNING *`,
    [contactId, status, handoff?.reason ?? null, handoff?.summary ?? null],
  );
  return rows[0]!;
}

export async function listConversationsByStatus(db: Db, statuses: ConversationStatus[]) {
  const { rows } = await db.query<Conversation & { name: string | null; phone: string | null }>(
    `SELECT cv.*, c.name, c.phone FROM conversations cv JOIN contacts c ON c.id = cv.contact_id
      WHERE cv.status = ANY($1) ORDER BY cv.updated_at DESC LIMIT 50`,
    [statuses],
  );
  return rows;
}
