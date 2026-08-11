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
  /* Vector KHÔNG bắt buộc, và có hạn riêng — ngắn hơn hạn của chính bản ghi mặt.
     Hai thứ này khác hẳn nhau về mức nhạy cảm: hộp/kích thước/độ nét là hình học,
     còn vector là mẫu sinh trắc. Vector chỉ dùng để SINH gợi ý; lúc BTL ngồi duyệt
     thì thứ họ nhìn là ảnh và gợi ý đã ghi sẵn. Đo được: dò+căn+nhúng 42ms/ảnh,
     tức chạy lại cả kho 1.285 tấm mất ~1 phút — giữ vector 30 ngày là đổi dữ liệu
     sinh trắc lấy một phút CPU. Sponsor chốt 7 ngày (10/08). */
  vec             BYTEA,
  vec_xoa_luc     TIMESTAMPTZ,          -- ghi LÚC xoá: chứng minh được, không chỉ là vắng mặt
  run_id          TEXT NOT NULL,
  /* N1 · cùng ràng buộc như bảng mẫu: giữ vector và mang dấu đã xoá là hai điều
     không thể cùng đúng. */
  CONSTRAINT ck_event_faces_vec_xoa CHECK (vec IS NULL OR vec_xoa_luc IS NULL),
  het_han_luc     TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_event_faces_anh
  ON crm_event_faces (event_photo_id) WHERE deleted_at IS NULL;
/* Quét dọn chỉ nhìn những dòng CÒN vector — dọn xong thì không phải duyệt lại. */
CREATE INDEX IF NOT EXISTS idx_event_faces_can_don
  ON crm_event_faces (het_han_luc) WHERE vec IS NOT NULL;

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
