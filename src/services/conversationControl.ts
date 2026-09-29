import type { AppContext } from '../context.js';
import { type Contact, setOptOut } from '../repositories/contacts.js';
import { setConversationStatus } from '../repositories/conversations.js';
import { cancelForContact } from '../repositories/scheduledMessages.js';
import { notifyAdmins } from './admins.js';

export const HANDOFF_REASONS = [
  'complaint',
  'refund',
  'negotiation',
  'payment_verification',
  'unusual_financial_request',
  'complex_question',
  'requested_staff',
  'other',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

const STOP_RE = /^\s*(stop|unsubscribe|opt[\s-]?out|stop all|cancel messages)\s*[.!]*\s*$/i;
const START_RE = /^\s*(start|subscribe|unstop|opt[\s-]?in)\s*[.!]*\s*$/i;

export const isStopKeyword = (text: string) => STOP_RE.test(text);
export const isStartKeyword = (text: string) => START_RE.test(text);

/** The customer asked us to stop: no more automated messages of any kind. */
export async function optOutContact(ctx: AppContext, contact: Contact): Promise<number> {
  await setOptOut(ctx.pool, contact.id, true);
  return cancelForContact(ctx.pool, contact.id, 'opted_out');
}

export async function optInContact(ctx: AppContext, contact: Contact): Promise<void> {
  await setOptOut(ctx.pool, contact.id, false);
}

/** Stops autonomous replies and automated messages and alerts staff. */
export async function handoffToHuman(
  ctx: AppContext,
  contact: Contact,
  reason: HandoffReason,
  summary: string,
): Promise<void> {
  await setConversationStatus(ctx.pool, contact.id, 'NEEDS_HUMAN', { reason, summary });
  await cancelForContact(ctx.pool, contact.id, 'handed_off', ['LEAD_FOLLOW_UP', 'CUSTOM_FOLLOW_UP']);
  const who = `${contact.name ?? 'Unknown'}${contact.phone ? ` (+${contact.phone})` : ''}`;
  await notifyAdmins(
    ctx,
    `🔔 *Staff needed*: ${who}\nReason: ${reason.replace(/_/g, ' ')}\nSummary: ${summary}\n\n` +
      `The AI has stopped replying to this chat. When you're done, message me "resume AI for ${contact.name ?? contact.phone ?? 'them'}".`,
  );
}

/** Admin "stop messaging X": no AI replies and no automated messages until resumed. */
export async function pauseContact(ctx: AppContext, contact: Contact): Promise<number> {
  await setConversationStatus(ctx.pool, contact.id, 'PAUSED', { reason: 'paused_by_admin' });
  return cancelForContact(ctx.pool, contact.id, 'paused_by_admin');
}

export async function resumeContact(ctx: AppContext, contact: Contact): Promise<void> {
  await setConversationStatus(ctx.pool, contact.id, 'ACTIVE');
}
