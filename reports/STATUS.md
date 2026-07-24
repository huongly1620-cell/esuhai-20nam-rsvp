# STATUS — RSVP Railway MVP (E08-D004)

> Product: `LandingPage_KhachMoi_0808` · Spec: `Projects_S2-coord/.../specs/2026-07-24-rsvp-railway-mvp.md`
> Nhánh deploy: `main` · Gate: **FULL** · Worker: PM-con-Kha (R1)

| Mốc | Trạng thái | Ghi chú |
|---|---|---|
| DoR | ✅ CLOSED 2026-07-24 | E08-D004 |
| Gate 1 | ✅ PASS 2026-07-24 | anh Kha duyệt |
| Code backend + wiring FE | ✅ DONE | server/ + 2 HTML + config.js + AGENTS.md |
| Smoke AC-2…AC-5 (local + Docker PG) | ✅ PASS | xem bảng dưới |
| **Railway provisioned** | ✅ DONE 2026-07-24 | project + Postgres + web service + env (trừ ADMIN_PASSWORD) |
| **Live smoke trên URL Railway** | ✅ PASS | AC-1/2/3/4-gate/6/7 xanh (xem dưới) |
| **ADMIN_PASSWORD (Railway env)** | ⛔ CHỜ ANH KHA | chưa set → /admin trả 503 (đúng thiết kế) |
| **Push `main`** | ⛔ CHỜ LỆNH | GitHub-connected; push → auto-deploy thật (AC-1) |
| Gate 2 (QC độc lập, actor≠worker) | ⛔ | sau khi push + set password |

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
