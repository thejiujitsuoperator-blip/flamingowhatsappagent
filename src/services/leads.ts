import { findPlan } from '../config/gym.js';
import type { AppContext } from '../context.js';
import { type Contact, updateContactName } from '../repositories/contacts.js';
import { getConversation } from '../repositories/conversations.js';
import { type Lead, type LeadUpdate, updateLead } from '../repositories/leads.js';
import { cancelForLead, scheduleOnce, type ScheduledMessage } from '../repositories/scheduledMessages.js';
import {
  diffDays,
  formatHumanDateTime,
  isIsoDate,
  localDate,
  localTime,
  nextSendableTime,
  weekday,
  zonedToUtc,
} from '../utils/dates.js';
import { notifyAdmins } from './admins.js';

/** Stages from which the automatic follow-up sequence may run. TRIAL_BOOKED leads get a trial reminder instead. */
const FOLLOW_UP_STAGES = ['NEW', 'QUALIFIED', 'FOLLOW_UP'];

export function isQualified(lead: Pick<Lead, 'name' | 'fitness_goal' | 'preferred_plan' | 'preferred_join_date'>): boolean {
  return !!lead.name && !!lead.fitness_goal && (!!lead.preferred_plan || !!lead.preferred_join_date);
}

export function missingLeadFields(lead: Lead, contact: Contact): string[] {
  const missing: string[] = [];
  if (!lead.name) missing.push('name');
  if (!contact.phone) missing.push('phone number');
  if (!lead.fitness_goal) missing.push('fitness goal');
  if (!lead.preferred_plan) missing.push('preferred membership');
  if (!lead.preferred_join_date) missing.push('preferred joining date');
  if (lead.trial_interest === null) missing.push('trial interest');
  return missing;
}

/**
 * Applies lead fields collected by the agent and moves NEW -> QUALIFIED automatically
 * once enough information is known. Never moves a lead backwards or to CONVERTED.
 */
export async function applyLeadUpdate(ctx: AppContext, lead: Lead, contact: Contact, fields: LeadUpdate): Promise<Lead> {
  const next: LeadUpdate = { ...fields };
  if (next.preferred_plan) {
    const plan = findPlan(ctx.config, next.preferred_plan);
    if (plan) next.preferred_plan = plan.code;
  }
  const merged = { ...lead, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) } as Lead;
  if (!next.stage && (lead.stage === 'NEW' || lead.stage === 'FOLLOW_UP') && isQualified(merged)) next.stage = 'QUALIFIED';
  if (next.name && !contact.name) await updateContactName(ctx.pool, contact.id, next.name);
  const updated = await updateLead(ctx.pool, lead.id, next);
  if (updated.stage === 'CONVERTED' || updated.stage === 'LOST') await cancelForLead(ctx.pool, lead.id, `lead_${updated.stage.toLowerCase()}`);
  return updated;
}

/** When a lead in FOLLOW_UP replies they are re-engaged, so move them back to their natural stage. */
export async function reengageLead(ctx: AppContext, lead: Lead): Promise<Lead> {
  if (lead.stage !== 'FOLLOW_UP') return lead;
  return updateLead(ctx.pool, lead.id, { stage: isQualified(lead) ? 'QUALIFIED' : 'NEW' });
}

/**
 * (Re)starts the automatic follow-up sequence after the lead's latest message.
 * `anchorKey` makes each sequence unique (one per inbound message) so it can never be duplicated.
 */
export async function scheduleLeadFollowUpSequence(
  ctx: AppContext,
  lead: Lead,
  contact: Contact,
  anchorKey: string | number,
): Promise<ScheduledMessage[]> {
  const cfg = ctx.config.automation.leadFollowUps;
  if (!cfg.enabled || contact.opted_out || !FOLLOW_UP_STAGES.includes(lead.stage)) return [];
  const conversation = await getConversation(ctx.pool, contact.id);
  if (conversation && conversation.status !== 'ACTIVE') return [];

  await cancelForLead(ctx.pool, lead.id, 'rescheduled');
  const now = ctx.now();
  const created: ScheduledMessage[] = [];
  for (const [i, step] of cfg.steps.entries()) {
    const due = new Date(now.getTime() + step.afterDays * 86_400_000);
    const row = await scheduleOnce(ctx.pool, {
      contact_id: contact.id,
      kind: 'LEAD_FOLLOW_UP',
      dedupe_key: `lead:${lead.id}:auto:${anchorKey}:${i}`,
      body: step.message,
      send_at: nextSendableTime(due, ctx.config.timezone, ctx.config.automation.quietHours),
      related_lead_id: lead.id,
      meta: { step: i, final: i === cfg.steps.length - 1 },
    });
    if (row) created.push(row);
  }
  return created;
}

export async function cancelLeadFollowUps(ctx: AppContext, lead: Lead, reason: string): Promise<number> {
  return cancelForLead(ctx.pool, lead.id, reason);
}

