# GATE 1 PROMPT — RSVP Railway MVP (E08-D004)

> Deliverable Gate 1 (FULL): PM con soạn prompt code + quyết định → PM tổng/QC chấm **trước khi code**.
> Nhánh `main` · Node 20 + Express + Postgres · 1 web service Railway.

---

## 0. Mục tiêu 1 câu
Biến 2 landing tĩnh thành app Railway: form → `POST /api/rsvp` ghi Postgres (SoT), `/admin` 1 user xem tổng + bảng + CSV; auto-deploy khi push `main`. Bỏ đường Apps Script/Sheet.

## 1. Quyết định cần DUYỆT (lệch so với draft — điểm chấm chính)

| # | Vấn đề | Đề xuất PM con | Lý do |
|---|---|---|---|
| D1 | **API contract**: draft phẳng `{fullName,phone,email,attendance,honeypot}` ≠ form thật (lồng `rep`+`guests[]`+`sessions[]`+`dietary`/`wish`/`note`). | API **nhận payload lồng thật** (giữ nguyên `collect()`), thêm `source`+`honeypot`. Không ép Ly đổi cấu trúc form. | Spec R3.1 & contract note: "map field hiện có". Ít sửa HTML nhất. |
| D2 | **Chống CORS + success thật** (R3.2). | **Serve 2 HTML từ chính Node service** → `fetch` same-origin. Đổi fetch: bỏ `mode:"no-cors"`+`text/plain` → `application/json`, đọc `res.ok`/`res.status` cho success/fail thật. | Same-origin = 0 CORS, 1 service = ít ops (spec §Stack). |
| D3 | **Endpoint config**. | `config.js` → `window.RSVP_ENDPOINT = "/api/rsvp"` (tương đối, cùng origin). Bỏ ghi chú Apps Script. | AC-6: config trỏ API Railway, không Sheet. |
| D4 | **DB schema**: chuẩn hóa hay JSONB? | 1 bảng `rsvp_submissions`: cột nghiệp vụ phẳng (rep_name, rep_phone, rep_email, source, status, sessions text, dietary, wish, note, guest_count, submitted_at, created_at, ip_hash, user_agent) + **`guests JSONB`** giữ chi tiết đoàn. | CSV/admin cần cột phẳng; JSONB giữ đủ đoàn mà không cần bảng con (MVP). |
| D5 | **Honeypot** (form chưa có). | Thêm input ẩn `company_website` (off-screen, `tabindex=-1`, `autocomplete=off`) vào **cả 2** HTML; payload gửi kèm; server có giá trị ⇒ trả 201 giả, **không** ghi row. | R3.3 honeypot; bot-safe. |
| D6 | **Rate-limit**. | Theo `rep.phone` (chuẩn hóa số) — chặn trùng trong **5 phút** → `429`. In-memory Map (1 service, đủ MVP) + fallback query DB theo phone+thời gian. | R3.3; wave 1 không cần Redis. |
| D7 | **Validate SĐT VN**. | Regex cơ bản: bỏ khoảng trắng → `^(0|\+84)(\d{9,10})$`. Sai → `400`. | R3.3. |
| D8 | **`source`**. | Mỗi trang set `window.RSVP_SOURCE` (`"dang-ky"` / `"tiec-toi"`); payload kèm. `tiec-toi` đã có `__GALA_ONLY__`. | AC-5 cột "nguồn". |
| D9 | **Auth /admin**. | Cookie session ký (SESSION_SECRET). `GET /admin` chưa login → form login; POST user+pass so với `ADMIN_USER`/`ADMIN_PASSWORD` env; đúng → set cookie httpOnly. Read+export only (không sửa/xóa). | R4.2/R4.4. |
| D10 | **CNAME hỏng** (`rsvp.esuhai20th`). | **Xóa file `CNAME`** (go-live qua `*.up.railway.app`). Ghi lý do trong report. | AC-7. |
| D11 | **Apps Script/Sheet**. | Không xóa code; thêm dòng **DEPRECATED** đầu `apps-script/Code.gs` + `HUONG_DAN_DEPLOY.md` + `config.js`. Giữ `saveLocal`+mailto làm fallback offline (vô hại). | R5.3, out-of-scope: không bắt Ly chạy Sheet. |

