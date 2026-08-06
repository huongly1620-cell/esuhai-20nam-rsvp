'use strict';

const crypto = require('crypto');
const path = require('path');
const { pool } = require('./db');
const crmImport = require('./crm/import');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'esuhai20-dev-session-secret';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const COOKIE = 'esuhai_admin';

// ---- signed-cookie session (no external dep) ----
function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  // timingSafeEqual needs equal-length buffers
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!obj.exp || Date.now() > obj.exp) return null;
    return obj;
  } catch (_) { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  const s = verify(parseCookies(req)[COOKIE]);
  return !!(s && s.u === ADMIN_USER);
}
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// Mask phone on the UI/API table: keep first 4 + last 3 (Q3 default).
function maskPhone(p) {
  if (!p) return '';
  const s = String(p);
  if (s.length <= 7) return s.replace(/.(?=.{2})/g, '*');
  return s.slice(0, 4) + '*'.repeat(Math.max(3, s.length - 7)) + s.slice(-3);
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---- routes ----
function mount(app) {
  // Login page (GET) — server-rendered minimal form; dashboard if already authed.
  app.get('/admin', (req, res) => {
    if (!isAuthed(req)) {
      return res.sendFile(path.join(__dirname, 'views', 'login.html'));
    }
    return res.sendFile(path.join(__dirname, 'views', 'admin.html'));
  });

  app.post('/admin/login', (req, res) => {
    const { user, password } = req.body || {};
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD chưa cấu hình trên server.' });
    }
    const okUser = String(user || '') === ADMIN_USER;
    const pw = Buffer.from(String(password || ''));
    const expect = Buffer.from(ADMIN_PASSWORD);
    const okPass = pw.length === expect.length && crypto.timingSafeEqual(pw, expect);
    if (!okUser || !okPass) {
      return res.status(401).json({ ok: false, error: 'Sai tài khoản hoặc mật khẩu.' });
    }
    const token = sign({ u: ADMIN_USER, exp: Date.now() + SESSION_TTL_MS });
    const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
    res.setHeader('Set-Cookie',
      `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=${SESSION_TTL_MS / 1000}`);
    return res.json({ ok: true });
  });

  app.post('/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return res.json({ ok: true });
  });

  app.get('/admin/api/summary', requireAuth, async (req, res) => {
    try {
      const total = await pool.query('SELECT count(*)::int AS n FROM rsvp_submissions');
      const bySource = await pool.query(
        'SELECT source, count(*)::int AS n FROM rsvp_submissions GROUP BY source');
      const byStatus = await pool.query(
        'SELECT status, count(*)::int AS n FROM rsvp_submissions GROUP BY status');
      const guests = await pool.query(
        "SELECT coalesce(sum(guest_count),0)::int AS n FROM rsvp_submissions WHERE status='yes'");
      return res.json({
        ok: true,
        total: total.rows[0].n,
        totalGuests: guests.rows[0].n,
        bySource: Object.fromEntries(bySource.rows.map((r) => [r.source, r.n])),
        byStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
      });
    } catch (err) {
      console.error('[admin] summary failed:', err.message);
      return res.status(500).json({ ok: false, error: 'summary error' });
    }
  });

  app.get('/admin/api/responses', requireAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
    try {
      const params = [];
      let where = '';
      if (q) {
        params.push(`%${q}%`);
        where = 'WHERE rep_name ILIKE $1 OR rep_phone ILIKE $1 OR rep_email ILIKE $1 OR rep_org ILIKE $1';
      }
      params.push(limit);
      // Read-only, authed. Returns the full record the dashboard needs;
      // phone is MASKED here (full phone only via /admin/api/export.csv).
      const rows = await pool.query(
        `SELECT id, source, status, rep_name, rep_phone, rep_email, rep_org, sessions,
                dietary, wish, note, guests, guest_count, submitted_at, created_at
         FROM rsvp_submissions ${where}
         ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return res.json({
        ok: true,
        rows: rows.rows.map((r) => ({
          id: String(r.id),
          source: r.source,
          status: r.status,
          rep: {
            name: r.rep_name || '',
            phone: maskPhone(r.rep_phone),
            email: r.rep_email || '',
            org: r.rep_org || '',
          },
          sessions: r.sessions ? String(r.sessions).split(' · ').filter(Boolean) : [],
          dietary: r.dietary || '',
          wish: r.wish || '',
          note: r.note || '',
          guests: Array.isArray(r.guests) ? r.guests : [],
          guestCount: r.guest_count,
          submittedAt: r.submitted_at || r.created_at,
          createdAt: r.created_at,
        })),
      });
    } catch (err) {
      console.error('[admin] responses failed:', err.message);
      return res.status(500).json({ ok: false, error: 'responses error' });
    }
  });

  app.get('/admin/api/export.csv', requireAuth, async (req, res) => {
    try {
      const rows = await pool.query(
        `SELECT rep_name, rep_phone, rep_email, source, status, guest_count,
                sessions, dietary, wish, note, submitted_at, created_at
         FROM rsvp_submissions ORDER BY created_at DESC`);
      const header = ['Ho ten', 'So dien thoai', 'Email', 'Nguon', 'Trang thai',
        'So khach', 'Phan tham du', 'Am thuc', 'Loi chuc', 'Ghi chu', 'Gui luc', 'Tao luc'];
      const lines = [header.map(csvCell).join(',')];
      for (const r of rows.rows) {
        lines.push([
          r.rep_name, r.rep_phone, r.rep_email, r.source, r.status, r.guest_count,
          r.sessions, r.dietary, r.wish, r.note,
          r.submitted_at ? new Date(r.submitted_at).toISOString() : '',
          new Date(r.created_at).toISOString(),
        ].map(csvCell).join(','));
      }
      // UTF-8 BOM so Excel renders Vietnamese correctly.
      const csv = '﻿' + lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="rsvp-esuhai20.csv"');
      return res.send(csv);
    } catch (err) {
      console.error('[admin] export failed:', err.message);
      return res.status(500).json({ ok: false, error: 'export error' });
    }
  });

  // Import a guest list (CSV / .xlsx, header row 1) into the reception CRM
  // (crm_guests) — admin-cookie authed, same pipeline as /crm/import (E08-D014).
  app.post('/admin/api/import-crm', requireAuth, crmImport.upload.single('file'), async (req, res) => {
    try {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const out = await crmImport.importRows(crmImport.parseUpload(req), 'admin:' + ADMIN_USER, ip);
      return res.json({ ok: true, ...out });
    } catch (err) { return crmImport.importError(res, err, 'admin-import-crm'); }
  });

  // Export guests as a CSV for Ly's seating tool (xep-ban.html). "Mã khách" =
  // guest_ext_id so table numbers round-trip back. "Hạng" is a best-effort
  // default from tags — BTC edits it before seating.
  //
  // E08-D050 — ĐƯỜNG VỀ nay là /crm → «Nhập file CẬP NHẬT» (D032), KHÔNG còn là
  // import-tables (tuyến đó đã khoá 410, xem cuối tệp). Sửa luôn câu này vì chú
  // thích cũ chỉ sang một tuyến đã chết là đúng cái bẫy D053 đang phải đi vá:
  // người sau đọc chú thích rồi tin, không đọc mã.
  app.get('/admin/api/export-seating.csv', requireAuth, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, guest_ext_id, full_name, org, tags, note FROM crm_guests
         WHERE deleted_at IS NULL ORDER BY full_name`);
      const hang = (tags) => {
        const t = (tags || '').toLowerCase();
        if (/nội bộ|noi bo|nhân viên|nhan vien|học viên|hoc vien|\bbtc\b/.test(t)) return 'Nội bộ';
        if (/vip/.test(t)) return 'VIP1';
        return 'VIP2 - Hàng 3';
      };
      const diet = (note) => (/chay/i.test(note || '') ? 'Món chay' : 'Món mặn');
      const header = ['Mã khách', 'Họ tên', 'Đơn vị', 'Hạng', 'Ẩm thực'];
      const lines = [header.map(csvCell).join(',')];
      for (const g of r.rows) {
        lines.push([g.guest_ext_id || ('crm:' + g.id), g.full_name, g.org, hang(g.tags), diet(g.note)].map(csvCell).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ds-xep-ban.csv"');
      return res.send('﻿' + lines.join('\r\n'));
    } catch (err) {
      console.error('[admin] export-seating failed:', err.message);
      return res.status(500).json({ ok: false, error: 'export error' });
    }
  });

  /* ---- E08-D050 · TUYẾN NÀY ĐÃ KHOÁ — ĐỪNG KHÔI PHỤC ----
     Sponsor chốt 06/08 18:4x (CR-77 ③). Trước đó CR-33 (05/08) đã chốt «nạp
     bàn/ghế qua CRM, không vá admin; bỏ admin sau» — chưa ai bỏ, và hàng rào
     duy nhất suốt từ đó tới nay là «không ai mở màn đó».

     VÌ SAO KHOÁ, không phải vì gọn gàng:
     Thân cũ chạy `UPDATE crm_guests SET table_no=$1` với `[ban || null]`, tức
     một ô **Bàn rỗng** trong file là GHI NULL — xoá số bàn. Cả vòng lặp nằm
     trong MỘT `BEGIN…COMMIT`, nên **một file thiếu cột Bàn là quét sạch sơ đồ
     chỗ ngồi** của chị Ly trong đúng một lượt nạp, không popup, không hỏi lại.
     Khác hẳn vòng D032 (`import-update.js`) đang dùng thật: ở đó ô rỗng nghĩa
     là «không đổi» (COALESCE), muốn xoá phải gõ tường minh `(xoá)`.

     ĐƯỜNG ĐÚNG: /crm → «Nhập file CẬP NHẬT (Bàn · Ghế · Trạng thái)» — D032.

     Giữ tuyến lại (thay vì gỡ hẳn) để ai còn tab cũ / bookmark cũ bấm vào thì
     nhận được CHỈ DẪN, không nhận 404 câm. Bỏ `requireAuth` và bỏ multer có
     chủ đích: thân này không đọc gì, không ghi gì, không chạm CSDL — không còn
     thứ gì để canh, và bỏ chúng đi thì AC-1 kiểm được bằng một lệnh gọi trần. */
  app.post('/admin/api/import-tables', (req, res) => res.status(410).json({
    ok: false,
    error: 'Tuyến này đã khoá (E08-D050). Nạp bàn/ghế qua CRM → «Nhập file CẬP NHẬT (D032)». '
         + 'Lý do: ô Bàn rỗng ở đây ghi NULL, một file sai là xoá sạch sơ đồ chỗ ngồi.',
    thay_bang: '/crm',
  }));
}

module.exports = { mount };
