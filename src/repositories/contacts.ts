import type { Db } from '../db/pool.js';

export interface Contact {
  id: number;
  phone: string | null;
  wa_jid: string | null;
  name: string | null;
  is_admin: boolean;
  opted_out: boolean;
  opted_out_at: Date | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function getContactById(db: Db, id: number): Promise<Contact | null> {
  const { rows } = await db.query<Contact>('SELECT * FROM contacts WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getContactByPhone(db: Db, phone: string): Promise<Contact | null> {
  const { rows } = await db.query<Contact>('SELECT * FROM contacts WHERE phone = $1', [phone]);
  return rows[0] ?? null;
}

/**
 * Finds or creates the contact for an inbound WhatsApp message.
 * Matches on JID first, then phone, and back-fills whichever identifier was missing.
 */
export async function upsertInboundContact(
  db: Db,
  input: { jid: string; phone: string | null; pushName?: string | null; isAdmin: boolean },
): Promise<Contact> {
  let contact: Contact | null = null;
  const byJid = await db.query<Contact>('SELECT * FROM contacts WHERE wa_jid = $1', [input.jid]);
  contact = byJid.rows[0] ?? null;
  if (!contact && input.phone) contact = await getContactByPhone(db, input.phone);

  if (!contact) {
    const { rows } = await db.query<Contact>(
      `INSERT INTO contacts (phone, wa_jid, name, is_admin, last_inbound_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
      [input.phone, input.jid, input.pushName?.trim() || null, input.isAdmin],
    );
    return rows[0]!;
  }

  const { rows } = await db.query<Contact>(
    `UPDATE contacts SET
       wa_jid = $2,
       phone = COALESCE(phone, $3),
       name = COALESCE(name, $4),
       is_admin = $5,
       last_inbound_at = NOW(),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [contact.id, input.jid, input.phone, input.pushName?.trim() || null, input.isAdmin],
  );
  return rows[0]!;
}

export async function getOrCreateContactByPhone(db: Db, phone: string, name?: string | null): Promise<Contact> {
  const { rows } = await db.query<Contact>(
    `INSERT INTO contacts (phone, name) VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET name = COALESCE(contacts.name, EXCLUDED.name), updated_at = NOW()
     RETURNING *`,
    [phone, name?.trim() || null],
  );
  return rows[0]!;
}

export async function updateContactName(db: Db, id: number, name: string): Promise<void> {
  await db.query('UPDATE contacts SET name = $2, updated_at = NOW() WHERE id = $1', [id, name.trim()]);
}

export async function setOptOut(db: Db, id: number, optedOut: boolean): Promise<void> {
  await db.query(
    `UPDATE contacts SET opted_out = $2, opted_out_at = CASE WHEN $2 THEN NOW() ELSE NULL END, updated_at = NOW()
     WHERE id = $1`,
    [id, optedOut],
  );
}

export async function touchOutbound(db: Db, id: number): Promise<void> {
  await db.query('UPDATE contacts SET last_outbound_at = NOW() WHERE id = $1', [id]);
}

/**
 * Searches contacts by phone digits or (partial) name across contacts, leads and members.
 * Used by admin commands such as "Mark Rahul's payment as paid".
 */
export async function searchContacts(db: Db, query: string, limit = 10): Promise<Contact[]> {
  const digits = query.replace(/\D/g, '');
  if (digits.length >= 6) {
    const { rows } = await db.query<Contact>(
      `SELECT * FROM contacts WHERE phone LIKE '%' || $1 ORDER BY updated_at DESC LIMIT $2`,
      [digits.slice(-10), limit],
    );
    return rows;
  }
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const { rows } = await db.query<Contact>(
    `SELECT DISTINCT c.* FROM contacts c
       LEFT JOIN leads l ON l.contact_id = c.id
       LEFT JOIN members m ON m.contact_id = c.id
     WHERE LOWER(c.name) LIKE '%' || $1 || '%'
        OR LOWER(l.name) LIKE '%' || $1 || '%'
        OR LOWER(m.name) LIKE '%' || $1 || '%'
     ORDER BY c.updated_at DESC
     LIMIT $2`,
    [q, limit],
  );
  return rows;
}
