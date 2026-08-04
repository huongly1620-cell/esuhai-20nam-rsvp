'use strict';

// CRM schema — SEPARATE tables, never ALTERs the RSVP `rsvp_submissions` table.
// Idempotent: safe to run on every boot.
const { pool } = require('./db');

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS staff_users (
  email       TEXT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff','btl')),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_guests (
  id           BIGSERIAL PRIMARY KEY,
  guest_ext_id TEXT UNIQUE,
  full_name    TEXT NOT NULL,
  phone        TEXT,
  phone_norm   TEXT,
  email        TEXT,
  org          TEXT,
  title        TEXT,
  note         TEXT,
  tags         TEXT,
  response_id  BIGINT,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_guests_phone_norm
  ON crm_guests (phone_norm) WHERE phone_norm IS NOT NULL AND phone_norm <> '';
CREATE INDEX IF NOT EXISTS idx_crm_guests_name ON crm_guests (lower(full_name));
CREATE INDEX IF NOT EXISTS idx_crm_guests_created ON crm_guests (created_at DESC);

CREATE TABLE IF NOT EXISTS crm_assignments (
  id          BIGSERIAL PRIMARY KEY,
  guest_id    BIGINT NOT NULL REFERENCES crm_guests(id) ON DELETE CASCADE,
  staff_email TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guest_id, staff_email)
);
CREATE INDEX IF NOT EXISTS idx_crm_assign_staff ON crm_assignments (staff_email);

CREATE TABLE IF NOT EXISTS crm_check_ins (
  id            BIGSERIAL PRIMARY KEY,
  guest_id      BIGINT NOT NULL UNIQUE REFERENCES crm_guests(id) ON DELETE CASCADE,
  actor_email   TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT
);

CREATE TABLE IF NOT EXISTS crm_interactions (
  id          BIGSERIAL PRIMARY KEY,
  guest_id    BIGINT NOT NULL REFERENCES crm_guests(id) ON DELETE CASCADE,
  actor_email TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'khác',
  body        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_inter_guest ON crm_interactions (guest_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_photos (
  id             BIGSERIAL PRIMARY KEY,
  guest_id       BIGINT NOT NULL REFERENCES crm_guests(id) ON DELETE CASCADE,
  interaction_id BIGINT REFERENCES crm_interactions(id) ON DELETE SET NULL,
  object_key     TEXT NOT NULL,
  content_type   TEXT,
  size           INTEGER,
  uploaded_by    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_photos_guest ON crm_photos (guest_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_audit_events (
  id          BIGSERIAL PRIMARY KEY,
  actor_email TEXT,
  event_type  TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_audit_created ON crm_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_actor ON crm_audit_events (actor_email);

CREATE TABLE IF NOT EXISTS crm_auth_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seating table number (from Ly's xep-ban tool), shown at check-in. CRM table only.
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS table_no TEXT;

-- E08-D028 AC-E: tên / chức vụ / đơn vị tiếng Nhật cho PG Nhật.
-- Additive, nullable — KHÔNG đè field VN. Chỉ nạp ô có ký tự Nhật thật; cột K
-- của sheet SoT có 186 ô nhưng chỉ 63 ô là kanji, 123 ô còn lại là tên Việt
-- viết latin, nạp thẳng sẽ cho PG Nhật thấy tên Việt gắn nhãn "tiếng Nhật".
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS name_jp  TEXT;
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS title_jp TEXT;
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS org_jp   TEXT;
`;

async function migrateCrm() {
  await pool.query(CREATE_SQL);
  console.log('[crm-db] migration ok (CRM tables ready)');
}

module.exports = { migrateCrm };
