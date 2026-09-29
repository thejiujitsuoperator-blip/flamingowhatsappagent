import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { type Contact, searchContacts } from '../../repositories/contacts.js';
import { getConversation, listConversationsByStatus } from '../../repositories/conversations.js';
import {
  getLeadByContact,
  LEAD_STAGES,
  leadStats,
  listLeads as listLeadsRows,
  updateLead as updateLeadRow,
} from '../../repositories/leads.js';
import {
  getActiveMembership,
  getMemberByContact,
  getOutstandingPayment,
  listOverduePayments,
  listPendingPayments,
  listPendingPaymentsDueBetween,
  listRecentPayments,
  paymentStats,
} from '../../repositories/members.js';
import { cancelForLead, listPendingForContact } from '../../repositories/scheduledMessages.js';
import { pauseContact, resumeContact } from '../../services/conversationControl.js';
import { createMember as createMemberService, markPaymentPaid as markPaidService, updateMember as updateMemberService } from '../../services/payments.js';
import { addDays, diffDays, formatHumanDate, localDate, zonedToUtc } from '../../utils/dates.js';
import { formatMoney } from '../../utils/format.js';
import { normalizePhone } from '../../utils/phone.js';
import { GYM_INFO_TOPICS, gymInformation, leadView, memberView, paymentView, plansView } from './shared.js';
import { type AgentTool, defineTool, isoDate } from './types.js';

/**
 * Tools for the gym owner/staff (numbers listed in ADMIN_PHONES).
 * People are referenced by name or phone; ambiguous names return candidates so the
 * model asks the owner which one they meant instead of guessing.
 */

type Resolved = { contact: Contact } | { error: string; candidates?: unknown[] };

async function resolveContact(app: AppContext, ref: string): Promise<Resolved> {
  const phone = /\d{6,}/.test(ref.replace(/\D/g, '')) ? normalizePhone(ref) : null;
  const matches = await searchContacts(app.pool, phone ?? ref);
  const people = matches.filter((c) => !c.is_admin);
  if (!people.length) return { error: `No contact found matching "${ref}".` };
  if (people.length === 1) return { contact: people[0]! };
  const exact = people.filter((c) => (c.name ?? '').toLowerCase() === ref.trim().toLowerCase());
  if (exact.length === 1) return { contact: exact[0]! };
  return {
    error: `"${ref}" matches ${people.length} people. Ask the owner which one they mean (use the phone number).`,
    candidates: people.map((c) => ({ name: c.name, phone: c.phone ? `+${c.phone}` : null })),
  };
}

const contactRef = () => z.string().min(1).describe("Person's name or phone number");

function dayRange(app: AppContext, from: string, to: string) {
  const tz = app.config.timezone;
  return { from: zonedToUtc(from, '00:00', tz), to: zonedToUtc(addDays(to, 1), '00:00', tz) };
}

