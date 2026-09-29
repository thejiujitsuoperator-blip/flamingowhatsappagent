import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool.js';
import { MessageHandler, type InboundMessage } from '../src/handlers/messageHandler.js';
import { dispatchDueMessages } from '../src/scheduler/dispatcher.js';
import { markUnresponsiveLeadsLost } from '../src/services/leads.js';
import { createMember } from '../src/services/payments.js';
import { FakeLlm, makeContext, resetDb, TEST_DB } from './helpers.js';

const LEAD = '919822222222';
const ADMIN = '919000000001';
let seq = 0;
const inbound = (phone: string, text: string | null, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  id: `IN${++seq}`,
  jid: `${phone}@s.whatsapp.net`,
  phone,
  pushName: 'Priya',
  text,
  fromMe: false,
  ...extra,
});

describe.skipIf(!TEST_DB)('conversation flow', () => {
  let pool: Pool;
  beforeEach(async () => {
    await pool?.end();
    pool = await resetDb();
  });
  afterAll(async () => pool?.end());

  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  it('answers a new lead, stores details and schedules follow-ups', async () => {
    const { ctx, transport } = makeContext(pool);
    const llm = new FakeLlm([
      (req) => {
        // gym knowledge + CRM context are in the system prompt
        expect(req.systemInstruction).toContain('₹2,500');
        expect(req.systemInstruction).toContain('This person is a LEAD');
        return { calls: [{ name: 'getMembershipPlans', args: {} }] };
      },
      () => ({ text: 'Our Monthly plan is ₹2,500. May I know your name?' }),
      () => ({ calls: [{ name: 'updateLead', args: { name: 'Priya', fitnessGoal: 'weight loss', preferredPlan: 'Monthly' } }] }),
      () => ({ text: 'Thanks Priya!' }),
    ]);
    const handler = new MessageHandler(ctx, llm);
    await handler.handle(inbound(LEAD, 'Hi, what are your membership prices?'));
    await handler.handle(inbound(LEAD, "I'm Priya, want to lose weight, monthly plan"));

    expect(transport.textsTo(LEAD)).toEqual(['Our Monthly plan is ₹2,500. May I know your name?', 'Thanks Priya!']);
    const [lead] = await q('SELECT * FROM leads');
    expect(lead).toMatchObject({ name: 'Priya', fitness_goal: 'weight loss', preferred_plan: 'monthly', stage: 'QUALIFIED' });

    const followUps = await q(`SELECT status, send_at FROM scheduled_messages WHERE kind = 'LEAD_FOLLOW_UP' ORDER BY id`);
    // first sequence cancelled when the lead replied, second one pending
    expect(followUps.map((f) => f.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED', 'PENDING', 'PENDING', 'PENDING']);

    const logs = await q('SELECT direction, source FROM message_logs ORDER BY id');
    expect(logs).toHaveLength(4);
    // tool calls are stored with the agent reply
    const [agentLog] = await q(`SELECT tool_calls FROM message_logs WHERE source = 'AGENT' ORDER BY id LIMIT 1`);
    expect(agentLog.tool_calls[0].name).toBe('getMembershipPlans');
  });

  it('sends follow-ups when the lead goes quiet and marks them LOST at the end', async () => {
    const { ctx, clock, transport } = makeContext(pool);
    const handler = new MessageHandler(ctx, new FakeLlm([() => ({ text: 'Hello! How can I help?' })]));
    await handler.handle(inbound(LEAD, 'hi'));

    for (const days of [1, 3, 7]) {
      clock.now = new Date(new Date('2026-10-02T06:00:00Z').getTime() + days * 86_400_000 + 60_000);
      await dispatchDueMessages(ctx);
    }
    const texts = transport.textsTo(LEAD);
    expect(texts).toHaveLength(4);
    expect(texts[1]).toContain('Hi Priya! Just checking in');
    expect(texts[3]).toContain('last check-in');
    expect((await q('SELECT stage FROM leads'))[0].stage).toBe('FOLLOW_UP');

    // Simulate a week of silence after the final follow-up.
    await pool.query(`UPDATE contacts SET last_inbound_at = NOW() - interval '15 days'`);
    await pool.query(`UPDATE scheduled_messages SET sent_at = NOW() - interval '8 days'`);
    clock.now = new Date();
    expect(await markUnresponsiveLeadsLost(ctx)).toHaveLength(1);
    expect((await q('SELECT stage FROM leads'))[0].stage).toBe('LOST');
  });

  it('handles STOP deterministically and cancels everything', async () => {
    const { ctx, transport } = makeContext(pool);
    const llm = new FakeLlm([() => ({ text: 'Hello!' })]);
    const handler = new MessageHandler(ctx, llm);
    await handler.handle(inbound(LEAD, 'hi'));
    await handler.handle(inbound(LEAD, 'STOP'));
    expect(llm.requests).toHaveLength(1); // STOP never reaches Gemini
    expect(transport.textsTo(LEAD)[1]).toContain('unsubscribed');
    expect((await q('SELECT opted_out FROM contacts'))[0].opted_out).toBe(true);
    expect(await q(`SELECT 1 FROM scheduled_messages WHERE status = 'PENDING'`)).toHaveLength(0);
  });

  it('hands off to a human, alerts the admin and stops replying', async () => {
    const { ctx, transport } = makeContext(pool);
    const llm = new FakeLlm([
      () => ({ calls: [{ name: 'handoffToHuman', args: { reason: 'refund', summary: 'Wants a refund for last month' } }] }),
      () => ({ text: 'I have passed this to our team; someone will get back to you shortly.' }),
    ]);
    const handler = new MessageHandler(ctx, llm);
    await handler.handle(inbound(LEAD, 'I want a refund'));
    await handler.handle(inbound(LEAD, 'hello??'));

    expect(transport.textsTo(LEAD)).toEqual(['I have passed this to our team; someone will get back to you shortly.']);
    expect(transport.textsTo(ADMIN)[0]).toContain('Staff needed');
    expect((await q('SELECT status FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.phone = $1', [LEAD]))[0].status).toBe(
      'NEEDS_HUMAN',
    );
    expect(await q(`SELECT 1 FROM scheduled_messages WHERE status = 'PENDING'`)).toHaveLength(0);
    expect(llm.requests).toHaveLength(2);
  });

  it('pauses the AI when staff reply manually from the gym phone', async () => {
    const { ctx, transport } = makeContext(pool);
    const llm = new FakeLlm([() => ({ text: 'Hello!' })]);
    const handler = new MessageHandler(ctx, llm, (id) => transport.isOwnMessage(id));
    await handler.handle(inbound(LEAD, 'hi'));
    // echo of the bot's own message is ignored
    await handler.handle(inbound(LEAD, 'Hello!', { id: transport.sent[0]!.id, fromMe: true }));
    expect((await q('SELECT status FROM conversations'))[0].status).toBe('ACTIVE');
    // staff message
    await handler.handle(inbound(LEAD, 'Hi Priya, this is Coach Arjun', { fromMe: true }));
    expect((await q('SELECT status FROM conversations'))[0].status).toBe('HUMAN_ACTIVE');
    await handler.handle(inbound(LEAD, 'Great, thanks coach'));
    expect(llm.requests).toHaveLength(1);
  });

  it('ignores duplicate deliveries of the same message', async () => {
    const { ctx, transport } = makeContext(pool);
    const handler = new MessageHandler(ctx, new FakeLlm());
    const m = inbound(LEAD, 'hi');
    await handler.handle(m);
    await handler.handle(m);
    expect(transport.sent).toHaveLength(1);
  });

  it('books a trial within allowed hours only', async () => {
    const { ctx, transport } = makeContext(pool);
    const llm = new FakeLlm([
      () => ({ calls: [{ name: 'bookTrial', args: { date: '2026-10-03', time: '23:00' } }] }),
      (req) => {
        const last = req.contents[req.contents.length - 1]!.parts![0]!.functionResponse!.response as { error: string };
        expect(last.error).toContain('between 06:00 and 20:00');
        return { calls: [{ name: 'bookTrial', args: { date: '2026-10-03', time: '18:00' } }] };
      },
      () => ({ text: 'Booked!' }),
    ]);
    await new MessageHandler(ctx, llm).handle(inbound(LEAD, 'Book a trial tomorrow 6pm'));
    const [lead] = await q('SELECT stage, trial_at FROM leads');
    expect(lead.stage).toBe('TRIAL_BOOKED');
    expect(new Date(lead.trial_at).toISOString()).toBe('2026-10-03T12:30:00.000Z');
    expect(transport.textsTo(ADMIN)[0]).toContain('Trial booked');
    const kinds = await q(`SELECT kind, meta FROM scheduled_messages WHERE status = 'PENDING'`);
    expect(kinds).toEqual([{ kind: 'CUSTOM_FOLLOW_UP', meta: { type: 'trial_reminder' } }]);
  });

  it('lets the owner run admin commands through tools', async () => {
    const { ctx, transport } = makeContext(pool);
    await createMember(ctx, { name: 'Rahul Verma', phone: '919811111111', planCode: 'monthly', startDate: '2026-09-28' });
    const llm = new FakeLlm([
      (req) => {
        expect(req.systemInstruction).toContain('back-office assistant');
        expect(req.tools.map((t) => t.name)).toContain('markPaymentPaid');
        return { calls: [{ name: 'markPaymentPaid', args: { contact: 'Rahul', method: 'cash' } }] };
      },
      (req) => {
        const res = req.contents[req.contents.length - 1]!.parts![0]!.functionResponse!.response as Record<string, unknown>;
        expect(res.ok).toBe(true);
        return { text: "Marked Rahul Verma's ₹2,500 payment as paid." };
      },
    ]);
    await new MessageHandler(ctx, llm).handle(inbound(ADMIN, "Mark Rahul's payment as paid", { pushName: 'Owner' }));
    expect(transport.textsTo(ADMIN)).toEqual(["Marked Rahul Verma's ₹2,500 payment as paid."]);
    const payments = await q('SELECT status, due_date FROM payments ORDER BY due_date');
    expect(payments).toEqual([
      { status: 'PAID', due_date: '2026-09-28' },
      { status: 'PENDING', due_date: '2026-10-28' },
    ]);
    // admins never become leads
    expect(await q('SELECT 1 FROM leads')).toHaveLength(0);
  });

  it('asks for clarification when an admin name is ambiguous', async () => {
    const { ctx } = makeContext(pool);
    await createMember(ctx, { name: 'Rahul Verma', phone: '919811111111', planCode: 'monthly', startDate: '2026-09-28' });
    await createMember(ctx, { name: 'Rahul Mehta', phone: '919833333333', planCode: 'monthly', startDate: '2026-09-28' });
    let toolResult: Record<string, unknown> = {};
    const llm = new FakeLlm([
      () => ({ calls: [{ name: 'stopMessaging', args: { contact: 'Rahul' } }] }),
      (req) => {
        toolResult = req.contents[req.contents.length - 1]!.parts![0]!.functionResponse!.response as Record<string, unknown>;
        return { text: 'Which Rahul?' };
      },
    ]);
    await new MessageHandler(ctx, llm).handle(inbound(ADMIN, 'Stop messaging Rahul'));
    expect(toolResult.error).toContain('matches 2 people');
    expect(await q(`SELECT 1 FROM conversations WHERE status = 'PAUSED'`)).toHaveLength(0);
  });

  it('shows a member their own payment status only', async () => {
    const { ctx, transport } = makeContext(pool);
    await createMember(ctx, { name: 'Rahul Verma', phone: '919811111111', planCode: 'monthly', startDate: '2026-10-05' });
    let res: Record<string, unknown> = {};
    const llm = new FakeLlm([
      (req) => {
        expect(req.systemInstruction).toContain('EXISTING MEMBER');
        return { calls: [{ name: 'getOutstandingPayment', args: {} }] };
      },
      (req) => {
        res = req.contents[req.contents.length - 1]!.parts![0]!.functionResponse!.response as Record<string, unknown>;
        return { text: 'Your ₹2,500 payment is due on 5 October.' };
      },
    ]);
    await new MessageHandler(ctx, llm).handle(inbound('919811111111', 'When is my payment due?'));
    expect(res.outstanding).toMatchObject({ amount: '₹2,500', dueDate: '2026-10-05', status: 'UPCOMING' });
    expect(transport.textsTo('919811111111')).toHaveLength(1);
    // members do not get lead follow-ups
    expect(await q(`SELECT 1 FROM scheduled_messages WHERE kind = 'LEAD_FOLLOW_UP'`)).toHaveLength(0);
  });
});
