/** Small date/phone helpers (kept local so this project has no dependency on the agent's code). */

let defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE ?? '91';
export function setDefaultCountryCode(code: string): void {
  defaultCountryCode = code;
}

/** Digits-only international format without "+", or null. 10-digit local numbers get the default country code. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = defaultCountryCode + digits;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export const phoneToJid = (phone: string) => `${phone}@s.whatsapp.net`;

export function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  return normalizePhone(jid.split('@')[0]!.split(':')[0]!);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parts(date: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

export function localDate(timeZone: string, date: Date = new Date()): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localDateTime(timeZone: string, date: Date): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Local wall-clock date/time in `timeZone` -> UTC instant. */
export function zonedToUtc(isoDate: string, time: string, timeZone: string): Date {
  const [y, mo, d] = isoDate.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess - tzOffsetMs(new Date(guess), timeZone);
  result = guess - tzOffsetMs(new Date(result), timeZone);
  return new Date(result);
}
