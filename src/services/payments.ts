import { findPlan } from '../config/gym.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db/pool.js';
import { type Contact, getOrCreateContactByPhone, updateContactName } from '../repositories/contacts.js';
import { getLeadByContact, updateLead } from '../repositories/leads.js';
import {
  cancelPendingPaymentsForMembership,
  getActiveMembership,
  getMemberByContact,
  getPaymentById,
  insertMember,
  insertMembership,
  insertPayment,
  listPendingPaymentsDueBetween,
  type Member,
  type Membership,
  type Payment,
  setPaymentStatus,
  updateMemberRow,
  updateMembershipRow,
} from '../repositories/members.js';
import { cancelForLead, cancelForPayments, type ScheduledKind, scheduleOnce } from '../repositories/scheduledMessages.js';
import { addDays, addMonths, diffDays, formatHumanDate, isIsoDate, localDate, nextSendableTime } from '../utils/dates.js';
import { firstName, formatMoney, renderTemplate } from '../utils/format.js';

export interface CreateMemberInput {
  name: string;
  phone: string;
  planCode: string;
  startDate: string;
  /** Overrides the plan's standard fee (per month). */
  monthlyFee?: number;
  /** Defaults to the start date. */
  firstDueDate?: string;
  notes?: string;
}

export type CreateMemberResult =
  | { ok: true; contact: Contact; member: Member; membership: Membership; firstPayment: Payment | null }
  | { ok: false; error: string };

/** Creates contact + member + membership + first payment atomically; converts any existing lead. */
export async function createMember(ctx: AppContext, input: CreateMemberInput): Promise<CreateMemberResult> {
  const plan = findPlan(ctx.config, input.planCode);
  if (!plan) {
    return { ok: false, error: `Unknown plan "${input.planCode}". Valid plans: ${ctx.config.plans.map((p) => p.code).join(', ')}` };
  }
  if (!isIsoDate(input.startDate)) return { ok: false, error: 'startDate must be YYYY-MM-DD' };
  const firstDue = input.firstDueDate ?? input.startDate;
  if (!isIsoDate(firstDue)) return { ok: false, error: 'firstDueDate must be YYYY-MM-DD' };
  const monthlyFee = input.monthlyFee ?? round2(plan.price / plan.durationMonths);
  if (!(monthlyFee >= 0)) return { ok: false, error: 'monthlyFee must be a positive number' };

  return withTransaction(ctx.pool, async (db) => {
    const contact = await getOrCreateContactByPhone(db, input.phone, input.name);
    if (!contact.name) await updateContactName(db, contact.id, input.name);
    if (await getMemberByContact(db, contact.id)) {
      return { ok: false as const, error: 'This phone number is already registered as a member. Use updateMember instead.' };
    }
    const member = await insertMember(db, contact.id, input.name, input.notes);
    const membership = await insertMembership(db, {
      member_id: member.id,
      plan_code: plan.code,
      plan_name: plan.name,
      start_date: input.startDate,
      expiry_date: addMonths(input.startDate, plan.durationMonths),
      monthly_fee: monthlyFee,
      billing_cycle_months: plan.durationMonths,
      auto_renew: true,
    });
    const firstPayment = await insertPayment(db, {
      member_id: member.id,
      membership_id: membership.id,
      amount: cycleAmount(membership),
      due_date: firstDue,
    });
    const lead = await getLeadByContact(db, contact.id);
    if (lead && lead.stage !== 'CONVERTED') {
      await updateLead(db, lead.id, { stage: 'CONVERTED' });
      await cancelForLead(db, lead.id, 'lead_converted');
    }
    return { ok: true as const, contact: { ...contact, name: contact.name ?? input.name }, member, membership, firstPayment };
  });
}

