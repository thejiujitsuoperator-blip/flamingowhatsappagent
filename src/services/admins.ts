import type { AppContext } from '../context.js';
import { getOrCreateContactByPhone } from '../repositories/contacts.js';

export function isAdminPhone(ctx: Pick<AppContext, 'adminPhones'>, phone: string | null): boolean {
  return !!phone && ctx.adminPhones.includes(phone);
}

/** Sends an internal notification to every configured admin (e.g. handoffs, trial bookings). */
export async function notifyAdmins(ctx: AppContext, text: string): Promise<void> {
  for (const phone of ctx.adminPhones) {
    const admin = await getOrCreateContactByPhone(ctx.pool, phone);
    if (!admin.is_admin) await ctx.pool.query('UPDATE contacts SET is_admin = TRUE WHERE id = $1', [admin.id]);
    await ctx.outbox.send({ contact: admin, text, source: 'ADMIN_NOTIFICATION' });
  }
}
