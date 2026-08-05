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

-- E08-D029: bản thu nhỏ cho danh sách (256px) và bản vừa cho hồ sơ (1024px).
-- Đo 05/08: mở cửa Gala khi chưa cuộn kéo về 13,03 MB vì mỗi avatar là FILE GỐC
-- (trung bình 1457 KB, lớn nhất 19,87 MB). Cùng ảnh đó thu 256px q75 chỉ còn
-- ~22 KB — gần như không phụ thuộc cỡ gốc.
-- Cả bốn cột NULLABLE và chỉ THÊM: khoá NULL nghĩa là chưa có bản dẫn xuất, mọi
-- đường dẫn tự lùi về ảnh gốc (đúng hành vi trước vé). Nhờ vậy deploy được
-- TRƯỚC khi backfill xong, và backfill dừng giữa chừng không hỏng gì.
-- E08-D031: trạng thái tham dự sửa TAY. NULL = chưa ai đụng → giá trị suy ra từ
-- tag/form (xem server/crm/attendance.js). Cot rieng chu KHONG sua cot tags:
-- import merge tag (ban va sau su co Pha 2), nen chieu "tham du -> khong du"
-- phai XOA tag buoi va luot import sau se gan lai - dung chieu Ly can nhat.
-- Cột riêng ⇒ import không bao giờ chạm, và xoá override là số trở về nguyên trạng.
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS att_override    TEXT;
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS att_override_at TIMESTAMPTZ;
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS att_override_by TEXT;

-- E08-D030: so ghe that. He thong truoc do CHI co so ban; o "Ghe" cu in ra
-- mot so ban thu hai (do prod: 0/378 khach co ca hai) nen da bo o 2a429ab.
-- Nullable: khong co ghe thi KHONG hien o Ghe, tuyet doi khong roi ve so ban.
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS seat_no TEXT;

-- E08-D040 · ghim mềm. Nullable, KHÔNG mặc định: NULL = lùi về hành vi cũ
-- (tấm chân dung mới nhất), nên xấu nhất là y như hôm nay.
-- ON DELETE SET NULL: xoá đúng tấm đang ghim thì cột tự về NULL và avatar lùi
-- về tấm còn lại, không thẻ nào mất mặt (§3g).
-- CHỈ có DDL ở đây. Backfill nằm ở script CLI chạy tay — nhét vào đây thì mỗi
-- lần app restart tối 08/08 là ghim luôn tấm PG vừa chụp (M1).
ALTER TABLE crm_guests ADD COLUMN IF NOT EXISTS avatar_photo_id BIGINT REFERENCES crm_photos(id) ON DELETE SET NULL;

ALTER TABLE crm_photos ADD COLUMN IF NOT EXISTS thumb_key    TEXT;
ALTER TABLE crm_photos ADD COLUMN IF NOT EXISTS thumb_size   INTEGER;
ALTER TABLE crm_photos ADD COLUMN IF NOT EXISTS preview_key  TEXT;
ALTER TABLE crm_photos ADD COLUMN IF NOT EXISTS preview_size INTEGER;
`;

async function migrateCrm() {
  await pool.query(CREATE_SQL);
  console.log('[crm-db] migration ok (CRM tables ready)');
}

module.exports = { migrateCrm };
