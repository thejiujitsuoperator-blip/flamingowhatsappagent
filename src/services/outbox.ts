import type { GymConfig } from '../config/gym.js';
import type { Pool } from '../db/pool.js';
import { type Contact, touchOutbound } from '../repositories/contacts.js';
import { insertMessageLog, type MessageSource } from '../repositories/messageLogs.js';
import type { Logger } from '../utils/logger.js';
import { phoneToJid } from '../utils/phone.js';
import { SlidingWindowLimiter, sleep } from '../utils/rateLimiter.js';
import type { MessageTransport } from './transport.js';

export interface SendResult {
  ok: boolean;
  waMessageId?: string | null;
  error?: string;
}

export interface SendRequest {
  contact: Contact;
  text: string;
  source: Exclude<MessageSource, 'CUSTOMER'>;
  scheduledMessageId?: number;
  toolCalls?: unknown;
}

/**
 * The single path for every outbound WhatsApp message.
 * - paces messages globally (min gap + per-minute cap) to avoid WhatsApp bans
 * - logs every message (success or failure) in message_logs
 */
export class Outbox {
  private chain: Promise<unknown> = Promise.resolve();
  private lastSentAt = 0;
  private readonly perMinute: SlidingWindowLimiter;

  constructor(
    private readonly transport: MessageTransport,
    private readonly pool: Pool,
    private readonly config: GymConfig,
    private readonly logger: Logger,
  ) {
    this.perMinute = new SlidingWindowLimiter(config.rateLimits.outboundPerMinute, 60_000);
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  async typing(contact: Contact): Promise<void> {
    const jid = jidFor(contact);
    if (jid && this.transport.sendTyping) await this.transport.sendTyping(jid).catch(() => undefined);
  }

  send(req: SendRequest): Promise<SendResult> {
    const run = this.chain.then(() => this.sendNow(req));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async pace(): Promise<void> {
    const gap = this.config.rateLimits.outboundMinGapMs - (Date.now() - this.lastSentAt);
    if (gap > 0) await sleep(gap);
    for (;;) {
      const wait = this.perMinute.waitTime('global');
      if (wait <= 0) break;
      this.logger.warn({ wait }, 'Outbound rate limit reached, waiting');
      await sleep(wait);
    }
    this.perMinute.tryAcquire('global');
    this.lastSentAt = Date.now();
  }

  private async sendNow(req: SendRequest): Promise<SendResult> {
    const text = req.text.trim();
    const jid = jidFor(req.contact);
    let result: SendResult;
    if (!text) {
      result = { ok: false, error: 'empty message' };
    } else if (!jid) {
      result = { ok: false, error: 'contact has no WhatsApp address' };
    } else if (!this.transport.isConnected()) {
      result = { ok: false, error: 'WhatsApp is not connected' };
    } else {
      await this.pace();
      try {
        const id = await this.transport.sendText(jid, text);
        result = { ok: true, waMessageId: id };
      } catch (err) {
        result = { ok: false, error: (err as Error).message };
      }
    }

    await insertMessageLog(this.pool, {
      contact_id: req.contact.id,
      direction: 'OUTBOUND',
      source: req.source,
      body: text || '(empty)',
      wa_message_id: result.waMessageId ?? null,
      scheduled_message_id: req.scheduledMessageId ?? null,
      tool_calls: req.toolCalls,
      status: result.ok ? 'OK' : 'FAILED',
      error: result.error ?? null,
    });
    if (result.ok) await touchOutbound(this.pool, req.contact.id);
    else this.logger.error({ contactId: req.contact.id, error: result.error, source: req.source }, 'Failed to send message');
    return result;
  }
}

export function jidFor(contact: Contact): string | null {
  if (contact.wa_jid) return contact.wa_jid;
  return contact.phone ? phoneToJid(contact.phone) : null;
}
