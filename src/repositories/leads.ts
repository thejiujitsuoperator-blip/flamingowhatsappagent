import type { Db } from '../db/pool.js';

export const LEAD_STAGES = ['NEW', 'QUALIFIED', 'TRIAL_BOOKED', 'FOLLOW_UP', 'CONVERTED', 'LOST'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
/** Stages in which a lead is still being worked on (eligible for follow-ups). */
export const OPEN_LEAD_STAGES: LeadStage[] = ['NEW', 'QUALIFIED', 'TRIAL_BOOKED', 'FOLLOW_UP'];

export interface Lead {
  id: number;
  contact_id: number;
  stage: LeadStage;
  name: string | null;
  fitness_goal: string | null;
  preferred_plan: string | null;
  preferred_join_date: string | null;
  trial_interest: boolean | null;
  trial_at: Date | null;
  notes: string | null;
  lost_reason: string | null;
  source: string;
  converted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface LeadWithContact extends Lead {
  phone: string | null;
  contact_name: string | null;
  opted_out: boolean;
}

export type LeadUpdate = Partial<
  Pick<
    Lead,
    | 'stage'
    | 'name'
    | 'fitness_goal'
    | 'preferred_plan'
    | 'preferred_join_date'
    | 'trial_interest'
    | 'trial_at'
    | 'notes'
    | 'lost_reason'
  >
>;

const UPDATABLE: (keyof LeadUpdate)[] = [
  'stage',
  'name',
  'fitness_goal',
  'preferred_plan',
  'preferred_join_date',
  'trial_interest',
  'trial_at',
  'notes',
  'lost_reason',
];

export async function getLeadByContact(db: Db, contactId: number): Promise<Lead | null> {
  const { rows } = await db.query<Lead>('SELECT * FROM leads WHERE contact_id = $1', [contactId]);
  return rows[0] ?? null;
}

export async function getLeadById(db: Db, id: number): Promise<Lead | null> {
  const { rows } = await db.query<Lead>('SELECT * FROM leads WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Idempotent: returns the existing lead for the contact if there is one. */
export async function createLead(db: Db, contactId: number, fields: LeadUpdate = {}): Promise<Lead> {
  const { rows } = await db.query<Lead>(
    `INSERT INTO leads (contact_id, name) VALUES ($1, $2)
     ON CONFLICT (contact_id) DO NOTHING RETURNING *`,
    [contactId, fields.name ?? null],
  );
  const lead = rows[0] ?? (await getLeadByContact(db, contactId))!;
  const rest = { ...fields };
  if (rows[0]) delete rest.name;
  return Object.keys(rest).length ? updateLead(db, lead.id, rest) : lead;
}

export async function updateLead(db: Db, id: number, fields: LeadUpdate): Promise<Lead> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const key of UPDATABLE) {
    if (fields[key] === undefined) continue;
    values.push(fields[key]);
    sets.push(`${key} = $${values.length}`);
  }
  if (fields.stage === 'CONVERTED') sets.push('converted_at = COALESCE(converted_at, NOW())');
  if (!sets.length) return (await getLeadById(db, id))!;
  sets.push('updated_at = NOW()');
  const { rows } = await db.query<Lead>(`UPDATE leads SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values);
  if (!rows[0]) throw new Error(`Lead ${id} not found`);
  return rows[0];
}

export async function listLeads(
  db: Db,
  filter: { stage?: LeadStage; createdFrom?: Date; createdTo?: Date; limit?: number },
): Promise<LeadWithContact[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.stage) {
    values.push(filter.stage);
    where.push(`l.stage = $${values.length}`);
  }
  if (filter.createdFrom) {
    values.push(filter.createdFrom);
    where.push(`l.created_at >= $${values.length}`);
  }
  if (filter.createdTo) {
    values.push(filter.createdTo);
    where.push(`l.created_at < $${values.length}`);
  }
  values.push(filter.limit ?? 50);
  const { rows } = await db.query<LeadWithContact>(
    `SELECT l.*, c.phone, c.name AS contact_name, c.opted_out
       FROM leads l JOIN contacts c ON c.id = l.contact_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

export async function leadStats(db: Db, from: Date, to: Date) {
  const { rows } = await db.query<{ created: number; converted: number; lost: number; trials_booked: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS created,
       COUNT(*) FILTER (WHERE converted_at >= $1 AND converted_at < $2)::int AS converted,
       COUNT(*) FILTER (WHERE stage = 'LOST' AND updated_at >= $1 AND updated_at < $2)::int AS lost,
       COUNT(*) FILTER (WHERE trial_at IS NOT NULL AND updated_at >= $1 AND updated_at < $2)::int AS trials_booked
     FROM leads`,
    [from, to],
  );
  const byStage = await db.query<{ stage: LeadStage; count: number }>(
    'SELECT stage, COUNT(*)::int AS count FROM leads GROUP BY stage',
  );
  return { ...rows[0]!, currentByStage: Object.fromEntries(byStage.rows.map((r) => [r.stage, r.count])) };
}
