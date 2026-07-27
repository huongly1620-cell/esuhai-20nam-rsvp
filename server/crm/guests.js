'use strict';

const { pool } = require('../db');
const { logAudit } = require('./audit');
const { ipOf } = require('./auth');

function normPhone(p) { return String(p || '').replace(/\D/g, ''); }
function clean(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v)); }

// staff may update these; never id/response_id/deleted_at/guest_ext_id.
const PATCH_WHITELIST = ['full_name', 'phone', 'email', 'org', 'title', 'note', 'tags'];

function mount(app, requireCrmAuth, requireRole) {
  // ---- search (staff sees all; ?mine=1 filters to actor's assignments) ----
  app.get('/crm/guests', requireCrmAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const mine = String(req.query.mine || '') === '1';
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    try {
      const params = []; const conds = ['g.deleted_at IS NULL'];
      let join = '';
      if (q) {
        params.push('%' + q + '%');
        conds.push(`(g.full_name ILIKE $${params.length} OR g.phone_norm ILIKE $${params.length} OR g.org ILIKE $${params.length})`);
      }
      if (mine) {
        params.push(req.actor.email);
        join = `JOIN crm_assignments a ON a.guest_id = g.id AND a.staff_email = $${params.length}`;
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT g.id, g.full_name, g.phone, g.org, g.title,
                (ci.guest_id IS NOT NULL) AS checked_in, ci.checked_in_at, ci.actor_email AS checked_in_by
         FROM crm_guests g
         ${join}
         LEFT JOIN crm_check_ins ci ON ci.guest_id = g.id
         ${'WHERE ' + conds.join(' AND ')}
         ORDER BY g.full_name ASC LIMIT $${params.length}`, params);
      return res.json({ ok: true, rows: r.rows });
    } catch (err) {
      console.error('[crm-guests] search failed:', err.message);
      return res.status(500).json({ ok: false, error: 'search error' });
    }
  });

  // ---- guest detail ----
  app.get('/crm/guests/:id', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const g = await pool.query('SELECT * FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const ci = await pool.query('SELECT actor_email, checked_in_at, note FROM crm_check_ins WHERE guest_id = $1', [id]);
      const asg = await pool.query('SELECT staff_email, assigned_at FROM crm_assignments WHERE guest_id = $1', [id]);
      const inter = await pool.query('SELECT id, actor_email, kind, body, created_at FROM crm_interactions WHERE guest_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
      const photos = await pool.query('SELECT id, object_key, content_type, uploaded_by, created_at FROM crm_photos WHERE guest_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
      const row = g.rows[0];
      return res.json({
        ok: true,
        guest: {
          id: row.id, full_name: row.full_name, phone: row.phone, email: row.email,
          org: row.org, title: row.title, note: row.note, tags: row.tags,
          response_id: row.response_id, created_at: row.created_at,
        },
        checkIn: ci.rows[0] || null,
        assignments: asg.rows,
        interactions: inter.rows,
        photos: photos.rows.map((p) => ({ id: p.id, url: '/crm/photos/' + p.id, content_type: p.content_type, uploaded_by: p.uploaded_by, created_at: p.created_at })),
      });
    } catch (err) {
      console.error('[crm-guests] detail failed:', err.message);
      return res.status(500).json({ ok: false, error: 'detail error' });
    }
  });

  // ---- create (btl) ----
  app.post('/crm/guests', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const b = req.body || {};
    const name = clean(b.full_name);
    if (!name) return res.status(400).json({ ok: false, error: 'Thiếu họ tên.' });
    const phone = clean(b.phone);
    try {
      const r = await pool.query(
        `INSERT INTO crm_guests (full_name, phone, phone_norm, email, org, title, note, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [name, phone || null, phone ? normPhone(phone) : null, clean(b.email) || null,
         clean(b.org) || null, clean(b.title) || null, clean(b.note) || null, clean(b.tags) || null]
      );
      const id = r.rows[0].id;
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'guest_create', target_type: 'guest', target_id: id, ip: ipOf(req) });
      return res.status(201).json({ ok: true, id: String(id) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ ok: false, error: 'Số điện thoại đã tồn tại.' });
      console.error('[crm-guests] create failed:', err.message);
      return res.status(500).json({ ok: false, error: 'create error' });
    }
  });

  // ---- patch (staff+, field whitelist) ----
  app.patch('/crm/guests/:id', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const b = req.body || {};
    const sets = []; const params = []; const changed = {};
    for (const f of PATCH_WHITELIST) {
      if (Object.prototype.hasOwnProperty.call(b, f)) {
        params.push(clean(b[f]) || null); sets.push(`${f} = $${params.length}`); changed[f] = true;
        if (f === 'phone') { params.push(clean(b[f]) ? normPhone(b[f]) : null); sets.push(`phone_norm = $${params.length}`); }
      }
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Không có trường hợp lệ để cập nhật.' });
    sets.push('updated_at = now()');
    params.push(id);
    try {
      const r = await pool.query(`UPDATE crm_guests SET ${sets.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL RETURNING id`, params);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'guest_update', target_type: 'guest', target_id: id, meta: { fields: Object.keys(changed) }, ip: ipOf(req) });
      return res.json({ ok: true });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ ok: false, error: 'Số điện thoại đã tồn tại.' });
      console.error('[crm-guests] patch failed:', err.message);
      return res.status(500).json({ ok: false, error: 'update error' });
    }
  });

  // ---- soft delete (btl) ----
  app.delete('/crm/guests/:id', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const r = await pool.query('UPDATE crm_guests SET deleted_at = now(), phone_norm = NULL WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'guest_delete', target_type: 'guest', target_id: id, ip: ipOf(req) });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[crm-guests] delete failed:', err.message);
      return res.status(500).json({ ok: false, error: 'delete error' });
    }
  });

  // ---- check-in (single per guest; report if already) ----
  app.post('/crm/guests/:id/check-in', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const exists = await pool.query('SELECT actor_email, checked_in_at FROM crm_check_ins WHERE guest_id = $1', [id]);
      if (exists.rows[0]) {
        return res.status(200).json({ ok: true, already: true, by: exists.rows[0].actor_email, at: exists.rows[0].checked_in_at });
      }
      const g = await pool.query('SELECT id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const ins = await pool.query(
        `INSERT INTO crm_check_ins (guest_id, actor_email, note) VALUES ($1,$2,$3)
         ON CONFLICT (guest_id) DO NOTHING RETURNING checked_in_at`,
        [id, req.actor.email, clean(req.body && req.body.note) || null]);
      if (!ins.rows[0]) {
        const e2 = await pool.query('SELECT actor_email, checked_in_at FROM crm_check_ins WHERE guest_id = $1', [id]);
        return res.status(200).json({ ok: true, already: true, by: e2.rows[0].actor_email, at: e2.rows[0].checked_in_at });
      }
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'check_in', target_type: 'guest', target_id: id, ip: ipOf(req) });
      return res.status(201).json({ ok: true, already: false, at: ins.rows[0].checked_in_at });
    } catch (err) {
      console.error('[crm-guests] check-in failed:', err.message);
      return res.status(500).json({ ok: false, error: 'check-in error' });
    }
  });

  // ---- interaction ----
  app.post('/crm/guests/:id/interactions', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const kind = clean(req.body && req.body.kind) || 'khác';
    const body = clean(req.body && req.body.body);
    if (!body) return res.status(400).json({ ok: false, error: 'Thiếu nội dung ghi chú.' });
    try {
      const g = await pool.query('SELECT id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const r = await pool.query('INSERT INTO crm_interactions (guest_id, actor_email, kind, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
        [id, req.actor.email, kind.slice(0, 40), body]);
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'interaction_create', target_type: 'guest', target_id: id, meta: { kind }, ip: ipOf(req) });
      return res.status(201).json({ ok: true, id: String(r.rows[0].id), created_at: r.rows[0].created_at });
    } catch (err) {
      console.error('[crm-guests] interaction failed:', err.message);
      return res.status(500).json({ ok: false, error: 'interaction error' });
    }
  });
}

module.exports = { mount, normPhone };