const tools: AgentTool[] = [
  defineTool({
    name: 'getGymInformation',
    description: 'Returns the gym knowledge/config (plans, timings, policies...).',
    schema: z.object({ topic: z.enum(GYM_INFO_TOPICS).optional() }),
    handler: async ({ topic }, tc) => gymInformation(tc.app.config, topic),
  }),
  defineTool({
    name: 'getMembershipPlans',
    description: 'Lists membership plans (code, name, price).',
    schema: z.object({}),
    handler: async (_a, tc) => ({ plans: plansView(tc.app.config) }),
  }),
  defineTool({
    name: 'listLeads',
    description: 'Lists leads, optionally filtered by stage and by creation date range (inclusive, local dates).',
    schema: z.object({
      stage: z.enum(LEAD_STAGES).optional(),
      fromDate: isoDate().optional(),
      toDate: isoDate().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    handler: async ({ stage, fromDate, toDate, limit }, tc) => {
      const today = localDate(tc.app.config.timezone, tc.app.now());
      const range = fromDate || toDate ? dayRange(tc.app, fromDate ?? '2000-01-01', toDate ?? today) : undefined;
      const rows = await listLeadsRows(tc.app.pool, { stage, createdFrom: range?.from, createdTo: range?.to, limit });
      return {
        count: rows.length,
        leads: rows.map((l) => ({
          ...leadView(l, tc.app.config),
          name: l.name ?? l.contact_name,
          phone: l.phone ? `+${l.phone}` : null,
          optedOut: l.opted_out,
        })),
      };
    },
  }),
  defineTool({
    name: 'getLeadStats',
    description: 'Counts leads created / converted / lost / trials booked in a date range, plus current totals by stage.',
    schema: z.object({ fromDate: isoDate(), toDate: isoDate() }),
    handler: async ({ fromDate, toDate }, tc) => {
      const r = dayRange(tc.app, fromDate, toDate);
      const stats = await leadStats(tc.app.pool, r.from, r.to);
      const payments = await paymentStats(tc.app.pool, r.from, r.to);
      return {
        fromDate,
        toDate,
        ...stats,
        paymentsCollected: formatMoney(payments.collected, tc.app.config),
        paymentsCount: payments.payments,
      };
    },
  }),
  defineTool({
    name: 'findContact',
    description: 'Searches people by name or phone and shows whether each is a lead or member.',
    schema: z.object({ query: z.string().min(1) }),
    handler: async ({ query }, tc) => {
      const phone = normalizePhone(query);
      const rows = (await searchContacts(tc.app.pool, phone ?? query)).filter((c) => !c.is_admin);
      const out = [];
      for (const c of rows) {
        const lead = await getLeadByContact(tc.app.pool, c.id);
        const member = await getMemberByContact(tc.app.pool, c.id);
        const conv = await getConversation(tc.app.pool, c.id);
        out.push({
          name: member?.name ?? lead?.name ?? c.name,
          phone: c.phone ? `+${c.phone}` : null,
          isMember: !!member,
          leadStage: lead?.stage ?? null,
          optedOut: c.opted_out,
          conversationStatus: conv?.status ?? 'ACTIVE',
        });
      }
      return { results: out };
    },
  }),
  defineTool({
    name: 'getLead',
    description: "Returns a person's lead record.",
    schema: z.object({ contact: contactRef() }),
    handler: async ({ contact }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const lead = await getLeadByContact(tc.app.pool, r.contact.id);
      return lead ? { lead: leadView(lead, tc.app.config), phone: r.contact.phone } : { lead: null };
    },
  }),
  defineTool({
    name: 'updateLead',
    description: "Updates a lead's stage or notes (e.g. mark as LOST or CONVERTED).",
    schema: z.object({
      contact: contactRef(),
      stage: z.enum(LEAD_STAGES).optional(),
      notes: z.string().max(500).optional(),
      lostReason: z.string().max(200).optional(),
    }),
    handler: async ({ contact, stage, notes, lostReason }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const lead = await getLeadByContact(tc.app.pool, r.contact.id);
      if (!lead) return { error: 'This person has no lead record.' };
      const updated = await updateLeadRow(tc.app.pool, lead.id, {
        stage,
        notes: notes ? [lead.notes, notes].filter(Boolean).join('\n') : undefined,
        lost_reason: lostReason,
      });
      if (stage === 'CONVERTED' || stage === 'LOST') await cancelForLead(tc.app.pool, lead.id, `admin_${stage.toLowerCase()}`);
      return { ok: true, lead: leadView(updated, tc.app.config) };
    },
  }),
  defineTool({
    name: 'createMember',
    description:
      'Registers a new member with a plan. The first payment is due on firstDueDate (defaults to startDate). ' +
      "monthlyFee defaults to the plan's price; only pass it if the owner states a different fee.",
    schema: z.object({
      name: z.string().min(1),
      phone: z.string().min(6),
      planCode: z.string().describe('Plan code or name'),
      startDate: isoDate(),
      monthlyFee: z.number().nonnegative().optional(),
      firstDueDate: isoDate().optional(),
      notes: z.string().max(500).optional(),
    }),
    handler: async (args, tc) => {
      const phone = normalizePhone(args.phone);
      if (!phone) return { error: 'Invalid phone number.' };
      const r = await createMemberService(tc.app, { ...args, phone });
      if (!r.ok) return r;
      return {
        ok: true,
        member: memberView(r.member, r.membership, r.firstPayment, tc.app.config, tc.app.now()),
        phone: `+${r.contact.phone}`,
      };
    },
  }),
  defineTool({
    name: 'getMember',
    description: "Returns a member's plan, dates, fee and payment status.",
    schema: z.object({ contact: contactRef() }),
    handler: async ({ contact }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const member = await getMemberByContact(tc.app.pool, r.contact.id);
      if (!member) return { error: 'This person is not a member.' };
      const membership = await getActiveMembership(tc.app.pool, member.id);
      const outstanding = await getOutstandingPayment(tc.app.pool, member.id);
      return {
        member: memberView(member, membership, outstanding, tc.app.config, tc.app.now()),
        phone: r.contact.phone ? `+${r.contact.phone}` : null,
        optedOut: r.contact.opted_out,
      };
    },
  }),
  defineTool({
    name: 'updateMember',
    description: "Updates a member's details: name, status (ACTIVE/PAUSED/CANCELLED), monthly fee, auto-renew or expiry date.",
    schema: z.object({
      contact: contactRef(),
      name: z.string().optional(),
      status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
      monthlyFee: z.number().nonnegative().optional(),
      autoRenew: z.boolean().optional(),
      expiryDate: isoDate().optional(),
      notes: z.string().max(500).optional(),
    }),
    handler: async ({ contact, ...fields }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const member = await getMemberByContact(tc.app.pool, r.contact.id);
      if (!member) return { error: 'This person is not a member.' };
      const res = await updateMemberService(tc.app, member, fields);
      if (!res.ok) return res;
      const outstanding = await getOutstandingPayment(tc.app.pool, member.id);
      return { ok: true, member: memberView(res.member, res.membership, outstanding, tc.app.config, tc.app.now()) };
    },
  }),
  defineTool({
    name: 'getPaymentStatus',
    description: "Returns a member's pending and recent payments.",
    schema: z.object({ contact: contactRef() }),
    handler: async ({ contact }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const member = await getMemberByContact(tc.app.pool, r.contact.id);
      if (!member) return { error: 'This person is not a member.' };
      const now = tc.app.now();
      return {
        name: member.name,
        pending: (await listPendingPayments(tc.app.pool, member.id)).map((p) => paymentView(p, tc.app.config, now)),
        recent: (await listRecentPayments(tc.app.pool, member.id)).map((p) => paymentView(p, tc.app.config, now)),
      };
    },
  }),
  defineTool({
    name: 'listPaymentsDue',
    description: 'Lists pending payments of active members due between two local dates (inclusive).',
    schema: z.object({ fromDate: isoDate(), toDate: isoDate() }),
    handler: async ({ fromDate, toDate }, tc) => {
      const rows = await listPendingPaymentsDueBetween(tc.app.pool, fromDate, toDate);
      return {
        count: rows.length,
        total: formatMoney(rows.reduce((s, p) => s + p.amount, 0), tc.app.config),
        payments: rows.map((p) => ({
          name: p.member_name,
          phone: p.phone ? `+${p.phone}` : null,
          amount: formatMoney(p.amount, tc.app.config),
          dueDate: formatHumanDate(p.due_date, tc.app.config.currency.locale),
        })),
      };
    },
  }),
  defineTool({
    name: 'listOverdueMembers',
    description: 'Lists active members with overdue payments.',
    schema: z.object({}),
    handler: async (_a, tc) => {
      const today = localDate(tc.app.config.timezone, tc.app.now());
      const rows = await listOverduePayments(tc.app.pool, today);
      return {
        count: rows.length,
        total: formatMoney(rows.reduce((s, p) => s + p.amount, 0), tc.app.config),
        overdue: rows.map((p) => ({
          name: p.member_name,
          phone: p.phone ? `+${p.phone}` : null,
          amount: formatMoney(p.amount, tc.app.config),
          dueDate: formatHumanDate(p.due_date, tc.app.config.currency.locale),
          daysOverdue: diffDays(today, p.due_date),
        })),
      };
    },
  }),
  defineTool({
    name: 'markPaymentPaid',
    description:
      "Marks a member's oldest pending payment as paid (stops its reminders and creates the next cycle's payment). " +
      'If the amount differs from what is due the tool asks for confirmation: only then, and only after the owner ' +
      'explicitly confirms, call again with confirmUnusual=true.',
    schema: z.object({
      contact: contactRef(),
      amount: z.number().positive().optional().describe('Amount received; omit if the full due amount was paid'),
      method: z.string().max(50).optional().describe('cash, UPI, card, bank transfer...'),
      notes: z.string().max(300).optional(),
      confirmUnusual: z.boolean().optional(),
    }),
    handler: async ({ contact, ...input }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const member = await getMemberByContact(tc.app.pool, r.contact.id);
      if (!member) return { error: 'This person is not a member.' };
      const pending = await getOutstandingPayment(tc.app.pool, member.id);
      if (!pending) return { error: `${member.name} has no pending payment.` };
      const res = await markPaidService(tc.app, { paymentId: pending.id, ...input });
      if (!res.ok) return res;
      const now = tc.app.now();
      return {
        ok: true,
        name: member.name,
        paid: paymentView(res.payment, tc.app.config, now),
        membershipValidUntil: res.membership?.expiry_date ?? null,
        nextPayment: res.nextPayment ? paymentView(res.nextPayment, tc.app.config, now) : null,
      };
    },
  }),
  defineTool({
    name: 'stopMessaging',
    description:
      'Stops ALL messages to a person: no AI replies, follow-ups or reminders until resumeMessaging is called.',
    schema: z.object({ contact: contactRef() }),
    handler: async ({ contact }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const cancelled = await pauseContact(tc.app, r.contact);
      return { ok: true, name: r.contact.name, cancelledScheduledMessages: cancelled };
    },
  }),
  defineTool({
    name: 'resumeMessaging',
    description:
      'Re-enables AI replies and automated messages for a person (after a handoff or stopMessaging). ' +
      'Does not override the customer’s own STOP/opt-out.',
    schema: z.object({ contact: contactRef() }),
    handler: async ({ contact }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      await resumeContact(tc.app, r.contact);
      return { ok: true, name: r.contact.name, customerOptedOut: r.contact.opted_out };
    },
  }),
  defineTool({
    name: 'listHandoffs',
    description: 'Lists conversations waiting for staff (NEEDS_HUMAN), being handled by staff, or paused.',
    schema: z.object({}),
    handler: async (_a, tc) => {
      const rows = await listConversationsByStatus(tc.app.pool, ['NEEDS_HUMAN', 'HUMAN_ACTIVE', 'PAUSED']);
      return {
        conversations: rows.map((r) => ({
          name: r.name,
          phone: r.phone ? `+${r.phone}` : null,
          status: r.status,
          reason: r.handoff_reason,
          summary: r.handoff_summary,
          since: r.handoff_at,
        })),
      };
    },
  }),
  defineTool({
    name: 'getScheduledMessages',
    description: 'Shows pending automated messages (reminders/follow-ups) for a person.',
    schema: z.object({ contact: contactRef() }),
    handler: async ({ contact }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const rows = await listPendingForContact(tc.app.pool, r.contact.id);
      return { scheduled: rows.map((m) => ({ kind: m.kind, sendAt: m.send_at, body: m.body })) };
    },
  }),
  defineTool({
    name: 'cancelFollowUps',
    description: 'Cancels pending lead follow-ups for a person.',
    schema: z.object({ contact: contactRef() }),
    handler: async ({ contact }, tc) => {
      const r = await resolveContact(tc.app, contact);
      if ('error' in r) return r;
      const lead = await getLeadByContact(tc.app.pool, r.contact.id);
      return { cancelled: lead ? await cancelForLead(tc.app.pool, lead.id, 'cancelled_by_admin') : 0 };
    },
  }),
];

export const adminTools: AgentTool[] = tools;
