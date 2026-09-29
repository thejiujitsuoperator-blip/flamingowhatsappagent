import { z } from 'zod';
import { findPlan } from '../../config/gym.js';
import { createLead as createLeadRow, getLeadByContact, type Lead } from '../../repositories/leads.js';
import {
  getActiveMembership,
  getMemberByContact,
  getOutstandingPayment as getOutstandingPaymentRow,
  listPendingPayments,
  listRecentPayments,
} from '../../repositories/members.js';
import { handoffToHuman, HANDOFF_REASONS } from '../../services/conversationControl.js';
import {
  applyLeadUpdate,
  bookTrial as bookTrialService,
  cancelLeadFollowUps,
  missingLeadFields,
  scheduleCustomFollowUp,
} from '../../services/leads.js';
import { normalizePhone } from '../../utils/phone.js';
import { GYM_INFO_TOPICS, gymInformation, leadView, memberView, paymentView, plansView } from './shared.js';
import { type AgentTool, defineTool, isoDate, type ToolContext } from './types.js';

/**
 * Tools available when talking to leads and members.
 * They NEVER take a phone/contact argument: they always act on the person in this chat,
 * so a customer can't read or change anyone else's data.
 */

async function currentLead(tc: ToolContext): Promise<Lead> {
  return (await getLeadByContact(tc.app.pool, tc.contact.id)) ?? createLeadRow(tc.app.pool, tc.contact.id, { name: null });
}

const getGymInformation = defineTool({
  name: 'getGymInformation',
  description:
    'Returns official gym information (location, timings, facilities, plans & prices, personal training, trial, policies, FAQs). ' +
    'This is the ONLY source of truth for gym facts.',
  schema: z.object({ topic: z.enum(GYM_INFO_TOPICS).optional().describe('Section to return; defaults to all') }),
  handler: async ({ topic }, tc) => gymInformation(tc.app.config, topic),
});

const getMembershipPlans = defineTool({
  name: 'getMembershipPlans',
  description: 'Lists membership plans with their exact prices.',
  schema: z.object({}),
  handler: async (_args, tc) => ({ plans: plansView(tc.app.config) }),
});

const getLead = defineTool({
  name: 'getLead',
  description: "Returns this person's lead record (what we already know) and which details are still missing.",
  schema: z.object({}),
  handler: async (_args, tc) => {
    const lead = await getLeadByContact(tc.app.pool, tc.contact.id);
    if (!lead) return { lead: null };
    return { lead: leadView(lead, tc.app.config), missing: missingLeadFields(lead, tc.contact) };
  },
});

const createLead = defineTool({
  name: 'createLead',
  description: 'Creates the lead record for this person if it does not exist yet (idempotent).',
  schema: z.object({ name: z.string().min(1).max(80).optional() }),
  handler: async ({ name }, tc) => {
    const lead = await createLeadRow(tc.app.pool, tc.contact.id, { name: name ?? null });
    return { lead: leadView(lead, tc.app.config) };
  },
});

const updateLead = defineTool({
  name: 'updateLead',
  description:
    'Saves details the person has told you. Call it as soon as you learn any of these. ' +
    'Only include fields the person actually stated. The stage becomes QUALIFIED automatically once enough is known.',
  schema: z.object({
    name: z.string().min(1).max(80).optional(),
    phone: z.string().optional().describe('Only if the person gives a phone number different from this chat'),
    fitnessGoal: z.string().max(200).optional().describe('e.g. weight loss, muscle gain, general fitness'),
    preferredPlan: z.string().optional().describe('Plan code or name from getMembershipPlans'),
    preferredJoinDate: isoDate().optional(),
    trialInterest: z.boolean().optional(),
    notInterested: z.boolean().optional().describe('true only if the person clearly says they are not interested'),
    notes: z.string().max(500).optional(),
  }),
  handler: async (args, tc) => {
    if (await getMemberByContact(tc.app.pool, tc.contact.id)) return { error: 'This person is already a member.' };
    const lead = await currentLead(tc);
    if (lead.stage === 'CONVERTED') return { error: 'This person is already a member.' };
    if (args.preferredPlan && !findPlan(tc.app.config, args.preferredPlan)) {
      return { error: `Unknown plan. Valid plans: ${tc.app.config.plans.map((p) => p.name).join(', ')}` };
    }
    if (args.phone) {
      const phone = normalizePhone(args.phone);
      if (!phone) return { error: 'That does not look like a valid phone number.' };
      if (!tc.contact.phone) {
        const { rowCount } = await tc.app.pool.query(
          `UPDATE contacts SET phone = $2, updated_at = NOW()
            WHERE id = $1 AND phone IS NULL AND NOT EXISTS (SELECT 1 FROM contacts WHERE phone = $2)`,
          [tc.contact.id, phone],
        );
        if (rowCount) tc.contact.phone = phone;
        else args.notes = [args.notes, `Alternate phone given: +${phone}`].filter(Boolean).join('\n');
      } else if (phone !== tc.contact.phone) {
        args.notes = [args.notes, `Alternate phone given: +${phone}`].filter(Boolean).join('\n');
      }
    }
    const updated = await applyLeadUpdate(tc.app, lead, tc.contact, {
      name: args.name,
      fitness_goal: args.fitnessGoal,
      preferred_plan: args.preferredPlan,
      preferred_join_date: args.preferredJoinDate,
      trial_interest: args.trialInterest,
      notes: args.notes ? [lead.notes, args.notes].filter(Boolean).join('\n') : undefined,
      ...(args.notInterested ? { stage: 'LOST' as const, lost_reason: 'Not interested' } : {}),
    });
    return { ok: true, lead: leadView(updated, tc.app.config), missing: missingLeadFields(updated, tc.contact) };
  },
});

