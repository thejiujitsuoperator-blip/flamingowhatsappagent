import type { GymConfig } from '../config/gym.js';

export function formatMoney(amount: number, config: GymConfig): string {
  const n = new Intl.NumberFormat(config.currency.locale, {
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
  return `${config.currency.symbol}${n}`;
}

/** Replaces {placeholders}; unknown placeholders are left untouched. */
export function renderTemplate(template: string, vars: Record<string, string | number | undefined | null>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = vars[key];
    return v === undefined || v === null || v === '' ? match : String(v);
  });
}

export function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim().split(/\s+/)[0];
  return n || 'there';
}
