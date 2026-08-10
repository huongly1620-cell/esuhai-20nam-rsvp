'use strict';
/* E08-D077 · API cho màn nhận diện — chỉ `btl`.
   Nguyên tắc xuyên suốt: máy KHÔNG tự gán ai cho ảnh nào (CR-127). Mọi thứ batch
   sinh ra đều ở trạng thái 'cho'; chỉ một cú bấm của người mới đổi được. */
/* pool nằm ở ../db (crm-db chỉ xuất migrateCrm) — đúng như event-photos.js làm.
   Lấy nhầm đường thì `pool` là undefined và MỌI route ở đây ném 500; node --check
   không thấy được vì nó chỉ soi cú pháp. */
const { pool } = require('../db');
const { hashIp } = require('./audit');
const { ipOf } = require('./auth');

/* Tên bảng audit là crm_audit_events và nó có cột ip_hash — kiểm trong guests.js
   chứ không đoán. Ghi sai tên bảng thì mọi lần audit đều ném, và vì nó nằm sau
   khi đã cập nhật xong nên hỏng sẽ hiện ra dưới dạng "bấm Xác nhận báo lỗi 500
   nhưng dữ liệu vẫn đổi" — kiểu lỗi khó lần nhất. */
function ghiAudit(client, req, loai, targetType, targetId, meta){
  return client.query(
    `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [req.actor.email, loai, targetType, String(targetId), JSON.stringify(meta), hashIp(ipOf(req))]);
}

function mount(app, requireCrmAuth, requireRole) {
  const btl = [requireCrmAuth, requireRole('btl')];

  /* Home của ngăn nhận diện = DANH SÁCH KHÁCH, không phải hàng đợi ảnh (FR-4c).
     Hàng đợi là công cụ; danh sách khách mới là thứ người ta đến đây để làm. */
  app.get('/crm/face-match/guests', ...btl, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const args = [];
      let loc = '';
      if (q) { args.push('%' + q + '%');
        loc = `AND (g.full_name ILIKE $1 OR g.org ILIKE $1 OR g.name_jp ILIKE $1 OR g.org_jp ILIKE $1)`; }
      const r = await pool.query(`
        SELECT g.id, g.full_name, g.name_jp, g.org, g.org_jp,
          (SELECT count(*)::int FROM crm_face_candidates c
             WHERE c.guest_id = g.id AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan') AS so_album,
          (SELECT count(*)::int FROM crm_face_candidates c
             WHERE c.guest_id = g.id AND c.deleted_at IS NULL AND c.trang_thai = 'cho') AS so_cho,
          (SELECT count(*)::int FROM crm_face_samples s
             WHERE s.guest_id = g.id AND s.deleted_at IS NULL AND s.vec IS NOT NULL) AS so_mau
        FROM crm_guests g
        WHERE g.deleted_at IS NULL ${loc}
        ORDER BY g.full_name`, args);
      res.json({ ok: true, items: r.rows });
    } catch (e) { console.error('[face-match] guests:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* Album của một khách = ĐÚNG những dòng đã xác nhận (FR-7 / AC-7). */
  app.get('/crm/face-match/album/:guestId', ...btl, async (req, res) => {
    try {
      const r = await pool.query(`
        SELECT c.id, c.event_photo_id, c.score, c.nguon, c.decided_by, c.decided_at,
               e.orig_name, f.canh_px, f.do_net
        FROM crm_face_candidates c
        JOIN crm_event_photos e ON e.id = c.event_photo_id AND e.deleted_at IS NULL
        LEFT JOIN crm_event_faces f ON f.id = c.face_id
        WHERE c.guest_id = $1 AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan'
        ORDER BY c.decided_at DESC NULLS LAST, c.id DESC`, [req.params.guestId]);
      res.json({ ok: true, items: r.rows });
    } catch (e) { console.error('[face-match] album:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* Hàng đợi gợi ý — LỐI PHỤ. Gom theo ảnh: người duyệt nhìn một khung hình rồi
     quyết cho từng khuôn mặt trong đó, chứ không nhảy giữa các ảnh rời rạc. */
  app.get('/crm/face-match/queue', ...btl, async (req, res) => {
    try {
      const gid = req.query.guest_id ? Number(req.query.guest_id) : null;
      const args = [Math.min(50, Number(req.query.limit) || 20)];
      let loc = '';
      if (gid) { args.push(gid); loc = 'AND c.guest_id = $2'; }
      const anh = await pool.query(`
        SELECT DISTINCT c.event_photo_id, e.orig_name, e.width, e.height
        FROM crm_face_candidates c
        JOIN crm_event_photos e ON e.id = c.event_photo_id AND e.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND c.trang_thai = 'cho' ${loc}
        ORDER BY c.event_photo_id LIMIT $1`, args);
      if (!anh.rows.length) return res.json({ ok: true, items: [] });
      const ids = anh.rows.map(x => x.event_photo_id);
      const goi = await pool.query(`
        SELECT c.id, c.event_photo_id, c.face_id, c.guest_id, c.score, c.sample_id,
               g.full_name, g.name_jp, g.org,
               f.box_x, f.box_y, f.box_w, f.box_h, f.canh_px, f.do_net
        FROM crm_face_candidates c
        JOIN crm_guests g ON g.id = c.guest_id
        LEFT JOIN crm_event_faces f ON f.id = c.face_id
        WHERE c.deleted_at IS NULL AND c.trang_thai = 'cho' AND c.event_photo_id = ANY($1::bigint[])
        ORDER BY c.event_photo_id, c.face_id, c.score DESC`, [ids]);
      const theoAnh = new Map(anh.rows.map(x => [String(x.event_photo_id),
        { ...x, goi_y: [] }]));
      goi.rows.forEach(x => theoAnh.get(String(x.event_photo_id))?.goi_y.push(x));
      res.json({ ok: true, items: [...theoAnh.values()] });
    } catch (e) { console.error('[face-match] queue:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* Mọi ảnh trong một khung — kể cả mặt chưa có gợi ý nào, để gán tay (FR-4b). */
  app.get('/crm/face-match/photo/:id/faces', ...btl, async (req, res) => {
    try {
      const r = await pool.query(`SELECT id, box_x, box_y, box_w, box_h, canh_px, do_net, diem_do
        FROM crm_event_faces WHERE event_photo_id = $1 AND deleted_at IS NULL ORDER BY canh_px DESC`,
        [req.params.id]);
      res.json({ ok: true, items: r.rows });
    } catch (e) { res.status(500).json({ ok: false, error: 'loi' }); }
  });

  const quyet = (trangThai) => async (req, res) => {
    try {
      const id = Number(req.body && req.body.id);
      if (!id) return res.status(400).json({ ok: false, error: 'thiếu id' });
      const r = await pool.query(`UPDATE crm_face_candidates
        SET trang_thai = $1, decided_by = $2, decided_at = now()
        WHERE id = $3 AND deleted_at IS NULL RETURNING id, guest_id, event_photo_id`,
        [trangThai, req.actor.email, id]);
      if (!r.rowCount) return res.status(404).json({ ok: false, error: 'không thấy' });
      await ghiAudit(pool, req, 'face_' + trangThai, 'face_candidate', id,
        { guest_id: r.rows[0].guest_id, event_photo_id: r.rows[0].event_photo_id });
      res.json({ ok: true, id });
    } catch (e) { console.error('[face-match] quyet:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  };
  app.post('/crm/face-match/confirm', ...btl, quyet('xac-nhan'));
  app.post('/crm/face-match/reject',  ...btl, quyet('tu-choi'));
  app.post('/crm/face-match/skip',    ...btl, quyet('bo-qua'));

  /* Gán tay (FR-4b): máy không đoán hoặc đoán sai thì người vẫn đưa được ảnh vào
     album. Ghi thẳng trạng thái đã xác nhận — người vừa quyết định xong rồi. */
  app.post('/crm/face-match/assign', ...btl, async (req, res) => {
    try {
      const { event_photo_id, guest_id, face_id } = req.body || {};
      if (!event_photo_id || !guest_id) return res.status(400).json({ ok: false, error: 'thiếu ảnh hoặc khách' });
      const r = await pool.query(`INSERT INTO crm_face_candidates
        (event_photo_id, face_id, guest_id, score, nguon, trang_thai, decided_by, decided_at)
        VALUES ($1,$2,$3,NULL,'tay','xac-nhan',$4,now())
        ON CONFLICT DO NOTHING RETURNING id`,
        [event_photo_id, face_id || null, guest_id, req.actor.email]);
      await ghiAudit(pool, req, 'face_assign_tay', 'event_photo', event_photo_id, { guest_id, face_id: face_id || null });
      res.json({ ok: true, id: r.rows[0] ? r.rows[0].id : null });
    } catch (e) { console.error('[face-match] assign:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* FR-10 · BTL khoanh mặt trên ảnh sự kiện → thành ảnh mẫu cho khách chưa có mẫu.
     Trang chỉ ghi KHUNG; vector do batch tính, vì engine không nằm trong app này. */
  app.post('/crm/face-match/sample', ...btl, async (req, res) => {
    try {
      const { event_photo_id, guest_id, box } = req.body || {};
      if (!event_photo_id || !guest_id || !box) return res.status(400).json({ ok: false, error: 'thiếu dữ liệu' });
      const r = await pool.query(`INSERT INTO crm_face_samples
        (guest_id, nguon, event_photo_id, box_x, box_y, box_w, box_h, created_by)
        VALUES ($1,'cat-tay',$2,$3,$4,$5,$6,$7) RETURNING id`,
        [guest_id, event_photo_id, box.x, box.y, box.w, box.h, req.actor.email]);
      await ghiAudit(pool, req, 'face_sample_cat_tay', 'face_sample', r.rows[0].id, { guest_id, event_photo_id, box });
      res.json({ ok: true, id: r.rows[0].id, cho_tinh: true });
    } catch (e) { console.error('[face-match] sample:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* AC-10 · gỡ mẫu khoanh tay. Các khớp sinh ra từ nó KHÔNG im lặng biến mất —
     chúng quay về 'cho' để người xem lại. Ảnh đã nằm trong album đã đánh dấu gửi
     thì không rút lại được, nên trả về số đó để giao diện cảnh báo. */
  app.delete('/crm/face-match/sample/:id', ...btl, async (req, res) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const s = await c.query(`UPDATE crm_face_samples SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING guest_id`, [req.params.id]);
      if (!s.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'không thấy' }); }
      const veCho = await c.query(`UPDATE crm_face_candidates
        SET trang_thai = 'cho', decided_by = NULL, decided_at = NULL
        WHERE sample_id = $1 AND deleted_at IS NULL AND trang_thai <> 'cho'
        RETURNING id, guest_id`, [req.params.id]);
      const daGui = await c.query(`SELECT count(*)::int n FROM crm_interactions i
        WHERE i.guest_id = $1 AND i.kind = 'Hình ảnh cảm ơn'`, [s.rows[0].guest_id]);
      await ghiAudit(c, req, 'face_sample_go', 'face_sample', req.params.id,
        { ve_cho: veCho.rowCount, guest_id: s.rows[0].guest_id });
      await c.query('COMMIT');
      res.json({ ok: true, ve_cho: veCho.rowCount, da_danh_dau_gui: daGui.rows[0].n });
    } catch (e) { await c.query('ROLLBACK'); console.error('[face-match] go sample:', e.message);
      res.status(500).json({ ok: false, error: 'loi' }); }
    finally { c.release(); }
  });
}
module.exports = { mount };
