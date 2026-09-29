import { isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, normalizeMessageContent, type WAMessage } from 'baileys';

/** Text of a WhatsApp message (plain text, captions, button/list replies). Null for media without text. */
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
  return text?.trim() ? text.trim() : null;
}

/** Messages that are not conversation content (receipts, reactions, key distribution, edits...). */
export function isIgnorableMessage(msg: WAMessage): boolean {
  const jid = msg.key.remoteJid;
  if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return true;
  if (msg.messageStubType) return true;
  const m = normalizeMessageContent(msg.message);
  if (!m) return true;
  if (m.protocolMessage || m.reactionMessage || m.pollUpdateMessage) return true;
  // Only a sender-key distribution (no real content).
  const keys = Object.keys(m).filter((k) => m[k as keyof typeof m] != null && k !== 'messageContextInfo');
  return keys.length === 0 || keys.every((k) => k === 'senderKeyDistributionMessage');
}
