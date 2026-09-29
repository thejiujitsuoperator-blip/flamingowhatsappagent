-- Initial schema for the gym WhatsApp agent.
-- The database is the single source of truth; Gemini never stores state.

CREATE TABLE contacts (
  id                BIGSERIAL PRIMARY KEY,
  phone             TEXT UNIQUE,              -- digits only, with country code (e.g. 919876543210)
  wa_jid            TEXT UNIQUE,              -- JID we last received from / reply to
  name              TEXT,
  is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
  opted_out         BOOLEAN NOT NULL DEFAULT FALSE,
  opted_out_at      TIMESTAMPTZ,
  last_inbound_at   TIMESTAMPTZ,
  last_outbound_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (phone IS NOT NULL OR wa_jid IS NOT NULL)
);
CREATE INDEX contacts_name_idx ON contacts (LOWER(name));

CREATE TABLE leads (
  id                   BIGSERIAL PRIMARY KEY,
  contact_id           BIGINT NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL DEFAULT 'NEW'
                       CHECK (stage IN ('NEW','QUALIFIED','TRIAL_BOOKED','FOLLOW_UP','CONVERTED','LOST')),
  name                 TEXT,
  fitness_goal         TEXT,
  preferred_plan       TEXT,
  preferred_join_date  DATE,
  trial_interest       BOOLEAN,
  trial_at             TIMESTAMPTZ,
  notes                TEXT,
  lost_reason          TEXT,
  source               TEXT NOT NULL DEFAULT 'whatsapp',
  converted_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX leads_stage_idx ON leads (stage);
CREATE INDEX leads_created_idx ON leads (created_at);

CREATE TABLE members (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','CANCELLED')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE memberships (
  id                    BIGSERIAL PRIMARY KEY,
  member_id             BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_code             TEXT NOT NULL,
  plan_name             TEXT NOT NULL,
  start_date            DATE NOT NULL,
  expiry_date           DATE NOT NULL,
  monthly_fee           NUMERIC(10,2) NOT NULL CHECK (monthly_fee >= 0),
  billing_cycle_months  INT NOT NULL DEFAULT 1 CHECK (billing_cycle_months > 0),
  auto_renew            BOOLEAN NOT NULL DEFAULT TRUE,
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED','CANCELLED')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- At most one active membership per member.
CREATE UNIQUE INDEX memberships_one_active_idx ON memberships (member_id) WHERE status = 'ACTIVE';

CREATE TABLE payments (
  id             BIGSERIAL PRIMARY KEY,
  member_id      BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  membership_id  BIGINT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  amount         NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  due_date       DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','WAIVED','CANCELLED')),
  paid_amount    NUMERIC(10,2),
  paid_at        TIMESTAMPTZ,
  method         TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (membership_id, due_date)
);
CREATE INDEX payments_pending_due_idx ON payments (due_date) WHERE status = 'PENDING';

-- One conversation thread per contact; holds the automation state.
CREATE TABLE conversations (
  id               BIGSERIAL PRIMARY KEY,
  contact_id       BIGINT NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','NEEDS_HUMAN','HUMAN_ACTIVE','PAUSED')),
  handoff_reason   TEXT,
  handoff_summary  TEXT,
  handoff_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE scheduled_messages (
  id                  BIGSERIAL PRIMARY KEY,
  contact_id          BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'PAYMENT_REMINDER_BEFORE','PAYMENT_REMINDER_DUE','PAYMENT_REMINDER_OVERDUE',
                        'LEAD_FOLLOW_UP','CUSTOM_FOLLOW_UP')),
  dedupe_key          TEXT NOT NULL UNIQUE,   -- prevents duplicate reminders/follow-ups
  body                TEXT NOT NULL,
  send_at             TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','SENDING','SENT','CANCELLED','SKIPPED','FAILED')),
  related_payment_id  BIGINT REFERENCES payments(id) ON DELETE CASCADE,
  related_lead_id     BIGINT REFERENCES leads(id) ON DELETE CASCADE,
  meta                JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  status_reason       TEXT,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX scheduled_messages_due_idx ON scheduled_messages (send_at) WHERE status = 'PENDING';
CREATE INDEX scheduled_messages_contact_idx ON scheduled_messages (contact_id, status);

-- Every inbound and outbound message (including every automated one).
CREATE TABLE message_logs (
  id                    BIGSERIAL PRIMARY KEY,
  contact_id            BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  direction             TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  source                TEXT NOT NULL CHECK (source IN (
                          'CUSTOMER','AGENT','AUTOMATED','HUMAN','SYSTEM','ADMIN_NOTIFICATION')),
  body                  TEXT NOT NULL,
  wa_message_id         TEXT,
  scheduled_message_id  BIGINT REFERENCES scheduled_messages(id) ON DELETE SET NULL,
  tool_calls            JSONB,
  status                TEXT NOT NULL DEFAULT 'OK' CHECK (status IN ('OK','FAILED','IGNORED')),
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX message_logs_wa_id_idx ON message_logs (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX message_logs_contact_idx ON message_logs (contact_id, created_at DESC);
