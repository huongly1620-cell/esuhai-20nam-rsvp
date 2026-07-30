# STATUS — RSVP Railway MVP (E08-D004)

> Product: `LandingPage_KhachMoi_0808` · Spec: `Projects_S2-coord/.../specs/2026-07-24-rsvp-railway-mvp.md`
> Nhánh deploy: `main` · Gate: **FULL** · Worker: PM-con-Kha (R1)

## Deploy log — mới nhất

**2026-07-30 · E08-D017 CRM UI theo mockup Ly — CODE DONE, chờ Gate 2 (CHƯA deploy, CHƯA flip)**
Port giao diện mockup `crm.html` lên `/crm` thật, **giữ nguyên app** (OTP/RBAC/check-in/interactions/photos/import/audit). Gate 1 PASS (AC-12=A · export=client-CSV · rollback CRM_UI+/crm/classic).

- **File:** MỚI `server/crm/views/crm-app-v2.html` (UI mockup + nối `/crm/*` API thật) · sửa `server/crm/index.js` (route theo env **`CRM_UI`**, mặc định `classic`; thêm `/crm/classic`). **KHÔNG** đụng `auth.js`/`guests.js`/`audit.js`/`import.js`/schema/contract.
- **Self-QC (worker=PM-con-Kha, Postgres 16 Docker cục bộ, 2 role):**

| Nhóm AC | Kết quả |
|---|---|
| A giao diện + nav | ✅ `/crm` (CRM_UI=new) render v2 · nav → `/admin`,`/xep-ban.html`,`/checkin-toadam.html`,`/checkin-gala.html` (bỏ `/check-in.html` cũ) |
| B nối dữ liệu thật (AC-5..10) | ✅ list `GET /crm/guests` · detail `:id` (table_no+điểm danh ai/lúc+interactions+ảnh) · check-in ghi **actor=staff** · repeat→already · interaction · PATCH · mine=1 · import/audit (btl) |
| C số liệu trung thực (AC-11..13) | ✅ dashboard "đón tiếp" tính từ rows thật (đã đến/chưa) · **AC-12=A**: tab Tọa đàm/Gala báo *"chưa có dữ liệu buổi — cần schema"* (0 bịa) · checklist gắn nhãn *"ghi nhớ trên máy này"* |
| D bảo mật/vận hành (AC-14..18) | ✅ no-cookie→401 · **AC-15 staff gọi thẳng API btl (POST guests/DELETE/import/audit/export) → 403 ở SERVER** · rollback: mặc định `CRM_UI` unset → `/crm`=classic, `/crm/classic` luôn classic · regress /health·/admin API 401·dang-ky·2 check-in·/api/rsvp |

Smoke tự động: **30/31 PASS** (1 "fail" là assertion sai của tôi — probe trang `/admin` (200, đúng là trang login) thay vì API `/admin/api/*`; đã xác nhận thủ công API no-auth → **401**). `grep localStorage crm-app-v2.html` → **chỉ `crm_theme` + `crm_chk`** (0 dữ liệu khách).
- **AC-12:** đã mở vé schema follow-up (draft) `specs/2026-07-30-crm-schema-buoi-followup.md`.
- **CÒN LẠI:** Gate 2 (actor khác) đọc code + chạy thật + thử rollback → PASS mới `railway up` + set env `CRM_UI=new`. **`/crm` production vẫn classic tới lúc đó.**

**2026-07-30 · tip FE Ly (LIGHT `ly-fe-checkin-crm-deploy`) — SHA live `5f13eb4`**
Pull `--ff-only` (behind 6 → tip) + `railway up esuhai-web`. 3 trang FE mới của Ly (không đụng BE).

| AC | Kết quả |
|---|---|
| AC-2 `checkin-toadam.html` | ✅ 200 · title "Check-in Tọa đàm · Gala 20 Năm" |
| AC-3 `checkin-gala.html` | ✅ 200 · title "Check-in Gala · Gala 20 Năm" |
| AC-4 `crm.html` (mock) | ✅ 200 · title "CRM Khách mời · Gala 20 Năm ESUHAI" |
| AC-5 regress BE | ✅ /health ok · dang-ky 200 · /admin login (api 401) · /crm (CRM thật) 200 · /api/rsvp 400 |
| AC-6 STATUS | ✅ (mục này) |
| AC-7 §B7 | Self-QC LIGHT (worker=PM-con-Kha) — QC độc lập tuỳ chọn: mở 3 URL mobile soi theme |

