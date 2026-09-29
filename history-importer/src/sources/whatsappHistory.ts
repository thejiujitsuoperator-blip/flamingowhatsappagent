import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import type { Logger } from 'pino';
import type { HistoryChat, HistoryMessage } from '../types.js';
import { jidToPhone } from '../util.js';

/**
 * Reads chat history by linking this tool as an extra WhatsApp device ("Linked devices")
 * and collecting WhatsApp's history sync. It is strictly read-only: every sending method on
 * the socket is replaced with one that throws, and the device is unlinked when done.
 */

export interface WhatsAppHistoryOptions {
  authDir: string;
  /** Stop after this many seconds without new history chunks. */
  idleSeconds: number;
  /** Hard limit for the whole sync (after login). */
  maxMinutes: number;
  /** Unlink the temporary device after importing (recommended). */
  unlinkWhenDone: boolean;
  logger: Logger;
}

export function extractText(message: WAMessage['message']): string | null {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    null;
  if (text?.trim()) return text.trim();
  if (m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage) return '[media]';
  return null;
}

function timestampOf(msg: WAMessage): Date | null {
  const ts = msg.messageTimestamp as number | { toNumber(): number } | null | undefined;
  const seconds = typeof ts === 'number' ? ts : ts?.toNumber?.();
  return seconds ? new Date(seconds * 1000) : null;
}

const NO_SEND = (name: string) => async () => {
  throw new Error(`history importer never sends anything (blocked ${name})`);
};

export async function readWhatsAppHistory(opts: WhatsAppHistoryOptions): Promise<HistoryChat[]> {
  const { logger } = opts;
  const messages = new Map<string, WAMessage>();
  const names = new Map<string, string>(); // jid -> name
  const lidToPn = new Map<string, string>();

  const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  await new Promise<void>((resolve, reject) => {
    let idleTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let finished = false;
    let sock: ReturnType<typeof makeWASocket>;

    const finish = async (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      try {
        if (opts.unlinkWhenDone && !err) await sock.logout('history import finished').catch(() => undefined);
        else sock.end(undefined);
      } finally {
        if (err) reject(err);
        else resolve();
      }
    };
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void finish(), opts.idleSeconds * 1000);
    };

    const connect = () => {
      sock = makeWASocket({
        auth: state,
        version,
        browser: Browsers.macOS('Desktop'), // desktop companions receive the most history
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: false,
        logger: logger.child({ module: 'baileys' }, { level: 'warn' }) as never,
      });
      // Hard guarantee: nothing can be sent through this socket.
      Object.assign(sock, {
        sendMessage: NO_SEND('sendMessage'),
        relayMessage: NO_SEND('relayMessage'),
        sendPresenceUpdate: NO_SEND('sendPresenceUpdate'),
        readMessages: NO_SEND('readMessages'),
      });

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          logger.info('Scan this QR code with the gym WhatsApp: Settings > Linked devices > Link a device');
          qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
          logger.info('Linked. Waiting for WhatsApp to send chat history (this can take several minutes)...');
          bumpIdle();
          hardTimer ??= setTimeout(() => {
            logger.warn(`Reached --max-minutes (${opts.maxMinutes}); importing what was received so far`);
            void finish();
          }, opts.maxMinutes * 60_000);
        }
        if (connection === 'close' && !finished) {
          const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) return void finish(new Error('WhatsApp logged this device out'));
          if (code === DisconnectReason.restartRequired || code === DisconnectReason.connectionClosed || code === undefined) {
            logger.info('Reconnecting...');
            return connect();
          }
          return void finish(new Error(`WhatsApp connection closed (status ${code})`));
        }
      });

      sock.ev.on('messaging-history.set', (h) => {
        for (const c of h.contacts) {
          const name = c.name ?? c.notify ?? c.verifiedName;
          if (name) names.set(jidNormalizedUser(c.id), name);
          if (c.lid && c.phoneNumber) lidToPn.set(jidNormalizedUser(c.lid), jidNormalizedUser(c.phoneNumber));
        }
        for (const m of h.lidPnMappings ?? []) lidToPn.set(jidNormalizedUser(m.lid), jidNormalizedUser(m.pn));
        for (const m of h.messages) if (m.key.id) messages.set(m.key.id, m);
        logger.info({ messages: messages.size, progress: h.progress ?? null }, 'Received history chunk');
        bumpIdle();
      });
      sock.ev.on('lid-mapping.update', (m) => lidToPn.set(jidNormalizedUser(m.lid), jidNormalizedUser(m.pn)));
    };
    connect();
  });

  return groupIntoChats([...messages.values()], names, lidToPn);
}

export function groupIntoChats(messages: WAMessage[], names: Map<string, string>, lidToPn: Map<string, string>): HistoryChat[] {
  const chats = new Map<string, HistoryChat>();
  for (const msg of messages) {
    const raw = msg.key.remoteJid;
    if (!raw || !msg.key.id || isJidGroup(raw) || isJidBroadcast(raw) || isJidNewsletter(raw) || raw === 'status@broadcast') continue;
    const jid = jidNormalizedUser(raw);
    if (!isPnUser(jid) && !isLidUser(jid)) continue;
    const alt = msg.key.remoteJidAlt ? jidNormalizedUser(msg.key.remoteJidAlt) : undefined;
    const pnJid = isPnUser(jid) ? jid : alt && isPnUser(alt) ? alt : lidToPn.get(jid);
    const phone = jidToPhone(pnJid);
    const text = extractText(msg.message);
    const timestamp = timestampOf(msg);
    if (!text || !timestamp) continue;

    const key = phone ?? jid;
    let chat = chats.get(key);
    if (!chat) {
      chat = { label: phone ? `+${phone}` : jid, jid, phone, name: null, messages: [] };
      chats.set(key, chat);
    }
    chat.name ??= names.get(jid) ?? (pnJid ? names.get(pnJid) : undefined) ?? (!msg.key.fromMe ? msg.pushName : null) ?? null;
    const m: HistoryMessage = { id: msg.key.id, fromMe: !!msg.key.fromMe, text, timestamp };
    chat.messages.push(m);
  }
  for (const c of chats.values()) c.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return [...chats.values()];
}
