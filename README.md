# ESUHAI 20 năm — RSVP (Railway + Postgres)

RSVP landing + backend for the ESUHAI Group 20th‑anniversary event ·
Sat **08/08/2026** · GEM Center, HCMC.

> **R0 / PM‑con‑Ly: đọc [`AGENTS.md`](AGENTS.md) mỗi session trước khi sửa gì.**

Two guest pages (one shared form), a Node/Express backend that writes to Postgres,
and an assistant dashboard at `/admin`. **Source of truth = Postgres on Railway.**
Google Sheet / Apps Script is **deprecated** (kept for reference only).

```
Guest ─► Railway web service (serves HTML + API) ─► Postgres
         dang-ky.html / tiec-toi.html   POST /api/rsvp        rsvp_submissions
                                        /admin (read + CSV)
```

---

## Architecture

| Path | Role |
|---|---|
| `index.html` | redirects to `dang-ky.html` |
| `dang-ky.html` | full form (Tọa đàm + Gala) — `RSVP_SOURCE="dang-ky"` |
| `tiec-toi.html` | gala‑only form — `RSVP_SOURCE="tiec-toi"` |
| `config.js` | `window.RSVP_ENDPOINT = "/api/rsvp"` (same origin, no CORS) |
| `server/index.js` | Express: static + `/health` + `/api/rsvp` + `/admin*` |
| `server/db.js` | pg pool + idempotent `migrate()` (runs on boot) |
| `server/rsvp.js` | validate (VN phone) + honeypot + rate‑limit + insert |
| `server/admin.js` | signed‑cookie session, summary / responses / `export.csv` |
| `server/views/` | `login.html`, `admin.html` |

The front‑end posts the **nested payload** produced by `collect()`
(`{status, source, honeypot, sessions[], rep{name,org,phone,email}, dietary, wish, note, guests[], submittedAt}`).
The server maps it to the `rsvp_submissions` table (flat business columns + `guests` JSONB).

---

## Environment variables (set on Railway — never commit)

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Provided by the Railway Postgres plugin |
| `ADMIN_USER` | no | Defaults to `admin` |
| `ADMIN_PASSWORD` | yes | **Set on Railway only.** Empty ⇒ `/admin` login disabled |
| `SESSION_SECRET` | yes | Random string; signs the admin cookie |
| `IP_HASH_SALT` | recommended | Salt for hashing IPs (no raw IP stored) |
| `PGSSL` | no | Set to `require` when connecting over the public proxy |
| `PORT` | no | Injected by Railway |

## Local development

```bash
npm install
# Postgres via Docker:
docker run -d --name rsvp-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
export DATABASE_URL="postgres://postgres:dev@localhost:5432/postgres"
export ADMIN_PASSWORD="dev-secret" SESSION_SECRET="dev-session"
npm start        # http://localhost:3000  ·  /admin  ·  /health
```

Migration is automatic on boot (`CREATE TABLE IF NOT EXISTS`) — no manual step.

## Deploy (Railway)

1. Create a Railway project → **Add Postgres** plugin (sets `DATABASE_URL`).
2. Connect this GitHub repo → service auto‑deploys on every push to **`main`**.
3. Set env vars above (esp. `ADMIN_PASSWORD`, `SESSION_SECRET`) in the service.
4. Healthcheck path is `/health` (see `railway.json`). Public URL: `*.up.railway.app`.

---

## Hướng dẫn ngắn cho Ly (R0 / PM‑con‑Ly)

- **Sửa đâu:** chỉ nội dung/giao diện trong `dang-ky.html`, `tiec-toi.html`, `index.html`
  (chữ, ảnh, layout). **Không** đụng thư mục `server/`, `config.js`, hay biến môi trường / mật khẩu.
- **Giữ nguyên khi sửa form:** `window.RSVP_SOURCE`, ô honeypot ẩn (`hp_company`),
  và cách gửi `fetch` JSON tới `/api/rsvp`. Không đổi `collect()` / payload nếu anh Kha (R1) chưa OK.
- **Push đâu:** commit → push nhánh **`main`** → Railway tự deploy (~vài phút).
- **Mỗi session:** `git pull` → đọc [`AGENTS.md`](AGENTS.md) + `reports/STATUS.md`.
- Mọi thắc mắc: nhắn Signal, đừng chỉnh backend.

> Google Sheet / Apps Script cũ đã **ngừng dùng** — không cần chạy nữa.