const bookTrial = defineTool({
  name: 'bookTrial',
  description:
    'Books a trial session once the person has agreed on a specific date and time. Confirm the slot with them before booking.',
  schema: z.object({
    date: isoDate().describe('Trial date, YYYY-MM-DD'),
    time: z.string().regex(/^\d{2}:\d{2}$/).describe('Local 24h time, HH:MM'),
  }),
  handler: async ({ date, time }, tc) => {
    const lead = await currentLead(tc);
    if (lead.stage === 'CONVERTED') return { error: 'This person is already a member.' };
    const result = await bookTrialService(tc.app, lead, tc.contact, date, time);
    return result.ok ? { ok: true, trialAt: result.formatted, stage: result.lead.stage } : { ok: false, error: result.error };
  },
});

const scheduleFollowUp = defineTool({
  name: 'scheduleFollowUp',
  description:
    'Schedules a follow-up message when the person explicitly asks to be contacted later (e.g. "message me next week").',
  schema: z.object({
    date: isoDate().describe('Local date to send the follow-up'),
    message: z.string().min(5).max(500).describe('Friendly message to send. Must not contain prices or offers.'),
    reason: z.string().max(200),
  }),
  handler: async ({ date, message, reason }, tc) => {
    const lead = await currentLead(tc);
    const r = await scheduleCustomFollowUp(tc.app, lead, tc.contact, date, message, reason);
    return r.ok ? { ok: true, scheduledFor: date } : r;
  },
});

const cancelFollowUps = defineTool({
  name: 'cancelFollowUps',
  description: 'Cancels all pending follow-up messages to this person (e.g. they asked not to be followed up).',
  schema: z.object({ reason: z.string().max(200) }),
  handler: async ({ reason }, tc) => {
    const lead = await getLeadByContact(tc.app.pool, tc.contact.id);
    return { cancelled: lead ? await cancelLeadFollowUps(tc.app, lead, reason) : 0 };
  },
});

const getMember = defineTool({
  name: 'getMember',
  description: "Returns this person's own membership details (plan, start/expiry date, fee, next payment).",
  schema: z.object({}),
  handler: async (_args, tc) => {
    const member = await getMemberByContact(tc.app.pool, tc.contact.id);
    if (!member) return { member: null, note: 'This person is not a registered member.' };
    const membership = await getActiveMembership(tc.app.pool, member.id);
    const outstanding = await getOutstandingPaymentRow(tc.app.pool, member.id);
    return { member: memberView(member, membership, outstanding, tc.app.config, tc.app.now()) };
  },
});

const getPaymentStatus = defineTool({
  name: 'getPaymentStatus',
  description: "Returns this person's pending and recent payments.",
  schema: z.object({}),
  handler: async (_args, tc) => {
    const member = await getMemberByContact(tc.app.pool, tc.contact.id);
    if (!member) return { member: null, note: 'This person is not a registered member.' };
    const now = tc.app.now();
    return {
      pending: (await listPendingPayments(tc.app.pool, member.id)).map((p) => paymentView(p, tc.app.config, now)),
      recent: (await listRecentPayments(tc.app.pool, member.id)).map((p) => paymentView(p, tc.app.config, now)),
    };
  },
});

const getOutstandingPayment = defineTool({
  name: 'getOutstandingPayment',
  description: "Returns this person's oldest unpaid payment (amount and due date), if any.",
  schema: z.object({}),
  handler: async (_args, tc) => {
    const member = await getMemberByContact(tc.app.pool, tc.contact.id);
    if (!member) return { member: null, note: 'This person is not a registered member.' };
    const p = await getOutstandingPaymentRow(tc.app.pool, member.id);
    return { outstanding: p ? paymentView(p, tc.app.config, tc.app.now()) : null };
  },
});

const handoff = defineTool({
  name: 'handoffToHuman',
  description:
    'Hands the conversation to gym staff and stops AI replies. Use for complaints, refunds, discounts/negotiation, ' +
    '"I already paid" claims, any unusual financial request, questions not answered by gym information, ' +
    'or when the person asks for a human.',
  schema: z.object({
    reason: z.enum(HANDOFF_REASONS),
    summary: z.string().min(5).max(500).describe('One or two sentences so staff understand the situation'),
  }),
  handler: async ({ reason, summary }, tc) => {
    await handoffToHuman(tc.app, tc.contact, reason, summary);
    tc.state.handedOff = true;
    return {
      ok: true,
      instruction: 'Tell the person a team member will get back to them shortly. Do not promise anything else.',
    };
  },
});

export const customerTools: AgentTool[] = [
  getGymInformation,
  getMembershipPlans,
  getLead,
  createLead,
  updateLead,
  bookTrial,
  scheduleFollowUp,
  cancelFollowUps,
  getMember,
  getPaymentStatus,
  getOutstandingPayment,
  handoff,
];