export function cycleAmount(m: Pick<Membership, 'monthly_fee' | 'billing_cycle_months'>): number {
  return round2(m.monthly_fee * m.billing_cycle_months);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export type MarkPaidResult =
  | { ok: true; payment: Payment; nextPayment: Payment | null; membership: Membership | null }
  | { ok: false; error: string; needsConfirmation?: boolean };

/**
 * Marks a payment as paid, cancels its pending reminders, extends the membership and
 * creates the next cycle's payment. Unusual amounts require explicit confirmation.
 */
export async function markPaymentPaid(
  ctx: AppContext,
  input: { paymentId: number; amount?: number; method?: string; notes?: string; confirmUnusual?: boolean },
): Promise<MarkPaidResult> {
  return withTransaction(ctx.pool, async (db) => {
    const payment = await getPaymentById(db, input.paymentId, true);
    if (!payment) return { ok: false as const, error: 'Payment not found.' };
    if (payment.status !== 'PENDING') return { ok: false as const, error: `Payment is already ${payment.status}.` };

    const amount = input.amount ?? payment.amount;
    if (amount !== payment.amount && !input.confirmUnusual) {
      return {
        ok: false as const,
        needsConfirmation: true,
        error:
          `Amount ${formatMoney(amount, ctx.config)} differs from the amount due ${formatMoney(payment.amount, ctx.config)}. ` +
          'Ask the owner to confirm explicitly, then call again with confirmUnusual=true.',
      };
    }

    const paid = await setPaymentStatus(db, payment.id, {
      status: 'PAID',
      paid_amount: amount,
      method: input.method ?? null,
      notes: input.notes ?? null,
    });
    await cancelForPayments(db, [payment.id], 'payment_paid');

    const { rows } = await db.query<Membership>('SELECT * FROM memberships WHERE id = $1 FOR UPDATE', [payment.membership_id]);
    const membership = rows[0] ?? null;
    let nextPayment: Payment | null = null;
    let updatedMembership = membership;
    if (membership && membership.status === 'ACTIVE') {
      const periodEnd = addMonths(payment.due_date, membership.billing_cycle_months);
      if (periodEnd > membership.expiry_date) {
        updatedMembership = await updateMembershipRow(db, membership.id, { expiry_date: periodEnd });
      }
      if (membership.auto_renew) {
        nextPayment = await insertPayment(db, {
          member_id: payment.member_id,
          membership_id: membership.id,
          amount: cycleAmount(membership),
          due_date: periodEnd,
        });
      }
    }
    return { ok: true as const, payment: paid, nextPayment, membership: updatedMembership };
  });
}

export interface UpdateMemberInput {
  name?: string;
  status?: Member['status'];
  notes?: string;
  monthlyFee?: number;
  autoRenew?: boolean;
  expiryDate?: string;
}

export async function updateMember(ctx: AppContext, member: Member, input: UpdateMemberInput) {
  if (input.expiryDate && !isIsoDate(input.expiryDate)) return { ok: false as const, error: 'expiryDate must be YYYY-MM-DD' };
  return withTransaction(ctx.pool, async (db) => {
    const updated = await updateMemberRow(db, member.id, { name: input.name, status: input.status, notes: input.notes });
    let membership = await getActiveMembership(db, member.id);
    if (membership && (input.monthlyFee !== undefined || input.autoRenew !== undefined || input.expiryDate)) {
      membership = await updateMembershipRow(db, membership.id, {
        monthly_fee: input.monthlyFee,
        auto_renew: input.autoRenew,
        expiry_date: input.expiryDate,
      });
      if (input.monthlyFee !== undefined) {
        // Pending (future) payments follow the new fee.
        await db.query(`UPDATE payments SET amount = $2, updated_at = NOW() WHERE membership_id = $1 AND status = 'PENDING'`, [
          membership.id,
          cycleAmount(membership),
        ]);
      }
    }
    if (input.status === 'CANCELLED' && membership) {
      await updateMembershipRow(db, membership.id, { status: 'CANCELLED' });
      const cancelled = await cancelPendingPaymentsForMembership(db, membership.id);
      await cancelForPayments(db, cancelled, 'membership_cancelled');
    }
    return { ok: true as const, member: updated, membership };
  });
}

/**
 * Daily job: creates (at most once per payment + stage) the payment reminders that are due today.
 * Uses dedupe keys so re-running the job never produces duplicates.
 */
export async function planPaymentReminders(ctx: AppContext): Promise<number> {
  const cfg = ctx.config.automation.paymentReminders;
  const tz = ctx.config.timezone;
  const now = ctx.now();
  const today = localDate(tz, now);
  const sendAt = nextSendableTime(now, tz, ctx.config.automation.quietHours);
  const payments = await listPendingPaymentsDueBetween(ctx.pool, addDays(today, -90), addDays(today, cfg.daysBefore));

  let scheduled = 0;
  for (const p of payments) {
    if (p.opted_out) continue;
    const daysUntilDue = diffDays(p.due_date, today);
    let kind: ScheduledKind;
    let key: string;
    let template: string;
    if (daysUntilDue > 0) {
      kind = 'PAYMENT_REMINDER_BEFORE';
      key = `payment:${p.id}:before`;
      template = cfg.templates.before;
    } else if (daysUntilDue === 0) {
      kind = 'PAYMENT_REMINDER_DUE';
      key = `payment:${p.id}:due`;
      template = cfg.templates.due;
    } else {
      const threshold = Math.max(0, ...cfg.overdueDays.filter((d) => -daysUntilDue >= d));
      if (!threshold) continue;
      kind = 'PAYMENT_REMINDER_OVERDUE';
      key = `payment:${p.id}:overdue:${threshold}`;
      template = cfg.templates.overdue;
    }
    const body = renderTemplate(template, {
      name: firstName(p.member_name),
      amount: formatMoney(p.amount, ctx.config),
      dueDate: formatHumanDate(p.due_date, ctx.config.currency.locale),
      plan: p.plan_name,
      gymName: ctx.config.gym.name,
    });
    const row = await scheduleOnce(ctx.pool, {
      contact_id: p.contact_id,
      kind,
      dedupe_key: key,
      body,
      send_at: sendAt,
      related_payment_id: p.id,
      meta: { dueDate: p.due_date, amount: p.amount },
    });
    if (row) scheduled++;
  }
  ctx.logger.info({ scheduled, candidates: payments.length }, 'Planned payment reminders');
  return scheduled;
}
