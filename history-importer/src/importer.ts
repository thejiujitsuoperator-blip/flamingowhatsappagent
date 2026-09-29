import type { Logger } from 'pino';
import type { GymConfig } from './config.js';
import { type Db, type Pool, withTransaction } from './db.js';
import type { LeadAssessment, LeadExtractor } from './extractor.js';
import type { HistoryChat, HistoryMessage } from './types.js';
import { localDate, zonedToUtc } from './util.js';

/**
 * Imports chat history into the agent's database and qualifies leads.
 * It writes ONLY to contacts, leads and message_logs (and never to scheduled_messages),
 * and has no code path that can send a WhatsApp message.
 */

export interface ImportOptions {
  config: GymConfig;
  adminPhones: string[];
  /** Only import messages on/after this instant. */
  since?: Date;
  dryRun: boolean;
  maxChats?: number;
  concurrency: number;
  now: () => Date;
  logger: Logger;
}

export type ChatAction =
  | 'lead_created'
  | 'lead_updated'
  | 'member_history_saved'
  | 'unchanged'
  | 'skipped'
  | 'would_create_lead'
  | 'would_update_lead'
  | 'would_save_member_history'
  | 'failed';

export interface ChatResult {
  chat: string;
  phone: string | null;
  name: string | null;
  action: ChatAction;
  reason?: string;
  stage?: string;
  newMessages: number;
  assessment?: LeadAssessment;
}

interface ExistingContact {
  id: number;
  is_admin: boolean;
  member_id: number | null;
  lead: LeadRow | null;
}

interface LeadRow {
  id: number;
  stage: string;
  name: string | null;
  fitness_goal: string | null;
  preferred_plan: string | null;
  preferred_join_date: string | null;
  trial_interest: boolean | null;
  trial_at: Date | null;
  notes: string | null;
}

const isQualified = (l: { name: string | null; fitness_goal: string | null; preferred_plan: string | null; preferred_join_date: string | null }) =>
  !!l.name && !!l.fitness_goal && (!!l.preferred_plan || !!l.preferred_join_date);

async function findExisting(db: Db, chat: HistoryChat): Promise<ExistingContact | null> {
  const { rows } = await db.query<{ id: number; is_admin: boolean; member_id: number | null }>(
    `SELECT c.id, c.is_admin, m.id AS member_id FROM contacts c LEFT JOIN members m ON m.contact_id = c.id
      WHERE ($1::text IS NOT NULL AND c.phone = $1) OR ($2::text IS NOT NULL AND c.wa_jid = $2)
      ORDER BY (c.phone = $1) DESC NULLS LAST LIMIT 1`,
    [chat.phone, chat.jid],
  );
  const c = rows[0];
  if (!c) return null;
  const lead = await db.query<LeadRow>('SELECT * FROM leads WHERE contact_id = $1', [c.id]);
  return { ...c, lead: lead.rows[0] ?? null };
}