/** A follow-up the customer explicitly asked for ("message me next week"). One per day at most. */
export async function scheduleCustomFollowUp(
  ctx: AppContext,
  lead: Lead,
  contact: Contact,
  date: string,
  message: string,
  reason: string,
): Promise<{ ok: true; sendAt: Date } | { ok: false; error: string }> {
  if (contact.opted_out) return { ok: false, error: 'Contact has opted out of messages.' };
  if (!isIsoDate(date)) return { ok: false, error: 'date must be YYYY-MM-DD' };
  const today = localDate(ctx.config.timezone, ctx.now());
  const days = diffDays(date, today);
  if (days < 1 || days > 90) return { ok: false, error: 'Follow-up date must be between tomorrow and 90 days from today.' };
  const sendAt = nextSendableTime(
    zonedToUtc(date, `${String(ctx.config.automation.quietHours.end).padStart(2, '0')}:30`, ctx.config.timezone),
    ctx.config.timezone,
    ctx.config.automation.quietHours,
  );
  const row = await scheduleOnce(ctx.pool, {
    contact_id: contact.id,
    kind: 'CUSTOM_FOLLOW_UP',
    dedupe_key: `lead:${lead.id}:custom:${date}`,
    body: message.slice(0, 600),
    send_at: sendAt,
    related_lead_id: lead.id,
    meta: { reason },
  });
  if (!row) return { ok: false, error: `A follow-up is already scheduled for ${date}.` };
  return { ok: true, sendAt };
}

export type TrialBookingResult =
  | { ok: true; lead: Lead; trialAt: Date; formatted: string }
  | { ok: false; error: string };

/** Validates the requested slot against the gym's trial rules and books it. */
export async function bookTrial(
  ctx: AppContext,
  lead: Lead,
  contact: Contact,
  date: string,
  time: string,
): Promise<TrialBookingResult> {
  const trial = ctx.config.trial;
  if (!trial.available) return { ok: false, error: 'Trial sessions are not offered by this gym.' };
  if (!isIsoDate(date)) return { ok: false, error: 'date must be YYYY-MM-DD' };
  if (!/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: 'time must be HH:MM (24h)' };
  const tz = ctx.config.timezone;
  const today = localDate(tz, ctx.now());
  if (diffDays(date, today) < 0) return { ok: false, error: 'That date is in the past.' };
  if (diffDays(date, today) > 60) return { ok: false, error: 'Trials can only be booked up to 60 days ahead.' };
  if (trial.closedWeekdays.includes(weekday(date))) return { ok: false, error: 'Trials are not available on that day of the week.' };
  if (time < trial.earliestTime || time > trial.latestTime) {
    return { ok: false, error: `Trials can only be booked between ${trial.earliestTime} and ${trial.latestTime}.` };
  }
  if (date === today && time <= localTime(tz, ctx.now())) return { ok: false, error: 'That time has already passed today.' };

  const trialAt = zonedToUtc(date, time, tz);
  const updated = await updateLead(ctx.pool, lead.id, { trial_at: trialAt, trial_interest: true, stage: 'TRIAL_BOOKED' });
  await cancelForLead(ctx.pool, lead.id, 'trial_booked');
  const formatted = formatHumanDateTime(trialAt, tz, ctx.config.currency.locale);

  // Reminder ~3h before the trial (only if that falls outside quiet hours and in the future).
  const reminderAt = new Date(trialAt.getTime() - 3 * 3_600_000);
  const sendAt = nextSendableTime(reminderAt > ctx.now() ? reminderAt : ctx.now(), tz, ctx.config.automation.quietHours);
  if (sendAt < trialAt && trialAt.getTime() - ctx.now().getTime() > 2 * 3_600_000) {
    await scheduleOnce(ctx.pool, {
      contact_id: contact.id,
      kind: 'CUSTOM_FOLLOW_UP',
      dedupe_key: `lead:${lead.id}:trial:${trialAt.toISOString()}`,
      body: `Hi {name}, a quick reminder about your trial session at {gymName} on ${formatted}. See you there!`,
      send_at: sendAt,
      related_lead_id: lead.id,
      meta: { type: 'trial_reminder' },
    });
  }

  await notifyAdmins(
    ctx,
    `📅 Trial booked: ${updated.name ?? contact.name ?? 'Unknown'}${contact.phone ? ` (+${contact.phone})` : ''} on ${formatted}` +
      (updated.fitness_goal ? `\nGoal: ${updated.fitness_goal}` : ''),
  );
  return { ok: true, lead: updated, trialAt, formatted };
}

/** Leads that never replied after the final follow-up are marked LOST. */
export async function markUnresponsiveLeadsLost(ctx: AppContext): Promise<number[]> {
  const { rows } = await ctx.pool.query<{ id: number }>(
    `UPDATE leads l SET stage = 'LOST', lost_reason = 'No response to follow-ups', updated_at = NOW()
       FROM scheduled_messages s JOIN contacts c ON c.id = s.contact_id
      WHERE s.related_lead_id = l.id
        AND s.kind = 'LEAD_FOLLOW_UP' AND s.status = 'SENT' AND (s.meta->>'final')::boolean
        AND s.sent_at < $1::timestamptz - make_interval(days => $2::int)
        AND (c.last_inbound_at IS NULL OR c.last_inbound_at < s.sent_at)
        AND l.stage = ANY($3)
      RETURNING l.id`,
    [ctx.now(), ctx.config.automation.leadFollowUps.markLostAfterDays, FOLLOW_UP_STAGES],
  );
  return rows.map((r) => r.id);
}
