'use strict';

const { pool } = require('../db');
const { logAudit, hashIp } = require('./audit');
const { ipOf } = require('./auth');
// E08-D031: một luật trạng thái tham dự dùng chung cho list · detail · stats.
const att = require('./attendance');

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
  // E08-D031 chuyển sang `attendance.js` để `/crm/stats` dùng ĐÚNG chuỗi này,
  // thay vì mỗi file giữ một bản chép tay rồi lệch nhau lúc nào không ai biết.
  const SESSION_RE = att.SESSION_RE;

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
        `SELECT g.id, g.guest_ext_id, g.full_name, g.phone, g.org, g.title, g.table_no, g.seat_no, g.tags, g.note,
                g.name_jp, g.title_jp, g.org_jp,
                ((',' || COALESCE(g.tags,'') || ',') ILIKE '%,toa-dam,%'
                 OR (g.response_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM rsvp_submissions s WHERE s.id = g.response_id
                         AND s.sessions ~* '${SESSION_RE['toa-dam']}'))) AS du_toa_dam,
                ((',' || COALESCE(g.tags,'') || ',') ILIKE '%,gala,%'
                 OR (g.response_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM rsvp_submissions s WHERE s.id = g.response_id
                         AND s.sessions ~* '${SESSION_RE.gala}'))) AS du_gala,
                ${att.attSql('g', att.duSql('g', 'g.response_id', "'" + SESSION_RE['toa-dam'] + "'", "'" + SESSION_RE.gala + "'"))} AS att_status,
                (g.response_id IS NOT NULL) AS from_rsvp,
                (ci.guest_id IS NOT NULL) AS checked_in, ci.checked_in_at, ci.actor_email AS checked_in_by,
                -- E08-D029 AC-2: danh sách trỏ BẢN THU NHỎ, không phải file gốc.
                -- Route /thumb tự lùi về gốc khi thẻ chưa có bản dẫn xuất, nên
                -- không màn nào mất ảnh trong lúc backfill đang chạy dở.
                CASE WHEN p.id IS NULL THEN NULL ELSE '/crm/photos/' || p.id || '/thumb' END AS photo_url,
                -- AC-3b: bản vừa (1024px) cho khối hồ sơ; khung .pf-av là 190px
                -- CSS ≈ 570px thiết bị, dùng thumb 256px sẽ mờ.
                CASE WHEN p.id IS NULL THEN NULL ELSE '/crm/photos/' || p.id || '/preview' END AS photo_view_url
         FROM crm_guests g
         ${join}
         LEFT JOIN crm_check_ins ci ON ci.guest_id = g.id
         LEFT JOIN LATERAL (
           -- AC-G4: ảnh có interaction_id là ảnh QUÀ chụp tại quầy, không phải
           -- chân dung khách. Không loại ra thì tấm quà chụp sau cùng sẽ thành
           -- avatar của khách trên mọi danh sách. 202 ảnh cũ đều NULL nên điều
           -- kiện này không đổi gì với dữ liệu đang có.
           -- E08-D040: COALESCE cắt ngắn ⇒ thẻ ĐÃ GHIM không chạy câu con thứ hai.
           -- Đo trên prod: nhánh ghim là Index Scan khoá chính (2 buffers, 0,048 ms)
           -- so với nhánh lùi 5 buffers / 0,104 ms ⇒ sau backfill màn danh sách RẺ
           -- HƠN hôm nay. Nhánh lùi giữ NGUYÊN VĂN câu đang chạy ⇒ kế hoạch truy vấn
           -- không đổi, vẫn dùng idx_crm_photos_guest (guest_id, created_at DESC).
           SELECT COALESCE(
             -- M2 + M3 kiểm ngay trong nhánh ghim: ảnh quà hoặc ảnh của khách khác
             -- thì ra NULL ⇒ TỰ LÙI về tấm chân dung mới nhất, không bao giờ hiện
             -- nhầm mặt. PATCH vẫn chặn ở đầu vào — đây là lớp cuối.
             (SELECT ap.id FROM crm_photos ap
               WHERE ap.id = g.avatar_photo_id AND ap.guest_id = g.id AND ap.interaction_id IS NULL),
             (SELECT ph.id FROM crm_photos ph
               WHERE ph.guest_id = g.id AND ph.interaction_id IS NULL
               ORDER BY ph.created_at DESC LIMIT 1)
           ) AS id
         ) p ON TRUE
         ${'WHERE ' + conds.join(' AND ')}
         ORDER BY g.full_name ASC LIMIT $${params.length}`, params);
      // M1 (E08-D032): `guest_ext_id` là KHOÁ để file xuất nhập ngược khớp
      // đúng người. Trước đây API không trả nó nên bản xuất rơi về `g.id` nội
      // bộ ⇒ nhập lại khớp 0/344, INSERT 344 khách trùng. Chỉ lộ cho `btl` —
      // 2 cửa (role staff) không cần và không nên thấy khoá nội bộ.
      if (!req.actor || req.actor.role !== 'btl') r.rows.forEach((x) => { delete x.guest_ext_id; });
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
                    AND s.sessions ~* $3))) AS du_gala,
           ${att.attSql('', att.duSql('', 'crm_guests.response_id', '$2', '$3'))} AS att_status
         FROM crm_guests WHERE id = $1 AND deleted_at IS NULL`,
        [id, SESSION_RE['toa-dam'], SESSION_RE.gala]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const ci = await pool.query('SELECT actor_email, checked_in_at, note FROM crm_check_ins WHERE guest_id = $1', [id]);
      const asg = await pool.query('SELECT staff_email, assigned_at FROM crm_assignments WHERE guest_id = $1', [id]);
      const inter = await pool.query('SELECT id, actor_email, kind, body, created_at FROM crm_interactions WHERE guest_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
      const photos = await pool.query('SELECT id, object_key, content_type, uploaded_by, created_at, interaction_id FROM crm_photos WHERE guest_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
      const row = g.rows[0];
      return res.json({
        ok: true,
        guest: {
          id: row.id, full_name: row.full_name, phone: row.phone, email: row.email,
          org: row.org, title: row.title, note: row.note, tags: row.tags,
          table_no: row.table_no, seat_no: row.seat_no || null,
          response_id: row.response_id, created_at: row.created_at,
          du_toa_dam: row.du_toa_dam, du_gala: row.du_gala,
          name_jp: row.name_jp, title_jp: row.title_jp, org_jp: row.org_jp,
          att_status: row.att_status,
          att_override: row.att_override || null,
          att_override_by: row.att_override_by || null,
          att_override_at: row.att_override_at || null,
          // E08-D040 — màn cần biết tấm nào ĐANG ghim: để chọn đúng ảnh hồ sơ và
          // để đánh dấu nút «Đặt làm ảnh đại diện». Truy vấn hồ sơ dùng SELECT *
          // nên cột mới tự có, không phải sửa danh sách cột.
          avatar_photo_id: row.avatar_photo_id || null,
        },
        checkIn: ci.rows[0] || null,
        assignments: asg.rows,
        interactions: inter.rows,
        // interaction_id: ảnh nào là ảnh QUÀ (gắn vào một ghi nhận tại quầy),
        // ảnh nào là chân dung khách. Màn cửa lấy avatar = tấm ĐẦU TIÊN có
        // interaction_id rỗng, khớp đúng luật của list ở trên.
        // url = gốc (giữ nguyên cho thư viện ảnh / tải về) · view_url = bản 1024
        // cho khối hồ sơ · thumb_url = 256 cho dải ảnh nhỏ.
        photos: photos.rows.map((p) => ({ id: p.id, url: '/crm/photos/' + p.id,
          view_url: '/crm/photos/' + p.id + '/preview', thumb_url: '/crm/photos/' + p.id + '/thumb',
          content_type: p.content_type, uploaded_by: p.uploaded_by, created_at: p.created_at, interaction_id: p.interaction_id })),
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
      // E08-D032 — khách thêm tay PHẢI có guest_ext_id. Thiếu một thẻ là nút
      // «Xuất để CẬP NHẬT» chặn TOÀN BỘ danh sách (thẻ 437, 05/08), và thẻ đó
      // cũng không đi qua được vòng xuất-sửa-nhập. Khoá lấy từ chính id nên
      // duy nhất theo cấu tạo — không đụng va chạm như khoá băm từ tên.
      const cli = await pool.connect();
      let id;
      try {
        await cli.query('BEGIN');
        const r = await cli.query(
          `INSERT INTO crm_guests (full_name, phone, phone_norm, email, org, title, note, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [name, phone || null, phone ? normPhone(phone) : null, clean(b.email) || null,
           clean(b.org) || null, clean(b.title) || null, clean(b.note) || null, clean(b.tags) || null]
        );
        id = r.rows[0].id;
        await cli.query('UPDATE crm_guests SET guest_ext_id = $1 WHERE id = $2', ['tay-' + id, id]);
        await cli.query('COMMIT');
      } catch (e) { await cli.query('ROLLBACK').catch(() => {}); cli.release(); throw e; }
      cli.release();
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

  // ---- ghim ảnh đại diện (btl) — E08-D040 ----
  // Quyền đổi avatar nằm ở CRM, KHÔNG ở cửa: ở cửa lúc đông rất dễ bấm nhầm, mà
  // avatar là thứ chị Ly chuẩn bị trước. Cửa chỉ chụp và xem.
  app.patch("/crm/guests/:id/avatar", requireCrmAuth, requireRole("btl"), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: "bad id" });
    const raw = req.body && req.body.photo_id;
    // photo_id = null ⇒ BỎ ghim, avatar lùi về tấm mới nhất. Giữ đường lùi để còn
    // sửa được khi ghim nhầm.
    const pid = (raw === null || raw === "" || raw === undefined) ? null : parseInt(raw, 10);
    if (pid !== null && !pid) return res.status(400).json({ ok: false, error: "bad photo_id" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cu = (await client.query("SELECT avatar_photo_id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id])).rows[0];
      if (!cu) { await client.query("ROLLBACK"); client.release(); return res.status(404).json({ ok: false, error: "not found" }); }
      if (pid !== null) {
        const ph = (await client.query("SELECT id, guest_id, interaction_id FROM crm_photos WHERE id = $1", [pid])).rows[0];
        if (!ph) { await client.query("ROLLBACK"); client.release(); return res.status(404).json({ ok: false, error: "Không thấy ảnh." }); }
        // M3 — ảnh phải thuộc ĐÚNG khách này, nếu không thì ghim được mặt người
        // khác lên thẻ. M2 — ảnh quà (có interaction_id) không làm avatar được.
        if (String(ph.guest_id) !== String(id)) { await client.query("ROLLBACK"); client.release(); return res.status(400).json({ ok: false, error: "Ảnh này không thuộc khách đó." }); }
        if (ph.interaction_id) { await client.query("ROLLBACK"); client.release(); return res.status(400).json({ ok: false, error: "Ảnh quà không dùng làm ảnh đại diện được." }); }
      }
      await client.query("UPDATE crm_guests SET avatar_photo_id = $1, updated_at = now() WHERE id = $2", [pid, id]);
      await logAudit(client, { actor_email: req.actor.email, event_type: "avatar_set", target_type: "guest", target_id: id,
        meta: { cu: cu.avatar_photo_id || null, moi: pid }, ip: ipOf(req) });
      await client.query("COMMIT");
      client.release();
      return res.json({ ok: true, avatar_photo_id: pid });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      console.error("[crm-guests] avatar set failed:", err.message);
      return res.status(500).json({ ok: false, error: "avatar error" });
    }
  });

  // ---- huỷ check-in (btl) — E08-D036 ----
  // Bảng có `guest_id UNIQUE` nên huỷ = XOÁ DÒNG, không có cột đánh dấu. Sponsor
  // chốt hướng xoá thật vì `crm_check_ins` bị ĐỌC ở 5 chỗ (stats · list · hồ sơ ·
  // hai chỗ trong tuyến check-in); đánh dấu huỷ thì cả 5 phải thêm bộ lọc, sót
  // một chỗ là khách đã huỷ vẫn hiện ✓ hoặc KPI lệch danh sách. Xoá dòng thì cả
  // 5 chỗ tự đúng, không sửa câu đọc nào.
  //
  // Cái giá của xoá thật: giờ đến gốc mất vĩnh viễn ⇒ AC-7 bắt audit phải là bản
  // sao ĐỦ để dựng lại. Nên ở đây KHÔNG dùng logAudit(): hàm đó nuốt lỗi có chủ
  // đích (audit.js: "Never let audit failure break the main action") — đúng với
  // mọi tuyến khác, nhưng ở tuyến này nó lật ngược thành: ghi audit hỏng mà
  // DELETE vẫn commit ⇒ mất dữ liệu vĩnh viễn, IM LẶNG. Ghi thẳng bằng
  // client.query trong cùng giao dịch để lỗi ném ra ngoài và cuốn DELETE theo
  // (AC-16).
  app.delete('/crm/guests/:id/check-in', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // FOR UPDATE OF ci: khoá đúng dòng check-in (không khoá cả thẻ khách) để
      // hai người cùng bấm huỷ thì người thứ hai đọc được trạng thái đã xoá,
      // không phải cùng xoá một dòng hai lần (AC-9).
      const cur = await client.query(
        `SELECT ci.actor_email, ci.checked_in_at, ci.note, g.full_name
           FROM crm_check_ins ci JOIN crm_guests g ON g.id = ci.guest_id
          WHERE ci.guest_id = $1 FOR UPDATE OF ci`, [id]);
      if (!cur.rows[0]) {
        // AC-8: khách chưa check-in (hoặc vừa bị người khác huỷ) — trả lời hiền,
        // không 500. Màn cứ vẽ lại theo sự thật là xong.
        await client.query('COMMIT');
        client.release();
        return res.status(200).json({ ok: true, already: false });
      }
      const c0 = cur.rows[0];
      // AC-7 — chép đủ để dựng lại dòng đã mất, và ĐỨNG MỘT MÌNH được: tên khách
      // chép theo giá trị, không chỉ id, để nhật ký còn đọc được cả khi thẻ khách
      // sau này đổi tên hoặc bị xoá.
      await client.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'check_in_undo','guest',$2,$3::jsonb,$4)`,
        [req.actor.email, String(id),
          JSON.stringify({
            guest_id: id,
            guest_ten: c0.full_name,
            cu_checked_in_at: c0.checked_in_at,
            cu_actor_email: c0.actor_email,
            cu_note: c0.note || null,
          }),
          hashIp(ipOf(req))]);
      await client.query('DELETE FROM crm_check_ins WHERE guest_id = $1', [id]);
      await client.query('COMMIT');
      client.release();
      return res.status(200).json({ ok: true, already: true, cu: { at: c0.checked_in_at, by: c0.actor_email } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      console.error('[crm-guests] check-in undo failed:', err.message);
      return res.status(500).json({ ok: false, error: 'undo error' });
    }
  });

  // ---- interaction ----
  // Nhận MỘT ghi nhận `{kind, body}` (như cũ) HOẶC nhiều ghi nhận cùng lúc
  // `{items:[{kind, body}, …]}` — nhiều thì ghi trong CÙNG MỘT transaction.
  //
  // E08-D028 L-02: bản cũ để client bắn ba POST tuần tự, mỗi cái tự commit. Job
  // 1 vào DB xong job 2 hỏng thì màn báo ĐỎ «CHƯA lưu được» trong khi dòng 1 ĐÃ
  // nằm trong bảng; PG bấm lại là ghi trùng. Không có route xoá interaction nên
  // dòng trùng nằm lại trên thẻ khách VIP và chị Thúy Hà đối soát quà sẽ đếm
  // sai. Một request + một transaction ⇒ hoặc vào hết, hoặc không dòng nào —
  // bấm lại bao nhiêu lần cũng không đẻ bản sao.
  app.post('/crm/guests/:id/interactions', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });

    const raw = (req.body && Array.isArray(req.body.items)) ? req.body.items : [req.body || {}];
    if (raw.length > 20) return res.status(400).json({ ok: false, error: 'Quá nhiều ghi nhận trong một lượt.' });
    const items = raw
      .map((x) => ({ kind: (clean(x && x.kind) || 'khác').slice(0, 40), body: clean(x && x.body) }))
      .filter((x) => x.body);
    if (!items.length) return res.status(400).json({ ok: false, error: 'Thiếu nội dung ghi chú.' });

    let client;
    try {
      const g = await pool.query('SELECT id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      client = await pool.connect();
      const out = [];
      try {
        await client.query('BEGIN');
        for (const it of items) {
          const r = await client.query(
            'INSERT INTO crm_interactions (guest_id, actor_email, kind, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
            [id, req.actor.email, it.kind, it.body]);
          out.push({ id: String(r.rows[0].id), created_at: r.rows[0].created_at, kind: it.kind });
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'interaction_create', target_type: 'guest', target_id: id, meta: { kinds: items.map((x) => x.kind) }, ip: ipOf(req) });
      return res.status(201).json({ ok: true, id: out[0].id, created_at: out[0].created_at, items: out });
    } catch (err) {
      console.error('[crm-guests] interaction failed:', err.message);
      return res.status(500).json({ ok: false, error: 'interaction error' });
    } finally {
      // D016 B10 đã dạy một lần: quên trả kết nối về pool thì vài chục lượt là
      // hết pool và MỌI route chết theo, không riêng route này.
      if (client) client.release();
    }
  });

  // ---- E08-D031: đổi trạng thái THAM DỰ ----
  // Sponsor chốt phương án A (05/08): mọi tài khoản đã đăng nhập đổi được —
  // cửa nay có OTP nên không còn đường ẩn danh, mọi thao tác đều có email đứng
  // tên. Ba ràng buộc đi kèm, cài ở đây chứ không phải quy ước:
  //   1. Audit MỌI lần: actor + cũ→mới + thao tác từ đâu.
  //   2. Ghi vào `att_override`, KHÔNG phá tag gốc ⇒ xoá override là số trở về
  //      đúng nguyên trạng (gửi status = null để xoá).
  //   3. BTL xem được danh sách đã sửa tay — route ngay dưới.
  //
  // TUYỆT ĐỐI không đụng `crm_check_ins`: "không tham dự" và "chưa đến" là hai
  // trục khác nhau; gộp chúng là làm hỏng cả hai con số.
  // Phương án A: MỌI tài khoản đã đăng nhập đổi được. Cửa nay có OTP nên không
  // còn đường ẩn danh — requireCrmAuth là đủ và đúng.
  app.post('/crm/guests/:id/attendance', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const raw = req.body && req.body.status;
    const status = (raw === null || raw === '' || raw === undefined) ? null : String(raw);
    if (status !== null && !att.isStatus(status)) {
      return res.status(400).json({ ok: false, error: 'Trạng thái không hợp lệ (du|khong|cho).' });
    }
    // Ghi lại thao tác đến từ màn nào — cùng một người có thể đứng ở /crm hay ở
    // một trong hai cửa, và khi đối soát số thì cần biết.
    const src = clean(req.body && req.body.source).slice(0, 24) || 'crm';
    const duX = att.duSql('', 'crm_guests.response_id', '$2', '$3');
    let client;
    try {
      client = await pool.connect();
      let before; let after;
      try {
        await client.query('BEGIN');
        // Khoá hàng rồi mới đọc: hai người cùng bấm trên hai máy thì lần ghi sau
        // phải thấy giá trị của lần trước, không phải giá trị lúc mở trang.
        const b = await client.query(
          `SELECT ${att.attSql('', duX)} AS att_status, att_override
             FROM crm_guests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [id, SESSION_RE['toa-dam'], SESSION_RE.gala]);
        if (!b.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'not found' }); }
        before = b.rows[0];
        await client.query(
          // Ép kiểu: `$2 IS NULL` trần thì Postgres không suy được kiểu tham số
          // và câu lệnh hỏng ngay khi chạy — node --check lẫn boot đều không bắt
          // được, chỉ gọi thật mới lộ.
          `UPDATE crm_guests SET att_override = $2::text,
                  att_override_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
                  att_override_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::text END,
                  updated_at = now()
            WHERE id = $1`, [id, status, req.actor.email]);
        const a = await client.query(
          `SELECT ${att.attSql('', duX)} AS att_status FROM crm_guests WHERE id = $1`,
          [id, SESSION_RE['toa-dam'], SESSION_RE.gala]);
        after = a.rows[0];
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }

      await logAudit(pool, {
        actor_email: req.actor.email, event_type: 'att_change', target_type: 'guest', target_id: id,
        meta: { tu: before.att_status, den: after.att_status, override: status, nguon: src },
        ip: ipOf(req),
      });
      return res.json({ ok: true, att_status: after.att_status, att_override: status,
        truoc: before.att_status });
    } catch (err) {
      console.error('[crm-guests] attendance failed:', err.message);
      return res.status(500).json({ ok: false, error: 'attendance error' });
    } finally {
      if (client) client.release();
    }
  });

  // Ràng buộc 3 của phương án A: BTL nhìn được TẤT CẢ thẻ đã bị sửa tay, kèm ai
  // sửa và lúc nào — để đối soát số trước khi chốt báo cáo.
  app.get('/crm/attendance/overrides', requireCrmAuth, requireRole('btl'), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, full_name, att_override, att_override_by, att_override_at
           FROM crm_guests
          WHERE deleted_at IS NULL AND att_override IS NOT NULL
          ORDER BY att_override_at DESC LIMIT 500`);
      return res.json({ ok: true, rows: r.rows, count: r.rowCount });
    } catch (err) {
      console.error('[crm-guests] overrides failed:', err.message);
      return res.status(500).json({ ok: false, error: 'overrides error' });
    }
  });
}

module.exports = { mount, normPhone };