async function countNewMessages(db: Db, messages: HistoryMessage[]): Promise<number> {
  if (!messages.length) return 0;
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM message_logs WHERE wa_message_id = ANY($1)`,
    [messages.map((m) => m.id)],
  );
  return messages.length - rows[0]!.n;
}

/** Decides the stage and trial time for a lead created from history. */
export function stageForNewLead(a: LeadAssessment, config: GymConfig, now: Date): { stage: string; trialAt: Date | null; note?: string } {
  const fields = { name: a.name, fitness_goal: a.fitnessGoal, preferred_plan: a.preferredPlan, preferred_join_date: a.preferredJoinDate };
  const base = isQualified(fields) ? 'QUALIFIED' : 'NEW';
  if (a.outcome === 'CONVERTED') return { stage: 'CONVERTED', trialAt: null, note: 'Chat suggests they joined - add them as a member if they are not already.' };
  if (a.outcome === 'LOST') return { stage: 'LOST', trialAt: null };
  if (a.trialDate) {
    const trialAt = a.trialTime ? zonedToUtc(a.trialDate, a.trialTime, config.timezone) : null;
    const upcoming = a.trialDate >= localDate(config.timezone, now) && (!trialAt || trialAt > now);
    if (upcoming && trialAt) return { stage: 'TRIAL_BOOKED', trialAt };
    return { stage: base, trialAt: null, note: `Trial discussed for ${a.trialDate}${a.trialTime ? ` ${a.trialTime}` : ''}${upcoming ? ' (no time agreed)' : ' (in the past)'}.` };
  }
  return { stage: base, trialAt: null };
}

async function upsertContact(db: Db, chat: HistoryChat, existing: ExistingContact | null, lastInbound: Date | null): Promise<number> {
  if (existing) {
    await db.query(
      `UPDATE contacts SET
         phone = COALESCE(phone, CASE WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE phone = $2) THEN $2 END),
         wa_jid = COALESCE(wa_jid, CASE WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE wa_jid = $3) THEN $3 END),
         name = COALESCE(name, $4),
         last_inbound_at = GREATEST(last_inbound_at, $5),
         updated_at = NOW()
       WHERE id = $1`,
      [existing.id, chat.phone, chat.jid, chat.name, lastInbound],
    );
    return existing.id;
  }
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO contacts (phone, wa_jid, name, last_inbound_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [chat.phone, chat.jid, chat.name, lastInbound],
  );
  return rows[0]!.id;
}

async function insertMessages(db: Db, contactId: number, messages: HistoryMessage[], runId: number | null): Promise<void> {
  if (!messages.length) return;
  await db.query(
    `INSERT INTO message_logs (contact_id, direction, source, body, wa_message_id, created_at, import_run_id)
     SELECT $1, CASE WHEN m.from_me THEN 'OUTBOUND' ELSE 'INBOUND' END,
            CASE WHEN m.from_me THEN 'HUMAN' ELSE 'CUSTOMER' END,
            m.body, m.id, m.ts, $2
       FROM unnest($3::text[], $4::bool[], $5::text[], $6::timestamptz[]) AS m(id, from_me, body, ts)
     ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
    [
      contactId,
      runId,
      messages.map((m) => m.id),
      messages.map((m) => m.fromMe),
      messages.map((m) => m.text),
      messages.map((m) => m.timestamp),
    ],
  );
}

const importNote = (a: LeadAssessment, extra?: string) =>
  ['[Imported from WhatsApp history]', a.summary, extra].filter(Boolean).join(' ');

