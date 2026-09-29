import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool.js';
import { dispatchDueMessages } from '../src/scheduler/dispatcher.js';
import { createMember, markPaymentPaid, planPaymentReminders } from '../src/services/payments.js';
import { makeContext, resetDb, TEST_DB } from './helpers.js';

describe.skipIf(!TEST_DB)('members, payments and reminders', () => {
  let pool: Pool;
  beforeEach(async () => {
    await pool?.end();
    pool = await resetDb();
  });
  afterAll(async () => pool?.end());

  async function setup(now: string) {
    const env = makeContext(pool, { now: new Date(now) });
    const r = await createMember(env.ctx, {
      name: 'Rahul Sharma',
      phone: '919811111111',
      planCode: 'monthly',
      startDate: '2026-09-05',
      firstDueDate: '2026-10-05',
    });
    if (!r.ok) throw new Error(r.error);
    return { ...env, member: r };
  }

  const scheduled = async () =>
    (await pool.query('SELECT kind, dedupe_key, status, body, status_reason FROM scheduled_messages ORDER BY id')).rows;

  it('creates a member with membership and first payment', async () => {
    const { member } = await setup('2026-10-01T06:00:00Z');
    expect(member.membership.monthly_fee).toBe(2500);
    expect(member.membership.expiry_date).toBe('2026-10-05');
    expect(member.firstPayment?.due_date).toBe('2026-10-05');
    expect(member.firstPayment?.amount).toBe(2500);
  });

  it('sends the 3-days-before reminder exactly once', async () => {
    const { ctx, transport } = await setup('2026-10-02T06:00:00Z'); // Oct 2, 11:30 IST
    expect(await planPaymentReminders(ctx)).toBe(1);
    expect(await planPaymentReminders(ctx)).toBe(0); // idempotent
    await dispatchDueMessages(ctx);
    await dispatchDueMessages(ctx);
    expect(transport.sent.map((s) => s.text)).toEqual([
      'Hey Rahul, just a heads-up that your gym membership payment of ₹2,500 is due on 5 October.',
    ]);
    const logs = await pool.query(`SELECT * FROM message_logs WHERE source = 'AUTOMATED'`);
    expect(logs.rowCount).toBe(1);
    expect(logs.rows[0].scheduled_message_id).not.toBeNull();
  });

  it('sends due-today and overdue reminders with distinct keys', async () => {
    const { ctx, clock, transport } = await setup('2026-10-05T06:00:00Z');
    await planPaymentReminders(ctx);
    await dispatchDueMessages(ctx);
    clock.now = new Date('2026-10-06T06:00:00Z');
    await planPaymentReminders(ctx);
    await dispatchDueMessages(ctx);
    clock.now = new Date('2026-10-07T06:00:00Z');
    expect(await planPaymentReminders(ctx)).toBe(0); // overdue:1 already sent, overdue:7 not reached
    expect((await scheduled()).map((s) => s.dedupe_key)).toEqual([expect.stringMatching(/:due$/), expect.stringMatching(/:overdue:1$/)]);
    expect(transport.sent[0]!.text).toBe('Hey Rahul, your ₹2,500 membership payment is due today.');
    expect(transport.sent[1]!.text).toContain('still pending');
  });

  it('never reminds about a payment that was marked paid', async () => {
    const { ctx, transport } = await setup('2026-10-02T06:00:00Z');
    await planPaymentReminders(ctx);
    const payment = (await pool.query(`SELECT id FROM payments WHERE status = 'PENDING'`)).rows[0];
    const res = await markPaymentPaid(ctx, { paymentId: payment.id, method: 'UPI' });
    expect(res.ok).toBe(true);
    await dispatchDueMessages(ctx);
    expect(transport.sent).toHaveLength(0);
    expect((await scheduled())[0]).toMatchObject({ status: 'CANCELLED', status_reason: 'payment_paid' });

    // next cycle created and membership extended
    if (!res.ok) throw new Error();
    expect(res.nextPayment?.due_date).toBe('2026-11-05');
    expect(res.membership?.expiry_date).toBe('2026-11-05');
  });

  it('skips a reminder if payment is paid between planning and sending', async () => {
    const { ctx, transport } = await setup('2026-10-02T06:00:00Z');
    await planPaymentReminders(ctx);
    // Paid outside the service (e.g. directly in DB) - dispatcher re-checks.
    await pool.query(`UPDATE payments SET status = 'PAID'`);
    await dispatchDueMessages(ctx);
    expect(transport.sent).toHaveLength(0);
    expect((await scheduled())[0]).toMatchObject({ status: 'SKIPPED', status_reason: 'payment_paid' });
  });

  it('requires confirmation for unusual payment amounts', async () => {
    const { ctx } = await setup('2026-10-02T06:00:00Z');
    const payment = (await pool.query(`SELECT id FROM payments WHERE status = 'PENDING'`)).rows[0];
    const r1 = await markPaymentPaid(ctx, { paymentId: payment.id, amount: 1000 });
    expect(r1).toMatchObject({ ok: false, needsConfirmation: true });
    const r2 = await markPaymentPaid(ctx, { paymentId: payment.id, amount: 1000, confirmUnusual: true });
    expect(r2.ok).toBe(true);
  });

  it('does not send during quiet hours or to opted-out members', async () => {
    const { ctx, clock, transport } = await setup('2026-10-02T17:00:00Z'); // 22:30 IST
    await planPaymentReminders(ctx);
    await dispatchDueMessages(ctx);
    expect(transport.sent).toHaveLength(0);
    await pool.query('UPDATE contacts SET opted_out = TRUE');
    clock.now = new Date('2026-10-03T04:00:00Z'); // 09:30 IST
    await dispatchDueMessages(ctx);
    expect(transport.sent).toHaveLength(0);
    expect((await scheduled())[0]).toMatchObject({ status: 'SKIPPED', status_reason: 'opted_out' });
  });
});
