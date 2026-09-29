import { buildHistory, runAgent } from '../agent/agent.js';
import type { LlmClient } from '../agent/llm.js';
import { adminSystemPrompt, customerSystemPrompt } from '../agent/prompts.js';
import { adminTools } from '../agent/tools/adminTools.js';
import { customerTools } from '../agent/tools/customerTools.js';
import { leadView, memberView } from '../agent/tools/shared.js';
import type { ToolContext } from '../agent/tools/types.js';
import type { AppContext } from '../context.js';
import { type Contact, getContactById, upsertInboundContact } from '../repositories/contacts.js';
import { type Conversation, getOrCreateConversation, setConversationStatus } from '../repositories/conversations.js';
import { createLead, getLeadByContact, type Lead } from '../repositories/leads.js';
import { insertMessageLog, recentMessages } from '../repositories/messageLogs.js';
import { getActiveMembership, getMemberByContact, getOutstandingPayment } from '../repositories/members.js';
import { cancelForContact } from '../repositories/scheduledMessages.js';
import { isAdminPhone } from '../services/admins.js';
import { isStartKeyword, isStopKeyword, optInContact, optOutContact } from '../services/conversationControl.js';
import { missingLeadFields, reengageLead, scheduleLeadFollowUpSequence } from '../services/leads.js';
import { KeyedSerialQueue, SlidingWindowLimiter } from '../utils/rateLimiter.js';

export interface InboundMessage {
  /** WhatsApp message id (used for de-duplication). */
  id: string;
  /** Chat JID to reply to. */
  jid: string;
  /** Sender phone (digits, with country code) when known. */
  phone: string | null;
  pushName: string | null;
  /** Text content, or null for media/unsupported messages. */
  text: string | null;
  /** Sent from the gym's own WhatsApp account (by the bot or by staff on the phone). */
  fromMe: boolean;
}

const HISTORY_LIMIT = 20;
const FALLBACK_REPLY = "Sorry, I'm having a little trouble right now. A team member will get back to you shortly.";
const NON_TEXT_REPLY = 'Thanks! I can only read text messages at the moment - could you type your question for me?';

export class MessageHandler {
  private readonly queue = new KeyedSerialQueue();
  private readonly inboundLimiter: SlidingWindowLimiter;

  constructor(
    private readonly ctx: AppContext,
    private readonly llm: LlmClient,
    private readonly isOwnOutbound: (id: string) => boolean = () => false,
  ) {
    this.inboundLimiter = new SlidingWindowLimiter(ctx.config.rateLimits.inboundPerMinute, 60_000);
  }

  /** Entry point. Messages from the same chat are processed strictly in order. */
  handle(msg: InboundMessage): Promise<void> {
    return this.queue.run(msg.jid, async () => {
      try {
        await this.process(msg);
      } catch (err) {
        this.ctx.logger.error({ err, jid: msg.jid, id: msg.id }, 'Failed to handle inbound message');
      }
    });
  }

  private async process(msg: InboundMessage): Promise<void> {
    const { ctx } = this;
    if (msg.fromMe) return this.handleOwnMessage(msg);

    const contact = await upsertInboundContact(ctx.pool, {
      jid: msg.jid,
      phone: msg.phone,
      pushName: msg.pushName,
      isAdmin: isAdminPhone(ctx, msg.phone),
    });
    const log = await insertMessageLog(ctx.pool, {
      contact_id: contact.id,
      direction: 'INBOUND',
      source: 'CUSTOMER',
      body: msg.text ?? '[non-text message]',
      wa_message_id: msg.id,
    });
    if (!log) return; // duplicate delivery of a message we already processed

    if (contact.is_admin) return this.handleAdmin(contact, msg);
    return this.handleCustomer(contact, msg, log.id);
  }

  /** Messages sent from the gym's phone that the bot didn't send mean staff took over the chat. */
  private async handleOwnMessage(msg: InboundMessage): Promise<void> {
    if (this.isOwnOutbound(msg.id) || !msg.text) return;
    const { rows } = await this.ctx.pool.query<Contact>('SELECT * FROM contacts WHERE wa_jid = $1', [msg.jid]);
    const contact = rows[0];
    if (!contact || contact.is_admin) return;
    const log = await insertMessageLog(this.ctx.pool, {
      contact_id: contact.id,
      direction: 'OUTBOUND',
      source: 'HUMAN',
      body: msg.text,
      wa_message_id: msg.id,
    });
    if (!log) return;
    const conv = await getOrCreateConversation(this.ctx.pool, contact.id);
    if (conv.status === 'ACTIVE' || conv.status === 'NEEDS_HUMAN') {
      await setConversationStatus(this.ctx.pool, contact.id, 'HUMAN_ACTIVE', { reason: 'staff_replied' });
      await cancelForContact(this.ctx.pool, contact.id, 'staff_took_over', ['LEAD_FOLLOW_UP', 'CUSTOM_FOLLOW_UP']);
      this.ctx.logger.info({ contactId: contact.id }, 'Staff replied manually; AI paused for this chat');
    }
  }

