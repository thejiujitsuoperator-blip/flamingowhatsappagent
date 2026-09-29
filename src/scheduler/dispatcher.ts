import type { AppContext } from '../context.js';
import { getContactById } from '../repositories/contacts.js';
import { getConversation } from '../repositories/conversations.js';
import { getLeadById, updateLead } from '../repositories/leads.js';
import { countAutomatedSince } from '../repositories/messageLogs.js';
import { getPaymentWithMember } from '../repositories/members.js';
import {
  claimDueMessages,
  deferMessage,
  markAttemptFailed,
  markSent,
  markSkipped,
  PAYMENT_KINDS,
  releaseStaleSending,
  type ScheduledMessage,
} from '../repositories/scheduledMessages.js';
import { addDays, isWithinQuietHours, localDate, localHour, nextSendableTime, zonedToUtc } from '../utils/dates.js';
import { firstName, renderTemplate } from '../utils/format.js';

export interface DispatchSummary {
  sent: number;
  skipped: number;
  deferred: number;
  failed: number;
}

type Decision = { action: 'send'; body: string } | { action: 'skip'; reason: string } | { action: 'defer'; until: Date; reason: string };

/**
 * Re-validates a scheduled message right before sending. State may have changed since it was
 * scheduled (payment made, lead replied, opt-out, handoff...), so the database is checked again.
 */
async function decide(ctx: AppContext, msg: ScheduledMessage): Promise<Decision> {
  const contact = await getContactById(ctx.pool, msg.contact_id);
  if (!contact) return { action: 'skip', reason: 'contact_missing' };
  if (contact.opted_out) return { action: 'skip', reason: 'opted_out' };

  const conversation = await getConversation(ctx.pool, contact.id);
  if (conversation && conversation.status !== 'ACTIVE') {
    return { action: 'skip', reason: `conversation_${conversation.status.toLowerCase()}` };
  }

  let name = contact.name;
  if (PAYMENT_KINDS.includes(msg.kind)) {
    const payment = msg.related_payment_id ? await getPaymentWithMember(ctx.pool, msg.related_payment_id) : null;
    if (!payment) return { action: 'skip', reason: 'payment_missing' };
    if (payment.status !== 'PENDING') return { action: 'skip', reason: `payment_${payment.status.toLowerCase()}` };
    if (payment.member_status !== 'ACTIVE') return { action: 'skip', reason: 'member_not_active' };
    name = payment.member_name;
  } else if (msg.related_lead_id) {
    const lead = await getLeadById(ctx.pool, msg.related_lead_id);
    if (!lead) return { action: 'skip', reason: 'lead_missing' };
    if (lead.stage === 'CONVERTED' || lead.stage === 'LOST') return { action: 'skip', reason: `lead_${lead.stage.toLowerCase()}` };
    const isTrialReminder = msg.meta?.type === 'trial_reminder';
    if (msg.kind === 'LEAD_FOLLOW_UP') {
      if (lead.stage === 'TRIAL_BOOKED') return { action: 'skip', reason: 'trial_booked' };
      if (contact.last_inbound_at && contact.last_inbound_at > msg.created_at) return { action: 'skip', reason: 'lead_replied' };
    }
    if (isTrialReminder && lead.stage !== 'TRIAL_BOOKED') return { action: 'skip', reason: 'trial_no_longer_booked' };
    name = lead.name ?? contact.name;
  }

  const tz = ctx.config.timezone;
  const now = ctx.now();
  const startOfDay = zonedToUtc(localDate(tz, now), '00:00', tz);
  const sentToday = await countAutomatedSince(ctx.pool, contact.id, startOfDay);
  if (sentToday >= ctx.config.automation.maxAutomatedPerContactPerDay) {
    const tomorrow = zonedToUtc(addDays(localDate(tz, now), 1), '00:00', tz);
    return {
      action: 'defer',
      until: nextSendableTime(tomorrow, tz, ctx.config.automation.quietHours),
      reason: 'daily_contact_cap',
    };
  }

  return { action: 'send', body: renderTemplate(msg.body, { name: firstName(name), gymName: ctx.config.gym.name }) };
}

/** Sends all due scheduled messages. Runs every minute. */
export async function dispatchDueMessages(ctx: AppContext): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
  if (!ctx.outbox.isConnected()) return summary;
  const now = ctx.now();
  if (isWithinQuietHours(localHour(ctx.config.timezone, now), ctx.config.automation.quietHours)) return summary;

  await releaseStaleSending(ctx.pool);
  const due = await claimDueMessages(ctx.pool, now);
  for (const msg of due) {
    try {
      const decision = await decide(ctx, msg);
      if (decision.action === 'skip') {
        await markSkipped(ctx.pool, msg.id, decision.reason);
        summary.skipped++;
        continue;
      }
      if (decision.action === 'defer') {
        await deferMessage(ctx.pool, msg.id, decision.until, decision.reason);
        summary.deferred++;
        continue;
      }
      const contact = (await getContactById(ctx.pool, msg.contact_id))!;
      const result = await ctx.outbox.send({
        contact,
        text: decision.body,
        source: 'AUTOMATED',
        scheduledMessageId: msg.id,
      });
      if (!result.ok) {
        await markAttemptFailed(ctx.pool, msg, result.error ?? 'send failed');
        summary.failed++;
        continue;
      }
      await markSent(ctx.pool, msg.id);
      summary.sent++;
      if (msg.kind === 'LEAD_FOLLOW_UP' && msg.related_lead_id) {
        const lead = await getLeadById(ctx.pool, msg.related_lead_id);
        if (lead && (lead.stage === 'NEW' || lead.stage === 'QUALIFIED')) {
          await updateLead(ctx.pool, lead.id, { stage: 'FOLLOW_UP' });
        }
      }
    } catch (err) {
      ctx.logger.error({ err, scheduledMessageId: msg.id }, 'Error dispatching scheduled message');
      await markAttemptFailed(ctx.pool, msg, (err as Error).message).catch(() => undefined);
      summary.failed++;
    }
  }
  if (due.length) ctx.logger.info(summary, 'Dispatched scheduled messages');
  return summary;
}
