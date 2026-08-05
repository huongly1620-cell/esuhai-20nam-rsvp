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

// Parse an uploaded file into rows (array-of-arrays). Supports CSV and .xlsx
// (generic: first sheet, header on row 1). The TGĐ file (header row 3) uses
// the dedicated CLI importer instead.
function parseUpload(req) {
  const f = req.file;
  const fname = String((f && f.originalname) || '').toLowerCase();
  const isXlsx = f && f.buffer && (fname.endsWith('.xlsx') || /sheet|excel/.test(f.mimetype || ''));
  if (isXlsx) {
    const XLSX = require('xlsx'); // lazy
    const wb = XLSX.read(f.buffer, { type: 'buffer' });
    const sh = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' }).map((r) => r.map((c) => String(c == null ? '' : c)));
  }
  let text = '';
  if (f && f.buffer) text = f.buffer.toString('utf8');
  else if (req.body && req.body.csv) text = String(req.body.csv);
  return text.trim() ? parseCSV(text) : [];
}

// Idempotent upsert of parsed rows into crm_guests (key: guest_ext_id else
// phone_norm). Returns {created, updated, assigned, total}. Throws with
// err.code EMPTY / NONAME for caller-friendly messages.
async function importRows(rows, actorEmail, ip) {
  if (!rows || rows.length < 2) { const e = new Error('empty'); e.code = 'EMPTY'; throw e; }
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
  if (col.name === -1) { const e = new Error('no name col'); e.code = 'NONAME'; throw e; }

  const client = await pool.connect();
  let created = 0; let updated = 0; let assigned = 0;
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
          [name, phone || null, pn, get(col.email) || null, get(col.org) || null, get(col.title) || null, get(col.tags) || null, ext, guestId]);
        updated++;
      } else {
        const ins = await client.query(
          `INSERT INTO crm_guests (guest_ext_id, full_name, phone, phone_norm, email, org, title, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [ext, name, phone || null, pn, get(col.email) || null, get(col.org) || null, get(col.title) || null, get(col.tags) || null]);
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
    client.release();
    throw err;
  }
  client.release();
  await logAudit(pool, { actor_email: actorEmail, event_type: 'import_run', target_type: 'import', meta: { created, updated, assigned, rows: rows.length - 1 }, ip });
  return { created, updated, assigned, total: rows.length - 1 };
}

function importError(res, err, tag) {
  if (err.code === 'EMPTY') return res.status(400).json({ ok: false, error: 'File trống hoặc không đọc được.' });
  if (err.code === 'NONAME') return res.status(400).json({ ok: false, error: 'Không tìm thấy cột Họ tên (tiêu đề dòng 1: Họ tên, SĐT, Đơn vị…).' });
  console.error(`[${tag}] failed:`, err.message);
  return res.status(500).json({ ok: false, error: 'Import lỗi.' });
}

function mount(app, requireCrmAuth, requireRole) {
  // E08-D030 — nạp SỐ BÀN + SỐ GHẾ từ CSV của công cụ xếp bàn, ĐI QUA CRM.
  // Sponsor chốt 05/08: không vá '/admin/api/import-tables' nữa (đường đó sẽ
  // chết khi bỏ admin). Khác đường admin ở một chỗ QUAN TRỌNG: admin ghi
  // `table_no=$1` với `ban || null`, nên MỘT Ô RỖNG XOÁ SẠCH số bàn đang có.
  // Ở đây COALESCE(NULLIF(...)) — ô rỗng nghĩa là "không đổi", đúng luật merge
  // D022 và đúng AC-5.
  app.post('/crm/import-seats', requireCrmAuth, requireRole('btl'), upload.single('file'), async (req, res) => {
    let client;
    try {
      const rows = parseUpload(req);
      if (!rows || rows.length < 2) return res.status(400).json({ ok: false, error: 'File trống.' });
      const hdr = rows[0];
      const iMa = detectCol(hdr, ['makhach', 'maid', 'guest_ext_id']);
      const iBan = detectCol(hdr, ['soban', 'table']);
      const iGhe = detectCol(hdr, ['soghe', 'seat']);
      if (iMa < 0) return res.status(400).json({ ok: false, error: 'Cần cột "Mã khách".' });
      if (iBan < 0 && iGhe < 0) return res.status(400).json({ ok: false, error: 'Cần ít nhất cột "Số bàn" hoặc "Số ghế".' });
      let matched = 0; let unmatched = 0; let setBan = 0; let setGhe = 0;
      client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let r = 1; r < rows.length; r++) {
          const ma = String(rows[r][iMa] || '').trim();
          if (!ma) continue;
          const ban = iBan > -1 ? String(rows[r][iBan] || '').trim() : '';
          const ghe = iGhe > -1 ? String(rows[r][iGhe] || '').trim() : '';
          if (ban) setBan++;
          if (ghe) setGhe++;
          const byId = ma.startsWith('crm:');
          const upd = await client.query(
            `UPDATE crm_guests
                SET table_no = COALESCE(NULLIF($1, ''), table_no),
                    seat_no  = COALESCE(NULLIF($2, ''), seat_no),
                    updated_at = now()
              WHERE ${byId ? 'id' : 'guest_ext_id'} = $3 AND deleted_at IS NULL`,
            [ban, ghe, byId ? (parseInt(ma.slice(4), 10) || 0) : ma]);
          if (upd.rowCount > 0) matched++; else unmatched++;
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'import_seats',
        target_type: 'crm_guests', meta: { khop: matched, khongKhop: unmatched, oBan: setBan, oGhe: setGhe }, ip: ipOf(req) });
      return res.json({ ok: true, matched, unmatched, setBan, setGhe, total: rows.length - 1 });
    } catch (err) {
      console.error('[crm-import] seats failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Nhập Bàn/Ghế lỗi.' });
    } finally { if (client) client.release(); }
  });

  app.post('/crm/import', requireCrmAuth, requireRole('btl'), upload.single('file'), async (req, res) => {
    try {
      const out = await importRows(parseUpload(req), req.actor.email, ipOf(req));
      return res.json({ ok: true, ...out, errors: [] });
    } catch (err) { return importError(res, err, 'crm-import'); }
  });
}

module.exports = { mount, parseUpload, importRows, importError, upload };
