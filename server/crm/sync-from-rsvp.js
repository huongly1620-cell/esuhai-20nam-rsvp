'use strict';

// Sync an RSVP submission (status=yes) into crm_guests so the reception team
// can find + check them in. Idempotent (safe on the write path AND re-run by
// backfill). Never ALTERs rsvp_submissions; only writes crm_guests.
const { pool } = require('../db');

function normPhone(p) { return String(p || '').replace(/\D/g, ''); }
function clean(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v)); }

// Cùng quy ước chuẩn hoá tên với import-vnjb.js — không phát minh luật thứ hai.
const HONOR = /^(anh|chị|chi|ông|ong|bà|ba|cô|co|chú|chu|thầy|thay|em|mr|mrs|ms|dr|gs|ts)\.?\s+/i;
function nameKey(s) {
  let x = String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i < 3; i++) x = x.replace(HONOR, '');
  return x.trim();
}

function mergeTags(existing, add) {
  const set = new Set(String(existing || '').split(',').map((s) => s.trim()).filter(Boolean));
  (add || []).forEach((t) => { if (t) set.add(String(t).trim()); });
  return Array.from(set).join(',');
}

// Thẻ vừa nhận `response_id` thì buổi đọc từ FORM, không đọc từ tag danh sách.
// D016 luật 5: ba nhóm (tag danh sách / theo form / chưa rõ) phải RỜI NHAU.
// Để cả hai là `overlap ≠ 0` → `/crm/stats.integrity.disjoint = false` → KPI
// phải hạ dòng "Dự Gala". Import Pha 2 đã dính đúng chỗ này một lần.
function dropSessionTags(csv) {
  return String(csv || '').split(',').map((s) => s.trim())
    .filter((s) => s && s !== 'toa-dam' && s !== 'gala').join(',');
}

// Upsert one CRM guest from an RSVP person. `db` = pool or a tx client.
// Match order: phone_norm (merge existing CSV/manual card) → guest_ext_id.
async function upsertOne(db, { ext_id, full_name, phone, email, org, title, response_id, tags }) {
  full_name = clean(full_name);
  if (!full_name) return null;
  const pn = phone ? normPhone(phone) : null;

  let existing = null;
  if (pn) {
    const r = await db.query('SELECT id, tags FROM crm_guests WHERE phone_norm = $1 AND deleted_at IS NULL', [pn]);
    existing = r.rows[0] || null;
  }
  if (!existing && ext_id) {
    const r = await db.query('SELECT id, tags FROM crm_guests WHERE guest_ext_id = $1', [ext_id]);
    existing = r.rows[0] || null;
  }
  // Làn TÊN (E08-D026). Sau khi nạp SoT, 259/401 thẻ mang mã `vnjb-*` và
  // `phone = NULL` (sheet của Ly không có cột SĐT) — nên khách trong danh sách
  // mời điền form thì hai làn trên TRƯỢT CẢ HAI và rơi xuống INSERT, tạo thẻ
  // thứ hai không ảnh, không số bàn, không tag buổi. 25 người đã dính trước khi
  // vá. Đây là đường ghi LIVE nên mỗi ngày còn thêm.
  if (!existing) {
    const r = await db.query(
      `SELECT id, tags, guest_ext_id FROM crm_guests
       WHERE deleted_at IS NULL AND lower(btrim(regexp_replace(
         full_name, '^(Anh|Chị|Ông|Bà|Cô|Chú|Thầy|Em|Mr|Mrs|Ms|Dr|GS|TS)\\.?\\s+', '', 'gi'))) = $1`,
      [nameKey(full_name)]);
    if (r.rows.length === 1) existing = r.rows[0];
    else if (r.rows.length > 1) {
      // Trùng tên: chỉ nối khi ĐÚNG MỘT thẻ thuộc danh sách mời chính thức
      // (tag `vnjb`). Thẻ đó là đích đúng; các thẻ kia là bản trùng do chính
      // lỗi này sinh ra. Không có căn cứ đó thì THÀ tạo thẻ mới + gắn cờ còn
      // hơn gộp nhầm hai người khác nhau.
      const sot = r.rows.filter((x) => (',' + String(x.tags || '') + ',').includes(',vnjb,'));
      if (sot.length === 1) existing = sot[0];
      else tags = (tags || []).concat('trung-ten-can-ra');
    }
  }

  if (existing) {
    await db.query(
      `UPDATE crm_guests SET
         full_name = $1,
         phone = COALESCE($2, phone), phone_norm = COALESCE($3, phone_norm),
         email = COALESCE($4, email), org = COALESCE($5, org), title = COALESCE($6, title),
         response_id = COALESCE(response_id, $7),
         guest_ext_id = COALESCE(guest_ext_id, $8),
         tags = $9, updated_at = now()
       WHERE id = $10`,
      [full_name, phone || null, pn, clean(email) || null, clean(org) || null, clean(title) || null,
       response_id, ext_id, dropSessionTags(mergeTags(existing.tags, tags)), existing.id]);
    return existing.id;
  }
  const ins = await db.query(
    `INSERT INTO crm_guests (guest_ext_id, full_name, phone, phone_norm, email, org, title, response_id, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ext_id, full_name, phone || null, pn, clean(email) || null, clean(org) || null, clean(title) || null,
     response_id, mergeTags('', tags)]);
  return ins.rows[0].id;
}

// sub = { id, source, rep:{name,phone,email,org}, guests:[{name,org,title}] }
// In the landing form rep === guests[0] (same person; rep carries phone/email),
// so we upsert rep once (keyed by phone) + guests[1..] as extra attendees.
async function syncFromRsvp(db, sub) {
  if (!sub || !sub.id) return;
  const id = sub.id;
  const guests = Array.isArray(sub.guests) ? sub.guests : [];
  const rep = sub.rep || {};
  const tags = ['rsvp', sub.source].filter(Boolean);
  const g0 = guests[0] || {};

  await upsertOne(db, {
    ext_id: `rsvp:${id}:rep`,
    full_name: rep.name || g0.name,
    phone: rep.phone, email: rep.email,
    org: rep.org || g0.org, title: g0.title,
    response_id: id, tags,
  });

  for (let i = 1; i < guests.length; i++) {
    const g = guests[i];
    if (!g || !clean(g.name)) continue;
    await upsertOne(db, {
      ext_id: `rsvp:${id}:g:${i}`,
      full_name: g.name, phone: null, email: null,
      org: g.org, title: g.title,
      response_id: id, tags,
    });
  }
}

module.exports = { syncFromRsvp, upsertOne, normPhone };
