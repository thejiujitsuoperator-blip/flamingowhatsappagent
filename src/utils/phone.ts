/** Default country calling code used when an admin types a local 10-digit number. */
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE ?? '91';

/**
 * Normalises a phone number to digits-only international format (no "+").
 * Returns null when the input cannot be a phone number.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = DEFAULT_COUNTRY_CODE + digits;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function phoneToJid(phone: string): string {
  return `${phone}@s.whatsapp.net`;
}

/** Extracts the phone digits from a phone-number JID (xxx@s.whatsapp.net), ignoring device suffixes. */
export function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const user = jid.split('@')[0]!.split(':')[0]!;
  return normalizePhone(user);
}