async function processChat(pool: Pool, chat: HistoryChat, extractor: LeadExtractor, opts: ImportOptions, runId: number | null): Promise<ChatResult> {
  const messages = opts.since ? chat.messages.filter((m) => m.timestamp >= opts.since!) : chat.messages;
  const result: ChatResult = { chat: chat.label, phone: chat.phone, name: chat.name, action: 'skipped', newMessages: 0 };
  if (!messages.length) return { ...result, reason: 'no_messages_in_range' };
  if (chat.phone && opts.adminPhones.includes(chat.phone)) return { ...result, reason: 'admin_number' };
  if (!messages.some((m) => !m.fromMe)) return { ...result, reason: 'customer_never_wrote' };

  const existing = await findExisting(pool, chat);
  if (existing?.is_admin) return { ...result, reason: 'admin_number' };
  result.newMessages = await countNewMessages(pool, messages);
  const lastInbound = messages.filter((m) => !m.fromMe).at(-1)?.timestamp ?? null;

  // Existing members: keep their history as context for the agent, but they are not leads.
  if (existing?.member_id) {
    if (!result.newMessages) return { ...result, action: 'unchanged', reason: 'member' };
    if (opts.dryRun) return { ...result, action: 'would_save_member_history' };
    await withTransaction(pool, async (db) => {
      const id = await upsertContact(db, chat, existing, lastInbound);
      await insertMessages(db, id, messages, runId);
    });
    return { ...result, action: 'member_history_saved' };
  }
  if (existing?.lead && !result.newMessages) return { ...result, action: 'unchanged', stage: existing.lead.stage };

  const assessment = await extractor.assess({ ...chat, messages });
  result.assessment = assessment;
  result.name = assessment.name ?? chat.name;
  // Personal chats, suppliers, spam... are not imported at all (unless we already know them as a lead).
  if (!assessment.isGymEnquiry && !existing?.lead) return { ...result, reason: 'not_a_gym_enquiry' };

  if (!existing?.lead) {
    const { stage, trialAt, note } = stageForNewLead(assessment, opts.config, opts.now());
    result.stage = stage;
    if (opts.dryRun) return { ...result, action: 'would_create_lead' };
    await withTransaction(pool, async (db) => {
      const contactId = await upsertContact(db, chat, existing, lastInbound);
      await insertMessages(db, contactId, messages, runId);
      await db.query(
        `INSERT INTO leads (contact_id, stage, name, fitness_goal, preferred_plan, preferred_join_date, trial_interest, trial_at,
                            notes, lost_reason, source, converted_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'whatsapp_import',$11,$12,NOW())
         ON CONFLICT (contact_id) DO NOTHING`,
        [
          contactId,
          stage,
          assessment.name ?? chat.name,
          assessment.fitnessGoal,
          assessment.preferredPlan,
          assessment.preferredJoinDate,
          assessment.trialInterest ?? (trialAt ? true : null),
          trialAt,
          importNote(assessment, note),
          stage === 'LOST' ? 'Imported: ' + (assessment.summary || 'not interested') : null,
          stage === 'CONVERTED' ? messages.at(-1)!.timestamp : null,
          // Lead date = when they first wrote, so "today's leads" reports stay accurate.
          messages[0]!.timestamp,
        ],
      );
    });
    return { ...result, action: 'lead_created' };
  }

  // Existing lead (e.g. already talking to the agent): only fill in blanks, never overwrite or downgrade.
  const lead = existing.lead;
  const merged = {
    name: lead.name ?? assessment.name,
    fitness_goal: lead.fitness_goal ?? assessment.fitnessGoal,
    preferred_plan: lead.preferred_plan ?? assessment.preferredPlan,
    preferred_join_date: lead.preferred_join_date ?? assessment.preferredJoinDate,
  };
  const stage = lead.stage === 'NEW' && isQualified(merged) ? 'QUALIFIED' : lead.stage;
  result.stage = stage;
  if (opts.dryRun) return { ...result, action: 'would_update_lead' };
  await withTransaction(pool, async (db) => {
    await upsertContact(db, chat, existing, lastInbound);
    await insertMessages(db, existing.id, messages, runId);
    await db.query(
      `UPDATE leads SET name = $2, fitness_goal = $3, preferred_plan = $4, preferred_join_date = $5,
              trial_interest = COALESCE(trial_interest, $6), stage = $7,
              notes = CONCAT_WS(E'\\n', notes, $8::text), updated_at = NOW()
        WHERE id = $1`,
      [lead.id, merged.name, merged.fitness_goal, merged.preferred_plan, merged.preferred_join_date, assessment.trialInterest, stage, importNote(assessment)],
    );
  });
  return { ...result, action: 'lead_updated' };
}

export interface ImportSummary {
  results: ChatResult[];
  stats: Record<string, number>;
}

export async function runImport(
  pool: Pool,
  chats: HistoryChat[],
  extractor: LeadExtractor,
  opts: ImportOptions,
  runId: number | null,
): Promise<ImportSummary> {
  const queue = chats.slice(0, opts.maxChats ?? chats.length);
  const results: ChatResult[] = new Array(queue.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < queue.length) {
      const i = next++;
      const chat = queue[i]!;
      try {
        results[i] = await processChat(pool, chat, extractor, opts, runId);
      } catch (err) {
        opts.logger.error({ err, chat: chat.label }, 'Failed to import chat');
        results[i] = { chat: chat.label, phone: chat.phone, name: chat.name, action: 'failed', reason: (err as Error).message, newMessages: 0 };
      }
      done++;
      if (done % 10 === 0 || done === queue.length) opts.logger.info(`Processed ${done}/${queue.length} chats`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));

  const stats: Record<string, number> = { chats: queue.length };
  for (const r of results) {
    stats[r.action] = (stats[r.action] ?? 0) + 1;
    if (r.stage && (r.action === 'lead_created' || r.action === 'would_create_lead')) stats[`stage_${r.stage}`] = (stats[`stage_${r.stage}`] ?? 0) + 1;
    if (r.action === 'skipped' && r.reason) stats[`skipped_${r.reason}`] = (stats[`skipped_${r.reason}`] ?? 0) + 1;
  }
  return { results, stats };
}