⚠️ `crm.html` = **mock** (chưa nối `/crm/*` API) — CRM thật vẫn ở `/crm`. Nối API = việc SAU (OUT phiếu này).
Deploy = CLI `railway up` (push `main` KHÔNG tự lên web). Trước đó: `fd800ab` (CR xếp bàn ↔ check-in, Gate 2 PASS).

| Mốc | Trạng thái | Ghi chú |
|---|---|---|
| DoR | ✅ CLOSED 2026-07-24 | E08-D004 |
| Gate 1 | ✅ PASS 2026-07-24 | anh Kha duyệt |
| Code backend + wiring FE | ✅ DONE | server/ + 2 HTML + config.js + AGENTS.md |
| Smoke AC-2…AC-5 (local + Docker PG) | ✅ PASS | xem bảng dưới |
| **Railway provisioned** | ✅ DONE 2026-07-24 | project + Postgres + web service + env (trừ ADMIN_PASSWORD) |
| **Live smoke trên URL Railway** | ✅ PASS | AC-1/2/3/4-gate/6/7 xanh (xem dưới) |
| **ADMIN_PASSWORD (Railway env)** | ✅ SET | anh Kha đã set → /admin/login gate hoạt động (probe → 401, không còn 503) |
| **Push `main`** | ✅ DONE | commit `1ab50bd` trên `main` (Ly invite Write cho `NicholasChen868`) |
| **Deploy code mới** | ✅ LIVE (CLI) | `railway up` — live = `7d5c88a` + **tối ưu tải trang (PM-con-Kha 27/07)**; smoke PASS |

## Tối ưu tải trang (27/07) — giữ nguyên thiết kế

Nguyên tắc: đo → tối ưu → đo lại → verify (Chromium + WebKit/Safari) → deploy. **Thiết kế giữ nguyên** (verify ảnh 2 engine giống hệt trước).

| Hạng mục | Trước | Sau |
|---|---|---|
| Ảnh tải thật (wax-seal, cover, 2 logo) | 933 KB | **151 KB (−84%)** |
| `wax-seal.png` | 453 KB | 71 KB |
| `screen1-cover.jpg` | 417 KB | 72 KB |
| Asset chết (không tham chiếu) | 737 KB | **xoá (0)** |
| Tổng asset repo | 1.8 MB | 372 KB |
| First-load (ảnh+html gz) | ~960 KB | **~180 KB** |

- Ảnh: nén bằng `sharp` (giữ nguyên định dạng/tên file → không đổi markup), verify chất lượng bằng mắt (đạt/đẹp hơn).
- Animation nhẹ hơn: shimmer chạy **1 lần** thay vì vô hạn; canvas sao **tạm dừng khi ẩn/offscreen/tab nền**; pulseGlow hữu hạn. Giảm repaint desktop (nghi vấn "chữ giật" Safari).
- **Chưa repro được** lỗi "đơn điệu" của Ly (headless Chromium+WebKit đều render đúng) → chờ Ly xác nhận trên M5 thật + quay 10s nếu còn.

⚠️ Thay đổi đang ở **working tree + đã railway up**, **CHƯA push `main`** — cần push để giữ lại + Ly pull không mất.
| **AC-1 auto-deploy khi push** | 🅗 HOLD (chấp nhận) | Wave 1 **chốt deploy bằng CLI `railway up`** (anh Kha 25/07). Auto-deploy = follow-up: cần anh connect Source (Railway) + Ly cài Railway GitHub App (GitHub) — 2 tay |
| **Gate 2 (QC độc lập)** | ✅ PASS-có-điều-kiện 25/07 | QC actor khác (§B7 OK). AC-2…7 PASS · AC-1 HOLD. Log: `review-logs/2026-07-25-rsvp-railway-mvp-gate2.md` |

## Deploy runbook (wave 1 — CLI)

**Publish thay đổi lên live** (PM-con-Kha, từ `~/Projects_S2/LandingPage_KhachMoi_0808/`):
```
railway up --service esuhai-web --detach   # deploy code hiện tại lên Railway
```
> ⚠️ **Push `main` KHÔNG tự lên web.** Ly push FE → phải có PM-con-Kha chạy `railway up` mới publish.
> ADMIN_PASSWORD đổi được ngay trên Railway env (không cần redeploy).

