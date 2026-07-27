# GATE 1 PLAN — CRM đón tiếp Lễ tân/PG (E08-D007 · CR-06 · E08-D008)

> Worker: PM-con-Kha (R1) · Gate: **FULL** · Nhánh: `feat/crm-don-tiep` (off `main` 5ed46a9)
> DoR-fixture · OTP console · 6 lock kiến trúc đã chốt. **Chưa code tới khi PASS.**

## 0. Nguyên tắc
- **Không đụng** `main` live (RSVP + admin UX). Toàn bộ CRM trên nhánh này.
- **Không ALTER** bảng `rsvp_submissions`. Chỉ **thêm bảng mới**.
- **Không deploy / không railway up / không merge** tới khi DoR-go-live + anh lệnh.
- Không commit PII thật / secret. Fixture không-PII.

## 1. Cấu trúc file (thêm mới, không sửa RSVP/admin)
```
server/
  crm/
    auth.js        # request-code, verify (OTP console), session cookie CRM, allowlist
    rbac.js        # requireCrmAuth, requireRole('btl'), field whitelist
    guests.js      # search, get, create(btl), patch(staff+), delete(btl soft), check-in
    interactions.js
    photos.js      # multipart → MinIO, presigned GET
    import.js      # CSV upsert idempotent (btl)
    audit.js       # ghi + GET/export audit (btl)
    storage.js     # MinIO client (env), presign
    views/         # crm-login.html, crm-app.html (mobile-first)
  crm-db.js        # migrate() các bảng CRM (idempotent, tách khỏi db.js RSVP)
  index.js         # +mount /crm/* và /auth/* (thêm, không sửa logic cũ)
fixtures/
  guests-sample.csv        # cột giả KHÔNG-PII
  allowlist-sample.json    # email test staff/btl
docker-compose.crm.yml     # MinIO local cho dev
```

## 2. Schema mới (bảng riêng — lock #2)
```sql
staff_users(email PK, role TEXT CHECK(role IN('staff','btl')), active BOOL, created_at)
guests(
  id BIGSERIAL PK, guest_ext_id TEXT UNIQUE NULL, phone_norm TEXT,   -- upsert key (lock #4)
  full_name, org, title, phone, email, note, tags,
  response_id BIGINT NULL,           -- link optional tới rsvp_submissions (lock #2)
  deleted_at TIMESTAMPTZ NULL,       -- soft-delete (lock #6)
  created_at, updated_at )
guest_assignments(guest_id FK, staff_email, assigned_at)   -- phân công follow
interactions(id, guest_id FK, actor_email, kind TEXT, body TEXT, created_at)
check_ins(id, guest_id FK, actor_email, checked_in_at, note)   -- 1 khách 1 check-in "hiện hành"
photos(id, guest_id FK, interaction_id NULL, object_key, content_type, size, uploaded_by, created_at)
audit_events(id, actor_email, event_type, target_type, target_id, meta JSONB, ip_hash, created_at)
auth_codes(email, code_hash, expires_at, attempts, created_at)   -- OTP, hash + hết hạn ngắn
```
Index: `guests(phone_norm)`, `guests(full_name)` (search 50+ NV), `audit_events(created_at DESC)`, `guest_assignments(staff_email)`.

