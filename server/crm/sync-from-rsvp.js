'use strict';

// Sync an RSVP submission (status=yes) into crm_guests so the reception team
// can find + check them in. Idempotent (safe on the write path AND re-run by
// backfill). Never ALTERs rsvp_submissions; only writes crm_guests.
const { pool } = require('../db');

function normPhone(p) { return String(p || '').replace(/\D/g, ''); }
function clean(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v)); }

function mergeTags(existing, add) {
  const set = new Set(String(existing || '').split(',').map((s) => s.trim()).filter(Boolean));
  (add || []).forEach((t) => { if (t) set.add(String(t).trim()); });
  return Array.from(set).join(',');
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
       response_id, ext_id, mergeTags(existing.tags, tags), existing.id]);
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