## Railway (workspace Backend.4all)

| | |
|---|---|
| Project | `esuhai-20nam-rsvp` · id `03a8e07f-2822-4ab6-88f2-57b25ed8bbb2` |
| Web service | `esuhai-web` · GitHub `huongly1620-cell/esuhai-20nam-rsvp` @ `main` |
| DB | Postgres plugin (region Southeast Asia) · `DATABASE_URL` wired vào web qua `${{Postgres.DATABASE_URL}}` |
| **Public URL** | **https://esuhai-web-production.up.railway.app** |
| Env đã set | `DATABASE_URL`, `ADMIN_USER=admin`, `SESSION_SECRET`, `IP_HASH_SALT`, `NODE_ENV=production` |
| Env **CHỜ anh** | `ADMIN_PASSWORD` (secret của anh — set trên Railway, không commit) |

### Live smoke (trên URL Railway, 2026-07-24)
- `/health` → `{"ok":true}` · `POST /api/rsvp` → **201** ghi Postgres thật
- trùng SĐT → **429** · honeypot → 201 **0 row** · `/admin` no-auth → **401** · `/admin/login` (chưa có pass) → **503**
- `/server/*` chặn → 404 · `dang-ky.html` có `RSVP_SOURCE` · `config.js` trỏ `/api/rsvp`
- **Đã xóa 1 row smoke** → SoT sạch (0 row) cho BTC.

> Lưu ý deploy: bản đang chạy là `railway up` (snapshot code local, KHÔNG đụng git). Khi anh **push `main`**, Railway auto-deploy từ GitHub (cùng code) — đó là đường AC-1 chính thức.

## Kết quả smoke (local, Node 24 + Postgres 16 Docker)

| AC | Kết quả |
|---|---|
| `/health` | ✅ `{ok:true}` |
| AC-2 submit hợp lệ → 1 row | ✅ 201 `{ok,id}`, row ghi Postgres, guest_count đúng |
| AC-3 rate-limit trùng SĐT <5' | ✅ 429 |
| AC-3 honeypot điền | ✅ 201 giả, **0 row** thêm |
| AC-3 SĐT VN sai | ✅ 400 |
| AC-4 `/admin` no-auth | ✅ 401; sai pass 401; đúng pass → cookie + summary + bảng |
| AC-4/UI mask SĐT trên bảng | ✅ `0912*****678` (CSV giữ đầy đủ) |
| AC-5 export.csv | ✅ đủ cột (tên,SĐT,email,nguồn,trạng thái,số khách,phần,ẩm thực,lời chúc,ghi chú,gửi lúc,tạo lúc) + BOM UTF-8, tiếng Việt đúng |
| AC-6 config trỏ `/api/rsvp` | ✅ không còn Apps Script/Sheet SoT |
| AC-7 CNAME | ✅ đã xóa file `CNAME` |

## Thay đổi chính
- `server/**` (Express + pg): `/health`, `POST /api/rsvp`, `/admin` (login/summary/responses/export.csv), migrate on boot.
- `config.js` → `RSVP_ENDPOINT="/api/rsvp"`.
- `dang-ky.html`,`tiec-toi.html`: honeypot ẩn, `RSVP_SOURCE`, fetch JSON same-origin (bỏ `no-cors`), báo success/fail thật.
- `CNAME` xóa; Apps Script + HUONG_DAN_DEPLOY.md gắn nhãn DEPRECATED.
- `AGENTS.md` (SoT phối hợp R0/R1) copy vào root; README viết lại (EN dev+env + mục VN cho Ly).

## Còn lại (ngoài code)
- **Q1:** nối GitHub↔Railway + Postgres plugin; set env `DATABASE_URL`,`ADMIN_USER`,`ADMIN_PASSWORD`,`SESSION_SECRET`,`IP_HASH_SALT` (password chỉ trên Railway).
- Chờ lệnh «push» → deploy → lấy URL `*.up.railway.app` → smoke AC-1/AC-2 trên Railway → Gate 2.

_Cập nhật: 2026-07-24 · PM-con-Kha._
