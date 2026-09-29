import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { HistoryChat, HistoryMessage, SkippedSource } from '../types.js';
import { normalizePhone, phoneToJid, zonedToUtc } from '../util.js';

/**
 * Parser for WhatsApp "Export chat" (without media) .txt files, Android and iOS formats:
 *   Android: 31/12/2023, 21:15 - Rahul: Hi            (or 12/31/23, 9:15 PM - ...)
 *   iOS:     [31/12/23, 9:15:32 PM] Rahul: Hi
 * Lines that don't start with a timestamp continue the previous message.
 */

export type DateOrder = 'DMY' | 'MDY' | 'auto';

export interface ExportParseOptions {
  timezone: string;
  /** Sender labels used by the gym's own account (e.g. "Flamingo Fitness", "You"). Case-insensitive. */
  gymNames: string[];
  /** Map of contact name (lowercase) -> phone, for exports where the customer is saved by name. */
  contactPhones: Map<string, string>;
  dateOrder: DateOrder;
}

const TS = String.raw`(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?`;
const ANDROID_RE = new RegExp(`^${TS}\\s+-\\s+(.*)$`);
const IOS_RE = new RegExp(`^\\[${TS}\\]\\s+(.*)$`);

const SYSTEM_PATTERNS = [
  /end-to-end encrypted/i,
  /^you (created|added|removed|changed|blocked|unblocked)/i,
  /security code (changed|with)/i,
  /disappearing messages/i,
  /this message was deleted/i,
  /you deleted this message/i,
  /missed (voice|video) call/i,
  /is a contact\.?$/i,
];
const MEDIA_RE = /^(<media omitted>|(image|video|audio|sticker|gif|document) omitted|<attached: .*>)$/i;

interface RawLine {
  parts: string[]; // d1, d2, d3, h, m, s, ampm
  sender: string | null;
  text: string;
}

function clean(line: string): string {
  return line.replace(/[‎‏‪-‮]/g, '').replace(/[  ]/g, ' ').replace(/\r$/, '');
}

function parseLines(content: string): RawLine[] {
  const out: RawLine[] = [];
  for (const rawLine of content.split('\n')) {
    const line = clean(rawLine);
    const m = IOS_RE.exec(line) ?? ANDROID_RE.exec(line);
    if (!m) {
      const last = out[out.length - 1];
      if (last && line.length) last.text += `\n${line}`;
      continue;
    }
    const rest = m[8]!;
    const sep = rest.indexOf(': ');
    out.push({
      parts: m.slice(1, 8).map((p) => p ?? ''),
      sender: sep > 0 ? rest.slice(0, sep).trim() : null,
      text: sep > 0 ? rest.slice(sep + 2) : rest,
    });
  }
  return out;
}

/** Decides day/month order from the data itself: any first component > 12 means DMY, any second > 12 means MDY. */
export function detectDateOrder(lines: RawLine[], fallback: 'DMY' | 'MDY' = 'DMY'): 'DMY' | 'MDY' | 'YMD' {
  let dmy = false;
  let mdy = false;
  for (const l of lines) {
    const [a, b] = [Number(l.parts[0]), Number(l.parts[1])];
    if (l.parts[0]!.length === 4) return 'YMD';
    if (a > 12) dmy = true;
    if (b > 12) mdy = true;
  }
  if (dmy && !mdy) return 'DMY';
  if (mdy && !dmy) return 'MDY';
  return fallback;
}

function toDate(parts: string[], order: 'DMY' | 'MDY' | 'YMD', timezone: string): Date | null {
  const [p1, p2, p3, hh, mm, ss, ampm] = parts as [string, string, string, string, string, string, string];
  let year: number, month: number, day: number;
  if (order === 'YMD') [year, month, day] = [Number(p1), Number(p2), Number(p3)];
  else if (order === 'DMY') [day, month, year] = [Number(p1), Number(p2), Number(p3)];
  else [month, day, year] = [Number(p1), Number(p2), Number(p3)];
  if (year < 100) year += 2000;
  let hour = Number(hh);
  const marker = ampm.toLowerCase().replace(/[.\s]/g, '');
  if (marker === 'pm' && hour < 12) hour += 12;
  if (marker === 'am' && hour === 12) hour = 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const minute = zonedToUtc(iso, `${String(hour).padStart(2, '0')}:${mm}`, timezone);
  return new Date(minute.getTime() + Number(ss || 0) * 1000);
}

