import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import type { InboundMessage } from '../handlers/messageHandler.js';
import type { MessageTransport } from '../services/transport.js';
import type { Logger } from '../utils/logger.js';
import { jidToPhone } from '../utils/phone.js';
import { extractText, isIgnorableMessage } from './extract.js';

const OWN_ID_TTL_MS = 10 * 60_000;

/**
 * Baileys connection (Phase 1). Handles QR login, reconnects, inbound message
 * normalisation and implements the MessageTransport used by the Outbox.
 */
export class BaileysConnection implements MessageTransport {
  private sock: WASocket | null = null;
  private connected = false;
  private stopped = false;
  private readonly ownIds = new Map<string, number>();
  private onMessage: ((msg: InboundMessage) => void) | null = null;

  constructor(
    private readonly authDir: string,
    private readonly logger: Logger,
  ) {}

  setMessageListener(listener: (msg: InboundMessage) => void): void {
    this.onMessage = listener;
  }

  isConnected(): boolean {
    return this.connected && !!this.sock;
  }

  isOwnMessage(id: string): boolean {
    return this.ownIds.has(id);
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu('Chrome'),
      logger: this.logger.child({ module: 'baileys' }, { level: 'warn' }) as never,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.logger.info('Scan this QR code with the gym WhatsApp (Settings > Linked devices > Link a device)');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        this.connected = true;
        this.logger.info({ user: sock.user?.id }, 'WhatsApp connected');
      }
      if (connection === 'close') {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          this.logger.error(`WhatsApp session logged out. Delete the "${this.authDir}" folder and restart to scan a new QR code.`);
          return;
        }
        if (this.stopped) return;
        this.logger.warn({ statusCode }, 'WhatsApp connection closed; reconnecting in 3s');
        setTimeout(() => void this.start().catch((err) => this.logger.error({ err }, 'Reconnect failed')), 3000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return; // skip history sync / appends
      for (const m of messages) {
        void this.normalize(m)
          .then((inbound) => inbound && this.onMessage?.(inbound))
          .catch((err) => this.logger.error({ err }, 'Failed to normalise inbound message'));
      }
    });
  }

  private async normalize(msg: WAMessage): Promise<InboundMessage | null> {
    if (!msg.key.id || isIgnorableMessage(msg)) return null;
    const remoteJid = jidNormalizedUser(msg.key.remoteJid!);
    return {
      id: msg.key.id,
      jid: remoteJid,
      phone: await this.resolvePhone(remoteJid, msg.key.remoteJidAlt),
      pushName: msg.pushName ?? null,
      text: extractText(msg.message),
      fromMe: !!msg.key.fromMe,
    };
  }

  /** WhatsApp may address users by LID instead of phone number; map back to the phone when possible. */
  private async resolvePhone(jid: string, alt?: string): Promise<string | null> {
    if (isPnUser(jid)) return jidToPhone(jid);
    if (alt && isPnUser(alt)) return jidToPhone(jidNormalizedUser(alt));
    if (isLidUser(jid) && this.sock) {
      const pn = await this.sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
      if (pn) return jidToPhone(jidNormalizedUser(pn));
    }
    return null;
  }

  async sendText(jid: string, text: string): Promise<string | null> {
    if (!this.sock) throw new Error('WhatsApp socket not initialised');
    const messageId = generateMessageIDV2(this.sock.user?.id);
    this.rememberOwnId(messageId);
    const sent = await this.sock.sendMessage(jid, { text }, { messageId });
    return sent?.key.id ?? messageId;
  }

  async sendTyping(jid: string): Promise<void> {
    await this.sock?.sendPresenceUpdate('composing', jid);
  }

  private rememberOwnId(id: string): void {
    const now = Date.now();
    this.ownIds.set(id, now);
    for (const [key, ts] of this.ownIds) {
      if (now - ts > OWN_ID_TTL_MS) this.ownIds.delete(key);
      else break;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.sock?.end(undefined);
    this.sock = null;
  }
}