## 3. Auth magic-link/OTP (2 realm — lock #3)
- Cookie CRM **riêng** (`esuhai_crm`), khác `esuhai_admin`. `/admin` (ADMIN_PASSWORD) **giữ nguyên**.
- `POST /auth/request-code {email}` → luôn `202` (không tiết lộ email có trong allowlist). Nếu email ∈ `staff_users.active`: sinh code 6 số, lưu `code_hash`+`expires_at` (≤10'), **`OTP_DELIVERY=console` → in mã ra log server** (dev). Rate-limit theo email+IP.
- `POST /auth/verify {email,code}` → so hash + hạn + attempts; đúng → cookie ký HMAC `{email, role, exp}` (HttpOnly, SameSite=Lax, Secure prod); ghi audit `login_success`.
- `POST /auth/logout`.
- Reuse cơ chế cookie ký HMAC đã có ở admin.js (cùng kỹ thuật, khác secret/tên).

## 4. RBAC (lock: staff/btl)
- `requireCrmAuth`: có cookie hợp lệ → gắn `req.actor={email,role}`; else 401.
- `requireRole('btl')` cho: create/delete guest, import, allowlist, GET audit.
- `staff` PATCH guest: **field whitelist** (org,title,note,phone,email,tags) — không sửa id/response_id/deleted_at.

## 5. API (spec §contract) + audit hook mọi ghi
`GET /crm/guests?q=` · `GET /crm/guests/:id` · `POST /crm/guests`(btl) · `PATCH /crm/guests/:id`(staff+ whitelist) · `DELETE /crm/guests/:id`(btl soft) · `POST /crm/guests/:id/check-in` · `POST /crm/guests/:id/interactions` · `POST /crm/guests/:id/photos`(multipart) · `POST /crm/import`(btl) · `GET /crm/audit`(btl) · `GET /crm/audit/export.csv`(btl).
Mỗi ghi → 1 dòng `audit_events` (actor_email + type + target + ip_hash + time).

## 6. Check-in "báo đã điểm danh" (AC-5)
- `POST check-in`: nếu đã có check-in → **KHÔNG** tạo im lặng; trả `{already:true, by, at}` → UI báo rõ "Đã điểm danh bởi X lúc Y", cho ghi note "check lại" (interaction) nhưng **không** reset trạng thái.

## 7. MinIO (lock #5)
- Dev: **MinIO Docker local** (`docker-compose.crm.yml`), creds qua env (`MINIO_ENDPOINT/ACCESS_KEY/SECRET/BUCKET`). Prod: swap env thật.
- Dep: `minio` SDK (S3-compatible) + `multer` (memory) cho multipart.
- Upload → put object key `guests/{id}/{uuid}` + metadata Postgres. **Không** lưu binary DB.
- Xem ảnh: **presigned GET hết hạn ngắn** (vd 5') — không public bucket.

## 8. Import CSV upsert idempotent (AC-8, lock #4)
- Key upsert: **`phone_norm`** chuẩn hóa VN; fixture dùng **`guest_ext_id`** nếu có. `ON CONFLICT (key) DO UPDATE`.
- Chạy 2 lần cùng file → không nhân đôi. Map `guest_assignments` (guest ↔ staff_email).
- Cột template: **đề xuất sau khi nhận file Ly**; fixture `guests-sample.csv` cột giả (ext_id, full_name, org, phone, assigned_email…). Audit `import_run` (số tạo/cập nhật).

## 9. UI mobile-first (AC-4, ≤3 bước)
- `/crm` → chưa login: form nhập email → "Gửi mã" → nhập mã → vào.
- Sau login: 1 ô **tìm lớn** (tên/SĐT/org) → kết quả tức thì → chạm mở **thẻ khách**: nút **Điểm danh** to; trạng thái điểm danh rõ; nút **Ghi tương tác**; nút **Chụp/Upload ảnh**; xem ảnh. `btl` thấy thêm: Thêm khách / Xóa / Import / Audit.
- Server-render HTML nhẹ (như admin), fetch JSON same-origin. Không framework nặng.

## 10. Fixtures / seed (dev)
- `staff_users`: seed vài email test (`staff@…`, `btl@…`).
- `guests-sample.csv`: ~10 dòng KHÔNG-PII.
- OTP in ra log (không email).

## 11. Deps thêm (tối thiểu)
`minio`, `multer`. (Email provider: **không thêm** — console tới go-live.)

## 12. Security / PDPL
OTP hạn ≤10' + rate-limit; cookie HttpOnly/Secure/SameSite; presigned ngắn; soft-delete; audit mọi ghi; mask SĐT/email trong log; PII/secret không commit; CRM route không lộ trên landing khách (AC-10).

## 13. Test plan → AC (Gate 2 trên fixture + MinIO Docker)
| AC | Cách |
|---|---|
| AC-1 | email ngoài allowlist → không nhận code hợp lệ / không vào |
| AC-2 | email in-list → code (từ log) → cookie gắn email; ghi audit có actor_email |
| AC-3 | staff POST/DELETE guest → 403; btl → OK |
| AC-4 | search mobile → mở thẻ; check-in ghi DB + audit |
| AC-5 | check-in lần 2 → báo "đã điểm danh bởi/ lúc" |
| AC-6 | interaction lưu + hiện thẻ + audit |
| AC-7 | upload ảnh → object MinIO + metadata; xem lại (presigned) |
| AC-8 | import fixture 2 lần → không nhân đôi (count) |
| AC-9 | btl GET/export audit có actor+type+time |
| AC-10 | grep landing không lộ /crm; git diff không PII/secret |

## 14. Coexistence & không regress
- `/admin`, `/api/rsvp`, `/health` **không đổi**. CRM chỉ thêm route mới. Grep xác nhận không sửa `admin.js` logic (trừ nếu tái dùng helper cookie → tách module chung, không đổi hành vi admin).

## 15. Câu hỏi mở cho Gate 1 (cần anh/PM tổng gật)
- Q1: Template cột CSV — chốt **sau khi có file Ly**; fixture đi trước. OK?
- Q2: Guest search scope cho `staff`: thấy **mọi khách** hay **chỉ khách được phân công**? Spec R3 staff "xem phân công của mình" nhưng cũng "tìm khách". Đề xuất: **staff search toàn bộ** (để đón tiếp bất kỳ ai tới) nhưng tab "Của tôi" lọc theo assignment. Cần chốt.
- Q3: 1 khách có nhiều lần check-in (vào/ra) hay chỉ **1 lần**? Đề xuất wave 1: **1 lần** (idempotent, báo đã điểm danh). OK?

## PASS Gate 1 = mở code
6 lock + plan này được duyệt + Q1–Q3 có hướng ⇒ code trên `feat/crm-don-tiep`. Gate 2 = actor khác (§B7).
