import type { Db } from '../db/pool.js';

export interface Member {
  id: number;
  contact_id: number;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Membership {
  id: number;
  member_id: number;
  plan_code: string;
  plan_name: string;
  start_date: string;
  expiry_date: string;
  monthly_fee: number;
  billing_cycle_months: number;
  auto_renew: boolean;
  status: 'ACTIVE' | 'ENDED' | 'CANCELLED';
  created_at: Date;
  updated_at: Date;
}

export interface Payment {
  id: number;
  member_id: number;
  membership_id: number;
  amount: number;
  due_date: string;
  status: 'PENDING' | 'PAID' | 'WAIVED' | 'CANCELLED';
  paid_amount: number | null;
  paid_at: Date | null;
  method: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A pending payment joined with everything needed to message the member. */
export interface PaymentWithMember extends Payment {
  member_name: string;
  member_status: Member['status'];
  contact_id: number;
  phone: string | null;
  opted_out: boolean;
  plan_name: string;
}

export async function getMemberByContact(db: Db, contactId: number): Promise<Member | null> {
  const { rows } = await db.query<Member>('SELECT * FROM members WHERE contact_id = $1', [contactId]);
  return rows[0] ?? null;
}

export async function getMemberById(db: Db, id: number): Promise<Member | null> {
  const { rows } = await db.query<Member>('SELECT * FROM members WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function insertMember(db: Db, contactId: number, name: string, notes?: string | null): Promise<Member> {
  const { rows } = await db.query<Member>(
    'INSERT INTO members (contact_id, name, notes) VALUES ($1, $2, $3) RETURNING *',
    [contactId, name.trim(), notes ?? null],
  );
  return rows[0]!;
}

export async function updateMemberRow(
  db: Db,
  id: number,
  fields: Partial<Pick<Member, 'name' | 'status' | 'notes'>>,
): Promise<Member> {
  const { rows } = await db.query<Member>(
    `UPDATE members SET
       name = COALESCE($2, name), status = COALESCE($3, status), notes = COALESCE($4, notes), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, fields.name ?? null, fields.status ?? null, fields.notes ?? null],
  );
  if (!rows[0]) throw new Error(`Member ${id} not found`);
  return rows[0];
}

export async function getActiveMembership(db: Db, memberId: number): Promise<Membership | null> {
  const { rows } = await db.query<Membership>(
    `SELECT * FROM memberships WHERE member_id = $1 AND status = 'ACTIVE'`,
    [memberId],
  );
  return rows[0] ?? null;
}

export async function insertMembership(
  db: Db,
  m: Pick<
    Membership,
    'member_id' | 'plan_code' | 'plan_name' | 'start_date' | 'expiry_date' | 'monthly_fee' | 'billing_cycle_months' | 'auto_renew'
  >,
): Promise<Membership> {
  const { rows } = await db.query<Membership>(
    `INSERT INTO memberships (member_id, plan_code, plan_name, start_date, expiry_date, monthly_fee, billing_cycle_months, auto_renew)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [m.member_id, m.plan_code, m.plan_name, m.start_date, m.expiry_date, m.monthly_fee, m.billing_cycle_months, m.auto_renew],
  );
  return rows[0]!;
}

export async function updateMembershipRow(
  db: Db,
  id: number,
  fields: Partial<Pick<Membership, 'expiry_date' | 'monthly_fee' | 'auto_renew' | 'status'>>,
): Promise<Membership> {
  const { rows } = await db.query<Membership>(
    `UPDATE memberships SET
       expiry_date = COALESCE($2, expiry_date),
       monthly_fee = COALESCE($3, monthly_fee),
       auto_renew = COALESCE($4, auto_renew),
       status = COALESCE($5, status),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, fields.expiry_date ?? null, fields.monthly_fee ?? null, fields.auto_renew ?? null, fields.status ?? null],
  );
  if (!rows[0]) throw new Error(`Membership ${id} not found`);
  return rows[0];
}

/** Inserts a payment; returns null if one already exists for that membership + due date. */
export async function insertPayment(
  db: Db,
  p: Pick<Payment, 'member_id' | 'membership_id' | 'amount' | 'due_date'>,
): Promise<Payment | null> {
  const { rows } = await db.query<Payment>(
    `INSERT INTO payments (member_id, membership_id, amount, due_date) VALUES ($1,$2,$3,$4)
     ON CONFLICT (membership_id, due_date) DO NOTHING RETURNING *`,
    [p.member_id, p.membership_id, p.amount, p.due_date],
  );
  return rows[0] ?? null;
}

export async function getPaymentById(db: Db, id: number, forUpdate = false): Promise<Payment | null> {
  const { rows } = await db.query<Payment>(`SELECT * FROM payments WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
  return rows[0] ?? null;
}

/** Oldest unpaid payment for a member (the one currently due/overdue). */
export async function getOutstandingPayment(db: Db, memberId: number): Promise<Payment | null> {
  const { rows } = await db.query<Payment>(
    `SELECT * FROM payments WHERE member_id = $1 AND status = 'PENDING' ORDER BY due_date ASC LIMIT 1`,
    [memberId],
  );
  return rows[0] ?? null;
}

export async function listPendingPayments(db: Db, memberId: number): Promise<Payment[]> {
  const { rows } = await db.query<Payment>(
    `SELECT * FROM payments WHERE member_id = $1 AND status = 'PENDING' ORDER BY due_date ASC`,
    [memberId],
  );
  return rows;
}

export async function listRecentPayments(db: Db, memberId: number, limit = 5): Promise<Payment[]> {
  const { rows } = await db.query<Payment>(
    'SELECT * FROM payments WHERE member_id = $1 ORDER BY due_date DESC LIMIT $2',
    [memberId, limit],
  );
  return rows;
}

const PAYMENT_WITH_MEMBER_SQL = `
  SELECT p.*, m.name AS member_name, m.status AS member_status, m.contact_id, c.phone, c.opted_out, ms.plan_name
    FROM payments p
    JOIN members m ON m.id = p.member_id
    JOIN memberships ms ON ms.id = p.membership_id
    JOIN contacts c ON c.id = m.contact_id`;

/** Pending payments of active members whose due date is within [from, to] (inclusive). */
export async function listPendingPaymentsDueBetween(db: Db, from: string, to: string): Promise<PaymentWithMember[]> {
  const { rows } = await db.query<PaymentWithMember>(
    `${PAYMENT_WITH_MEMBER_SQL}
     WHERE p.status = 'PENDING' AND m.status = 'ACTIVE' AND ms.status = 'ACTIVE'
       AND p.due_date BETWEEN $1 AND $2
     ORDER BY p.due_date ASC, m.name ASC`,
    [from, to],
  );
  return rows;
}

export async function listOverduePayments(db: Db, today: string): Promise<PaymentWithMember[]> {
  const { rows } = await db.query<PaymentWithMember>(
    `${PAYMENT_WITH_MEMBER_SQL}
     WHERE p.status = 'PENDING' AND m.status = 'ACTIVE' AND ms.status = 'ACTIVE' AND p.due_date < $1
     ORDER BY p.due_date ASC, m.name ASC`,
    [today],
  );
  return rows;
}

export async function getPaymentWithMember(db: Db, paymentId: number): Promise<PaymentWithMember | null> {
  const { rows } = await db.query<PaymentWithMember>(`${PAYMENT_WITH_MEMBER_SQL} WHERE p.id = $1`, [paymentId]);
  return rows[0] ?? null;
}

export async function setPaymentStatus(
  db: Db,
  id: number,
  fields: { status: Payment['status']; paid_amount?: number | null; method?: string | null; notes?: string | null },
): Promise<Payment> {
  const { rows } = await db.query<Payment>(
    `UPDATE payments SET
       status = $2,
       paid_amount = $3,
       paid_at = CASE WHEN $2 = 'PAID' THEN NOW() ELSE paid_at END,
       method = COALESCE($4, method),
       notes = COALESCE($5, notes),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, fields.status, fields.paid_amount ?? null, fields.method ?? null, fields.notes ?? null],
  );
  if (!rows[0]) throw new Error(`Payment ${id} not found`);
  return rows[0];
}

export async function cancelPendingPaymentsForMembership(db: Db, membershipId: number): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE payments SET status = 'CANCELLED', updated_at = NOW()
     WHERE membership_id = $1 AND status = 'PENDING' RETURNING id`,
    [membershipId],
  );
  return rows.map((r) => r.id);
}

export async function paymentStats(db: Db, from: Date, to: Date) {
  const { rows } = await db.query<{ collected: number; payments: number }>(
    `SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0)::float AS collected, COUNT(*)::int AS payments
       FROM payments WHERE status = 'PAID' AND paid_at >= $1 AND paid_at < $2`,
    [from, to],
  );
  return rows[0]!;
}
