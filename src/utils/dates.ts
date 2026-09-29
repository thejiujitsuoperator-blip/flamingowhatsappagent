/**
 * Date helpers. Calendar dates are handled as "YYYY-MM-DD" strings in the gym's timezone
 * to avoid off-by-one errors from server timezones.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parts(date: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Local calendar date (YYYY-MM-DD) of `date` in `timeZone`. */
export function localDate(timeZone: string, date: Date = new Date()): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localHour(timeZone: string, date: Date = new Date()): number {
  return Number(parts(date, timeZone).hour);
}

export function localTime(timeZone: string, date: Date = new Date()): string {
  const p = parts(date, timeZone);
  return `${p.hour}:${p.minute}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Adds calendar months, clamping to the end of the month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, day] = isoDate.split('-').map(Number) as [number, number, number];
  const targetMonthIndex = m - 1 + months;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/** Whole days from `b` to `a` (a - b). */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function weekday(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/** "October 5" style formatting for customer-facing messages. */
export function formatHumanDate(isoDate: string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );
}

export function formatHumanDateTime(date: Date, timeZone: string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converts a local wall-clock date/time in `timeZone` to a UTC instant. */
export function zonedToUtc(isoDate: string, time: string, timeZone: string): Date {
  const [y, mo, d] = isoDate.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess - tzOffsetMs(new Date(guess), timeZone);
  // Second pass handles DST transitions.
  result = guess - tzOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

export function isWithinQuietHours(hour: number, quiet: { start: number; end: number }): boolean {
  if (quiet.start === quiet.end) return false;
  return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end;
}

/** Earliest instant >= `from` that is outside quiet hours (in the gym's timezone). */
export function nextSendableTime(from: Date, timeZone: string, quiet: { start: number; end: number }): Date {
  if (!isWithinQuietHours(localHour(timeZone, from), quiet)) return from;
  let date = localDate(timeZone, from);
  if (localHour(timeZone, from) >= quiet.end && quiet.start > quiet.end) date = addDays(date, 1);
  const candidate = zonedToUtc(date, `${String(quiet.end).padStart(2, '0')}:00`, timeZone);
  return candidate > from ? candidate : zonedToUtc(addDays(date, 1), `${String(quiet.end).padStart(2, '0')}:00`, timeZone);
}
