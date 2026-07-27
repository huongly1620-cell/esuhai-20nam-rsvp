'use strict';

const { pool } = require('../db');
const { logAudit } = require('./audit');
const { ipOf } = require('./auth');
const { normPhone } = require('./guests');

let multer = null;
try { multer = require('multer'); } catch (_) { /* optional */ }
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }) : { single: () => (req, res, next) => next() };

function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v || '').trim() !== ''));
}
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ''); }
function detectCol(headers, keys) {
  for (let i = 0; i < headers.length; i++) { const h = norm(headers[i]); for (const k of keys) if (h.indexOf(k) > -1) return i; }
  return -1;
}
function clean(v) { return String(v == null ? '' : v).trim(); }

// Idempotent upsert keyed by guest_ext_id (if present) else normalized phone.
function mount(app, requireCrmAuth, requireRole) {
  app.post('/crm/import', requireCrmAuth, requireRole('btl'), upload.single('file'), async (req, res) => {
    let text = '';
    if (req.file && req.file.buffer) text = req.file.buffer.toString('utf8');
    else if (req.body && req.body.csv) text = String(req.body.csv);
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'File CSV trống.' });

    const rows = parseCSV(text);
    if (rows.length < 2) return res.status(400).json({ ok: false, error: 'CSV không có dữ liệu.' });
    const headers = rows[0];
    const col = {
      ext: detectCol(headers, ['extid', 'guestid', 'maid', 'ma']),
      name: detectCol(headers, ['hoten', 'tenkhach', 'fullname', 'ten', 'name']),
      phone: detectCol(headers, ['sdt', 'dienthoai', 'phone']),
      email: detectCol(headers, ['email']),
      org: detectCol(headers, ['donvi', 'org', 'congty', 'truong']),
      title: detectCol(headers, ['chucdanh', 'chucvu', 'title']),
      assigned: detectCol(headers, ['assign', 'phancong', 'nvphutrach', 'nv', 'staff']),
      tags: detectCol(headers, ['tag', 'nhom', 'loai']),
    };
    if (col.name === -1) return res.status(400).json({ ok: false, error: 'Không tìm thấy cột Họ tên trong CSV.' });

    const client = await pool.connect();
    let created = 0; let updated = 0; let assigned = 0; const errors = [];
    try {
      await client.query('BEGIN');
      for (let r = 1; r < rows.length; r++) {
        const rec = rows[r];
        const get = (i) => (i > -1 ? clean(rec[i]) : '');
        const name = get(col.name);
        if (!name) continue;
        const ext = get(col.ext) || null;
        const phone = get(col.phone);
        const pn = phone ? normPhone(phone) : null;
        const fields = { full_name: name, phone: phone || null, phone_norm: pn, email: get(col.email) || null, org: get(col.org) || null, title: get(col.title) || null, tags: get(col.tags) || null };

        // find existing by ext_id, else by phone_norm
        let existing = null;
        if (ext) { const e = await client.query('SELECT id FROM crm_guests WHERE guest_ext_id = $1', [ext]); existing = e.rows[0]; }
        if (!existing && pn) { const e = await client.query('SELECT id FROM crm_guests WHERE phone_norm = $1 AND deleted_at IS NULL', [pn]); existing = e.rows[0]; }

        let guestId;
        if (existing) {
          guestId = existing.id;
          await client.query(
            `UPDATE crm_guests SET full_name=$1, phone=COALESCE($2,phone), phone_norm=COALESCE($3,phone_norm),
               email=COALESCE($4,email), org=COALESCE($5,org), title=COALESCE($6,title), tags=COALESCE($7,tags),
               guest_ext_id=COALESCE($8,guest_ext_id), updated_at=now() WHERE id=$9`,
            [fields.full_name, fields.phone, fields.phone_norm, fields.email, fields.org, fields.title, fields.tags, ext, guestId]);
          updated++;
        } else {
          const ins = await client.query(
            `INSERT INTO crm_guests (guest_ext_id, full_name, phone, phone_norm, email, org, title, tags)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [ext, fields.full_name, fields.phone, fields.phone_norm, fields.email, fields.org, fields.title, fields.tags]);
          guestId = ins.rows[0].id;
          created++;
        }
        const asgEmail = get(col.assigned).toLowerCase();
        if (asgEmail) {
          const a = await client.query('INSERT INTO crm_assignments (guest_id, staff_email) VALUES ($1,$2) ON CONFLICT (guest_id, staff_email) DO NOTHING RETURNING id', [guestId, asgEmail]);
          if (a.rows[0]) assigned++;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[crm-import] failed:', err.message);
      client.release();
      return res.status(500).json({ ok: false, error: 'Import lỗi: ' + err.message });
    }
    client.release();
    await logAudit(pool, { actor_email: req.actor.email, event_type: 'import_run', target_type: 'import', meta: { created, updated, assigned, rows: rows.length - 1 }, ip: ipOf(req) });
    return res.json({ ok: true, created, updated, assigned, total: rows.length - 1, errors });
  });
}

module.exports = { mount };
