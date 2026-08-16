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

-- E08-D047: check-in THEO BUỔI (toa-dam | gala). Trước đây guest_id UNIQUE
-- ⇒ một lần bấm ở Tọa đàm làm cửa Gala cũng hiện «đã đến».
CREATE TABLE IF NOT EXISTS crm_check_ins (
  id            BIGSERIAL PRIMARY KEY,
  guest_id      BIGINT NOT NULL REFERENCES crm_guests(id) ON DELETE CASCADE,
  session       TEXT NOT NULL DEFAULT 'gala' CHECK (session IN ('toa-dam','gala')),
  actor_email   TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT,
  UNIQUE (guest_id, session)
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

-- E08-D047 · bảng cũ (guest_id UNIQUE, không cột session) → theo buổi.
-- Idempotent: chạy lại an toàn khi cột/index đã có.
ALTER TABLE crm_check_ins ADD COLUMN IF NOT EXISTS session TEXT;

/* ─────────── E08-D082 · KHO ẢNH SỰ KIỆN (bảng RIÊNG, không đụng crm_photos) ───────────
   CHÚ Ý người sửa sau: khối này là template literal của JS, mở và đóng bằng dấu
   huyền. Đừng dùng dấu huyền để trích tên cột trong chú thích — chuỗi sẽ đứt
   giữa chừng và cả file hỏng cú pháp. (Đã dính đúng lỗi này khi viết vé D082.)

   BẢNG MỚI chứ không nới crm_photos.guest_id thành nullable. Lý do không phải
   khẩu vị: avatar khách ở CẢ BỐN màn đang chạy thật là «ảnh mới nhất của thẻ»
   (idx_crm_photos_guest = guest_id, created_at DESC). Ảnh phóng sự thì CHƯA biết
   của ai — đó đúng là bài toán D077 phải giải. Cho nó vào chung bảng nghĩa là
   một tấm ảnh sân khấu chưa gán ai sẽ thành mặt của một khách nào đó trên mọi
   danh sách, và không có đường lùi. Tách bảng thì hỏng cũng chỉ hỏng trong kho.

   Cột guest_id KHÔNG có ở đây. Liên kết ảnh↔khách là việc của D077 và chỉ ghi
   sau khi BTL bấm Xác nhận tay (CR-127) — sẽ nằm ở bảng khớp riêng, không phải
   một cột trong bảng này.

   sha256 là của FILE GỐC trên đĩa, tính ở trình duyệt trước khi thu nhỏ. Nhờ nó
   mà chọn trùng thư mục hai lần không đẻ bản ghi thứ hai, và người dùng thấy
   ngay «đã có rồi» thay vì ngồi chờ upload lại 3.000 tấm.
   UNIQUE một phần (WHERE deleted_at IS NULL): gỡ một tấm rồi nạp lại được. */
CREATE TABLE IF NOT EXISTS crm_event_photos (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'thiet-bi'
                CHECK (source IN ('thiet-bi','dropbox','onedrive','google-drive')),
  sha256        TEXT NOT NULL,
  orig_name     TEXT NOT NULL,
  rel_path      TEXT,
  taken_at      TIMESTAMPTZ,
  object_key    TEXT NOT NULL,
  content_type  TEXT,
  size          INTEGER,
  width         INTEGER,
  height        INTEGER,
  thumb_key     TEXT,
  thumb_size    INTEGER,
  preview_key   TEXT,
  preview_size  INTEGER,
  uploaded_by   TEXT NOT NULL,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_event_photos_sha
  ON crm_event_photos (sha256) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_event_photos_batch
  ON crm_event_photos (batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_event_photos_live
  ON crm_event_photos (created_at DESC) WHERE deleted_at IS NULL;

/* ── E08-D077 · nhận diện khuôn mặt ──────────────────────────────────────────
   Ba bảng, tách theo ba thứ khác nhau về bản chất:
     crm_face_samples    — MẶT MẪU của khách (biết là ai)
     crm_event_faces     — mặt tìm thấy trong ảnh sự kiện (chưa biết là ai)
     crm_face_candidates — một phỏng đoán nối hai cái trên, CHỜ người xác nhận

   Vì sao không gộp: mặt mẫu sống lâu và ít, mặt sự kiện đông và có hạn dùng, còn
   phỏng đoán thì bị người sửa suốt. Gộp lại thì mỗi lần chạy lại một đợt là phải
   đụng vào cả dữ liệu đã được người duyệt.

   KHÔNG cột nào ở đây ghi đè crm_photos / crm_guests (AC-1). avatar_photo_id là
   việc của D048, vé này không chạm (AC-11). */

CREATE TABLE IF NOT EXISTS crm_face_samples (
  id              BIGSERIAL PRIMARY KEY,
  guest_id        BIGINT NOT NULL REFERENCES crm_guests(id) ON DELETE CASCADE,
  /* 'crm-photos' = cắt từ ảnh chân dung đã gắn khách sẵn.
     'cat-tay'    = BTL khoanh mặt trên ảnh sự kiện rồi gán khách (FR-10).
     Phân biệt được nguồn là điều kiện để gỡ dây chuyền khi một lần khoanh sai. */
  nguon           TEXT NOT NULL CHECK (nguon IN ('crm-photos','cat-tay')),
  photo_id        BIGINT REFERENCES crm_photos(id) ON DELETE SET NULL,
  event_photo_id  BIGINT REFERENCES crm_event_photos(id) ON DELETE CASCADE,
  box_x           REAL NOT NULL, box_y REAL NOT NULL,
  box_w           REAL NOT NULL, box_h REAL NOT NULL,
  moc             JSONB,                    -- 5 mốc, để căn lại mà không dò lại
  /* vec CÓ THỂ RỖNG, và đó là hệ quả của một ràng buộc khác: cấm nhét ONNX vào
     image esuhai-web. Nên khi BTL khoanh mặt (FR-10), trang web chỉ ghi được
     KHUNG; vector do batch tính ở lượt chạy sau, nơi có engine. Mẫu chờ tính là
     mẫu chưa dùng được, không phải mẫu hỏng. */
  vec             BYTEA,                    -- 128 float32; KHÔNG log ra ngoài
  /* Q4 · mẫu cắt từ ảnh sự kiện cũng là dữ liệu sinh trắc. Gỡ ảnh mà chỉ đặt
     deleted_at thì vector của mẫu Ở LẠI Postgres, và không có cột nào để nói nó
     đã đi. Cùng khuôn với crm_event_faces: xoá vec, ghi LÚC xoá.

     N1 · Nhưng mẫu KHÔNG hết hạn theo đồng hồ, khác crm_event_faces. Hai thứ này
     khác nhau về bản chất: vector mặt sự kiện là chỉ mục hàng loạt, không ai
     quyết định gì; vector mẫu là hệ quả của MỘT quyết định của người — BTL khoanh
     mặt để dạy máy nhận ra một khách không có ảnh chân dung.
     Cho mẫu hết hạn theo đồng hồ vừa vô nghĩa vừa nguy hiểm: ảnh nguồn vẫn nằm
     đó nên vector luôn tính lại được (hết hạn không xoá được gì thật), mà lượt
     batch kế tiếp sẽ tính lại đúng cái vừa xoá — sinh ra hàng vừa GIỮ sinh trắc
     vừa mang vec_xoa_luc, tức dấu chứng minh đã xoá lại chứng minh điều ngược
     lại. Đường xoá thật của mẫu là: gỡ ảnh nguồn (cascade), gỡ mẫu, hoặc xoá
     cứng ảnh — cả ba đều gắn với vòng đời dữ liệu, không gắn với đồng hồ. */
  vec_xoa_luc     TIMESTAMPTZ,
  diem_do         REAL,                     -- điểm YuNet lúc lấy mẫu
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  /* Mẫu phải biết mình từ đâu ra: một trong hai nguồn, đúng một. */
  CHECK ((nguon = 'crm-photos' AND photo_id IS NOT NULL)
      OR (nguon = 'cat-tay'    AND event_photo_id IS NOT NULL)),
  /* N1 · Không hàng nào được vừa giữ vector vừa mang dấu đã xoá vector. Đặt ở
     tầng CSDL chứ không ở tầng ứng dụng: một lời hứa về dữ liệu sinh trắc không
     nên phụ thuộc vào việc mọi đường ghi đều nhớ kiểm. */
  CONSTRAINT ck_face_samples_vec_xoa CHECK (vec IS NULL OR vec_xoa_luc IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_face_samples_guest
  ON crm_face_samples (guest_id) WHERE deleted_at IS NULL;
/* Mẫu khoanh tay đang chờ batch tính vector. */
CREATE INDEX IF NOT EXISTS idx_face_samples_cho_tinh
  ON crm_face_samples (created_at) WHERE deleted_at IS NULL AND vec IS NULL;
CREATE INDEX IF NOT EXISTS idx_face_samples_tu_anh_su_kien
  ON crm_face_samples (event_photo_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS crm_event_faces (
  id              BIGSERIAL PRIMARY KEY,
  event_photo_id  BIGINT NOT NULL REFERENCES crm_event_photos(id) ON DELETE CASCADE,
  box_x           REAL NOT NULL, box_y REAL NOT NULL,
  box_w           REAL NOT NULL, box_h REAL NOT NULL,
  /* canh_px tính trên ẢNH GỐC, không trên bản 640 đưa vào model — mọi ngưỡng
     FR-8 phải nói về ảnh thật. do_net để tách chủ thể khỏi người qua đường:
     số đo đầu cho thấy KÍCH THƯỚC một mình không tách được (người mờ phía sau
     vẫn 79–87px, mà cả một khung đám đông thật thì 51–78px). */
  canh_px         REAL NOT NULL,
  do_net          REAL,
  diem_do         REAL NOT NULL,
  moc             JSONB,
  /* E08-D134 · vector mặt sự kiện KHÔNG hết hạn theo đồng hồ nữa.
     Bản D077 giữ 7 ngày với lập luận: vector chỉ để SINH gợi ý, mà dò+căn+nhúng
     chỉ 42ms/ảnh nên tính lại cả kho mất ~1 phút — đổi sinh trắc lấy một phút CPU
     là món hời. Lập luận ấy hỏng ở đúng chỗ nó không nhìn tới: khi CRM có avatar
     hoặc mẫu MỚI, đội vận hành phải tái tìm ảnh của khách trên TOÀN BỘ kho đã lưu.
     Muốn thế thì phải có vector của những khuôn mặt đã dò; tính lại cả kho nghĩa
     là tải lại từng tấm và dò lại từng khung — không phải một phút, và không phải
     việc làm được mỗi lần BTL khoanh thêm một mẫu.
     Sponsor 16/08/2026: giữ cả hai loại vector, giữ vĩnh viễn.
     VĨNH VIỄN Ở ĐÂY KHÔNG PHẢI BẤT KHẢ XOÁ: vector sống chừng nào bản ghi nguồn
     còn sống. Gỡ ảnh, gỡ mẫu, xoá khách, yêu cầu xoá hợp lệ vẫn cascade y như cũ
     (xem event-photos.js và face-match.js) — cái bị bỏ là ĐỒNG HỒ, không phải
     đường xoá. */
  vec             BYTEA,
  vec_xoa_luc     TIMESTAMPTZ,          -- ghi LÚC xoá: chứng minh được, không chỉ là vắng mặt
  run_id          TEXT NOT NULL,
  /* N1 · cùng ràng buộc như bảng mẫu: giữ vector và mang dấu đã xoá là hai điều
     không thể cùng đúng. */
  CONSTRAINT ck_event_faces_vec_xoa CHECK (vec IS NULL OR vec_xoa_luc IS NULL),
  /* D134 · CỘT NGHỈ HƯU, cố ý không xoá. Ba lý do, lý do thứ ba mới là lý do thật:
       1 · không ai đọc nó nữa (mọi đường TTL đã gỡ ở vé này);
       2 · bỏ cột là một lượt ghi không lùi được, mà spec cấm mọi thao tác xoá dữ
           liệu không có quyết định Sponsor riêng;
       3 · ROLLBACK. Rollback mã ở dự án này là redeploy commit cũ, và commit cũ
           mang nguyên câu quét hạn. Nếu bỏ cột, bản cũ ném "column does not exist"
           — mà face-match.js nuốt đúng lỗi đó còn batch.js thì thoát mã 1, tức cả
           đường nhận diện đứng. Giữ cột + để TRỐNG thì bản cũ chạy bình thường và
           xoá 0 hàng, vì NULL <= now() không bao giờ đúng.
     Vì thế cột nullable, KHÔNG default, KHÔNG index, và mọi hàng cũ được đặt về
     NULL trong migrateCrm(). CẤM dùng lại làm điều kiện xoá vector. */
  het_han_luc     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_event_faces_anh
  ON crm_event_faces (event_photo_id) WHERE deleted_at IS NULL;
/* D134 · idx_event_faces_can_don (chỉ mục của lượt quét hạn) đã bỏ — xem khối
   nâng cấp cuối tệp cho CSDL đã có sẵn chỉ mục ấy. */

CREATE TABLE IF NOT EXISTS crm_face_candidates (
  id              BIGSERIAL PRIMARY KEY,
  event_photo_id  BIGINT NOT NULL REFERENCES crm_event_photos(id) ON DELETE CASCADE,
  face_id         BIGINT REFERENCES crm_event_faces(id) ON DELETE CASCADE,
  guest_id        BIGINT NOT NULL REFERENCES crm_guests(id) ON DELETE CASCADE,
  /* sample_id = mẫu nào đẻ ra phỏng đoán này. Không có cột này thì gỡ một mẫu
     khoanh sai xong không biết những khớp nào sinh từ nó (AC-10). */
  sample_id       BIGINT REFERENCES crm_face_samples(id) ON DELETE SET NULL,
  score           REAL,                     -- NULL khi người gán tay (FR-4b)
  nguon           TEXT NOT NULL DEFAULT 'may' CHECK (nguon IN ('may','tay')),
  trang_thai      TEXT NOT NULL DEFAULT 'cho'
                  CHECK (trang_thai IN ('cho','xac-nhan','tu-choi','bo-qua')),
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  run_id          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
/* Một khuôn mặt chỉ nên có một dòng cho mỗi khách — chạy lại đợt không được đẻ
   bản sao. Người gán tay (face_id NULL) không rơi vào ràng buộc này. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_face_candidates_mat_khach
  ON crm_face_candidates (face_id, guest_id)
  WHERE deleted_at IS NULL AND face_id IS NOT NULL;
/* Q6 · gán tay không có face_id nên KHÔNG rơi vào unique một phần ở trên: bấm
   hai lần đẻ hai dòng album và so_album đếm phồng. Chặn riêng cho nhánh đó. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_face_candidates_gan_tay
  ON crm_face_candidates (event_photo_id, guest_id)
  WHERE deleted_at IS NULL AND face_id IS NULL;

/* ── E08-D115 · MỘT TẤM ĐẾM MỘT LẦN ────────────────────────────────────────────
   Hai unique trên đây mỗi cái đúng phần của nó, nhưng cộng lại vẫn hở đúng ở
   giữa: (P, F, G) rơi vào cái thứ nhất, (P, NULL, G) rơi vào cái thứ hai, không
   cái nào thấy cái kia. Ai duyệt gợi ý máy rồi lại gắn tên tay cho cùng tấm ấy
   thì tấm đó nằm HAI dòng trong album của cùng một khách — lưới hiện hai lần,
   con số phồng, và người gửi ảnh cho khách không biết mình gửi trùng.
   Bất biến đúng phải nói về (TẤM, KHÁCH) chứ không về mặt: một khách chỉ có một
   dòng album cho một tấm, dù dòng ấy sinh ra từ máy hay từ tay.

   Hai unique cũ GIỮ NGUYÊN — chúng chặn lớp lỗi khác (chạy lại đợt nhận diện đẻ
   bản sao gợi ý khi trạng thái còn 'cho'), mà unique mới không phủ vì nó chỉ
   nhìn dòng đã 'xac-nhan'.

   THỨ TỰ Ở ĐÂY LÀ MỘT PHẦN CỦA VÉ: khối gộp phải đứng TRƯỚC lệnh tạo unique.
   CSDL nào đang mang sẵn dòng trùng (prod đang mang) thì tạo index trước là
   lỗi, mà server/index.js bắt lỗi migrate rồi VẪN cho app lên — tức bất biến im
   lặng không ra đời còn app thì chạy tiếp. Cả CREATE_SQL đi trong MỘT câu simple
   query nên nằm chung một transaction ngầm: hoặc gộp xong rồi có unique, hoặc
   không có gì đổi. */
DO $gopdoi$
DECLARE so_dong INT; so_cap INT;
BEGIN
  /* Dòng nào sống: dòng CÓ face_id (nó mang khung mặt — bỏ nó là mất chỗ đã
     khoanh), hoà thì id nhỏ nhất. Dòng thua mang deleted_at, KHÔNG DELETE: gộp
     nhầm còn lần ngược được, và mọi câu đọc đều đã lọc deleted_at IS NULL. */
  WITH xep AS (
    SELECT id,
           first_value(id) OVER (PARTITION BY event_photo_id, guest_id
                                 ORDER BY (face_id IS NULL), id) AS id_song
      FROM crm_face_candidates
     WHERE deleted_at IS NULL AND trang_thai = 'xac-nhan'
  ), thua AS (
    SELECT id, id_song FROM xep WHERE id <> id_song
  ), da_go AS (
    UPDATE crm_face_candidates c SET deleted_at = now()
      FROM thua t WHERE c.id = t.id
      RETURNING c.id, c.event_photo_id, c.guest_id, t.id_song
  ), ghi AS (
    INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta)
    SELECT 'he-thong', 'face_gop_doi', 'event_photo', d.event_photo_id::text,
           jsonb_build_object('ve', 'E08-D115', 'guest_id', d.guest_id,
                              'id_song', d.id_song, 'id_bo', d.id, 'nguon', 'migrate')
      FROM da_go d
    RETURNING target_id, meta
  )
  SELECT count(*), count(DISTINCT (target_id, meta ->> 'guest_id'))
    INTO so_dong, so_cap FROM ghi;
  IF so_dong > 0 THEN
    RAISE NOTICE 'D115: gop % dong album trung tren % cap (tam, khach)', so_dong, so_cap;
  END IF;
END $gopdoi$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_face_candidates_album_tam
  ON crm_face_candidates (event_photo_id, guest_id)
  WHERE deleted_at IS NULL AND trang_thai = 'xac-nhan';
CREATE INDEX IF NOT EXISTS idx_face_candidates_cho
  ON crm_face_candidates (score DESC) WHERE deleted_at IS NULL AND trang_thai = 'cho';
/* Album của một khách = đúng những dòng đã xác nhận (FR-7). */
CREATE INDEX IF NOT EXISTS idx_face_candidates_album
  ON crm_face_candidates (guest_id, created_at DESC)
  WHERE deleted_at IS NULL AND trang_thai = 'xac-nhan';
CREATE INDEX IF NOT EXISTS idx_face_candidates_theo_anh
  ON crm_face_candidates (event_photo_id) WHERE deleted_at IS NULL;

/* ── E08-D120 · SỔ CHIA SẺ ALBUM (một người một link) ─────────────────────────
   Bảng này KHÔNG phải sổ khách thứ hai và KHÔNG phải timeline: nó chỉ ghi việc
   một đường dẫn đã được phát cho ai, lúc nào, và khách đã mở chưa. Mọi dữ liệu
   khách vẫn nằm nguyên ở crm_guests (trục [X]); ở đây chỉ có guest_id.

   Ba điều được đặt ở TẦNG CSDL chứ không ở tầng ứng dụng, vì cả ba là lời hứa
   với người thật, không nên phụ thuộc vào việc mọi đường ghi tương lai đều nhớ:

   · token_hash UNIQUE, và LƯU BĂM. Cột này không bao giờ chứa bản thô — rò một
     bản sao lưu CSDL không đưa cho ai một đường dẫn dùng được.
   · MỘT LINK ĐANG SỐNG cho mỗi khách (luật 1): unique một phần trên guest_id
     với điều kiện chưa thu hồi. Tạo lại buộc phải thu hồi cái cũ trước, nếu
     không CSDL từ chối — «link cũ chết» không thể quên.
   · CHECK (dong_y): không hàng nào tồn tại mà thiếu ô tick đồng ý (luật 6).
     Sổ share vì thế KHÔNG THỂ mang một dòng không có người đồng ý.

   Hàng đã thu hồi Ở LẠI — đó chính là sổ: AC-8 đòi còn thấy lần share trước. */
CREATE TABLE IF NOT EXISTS crm_album_links (
  id           BIGSERIAL PRIMARY KEY,
  guest_id     BIGINT NOT NULL REFERENCES crm_guests(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_by   TEXT NOT NULL,
  dong_y       BOOLEAN NOT NULL DEFAULT false,
  het_han_luc  TIMESTAMPTZ NOT NULL,
  thu_hoi_luc  TIMESTAMPTZ,
  thu_hoi_boi  TEXT,
  so_lan_mo    INTEGER NOT NULL DEFAULT 0,
  mo_lan_dau   TIMESTAMPTZ,
  mo_gan_nhat  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_album_links_dong_y CHECK (dong_y)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_album_links_song
  ON crm_album_links (guest_id) WHERE thu_hoi_luc IS NULL;
CREATE INDEX IF NOT EXISTS idx_album_links_guest
  ON crm_album_links (guest_id, created_at DESC);

/* ── E08-D124 · SỔ VIỆC ĐOÁN MẶT (một việc một lúc) ──────────────────────────
   Trước vé này, đợt nhận diện chỉ chạy từ máy người kỹ thuật nên «đang chạy hay
   không» là thứ chỉ người ấy biết. Nay ban tổ chức tự bấm, nên trạng thái phải
   nằm ở chỗ mọi tab và mọi lần F5 đều đọc được — tức trong CSDL, không trong một
   biến của tiến trình máy chủ (biến ấy chết theo mỗi lần deploy).

   Bảng cố ý NGHÈO: đếm và một câu lỗi, không giữ log. Nó nằm cạnh dữ liệu khách
   nên mọi cột thêm vào đây là một cột phải trả lời câu hỏi PDPL — không tên
   khách, không token, không chuỗi kết nối. Cột boi là email nhân sự BTL, cùng
   loại dữ liệu với crm_audit_events.actor_email đã có.

   UNIQUE MỘT PHẦN LÀ CÁI KHOÁ, và đó là điểm của cả bảng: «một việc một lúc»
   không được phép phụ thuộc vào việc mọi đường mở việc tương lai đều nhớ kiểm
   trước. Chỉ mục đặt trên chính cột trạng thái với điều kiện chỉ nhìn hàng đang
   chạy, nên nhiều nhất một hàng như thế tồn tại — hai tab bấm cùng một phần nghìn
   giây thì một cú thắng, cú kia nhận 23505.
   (Nhắc lại cảnh báo đầu khối D082: đây là chuỗi mẫu JS — KHÔNG dấu huyền trong
   chú thích, kể cả để trích tên cột. Vừa dẫm phải đúng bẫy đó lần thứ ba.) */
CREATE TABLE IF NOT EXISTS crm_nhan_dien_runs (
  id          BIGSERIAL PRIMARY KEY,
  trang_thai  TEXT NOT NULL DEFAULT 'chay' CHECK (trang_thai IN ('chay','xong','loi')),
  /* 'tay' = bấm nút trên trang ảnh · 'nap-kho' = tự chạy sau một lượt nạp ảnh. */
  nguon       TEXT NOT NULL DEFAULT 'tay' CHECK (nguon IN ('tay','nap-kho')),
  boi         TEXT NOT NULL,
  bat_dau     TIMESTAMPTZ NOT NULL DEFAULT now(),
  xong_luc    TIMESTAMPTZ,
  so_mau      INTEGER,                   -- mẫu khoanh tay vừa tính được vector
  so_tam      INTEGER,                   -- tấm chưa có hàng mặt, lượt này dò
  so_goi_y    INTEGER,                   -- gợi ý sinh thêm (tấm mới + khớp lại)
  loi         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_nhan_dien_runs_dang_chay
  ON crm_nhan_dien_runs (trang_thai) WHERE trang_thai = 'chay';

/* ── E08-D126 · NHIỀU LUỒNG, TẠM DỪNG ĐƯỢC, THẤY TIẾN ĐỘ ─────────────────────
   D124 dựng sổ việc cho MỘT việc chạy tới cùng. Tối 11/08 chạy thật 5 luồng thì
   lộ ra ba chỗ bảng ấy không đỡ nổi, và cả ba đều là lược đồ chứ không phải giao
   diện:

     1 · Chia việc bằng OFFSET tính tay. Hàng đợi co lại trong lúc chạy nên hai
         cửa sổ có thể chồng nhau, và crm_event_faces KHÔNG có ràng buộc chống
         một tấm bị hai luồng soi. Nay chia việc bằng cách GIỮ ẢNH: một luồng
         đóng dấu tên mình lên 25 tấm bằng FOR UPDATE SKIP LOCKED, nên hai luồng
         không thể cầm cùng một tấm kể cả khi khởi động cùng giây.

     2 · Hàng đợi cũ là «tấm chưa có hàng mặt», nên 1.217 tấm đã biết không có
         mặt người nằm lại đầu hàng đợi và ăn 26 phút MỖI lượt. Nay hàng đợi là
         soi_luc IS NULL — soi rồi thì đánh dấu, kể cả khi không thấy mặt nào.
         Đây cũng là điều kiện để phần trăm tiến độ nói thật.

     3 · Không có chỗ nào ghi «luồng số 3 đang sống hay đã chết». Nay mỗi luồng
         một hàng, có nhịp (heartbeat); quá 3 phút không nhịp thì web đánh
         mat-lien-lac và nhả ảnh nó đang giữ về hàng đợi.

   Vẫn NGHÈO CÓ CHỦ Ý như D124: đếm, nhịp, một câu lỗi. Không tên khách, không
   token, không chuỗi kết nối, không giữ log. Cột may là tên máy (hostname) —
   để người vận hành biết luồng nào chạy ở đâu, không phải danh tính người.
   (Nhắc lại: khối này là chuỗi mẫu JS — KHÔNG dấu huyền trong chú thích.) */

/* Trạng thái nới ra hai nấc mới. tam-dung là «đang mở nhưng ngủ», huy là «người
   bấm Dừng hẳn». Ràng buộc D124 do Postgres tự đặt tên; đặt tên mới cho cái của
   mình rồi hỏi catalog, vì Postgres không có ADD CONSTRAINT IF NOT EXISTS. */
DO $d126$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'crm_nhan_dien_runs'::regclass
                    AND conname = 'ck_nhan_dien_runs_trang_thai') THEN
    ALTER TABLE crm_nhan_dien_runs
      DROP CONSTRAINT IF EXISTS crm_nhan_dien_runs_trang_thai_check;
    ALTER TABLE crm_nhan_dien_runs
      ADD CONSTRAINT ck_nhan_dien_runs_trang_thai
      CHECK (trang_thai IN ('chay','xong','loi','tam-dung','huy'));
  END IF;
END $d126$;

ALTER TABLE crm_nhan_dien_runs ADD COLUMN IF NOT EXISTS so_luong INTEGER NOT NULL DEFAULT 1;
ALTER TABLE crm_nhan_dien_runs ADD COLUMN IF NOT EXISTS nguong   REAL;

/* Cái khoá đổi NGHĨA, không đổi vai: D124 chặn «một việc một lúc» bằng chỉ mục
   trên chính cột trạng thái với điều kiện chay. Nay một đợt đang TẠM DỪNG vẫn là
   một đợt đang mở — cho mở đợt thứ hai chồng lên là để hai đợt cùng tranh một
   hàng đợi. Chỉ mục cũ không làm được việc ấy: chay và tam-dung là hai giá trị
   khác nhau nên nó cho phép mỗi loại một hàng. Nên chỉ mục mới đặt trên một
   BIỂU THỨC luôn đúng bên trong điều kiện lọc — nhiều nhất một hàng như thế tồn
   tại, bất kể nó đang chạy hay đang ngủ. Hai tab bấm cùng lúc: một cú nhận 23505. */
DROP INDEX IF EXISTS uq_nhan_dien_runs_dang_chay;
CREATE UNIQUE INDEX IF NOT EXISTS uq_nhan_dien_runs_dot_mo
  ON crm_nhan_dien_runs ((trang_thai IN ('chay','tam-dung')))
  WHERE trang_thai IN ('chay','tam-dung');

/* Một hàng một LUỒNG. so là số thứ tự người nhìn thấy trên bảng (1..6), id là
   thứ máy quét đóng dấu lên ảnh nó giữ.
   so_loi đếm TẤM lỗi; loi giữ MỘT câu cho người đọc. Hai thứ khác nhau: con số
   để bảng tô đỏ khi vượt 5%, câu để người biết vì sao luồng tự hãm. */
CREATE TABLE IF NOT EXISTS crm_nhan_dien_luong (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES crm_nhan_dien_runs(id) ON DELETE CASCADE,
  so            INTEGER NOT NULL,
  /* huy có mặt vì FR-4 nói huy là một CỜ web đặt được lên luồng, và vì một luồng
     bị người bấm Dừng hẳn không phải là xong (nó chưa làm hết việc) cũng không
     phải là loi (không có gì hỏng). Gắn nhãn sai ở đây là làm sổ nói dối đúng
     chỗ người ta sẽ đọc để hiểu chuyện gì đã xảy ra. */
  trang_thai    TEXT NOT NULL DEFAULT 'cho'
                CHECK (trang_thai IN ('cho','chay','tam-dung','xong','loi','mat-lien-lac','huy')),
  may           TEXT,                    -- hostname máy quét, KHÔNG phải người
  nhip_cuoi     TIMESTAMPTZ,             -- lần cuối luồng còn thở
  bat_dau       TIMESTAMPTZ,
  xong_luc      TIMESTAMPTZ,
  da_soi        INTEGER NOT NULL DEFAULT 0,
  so_mat        INTEGER NOT NULL DEFAULT 0,
  goi_y         INTEGER NOT NULL DEFAULT 0,
  so_loi        INTEGER NOT NULL DEFAULT 0,
  anh_hien_tai  TEXT,                    -- TÊN TỆP đang xử lý, không phải tên khách
  loi           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
/* Số thứ tự là duy nhất trong một đợt: hai luồng cùng mang số 3 thì mọi câu người
   vận hành nói («tạm dừng luồng 3») mất nghĩa. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_nhan_dien_luong_so
  ON crm_nhan_dien_luong (run_id, so);
CREATE INDEX IF NOT EXISTS idx_nhan_dien_luong_song
  ON crm_nhan_dien_luong (nhip_cuoi) WHERE trang_thai IN ('chay','tam-dung');

/* ── E08-D127 · MÁY QUÉT THỞ CẢ LÚC CHƯA CÓ VIỆC ─────────────────────────────
   D126 chỉ có một chỗ để biết máy quét còn sống: nhịp của một hàng LUỒNG. Mà
   luồng chỉ tồn tại sau khi có người bấm Bắt đầu — nên 6h sáng 12/08, ba máy quét
   đang đứng chờ trên máy anh Kha, trang vẫn nói "chưa có máy quét nào". Câu ấy
   sai đúng lúc nó quan trọng nhất: người ta đọc nó TRƯỚC khi bấm, để quyết định
   có bấm hay không.

   Nên nơi ghi "tôi còn sống" phải TÁCH khỏi nơi ghi "tôi đang làm gì". Bảng này
   là cái thứ nhất, và nó nghèo hơn cả sổ luồng: một tên máy, một pid, một giờ.
   Không đếm, không câu lỗi, không tên khách — nó chỉ trả lời đúng một câu hỏi.

   Khoá chính là (may, pid) chứ không phải may một mình: ba tiến trình --truc chạy
   trên CÙNG một máy tính là cách vận hành thật (Sponsor mở ba cửa sổ terminal),
   và khoá theo tên máy thì ba tiến trình ấy đè lên nhau thành một hàng — bảng nói
   "1 máy quét" trong khi có ba. pid mặc định 0 để một máy quét không khai pid vẫn
   có chỗ đứng, đúng nghĩa "pid tuy chon" của spec.
   pid KHÔNG hiện lên giao diện: nó ở đây để phân biệt hàng, không để người đọc.
   (Nhắc lại: khối này là chuỗi mẫu JS — KHONG dau huyen trong chu thich.) */
CREATE TABLE IF NOT EXISTS crm_nhan_dien_may (
  may       TEXT NOT NULL,
  pid       INTEGER NOT NULL DEFAULT 0,
  nhip_cuoi TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (may, pid)
);
/* Web dọn hàng quá hạn mỗi 30 giây và đếm hàng còn thở mỗi 3 giây — cả hai đều
   hỏi theo nhip_cuoi, nên nó cần chỉ mục dù bảng chỉ có vài hàng. */
CREATE INDEX IF NOT EXISTS idx_nhan_dien_may_nhip
  ON crm_nhan_dien_may (nhip_cuoi);

/* ── Dấu ĐÃ SOI trên chính bảng ảnh ────────────────────────────────────────────
   Bốn cột, hai vai khác nhau và cố ý không gộp:
     soi_luc      — soi XONG lúc nào. Đây là hàng đợi mới (NULL = chưa soi).
     soi_luong_id — luồng nào đang GIỮ tấm này. Chỉ có nghĩa khi soi_luc IS NULL;
                    soi xong thì nhả về NULL, nên «đang giữ mà đã soi» là 0 hàng
                    (AC-2 kiểm đúng câu ấy).
     soi_giu_luc  — giữ từ lúc nào, để nhìn ra tấm bị kẹt.
     soi_so_mat   — thấy mấy mặt. 0 là một câu trả lời, không phải thiếu dữ liệu.

   KHÔNG khoá ngoại từ soi_luong_id sang crm_nhan_dien_luong: dấu giữ là thứ tạm,
   sống ngắn hơn cả hàng luồng, và một khoá ngoại ở đây nghĩa là xoá sổ luồng cũ
   phải đi sửa hàng triệu dòng ảnh. Nhịp dọn của web mới là thứ giữ hai bên khớp
   nhau — nó nhả mọi tấm mà luồng giữ chúng không còn sống. */
ALTER TABLE crm_event_photos ADD COLUMN IF NOT EXISTS soi_luc      TIMESTAMPTZ;
ALTER TABLE crm_event_photos ADD COLUMN IF NOT EXISTS soi_luong_id BIGINT;
ALTER TABLE crm_event_photos ADD COLUMN IF NOT EXISTS soi_giu_luc  TIMESTAMPTZ;
ALTER TABLE crm_event_photos ADD COLUMN IF NOT EXISTS soi_so_mat   INTEGER;

/* Chỉ mục của hàng đợi. Không có nó thì mỗi lượt xin 25 tấm là một lượt quét cả
   bảng ảnh, mà một đợt 6 luồng xin vài trăm lượt. */
CREATE INDEX IF NOT EXISTS idx_event_photos_hang_doi
  ON crm_event_photos (id)
  WHERE deleted_at IS NULL AND soi_luc IS NULL AND soi_luong_id IS NULL;
/* Chỉ mục của nhịp dọn: tìm nhanh những tấm đang bị một luồng chết giữ. */
CREATE INDEX IF NOT EXISTS idx_event_photos_dang_giu
  ON crm_event_photos (soi_luong_id)
  WHERE soi_luong_id IS NOT NULL AND soi_luc IS NULL;
/* Tốc độ trên bảng là «bao nhiêu tấm trong một phút VỪA QUA», không phải trung
   bình từ lúc bắt đầu — người vận hành tăng giảm số luồng để nhìn con số đổi, mà
   trung bình tích luỹ thì mười phút sau mới nhúc nhích. Câu hỏi ấy chạy 3 giây
   một lần nên nó cần chỉ mục; đổi lại là một lượt ghi chỉ mục cho mỗi tấm soi
   xong, tức ~1 phần nghìn của thời gian dò một tấm. */
CREATE INDEX IF NOT EXISTS idx_event_photos_soi_luc
  ON crm_event_photos (soi_luc DESC) WHERE soi_luc IS NOT NULL;

/* ── Nâng cấp cho CSDL ĐÃ CÓ ba bảng ────────────────────────────────────────
   CREATE TABLE IF NOT EXISTS chỉ dựng bảng khi chưa có — nó KHÔNG thêm cột,
   KHÔNG nới NOT NULL, KHÔNG thêm CHECK vào bảng đã tồn tại. Ba cột và hai ràng
   buộc dưới đây ra đời SAU lần tạo bảng đầu, nên ở bất kỳ nơi nào bảng đã có sẵn
   thì chúng lặng lẽ vắng mặt — đúng lớp lỗi vé này đã bắt hai lần: một bất biến
   không tồn tại thì không báo gì cả, nó chỉ đơn giản là không chặn.
   Postgres KHÔNG có ADD CONSTRAINT IF NOT EXISTS; phải tự hỏi catalog.
   (Nhắc lại cảnh báo đầu file: khối này là chuỗi mẫu JS — KHÔNG dùng backtick
   trong chú thích, kể cả để trích tên lệnh. Vừa dẫm phải đúng bẫy đó.) */
ALTER TABLE crm_face_samples ADD COLUMN IF NOT EXISTS vec_xoa_luc TIMESTAMPTZ;
ALTER TABLE crm_event_faces  ADD COLUMN IF NOT EXISTS vec_xoa_luc TIMESTAMPTZ;
ALTER TABLE crm_face_samples ALTER COLUMN vec DROP NOT NULL;
ALTER TABLE crm_event_faces  ALTER COLUMN vec DROP NOT NULL;

DO $nangcap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_face_samples_vec_xoa') THEN
    /* NOT VALID: chỉ ràng buộc từ nay về sau, không quét lại toàn bảng. Nếu có
       hàng cũ đang ở trạng thái mâu thuẫn thì ALTER sẽ không nổ giữa lúc deploy —
       hàng đó phải được dọn rồi VALIDATE riêng, chứ không âm thầm chặn khởi động. */
    ALTER TABLE crm_face_samples
      ADD CONSTRAINT ck_face_samples_vec_xoa
      CHECK (vec IS NULL OR vec_xoa_luc IS NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_event_faces_vec_xoa') THEN
    ALTER TABLE crm_event_faces
      ADD CONSTRAINT ck_event_faces_vec_xoa
      CHECK (vec IS NULL OR vec_xoa_luc IS NULL) NOT VALID;
  END IF;
END $nangcap$;

/* ── E08-D134 · THÁO HẠN 7 NGÀY CHO CSDL ĐÃ CÓ BẢNG ──────────────────────────
   Cùng bài học với khối ngay trên: CREATE TABLE IF NOT EXISTS KHÔNG sửa được
   bảng đã tồn tại. Sửa định nghĩa cột ở khối D077 phía trên chỉ đúng cho một
   CSDL mới tinh; prod đã mang bảng từ 10/08 nên nếu chỉ sửa ở trên thì trên prod
   default 7 ngày vẫn nguyên và mọi hàng mới vẫn mang án tử. Phải có cả hai.

   THỨ TỰ Ở ĐÂY LÀ MỘT PHẦN CỦA VÉ:
     · DROP INDEX trước — lượt UPDATE thao hạn trong migrateCrm() khỏi phải bảo
       trì một chỉ mục sắp bị bỏ;
     · DROP NOT NULL trước lượt UPDATE ấy — đảo lại là UPDATE nổ ngay dòng đầu.
   Không dùng DROP INDEX CONCURRENTLY: cả CREATE_SQL đi trong MỘT simple query
   nên nằm chung một transaction ngầm, mà CONCURRENTLY không chạy trong giao dịch.
   Đổi lại là một nhịp khoá ACCESS EXCLUSIVE rất ngắn (chỉ đụng catalog, không
   viết lại bảng) — deploy lúc không có đợt nhận diện nào đang mở.

   Cả bốn câu CHẠY LẠI ĐƯỢC: DROP DEFAULT trên cột không default là no-op,
   DROP NOT NULL trên cột đã nullable cũng vậy, IF EXISTS lo chỉ mục, COMMENT
   ghi đè chính nó.
   (Nhắc lại cảnh báo đầu tệp: khối này là chuỗi mẫu JS — KHÔNG dấu huyền trong
   chú thích, kể cả để trích tên cột.) */
DROP INDEX IF EXISTS idx_event_faces_can_don;
ALTER TABLE crm_event_faces ALTER COLUMN het_han_luc DROP DEFAULT;
ALTER TABLE crm_event_faces ALTER COLUMN het_han_luc DROP NOT NULL;
COMMENT ON COLUMN crm_event_faces.het_han_luc IS
  'E08-D134 RETIRED: khong default, khong index, moi hang NULL. CAM dung lam dieu kien xoa vector. Sponsor 16/08/2026 chot giu vinh vien.';
`;

async function migrateCrm() {
  /* E08-D115 · mốc sổ audit TRƯỚC khi lược đồ chạy. RAISE NOTICE trong khối gộp
     không đi ra log máy chủ (node-postgres không gắn bộ nghe 'notice' cho pool),
     nên số dòng đã gộp của ĐÚNG lần boot này phải đọc lại từ sổ. Bảng chưa tồn
     tại = CSDL mới tinh: không có gì để gộp, mốc 0. */
  let mocAudit = 0;
  try {
    const m = await pool.query('SELECT coalesce(max(id), 0)::bigint AS id FROM crm_audit_events');
    mocAudit = m.rows[0].id;
  } catch (e) { mocAudit = 0; }

  await pool.query(CREATE_SQL);

  const gop = await pool.query(`SELECT count(*)::int AS dong,
      count(DISTINCT (target_id, meta ->> 'guest_id'))::int AS cap
      FROM crm_audit_events WHERE event_type = 'face_gop_doi' AND id > $1`, [mocAudit]);
  if (gop.rows[0].dong) {
    console.log('[crm-db] D115: gộp ' + gop.rows[0].dong + ' dòng album trùng trên '
      + gop.rows[0].cap + ' cặp (tấm, khách) — xem sổ audit face_gop_doi');
  }

  /* ── E08-D126 · gieo dấu ĐÃ SOI cho những tấm đã soi từ trước ────────────────
     Cột soi_luc ra đời sau 10.983 tấm, nên nếu để trống hết thì lần bấm Bắt đầu
     đầu tiên sau khi lên sẽ soi lại CẢ KHO — mấy tiếng CPU và mấy nghìn lượt tải
     ảnh cho một việc đã làm rồi.

     Điều kiện lấy đúng hàng đợi CŨ của D077 («tấm chưa có hàng mặt nào còn
     sống»), không rộng hơn: tấm có mặt nhưng mặt đã bị gỡ tay thì trước nay vẫn
     nằm trong hàng đợi, và vé này không được lặng lẽ đẩy nó ra.

     Mốc soi_luc lấy giờ của HÀNG MẶT đầu tiên chứ không phải now(): đó mới là
     lúc tấm ấy thật sự được soi, và một ngày nào đó có người sẽ hỏi «kho này soi
     xong hồi nào».

     CHẠY LẠI ĐƯỢC: vế soi_luc IS NULL khiến lượt hai đụng 0 dòng. Những tấm chưa
     ai soi vẫn nguyên NULL — chúng là hàng đợi thật.

     Còn 1.217 tấm «đã soi mà không thấy mặt nào» thì lượt này KHÔNG gieo được:
     trước D126 không có chỗ nào ghi lại việc đã soi chúng. Chúng sẽ bị soi lại
     đúng MỘT lần nữa, rồi từ đó có dấu và biến mất khỏi hàng đợi vĩnh viễn — đó
     chính là 26 phút mà AC-6 đo. */
  const gieo = await pool.query(`
    UPDATE crm_event_photos p
       SET soi_luc    = coalesce(m.som_nhat, now()),
           soi_so_mat = m.so_mat
      FROM (SELECT f.event_photo_id AS pid, min(f.created_at) AS som_nhat,
                   count(*)::int AS so_mat
              FROM crm_event_faces f
             WHERE f.deleted_at IS NULL
             GROUP BY f.event_photo_id) m
     WHERE p.id = m.pid AND p.soi_luc IS NULL`);
  if (gieo.rowCount) {
    console.log('[crm-db] D126: gieo dấu đã soi cho ' + gieo.rowCount + ' tấm đã có mặt trong sổ');
  }

  /* ── E08-D134 · THÁO MỐC HẾT HẠN KHỎI MỌI HÀNG CŨ ───────────────────────────
     Đây là câu quan trọng nhất của vé, và nó không phải chuyện dọn dẹp.

     Khối lược đồ ở trên đã tháo default và NOT NULL, nên hàng MỚI sinh ra mang
     het_han_luc NULL và không bao giờ quá hạn. Nhưng hàng CŨ vẫn giữ mốc quá khứ
     của chúng, và mọi câu quét hạn đều có dạng:
         WHERE vec IS NOT NULL AND het_han_luc <= now()
     Rollback mã ở dự án này là REDEPLOY COMMIT CŨ, mà commit cũ mang nguyên ba
     đường quét ấy (nhịp giờ của face-match, pre-clean của batch, tool dọn tay).
     Nếu chỉ tháo default thì một lần rollback là một lần xoá sạch đúng những
     vector vé này vừa đi khôi phục — tức spec bị vi phạm bởi chính đường lùi của
     nó. Đặt tất cả về NULL biến điều kiện trên thành NULL <= now(), tức NULL, tức
     KHÔNG hàng nào khớp, kể cả khi mã TTL quay lại. Lời hứa "rollback không tái
     kích hoạt TTL" nhờ vậy là một tính chất của DỮ LIỆU, không phải một điều
     người deploy phải nhớ.

     Mất gì: mốc "đáng lẽ hết hạn lúc nào". Suy lại được bằng created_at + 7 ngày,
     và không mã nào đọc nó — grep het_han_luc toàn nhánh sau vé này chỉ còn ra
     crm_album_links, một bảng khác hẳn.

     CHẠY LẠI ĐƯỢC: vế het_han_luc IS NOT NULL khiến lượt hai đụng 0 dòng.
     Đặt NGOÀI CREATE_SQL có chủ ý: RAISE NOTICE bên trong khối lược đồ không đi
     ra log máy chủ (xem mốc audit của D115 ở đầu hàm), còn ở đây rowCount cầm
     được thẳng — và con số này phải đối chiếu với câu preflight trước khi deploy. */
  const thaoHan = await pool.query(
    'UPDATE crm_event_faces SET het_han_luc = NULL WHERE het_han_luc IS NOT NULL');
  if (thaoHan.rowCount) {
    console.log('[crm-db] D134: tháo mốc hết hạn khỏi ' + thaoHan.rowCount
      + ' mặt sự kiện — vector giữ vĩnh viễn, TTL không tái kích hoạt được kể cả khi rollback');
  }

  // ─────────── E08-D047 · di trú crm_check_ins sang khoá (guest_id, session) ───────────
  // HAI ĐIỀU KIỆN Sponsor chốt trước khi deploy (06/08):
  //
  // 1 · MỘT TRANSACTION. Năm lệnh này KHÔNG được chạy rời: giữa DROP CONSTRAINT và
  //     CREATE UNIQUE INDEX có một khoảng mà bảng KHÔNG còn ràng buộc chống trùng.
  //     Hỏng đúng lúc đó là từ đó một khách check-in được nhiều dòng cùng buổi, và
  //     tối 08/08 KPI đếm sai mà không ai biết. Gói vào BEGIN/COMMIT thì hoặc xong
  //     cả, hoặc bảng y nguyên như trước khi chạy.
  //
  // 2 · KHÔNG nuốt lỗi. Bản trước có `EXCEPTION WHEN others THEN NULL` ở bước
  //     SET NOT NULL — hỏng gì cũng im, rồi vẫn in "migration ok". Đúng lớp bẫy
  //     logAudit mà D036/D040 đã chốt: chỗ nào là bản đảm bảo duy nhất thì hỏng
  //     PHẢI NỔ. Nay chỉ bắt đúng hai ngoại lệ VÔ HẠI của việc chạy lại
  //     (undefined_object · duplicate_object), còn lại ném ra ngoài.
  //
  // Chạy lại lần hai: DROP ... IF EXISTS không có gì để bỏ · không còn dòng
  // session NULL nên INSERT/DELETE đụng 0 dòng · SET NOT NULL đã đúng · CHECK và
  // UNIQUE INDEX đã tồn tại ⇒ 0 dòng đổi thêm.
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query(`
      DO $$ BEGIN
        ALTER TABLE crm_check_ins DROP CONSTRAINT IF EXISTS crm_check_ins_guest_id_key;
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$`);
    // Dòng cũ (session NULL) nhân bản thành toa-dam + gala rồi xoá bản NULL —
    // smoke/test cũ vẫn hiện «đã đến» ở cả hai cửa; check-in MỚI chỉ ghi đúng buổi.
    const nhan = await cli.query(`
      INSERT INTO crm_check_ins (guest_id, actor_email, checked_in_at, note, session)
      SELECT c.guest_id, c.actor_email, c.checked_in_at, c.note, v.sess
        FROM crm_check_ins c
        CROSS JOIN (VALUES ('toa-dam'), ('gala')) AS v(sess)
       WHERE c.session IS NULL`);
    const xoa = await cli.query('DELETE FROM crm_check_ins WHERE session IS NULL');
    // KHÔNG bọc EXCEPTION: hỏng ở đây là dữ liệu còn dòng session NULL, tức bước
    // trên chưa xong — phải nổ để ROLLBACK, không được đi tiếp rồi báo ok.
    await cli.query('ALTER TABLE crm_check_ins ALTER COLUMN session SET NOT NULL');
    await cli.query(`
      DO $$ BEGIN
        ALTER TABLE crm_check_ins ADD CONSTRAINT crm_check_ins_session_check
          CHECK (session IN ('toa-dam','gala'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$`);
    await cli.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_check_ins_guest_session
        ON crm_check_ins (guest_id, session)`);
    await cli.query('COMMIT');
    if (nhan.rowCount || xoa.rowCount) {
      console.log('[crm-db] D047: bung ' + xoa.rowCount + ' dòng check-in cũ thành ' + nhan.rowCount + ' dòng theo buổi');
    }
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    cli.release();
    /* Ném tiếp. ĐO ĐƯỢC (boot thử 06/08): server/index.js bắt lỗi migrate rồi
       VẪN cho app lên — in "[startup] migration failed: …" rồi "listening". Nên
       câu này KHÔNG chặn app khởi động; thứ nó bảo đảm là bảng không bao giờ ở
       trạng thái DỞ: transaction đã ROLLBACK nên bảng y nguyên như trước khi
       chạy (còn UNIQUE(guest_id) cũ). Hệ quả: mã mới chạy trên lược đồ cũ ⇒
       check-in buổi thứ hai sẽ lỗi ràng buộc — ồn ào và thấy được, KHÔNG phải
       hỏng im lặng. Muốn app dừng hẳn khi migrate hỏng thì phải sửa index.js,
       việc đó ngoài vé này. */
    throw e;
  }
  cli.release();
  console.log('[crm-db] migration ok (CRM tables ready · D047 session check-in)');
}

module.exports = { migrateCrm };
