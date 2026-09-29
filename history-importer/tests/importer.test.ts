import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseGymConfig } from '../src/config.js';
import { createPool, prepareSchema, type Pool } from '../src/db.js';
import { type LeadAssessment, type LeadExtractor, sanitizeAssessment } from '../src/extractor.js';
import { type ImportOptions, runImport } from '../src/importer.js';
import type { HistoryChat } from '../src/types.js';

/**
 * Needs a Postgres database with the WhatsApp agent's schema. By default the agent's
 * migration file from the parent repo is applied; override with AGENT_SCHEMA_SQL.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const SCHEMA_SQL = process.env.AGENT_SCHEMA_SQL ?? new URL('../../migrations/001_init.sql', import.meta.url).pathname;

const config = parseGymConfig({
  gym: { name: 'Flamingo Fitness' },
  timezone: 'Asia/Kolkata',
  plans: [
    { code: 'monthly', name: 'Monthly', price: 2500 },
    { code: 'quarterly', name: 'Quarterly', price: 6500 },
  ],
});

const NOW = new Date('2026-10-02T06:00:00Z');
const LEAD_PHONE = '919822222222';

const baseAssessment: LeadAssessment = {
  isGymEnquiry: true,
  name: 'Priya',
  fitnessGoal: 'weight loss',
  preferredPlan: 'monthly',
  preferredJoinDate: null,
  trialInterest: true,
  trialDate: null,
  trialTime: null,
  outcome: 'QUALIFIED',
  summary: 'Asked about monthly pricing to lose weight.',
};

class FakeExtractor implements LeadExtractor {
  calls = 0;
  constructor(public answer: (chat: HistoryChat) => LeadAssessment = () => baseAssessment) {}
  async assess(chat: HistoryChat) {
    this.calls++;
    return this.answer(chat);
  }
}

const chat = (phone: string, texts: [boolean, string, string][], name: string | null = null): HistoryChat => ({
  label: `+${phone}`,
  jid: `${phone}@s.whatsapp.net`,
  phone,
  name,
  messages: texts.map(([fromMe, text, iso], i) => ({ id: `${phone}-${i}-${iso}`, fromMe, text, timestamp: new Date(iso) })),
});

const priyaChat = () =>
  chat(LEAD_PHONE, [
    [false, 'Hi, what are your membership prices?', '2026-08-01T10:00:00Z'],
    [true, 'Monthly is 2500', '2026-08-01T10:05:00Z'],
    [false, "I'm Priya, I want to lose weight", '2026-08-01T10:07:00Z'],
  ]);

describe.skipIf(!TEST_DB)('history import', () => {
  let pool: Pool;
  const opts = (o: Partial<ImportOptions> = {}): ImportOptions => ({
    config,
    adminPhones: ['919000000001'],
    dryRun: false,
    concurrency: 2,
    now: () => NOW,
    logger: pino({ level: 'silent' }),
    ...o,
  });
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  beforeEach(async () => {
    await pool?.end();
    pool = createPool(TEST_DB!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(readFileSync(SCHEMA_SQL, 'utf8'));
    await prepareSchema(pool);
  });
  afterAll(async () => pool?.end());

  it('creates a qualified lead with the original history and sends/schedules nothing', async () => {
    const run = (await q(`INSERT INTO history_import_runs (source) VALUES ('export') RETURNING id`))[0].id;
    const { results, stats } = await runImport(pool, [priyaChat()], new FakeExtractor(), opts(), run);
    expect(results[0]).toMatchObject({ action: 'lead_created', stage: 'QUALIFIED', newMessages: 3 });
    expect(stats).toMatchObject({ lead_created: 1, stage_QUALIFIED: 1 });

    const [lead] = await q('SELECT * FROM leads');
    expect(lead).toMatchObject({ name: 'Priya', fitness_goal: 'weight loss', preferred_plan: 'monthly', source: 'whatsapp_import' });
    expect(lead.created_at.toISOString()).toBe('2026-08-01T10:00:00.000Z'); // lead date = first message
    expect(lead.notes).toContain('[Imported from WhatsApp history]');

    const logs = await q('SELECT direction, source, created_at, import_run_id FROM message_logs ORDER BY created_at');
    expect(logs.map((l) => `${l.direction}/${l.source}`)).toEqual(['INBOUND/CUSTOMER', 'OUTBOUND/HUMAN', 'INBOUND/CUSTOMER']);
    expect(logs.every((l) => l.import_run_id === run)).toBe(true);
    expect(logs[0].created_at.toISOString()).toBe('2026-08-01T10:00:00.000Z');

    // Nothing sent, nothing queued.
    expect(await q('SELECT 1 FROM scheduled_messages')).toHaveLength(0);
    expect(await q(`SELECT 1 FROM message_logs WHERE source IN ('AGENT','AUTOMATED','SYSTEM','ADMIN_NOTIFICATION')`)).toHaveLength(0);
    const [contact] = await q('SELECT last_inbound_at, last_outbound_at FROM contacts');
    expect(contact.last_inbound_at.toISOString()).toBe('2026-08-01T10:07:00.000Z');
    expect(contact.last_outbound_at).toBeNull();
  });

  it('is idempotent: a second run imports nothing and skips Gemini', async () => {
    const extractor = new FakeExtractor();
    await runImport(pool, [priyaChat()], extractor, opts(), null);
    const second = await runImport(pool, [priyaChat()], extractor, opts(), null);
    expect(second.results[0]!.action).toBe('unchanged');
    expect(extractor.calls).toBe(1);
    expect(await q('SELECT 1 FROM message_logs')).toHaveLength(3);
    expect(await q('SELECT 1 FROM leads')).toHaveLength(1);
  });

  it('does not store personal/non-gym chats or admin chats at all', async () => {
    const extractor = new FakeExtractor(() => ({ ...baseAssessment, isGymEnquiry: false }));
    const { results } = await runImport(
      pool,
      [priyaChat(), chat('919000000001', [[false, 'Owner here', '2026-08-01T10:00:00Z']])],
      extractor,
      opts(),
      null,
    );
    expect(results.map((r) => r.reason)).toEqual(['not_a_gym_enquiry', 'admin_number']);
    expect(await q('SELECT 1 FROM contacts')).toHaveLength(0);
    expect(await q('SELECT 1 FROM message_logs')).toHaveLength(0);
  });

  it('dry run writes nothing', async () => {
    const { results } = await runImport(pool, [priyaChat()], new FakeExtractor(), opts({ dryRun: true }), null);
    expect(results[0]).toMatchObject({ action: 'would_create_lead', stage: 'QUALIFIED' });
    expect(await q('SELECT 1 FROM contacts')).toHaveLength(0);
  });

  it('saves member history without creating a lead or calling Gemini', async () => {
    const [c] = await q(`INSERT INTO contacts (phone, name) VALUES ($1, 'Priya') RETURNING id`, [LEAD_PHONE]);
    await q(`INSERT INTO members (contact_id, name) VALUES ($1, 'Priya')`, [c.id]);
    const extractor = new FakeExtractor();
    const { results } = await runImport(pool, [priyaChat()], extractor, opts(), null);
    expect(results[0]!.action).toBe('member_history_saved');
    expect(extractor.calls).toBe(0);
    expect(await q('SELECT 1 FROM leads')).toHaveLength(0);
    expect(await q('SELECT 1 FROM message_logs')).toHaveLength(3);
  });

  it('only fills blanks on leads the agent already knows', async () => {
    const [c] = await q(`INSERT INTO contacts (phone, wa_jid, name) VALUES ($1, $2, 'P') RETURNING id`, [LEAD_PHONE, `${LEAD_PHONE}@s.whatsapp.net`]);
    await q(`INSERT INTO leads (contact_id, stage, name, preferred_plan) VALUES ($1, 'NEW', 'Priya Sharma', 'quarterly')`, [c.id]);
    const extractor = new FakeExtractor(() => ({ ...baseAssessment, outcome: 'LOST', isGymEnquiry: false }));
    const { results } = await runImport(pool, [priyaChat()], extractor, opts(), null);
    expect(results[0]).toMatchObject({ action: 'lead_updated', stage: 'QUALIFIED' });
    const [lead] = await q('SELECT * FROM leads');
    // existing values kept, blank goal filled, never downgraded to LOST
    expect(lead).toMatchObject({ name: 'Priya Sharma', preferred_plan: 'quarterly', fitness_goal: 'weight loss', stage: 'QUALIFIED' });
  });

  it('maps trials, conversions and unqualified enquiries to stages', async () => {
    const answers: Record<string, Partial<LeadAssessment>> = {
      '919811111111': { outcome: 'TRIAL_BOOKED', trialDate: '2026-10-05', trialTime: '18:00' },
      '919822222222': { outcome: 'TRIAL_BOOKED', trialDate: '2026-08-05', trialTime: '18:00' },
      '919833333333': { outcome: 'CONVERTED' },
      '919844444444': { outcome: 'QUALIFIED', name: null, fitnessGoal: null },
    };
    const chats = Object.keys(answers).map((p) => chat(p, [[false, 'hi, gym fees?', '2026-08-01T10:00:00Z']]));
    const extractor = new FakeExtractor((c) => ({ ...baseAssessment, ...answers[c.phone!] }));
    await runImport(pool, chats, extractor, opts(), null);
    const rows = await q(`SELECT c.phone, l.stage, l.trial_at, l.notes FROM leads l JOIN contacts c ON c.id = l.contact_id ORDER BY c.phone`);
    expect(rows.map((r) => [r.phone, r.stage])).toEqual([
      ['919811111111', 'TRIAL_BOOKED'],
      ['919822222222', 'QUALIFIED'],
      ['919833333333', 'CONVERTED'],
      ['919844444444', 'NEW'],
    ]);
    expect(rows[0].trial_at.toISOString()).toBe('2026-10-05T12:30:00.000Z');
    expect(rows[1].notes).toContain('in the past');
    // Imported trials never get an automatic reminder: nothing is scheduled.
    expect(await q('SELECT 1 FROM scheduled_messages')).toHaveLength(0);
  });
});

describe('sanitizeAssessment', () => {
  it('drops unknown plans and malformed dates', () => {
    const a = sanitizeAssessment(
      {
        isGymEnquiry: true,
        name: ' Priya ',
        fitnessGoal: '',
        preferredPlan: 'Platinum',
        preferredJoinDate: '2026-02-30',
        trialInterest: null,
        trialDate: 'next monday',
        trialTime: '6pm',
        outcome: 'NEW',
        summary: 'x',
      },
      config,
    );
    expect(a).toMatchObject({ name: 'Priya', fitnessGoal: null, preferredPlan: null, preferredJoinDate: null, trialDate: null, trialTime: null });
    expect(sanitizeAssessment({ ...a, preferredPlan: 'quarterly plan', outcome: 'NEW', summary: '' }, config).preferredPlan).toBe('quarterly');
  });
});