  private async handleCustomer(contact: Contact, msg: InboundMessage, inboundLogId: number): Promise<void> {
    const { ctx } = this;
    const text = msg.text?.trim() ?? '';

    // Deterministic compliance handling first - never left to the LLM.
    if (text && isStopKeyword(text)) {
      await optOutContact(ctx, contact);
      await ctx.outbox.send({
        contact,
        source: 'SYSTEM',
        text: `You've been unsubscribed and won't receive any more automated messages from ${ctx.config.gym.name}. Reply START to subscribe again.`,
      });
      return;
    }
    if (text && isStartKeyword(text) && contact.opted_out) {
      await optInContact(ctx, contact);
      await ctx.outbox.send({ contact, source: 'SYSTEM', text: "You're subscribed again. How can we help you today?" });
      return;
    }

    // Any reply stops the pending automatic follow-up sequence.
    await cancelForContact(ctx.pool, contact.id, 'contact_replied', ['LEAD_FOLLOW_UP']);

    const conversation = await getOrCreateConversation(ctx.pool, contact.id);
    if (conversation.status !== 'ACTIVE') {
      ctx.logger.info({ contactId: contact.id, status: conversation.status }, 'AI paused for this conversation; not replying');
      return;
    }
    if (!this.inboundLimiter.tryAcquire(String(contact.id))) {
      ctx.logger.warn({ contactId: contact.id }, 'Inbound rate limit exceeded; ignoring message');
      return;
    }
    if (!text) {
      await ctx.outbox.send({ contact, source: 'SYSTEM', text: NON_TEXT_REPLY });
      return;
    }

    const member = await getMemberByContact(ctx.pool, contact.id);
    let lead = member ? null : ((await getLeadByContact(ctx.pool, contact.id)) ?? (await createLead(ctx.pool, contact.id)));
    if (lead) lead = await reengageLead(ctx, lead);

    await ctx.outbox.typing(contact);
    const toolContext: ToolContext = { app: ctx, contact, state: { handedOff: false } };
    let reply: string;
    let toolCalls: unknown;
    try {
      const history = buildHistory(await recentMessages(ctx.pool, contact.id, HISTORY_LIMIT));
      const result = await runAgent({
        llm: this.llm,
        systemInstruction: customerSystemPrompt(ctx.config, ctx.now(), await this.crmContext(contact, conversation, lead)),
        history,
        tools: customerTools,
        toolContext,
      });
      reply = result.reply || FALLBACK_REPLY;
      toolCalls = result.toolCalls;
    } catch (err) {
      ctx.logger.error({ err, contactId: contact.id }, 'Agent failed');
      reply = FALLBACK_REPLY;
    }

    const fresh = (await getContactById(ctx.pool, contact.id))!;
    await ctx.outbox.send({ contact: fresh, text: reply, source: 'AGENT', toolCalls });

    // Phase 5: if they go quiet after this reply, follow up automatically.
    if (lead && !toolContext.state.handedOff) {
      const current = await getLeadByContact(ctx.pool, contact.id);
      if (current) await scheduleLeadFollowUpSequence(ctx, current, fresh, inboundLogId);
    }
  }

  private async handleAdmin(contact: Contact, msg: InboundMessage): Promise<void> {
    const { ctx } = this;
    if (!msg.text?.trim()) return;
    await ctx.outbox.typing(contact);
    let reply: string;
    let toolCalls: unknown;
    try {
      const history = buildHistory(await recentMessages(ctx.pool, contact.id, HISTORY_LIMIT));
      const result = await runAgent({
        llm: this.llm,
        systemInstruction: adminSystemPrompt(ctx.config, ctx.now(), contact.name),
        history,
        tools: adminTools,
        toolContext: { app: ctx, contact, state: { handedOff: false } },
      });
      reply = result.reply || 'Done.';
      toolCalls = result.toolCalls;
    } catch (err) {
      ctx.logger.error({ err }, 'Admin agent failed');
      reply = `Sorry, that failed: ${(err as Error).message}`;
    }
    await ctx.outbox.send({ contact, text: reply, source: 'AGENT', toolCalls });
  }

  private async crmContext(contact: Contact, conversation: Conversation, lead: Lead | null): Promise<string> {
    const { ctx } = this;
    const lines = [
      `WhatsApp name: ${contact.name ?? 'unknown'}`,
      `Phone: ${contact.phone ? `+${contact.phone}` : 'unknown (ask for it when relevant)'}`,
      `Opted out of automated messages: ${contact.opted_out ? 'yes' : 'no'}`,
      `Conversation status: ${conversation.status}`,
    ];
    const member = await getMemberByContact(ctx.pool, contact.id);
    if (member) {
      const membership = await getActiveMembership(ctx.pool, member.id);
      const outstanding = await getOutstandingPayment(ctx.pool, member.id);
      lines.push(`This person is an EXISTING MEMBER: ${JSON.stringify(memberView(member, membership, outstanding, ctx.config, ctx.now()))}`);
    } else if (lead) {
      lines.push(`This person is a LEAD: ${JSON.stringify(leadView(lead, ctx.config))}`);
      const missing = missingLeadFields(lead, contact);
      lines.push(missing.length ? `Still unknown: ${missing.join(', ')}` : 'All lead details collected.');
    }
    return lines.join('\n');
  }
}