## 2. Kiến trúc & cây file (sau code)
```
server/
  index.js         # Express: static + /health + /api/rsvp + /admin*
  db.js            # pg Pool, migrate() idempotent (CREATE TABLE IF NOT EXISTS)
  rsvp.js          # validate + honeypot + rate-limit + insert
  admin.js         # login/session + summary + responses + export.csv
  views/admin.html # dashboard nhẹ (server-render số liệu hoặc fetch /admin/api/*)
package.json       # node20, express, pg, cookie/session dep; start: node server/index.js
railway.json/Procfile (nếu cần)  # web: node server/index.js; healthcheck /health
config.js          # RSVP_ENDPOINT="/api/rsvp"  (sửa)
dang-ky.html       # +honeypot +RSVP_SOURCE +fetch JSON thật (sửa)
tiec-toi.html      # +honeypot +RSVP_SOURCE +fetch JSON thật (sửa)
CNAME              # XÓA
README.md          # EN dev setup + env + 1 mục VN cho Ly
```
Static: Node serve `dang-ky.html`,`tiec-toi.html`,`index.html`,`config.js`,assets. `/` → `index.html` (đã redirect `dang-ky`).

## 3. Schema (draft cần duyệt)
```sql
CREATE TABLE IF NOT EXISTS rsvp_submissions (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,              -- dang-ky | tiec-toi
  status       TEXT NOT NULL,              -- yes | no
  rep_name     TEXT NOT NULL,
  rep_org      TEXT,
  rep_phone    TEXT,                        -- yes: bắt buộc; no: null
  rep_email    TEXT,
  sessions     TEXT,                        -- "Tọa đàm · Gala"
  dietary      TEXT,
  wish         TEXT,
  note         TEXT,
  guest_count  INT NOT NULL DEFAULT 0,
  guests       JSONB NOT NULL DEFAULT '[]',
  ip_hash      TEXT,                        -- sha256(ip+secret), không lưu IP thô
  user_agent   TEXT,
  submitted_at TIMESTAMPTZ,                 -- từ client
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rsvp_created ON rsvp_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rsvp_phone   ON rsvp_submissions (rep_phone);
```

## 4. API
- `GET /health` → `200 {ok:true}`.
- `POST /api/rsvp` (JSON = payload `collect()` + `source` + `honeypot`) → `201 {ok:true,id}` / `400` / `429` / `500` generic (không lộ stack).
- `GET /admin` → login form / dashboard (cookie).
- `POST /admin/login` → set session.
- `GET /admin/api/summary` → `{total, bySource, byStatus}`.
- `GET /admin/api/responses?q=&limit=` → list (mask SĐT ở UI? — xem Q3).
- `GET /admin/api/export.csv` → CSV cột: tên, SĐT, email, nguồn, trạng thái, số khách, sessions, submitted_at.

## 5. Env (chỉ Railway)
`DATABASE_URL` (Postgres plugin) · `ADMIN_USER`=admin · `ADMIN_PASSWORD` (anh Kha) · `SESSION_SECRET` · `IP_HASH_SALT`. **Không commit.**

## 6. Test plan → AC
| AC | Cách kiểm |
|---|---|
| AC-1 | Push `main` → Railway deploy ≤10' log xanh |
| AC-2 | Submit 1 form → 1 row (admin/psql) |
| AC-3 | Submit trùng SĐT <5' → 429; honeypot điền → 201 giả, 0 row |
| AC-4 | `/admin` no-pass → chặn; đúng pass → tổng+bảng+CSV |
| AC-5 | CSV đủ cột tên/SĐT/nguồn/trạng thái/thời gian |
| AC-6 | `git diff` config.js trỏ `/api/rsvp`; smoke không qua Sheet |
| AC-7 | `CNAME` xóa; Railway URL mở được |

## 7. Câu hỏi Sponsor/PM tổng (chờ trả lời)
- **Q1 — Deploy access:** Ai nối Railway ↔ GitHub? Repo thuộc account Ly (`huongly1620-cell`). Anh Kha được invite collaborator, hay deploy từ fork ủy quyền? *(Blocker AC-1)*
- **Q2 — Push author:** Khi push code lên `main`, dùng account nào (§A2)? Chờ lệnh «push» rõ của anh Kha.
- **Q3 — Mask SĐT trên UI admin:** Che giữa số (vd `0912***678`) trên bảng, chỉ CSV đầy đủ? (Security §: tránh in full SĐT.) Đề xuất: **có mask trên bảng**.
- **Q4 — Giữ mailto + localStorage fallback?** Đề xuất: **giữ** (vô hại, offline backup). OK?
- **Q5 — Trạng thái "chưa rõ":** form ép chọn yes/no → không có "chưa rõ". Admin chỉ hiển thị 2 trạng thái. OK?

## 8. Định nghĩa PASS Gate 1
D1–D11 được duyệt/hiệu chỉnh + Q1/Q2 có hướng (không chặn viết code, chỉ chặn deploy) ⇒ mở code. §B7: QC Gate 2 do actor khác.
