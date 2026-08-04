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
  // Session tags written by the D018 importer (Wave A uses tags, not a schema
  // column — see E08-D020). Only these two are filterable; anything else 400s.
  const SESSION_TAGS = { 'toa-dam': 'toa-dam', gala: 'gala' };
  // Buổi khai trên form nằm ở `rsvp_submissions.sessions` — **free text** người
  // dùng gõ trên form công khai (rsvp.js không whitelist). Sau E08-D028 chuỗi
  // này QUYẾT ĐỊNH ai lên /checkin-gala.html, nên phải khớp có BIÊN TỪ:
  // '%ala%' cũ khớp cả "Salad" và "Balalaika".
  // Một hằng dùng chung cho ?session= và cho field du_* — không viết hai bản.
  const SESSION_RE = {
    'toa-dam': '(^|[^[:alpha:]])(t[oọ]a[ ]?đ[aà]m|toa dam)([^[:alpha:]]|$)',
    gala: '(^|[^[:alpha:]])gala([^[:alpha:]]|$)',
  };

  app.get('/crm/guests', requireCrmAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const mine = String(req.query.mine || '') === '1';
    const session = String(req.query.session || '').trim();
    if (session && !SESSION_TAGS[session]) return res.status(400).json({ ok: false, error: 'session không hợp lệ (toa-dam|gala).' });
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 50));
    try {
      const params = []; const conds = ['g.deleted_at IS NULL'];
      let join = '';
      if (q) {
        params.push('%' + q + '%');
        conds.push(`(g.full_name ILIKE $${params.length} OR g.phone_norm ILIKE $${params.length} OR g.org ILIKE $${params.length})`);
      }
      if (session) {
        // MỘT SoT (E08-D028 AC-A): buổi = tag danh sách ∪ buổi khai trên form,
        // đúng luật KPI /crm/stats đang dùng.
        //
        // Trước đây chỉ lọc theo tag. Nhưng D026 gỡ tag buổi khỏi khách đã có
        // bản đăng ký (D016 luật 5 — ba nhóm phải rời nhau, buổi của họ đọc từ
        // form), nên bộ lọc này giấu mất họ: đo trên prod Gala 303 trong khi
        // thực tế 350 — 47 khách đã đăng ký KHÔNG hiện ở trang check-in, PG tra
        // không ra và màn không có dấu hiệu gì.
        params.push('%,' + SESSION_TAGS[session] + ',%');
        const tagIdx = params.length;
        params.push(SESSION_RE[session]);
        const formIdx = params.length;
        conds.push(`(
          (',' || COALESCE(g.tags,'') || ',') ILIKE $${tagIdx}
          OR (g.response_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM rsvp_submissions s
                WHERE s.id = g.response_id AND s.sessions ~* $${formIdx}))
        )`);
      }
      if (mine) {
        params.push(req.actor.email);
        join = `JOIN crm_assignments a ON a.guest_id = g.id AND a.staff_email = $${params.length}`;
      }
      params.push(limit);
      const r = await pool.query(
        // du_toa_dam / du_gala: buổi HIỆU LỰC của khách = tag danh sách ∪ buổi
        // khai trên form. Trả sẵn từ máy chủ để tab, ?session= và KPI dùng CHUNG
        // một luật — trước đây client tự đếm tag nên nói 303 trong khi KPI nói
        // 350, và 47 khách đã đăng ký biến mất khỏi tab Gala.
        `SELECT g.id, g.full_name, g.phone, g.org, g.title, g.table_no, g.tags, g.note,
                ((',' || COALESCE(g.tags,'') || ',') ILIKE '%,toa-dam,%'
                 OR (g.response_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM rsvp_submissions s WHERE s.id = g.response_id
                         AND s.sessions ~* '${SESSION_RE['toa-dam']}'))) AS du_toa_dam,
                ((',' || COALESCE(g.tags,'') || ',') ILIKE '%,gala,%'
                 OR (g.response_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM rsvp_submissions s WHERE s.id = g.response_id
                         AND s.sessions ~* '${SESSION_RE.gala}'))) AS du_gala,
                (g.response_id IS NOT NULL) AS from_rsvp,
                (ci.guest_id IS NOT NULL) AS checked_in, ci.checked_in_at, ci.actor_email AS checked_in_by,
                CASE WHEN p.id IS NULL THEN NULL ELSE '/crm/photos/' || p.id END AS photo_url
         FROM crm_guests g
         ${join}
         LEFT JOIN crm_check_ins ci ON ci.guest_id = g.id
         LEFT JOIN LATERAL (
           SELECT ph.id FROM crm_photos ph WHERE ph.guest_id = g.id ORDER BY ph.created_at DESC LIMIT 1
         ) p ON TRUE
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
      // du_toa_dam / du_gala phải có ở ĐÂY nữa, không chỉ ở list. Hồ sơ khách
      // đọc từ endpoint này; thiếu hai field thì `buoiOf()` ra "—" cho MỌI
      // khách — nặng hơn cả trạng thái trước vé. Dùng chung SESSION_RE.
      const g = await pool.query(
        `SELECT *,
           ((',' || COALESCE(tags,'') || ',') ILIKE '%,toa-dam,%'
            OR (response_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM rsvp_submissions s WHERE s.id = crm_guests.response_id
                    AND s.sessions ~* $2))) AS du_toa_dam,
           ((',' || COALESCE(tags,'') || ',') ILIKE '%,gala,%'
            OR (response_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM rsvp_submissions s WHERE s.id = crm_guests.response_id
                    AND s.sessions ~* $3))) AS du_gala
         FROM crm_guests WHERE id = $1 AND deleted_at IS NULL`,
        [id, SESSION_RE['toa-dam'], SESSION_RE.gala]);
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
          table_no: row.table_no, response_id: row.response_id, created_at: row.created_at,
          du_toa_dam: row.du_toa_dam, du_gala: row.du_gala,
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