/** "WhatsApp Chat with Rahul.txt" / "WhatsApp Chat - Rahul/_chat.txt" -> "Rahul". */
export function chatTitleFromPath(path: string): string | null {
  const file = basename(path).replace(/\.txt$/i, '');
  const candidate = file === '_chat' ? basename(dirname(path)) : file;
  const m = /^WhatsApp Chat (?:with|-)\s*(.+?)(?:\s*\(\d+\))?(?:\.zip)?$/i.exec(candidate);
  return (m ? m[1]! : candidate).trim() || null;
}

const looksLikePhone = (s: string) => /^\+?[\d\s()-]{8,}$/.test(s);

export function parseExportText(
  content: string,
  path: string,
  opts: ExportParseOptions,
): { chat: HistoryChat } | { skipped: SkippedSource } {
  const label = basename(dirname(path)) === '.' ? basename(path) : `${basename(dirname(path))}/${basename(path)}`;
  const lines = parseLines(content).filter((l) => l.sender !== null);
  if (!lines.length) return { skipped: { label, reason: 'no_messages_found' } };

  const title = chatTitleFromPath(path);
  const senders = [...new Set(lines.map((l) => l.sender!))];
  const gymNames = new Set(opts.gymNames.map((n) => n.toLowerCase()));
  const nonGym = senders.filter((s) => !gymNames.has(s.toLowerCase()));

  let customer: string | undefined;
  if (nonGym.length === 1 && (gymNames.size > 0 || senders.length === 1)) customer = nonGym[0];
  if (!customer && title) customer = senders.find((s) => s.toLowerCase() === title.toLowerCase());
  if (!customer && senders.length === 2) {
    const phoneLike = senders.filter(looksLikePhone);
    if (phoneLike.length === 1) customer = phoneLike[0];
  }
  if (senders.length > 2 && nonGym.length > 1) return { skipped: { label, reason: 'group_chat' } };
  if (!customer) {
    return { skipped: { label, reason: 'cannot_tell_gym_from_customer (pass --gym-names "Your WhatsApp name")' } };
  }

  const phone =
    (looksLikePhone(customer) ? normalizePhone(customer) : null) ??
    (title && looksLikePhone(title) ? normalizePhone(title) : null) ??
    normalizePhone(opts.contactPhones.get(customer.toLowerCase()) ?? opts.contactPhones.get((title ?? '').toLowerCase()));
  if (!phone) return { skipped: { label, reason: `no_phone_for "${customer}" (add it to --contacts CSV)` } };

  const order = opts.dateOrder === 'auto' ? detectDateOrder(lines) : opts.dateOrder;
  const seen = new Map<string, number>();
  const messages: HistoryMessage[] = [];
  for (const l of lines) {
    const text = l.text.trim();
    if (!text || SYSTEM_PATTERNS.some((re) => re.test(text))) continue;
    const timestamp = toDate(l.parts, order, opts.timezone);
    if (!timestamp) continue;
    const fromMe = l.sender !== customer;
    const body = MEDIA_RE.test(text) ? '[media]' : text;
    // Deterministic id so re-importing the same export never duplicates messages.
    const base = `${phone}|${timestamp.toISOString()}|${fromMe ? 1 : 0}|${body}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const id = `import:${createHash('sha1').update(`${base}|${n}`).digest('hex')}`;
    messages.push({ id, fromMe, text: body, timestamp });
  }
  if (!messages.length) return { skipped: { label, reason: 'no_messages_found' } };

  return {
    chat: {
      label,
      jid: phoneToJid(phone),
      phone,
      name: looksLikePhone(customer) ? null : customer,
      messages,
    },
  };
}

/** Reads a single .txt export or every .txt export found (recursively) in a folder. */
export function readExports(path: string, opts: ExportParseOptions): { chats: HistoryChat[]; skipped: SkippedSource[] } {
  const files: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else if (p.toLowerCase().endsWith('.txt')) files.push(p);
  };
  walk(path);

  const chats: HistoryChat[] = [];
  const skipped: SkippedSource[] = [];
  for (const file of files.sort()) {
    const r = parseExportText(readFileSync(file, 'utf8'), file, opts);
    if ('chat' in r) chats.push(r.chat);
    else skipped.push(r.skipped);
  }
  return { chats: mergeByPhone(chats), skipped };
}

/** The same person can appear in several export files; merge them into one chat. */
function mergeByPhone(chats: HistoryChat[]): HistoryChat[] {
  const byPhone = new Map<string, HistoryChat>();
  for (const c of chats) {
    const existing = byPhone.get(c.phone!);
    if (!existing) byPhone.set(c.phone!, { ...c, messages: [...c.messages] });
    else {
      const ids = new Set(existing.messages.map((m) => m.id));
      existing.messages.push(...c.messages.filter((m) => !ids.has(m.id)));
      existing.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      existing.name ??= c.name;
      existing.label += `, ${c.label}`;
    }
  }
  return [...byPhone.values()];
}
