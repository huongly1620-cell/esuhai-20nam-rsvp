'use strict';

const { pool } = require('../db');
const { logAudit, hashIp } = require('./audit');
const { ipOf } = require('./auth');
const storage = require('./storage');

let multer = null;
try { multer = require('multer'); } catch (_) { /* dep not installed yet */ }

const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } }) // 12MB
  : { single: () => (req, res, next) => next() };

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

// Cùng luật cắt khoảng trắng với guests.js — multipart luôn đưa field text về chuỗi.
function clean(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v)); }

// E08-D029 — key của bản dẫn xuất suy TẤT ĐỊNH từ key gốc, không sinh UUID mới.
// Backfill vì thế chạy lại bao nhiêu lần cũng ra đúng một object, không đẻ rác —
// cùng bài học với khoá `vnjb-<sha1>` của D022.
const THUMB_KEY = (k) => k + '.t256.jpg';
const PREVIEW_KEY = (k) => k + '.t1024.jpg';
// Chặn trên cho phần dẫn xuất do TRÌNH DUYỆT gửi lên: bản 256px thật cỡ ~22 KB,
// bản 1024px ~250 KB. Vượt xa mức đó nghĩa là client gửi sai thứ — bỏ qua phần
// đó chứ KHÔNG chặn việc lưu ảnh gốc.
const MAX_THUMB = 512 * 1024;
const MAX_PREVIEW = 3 * 1024 * 1024;

// Ảnh dẫn xuất bất biến theo key ⇒ cache dài, và đây mới là chỗ ăn tiền: cửa
// gọi lại danh sách mỗi 25 giây, URL cố định thì mỗi vòng poll tốn 0 byte ảnh.
const CACHE = 'private, max-age=604800, immutable';

async function pickPart(files, name, max) {
  const f = files && files[name] && files[name][0];
  if (!f || !f.buffer || !f.buffer.length) return null;
  if (f.buffer.length > max) return null;
  if (String(f.mimetype || '').indexOf('image/') !== 0) return null;
  return f;
}

function mount(app, requireCrmAuth, requireRole) {
  // Upload a photo attached to a guest → MinIO object + Postgres metadata.
  // `photo` bắt buộc; `thumb`/`preview` do trình duyệt thu nhỏ sẵn, KHÔNG bắt buộc.
  app.post('/crm/guests/:id/photos', requireCrmAuth,
    upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'thumb', maxCount: 1 }, { name: 'preview', maxCount: 1 }]),
    async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    if (!storage.isConfigured()) return res.status(503).json({ ok: false, error: 'Kho ảnh (MinIO) chưa cấu hình.' });
    const main = req.files && req.files.photo && req.files.photo[0];
    if (!main || !main.buffer) return res.status(400).json({ ok: false, error: 'Thiếu file ảnh.' });
    req.file = main;                       // giữ nguyên tên cũ cho phần dưới
    const ct = main.mimetype || 'application/octet-stream';
    if (ALLOWED.indexOf(ct) === -1) return res.status(400).json({ ok: false, error: 'Định dạng ảnh không hỗ trợ.' });
    try {
      const g = await pool.query('SELECT id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });

      // E08-D028 AC-G4: ảnh gắn vào một ghi nhận tại quầy (ảnh QUÀ) thay vì ảnh
      // chân dung khách. Cột `crm_photos.interaction_id` đã có sẵn từ đầu nhưng
      // chưa dòng code nào set — 202/202 ảnh trên prod đang NULL. Phải phân biệt
      // được, vì avatar khách ở CẢ 4 màn là ẢNH MỚI NHẤT của thẻ: ảnh cái hộp
      // quà sẽ thế chỗ mặt khách trên mọi danh sách, và không có route xoá ảnh
      // để lùi lại.
      // E08-D028 L-03: bản cũ để CLIENT tạo dòng ghi nhận TRƯỚC rồi mới gửi ảnh.
      // Ảnh hỏng ở bước sau (MinIO 503 — prod vừa có đúng sự cố đó 8 phút) thì
      // dòng «Chụp ảnh quà» đã nằm trên thẻ khách mà không có ảnh nào, và KHÔNG
      // có route xoá interaction để lùi. Nay máy chủ tự tạo dòng ghi nhận, SAU
      // khi ảnh đã lên kệ, trong cùng một transaction với dòng ảnh: hoặc có cả
      // hai, hoặc không có gì.
      const nKind = clean(req.body && req.body.interaction_kind);
      const nBody = clean(req.body && req.body.interaction_body);

      let interId = null;
      if (req.body && req.body.interaction_id) {
        const q = await pool.query(
          'SELECT id FROM crm_interactions WHERE id = $1 AND guest_id = $2',
          [parseInt(req.body.interaction_id, 10) || 0, id]);
        if (!q.rows[0]) return res.status(400).json({ ok: false, error: 'Ghi nhận không thuộc khách này.' });
        interId = q.rows[0].id;
      }

      const key = await storage.putObject(id, req.file.buffer, ct);

      // Bản thu nhỏ do trình duyệt dựng. CỐ Ý không thu nhỏ ở máy chủ: repo
      // không có thư viện ảnh nào, và thêm một phụ thuộc biên dịch gốc (sharp)
      // vào ảnh production ba ngày trước lễ thì build hỏng = cả app không lên
      // được. Thiếu bản dẫn xuất chỉ có nghĩa là "chậm như trước", không mất gì.
      let tKey = null; let tSize = null; let pKey = null; let pSize = null;
      try {
        const th = await pickPart(req.files, 'thumb', MAX_THUMB);
        if (th) { tKey = await storage.putObjectAt(THUMB_KEY(key), th.buffer, 'image/jpeg'); tSize = th.buffer.length; }
        const pv = await pickPart(req.files, 'preview', MAX_PREVIEW);
        if (pv) { pKey = await storage.putObjectAt(PREVIEW_KEY(key), pv.buffer, 'image/jpeg'); pSize = pv.buffer.length; }
      } catch (e) {
        // Ảnh gốc ĐÃ nằm trong kho — không được để lỗi bản phụ làm hỏng cả lượt lưu.
        console.error('[crm-photos] derivative put failed:', e.message);
        tKey = tKey || null; pKey = pKey || null;
      }

      // Ảnh ĐÃ nằm trên kệ trước khi chạm Postgres. Nếu transaction dưới đây
      // hỏng thì kho thừa một object không ai trỏ tới — vô hại; đổi lại thẻ
      // khách không bao giờ mang một dòng ghi nhận trỏ vào hư không.
      let client = await pool.connect();
      let photoId; let madeInter = false;
      try {
        await client.query('BEGIN');
        if (!interId && nKind && nBody) {
          const ri = await client.query(
            'INSERT INTO crm_interactions (guest_id, actor_email, kind, body) VALUES ($1,$2,$3,$4) RETURNING id',
            [id, req.actor.email, nKind.slice(0, 40), nBody]);
          interId = ri.rows[0].id; madeInter = true;
        }
        const r = await client.query(
          `INSERT INTO crm_photos (guest_id, object_key, content_type, size, uploaded_by, interaction_id,
                                   thumb_key, thumb_size, preview_key, preview_size)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [id, key, ct, req.file.size, req.actor.email, interId, tKey, tSize, pKey, pSize]);
        photoId = r.rows[0].id;
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }

      await logAudit(pool, { actor_email: req.actor.email, event_type: 'photo_upload', target_type: 'guest', target_id: id, meta: { key, interaction_id: interId, tao_ghi_nhan: madeInter, thumb: !!tKey, preview: !!pKey }, ip: ipOf(req) });
      return res.status(201).json({ ok: true, id: String(photoId), url: '/crm/photos/' + photoId,
        interaction_id: interId ? String(interId) : null });
    } catch (err) {
      console.error('[crm-photos] upload failed:', err.message);
      return res.status(500).json({ ok: false, error: 'upload error' });
    }
  });

  // E08-D029 AC-7 hướng B — phục vụ bản dẫn xuất bằng STREAM ở URL cố định.
  // Có bản dẫn xuất  → stream + cache dài (bỏ hẳn vòng 302, trình duyệt cache).
  // Chưa có           → 302 như cũ, tức đúng hành vi trước vé. Nhờ nhánh này mà
  //                     deploy được TRƯỚC khi backfill xong: xấu nhất là chậm
  //                     như hôm nay, không màn nào mất ảnh.
  async function serveDerived(req, res, col) {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const r = await pool.query(`SELECT object_key, ${col} AS dkey FROM crm_photos WHERE id = $1`, [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const dkey = r.rows[0].dkey;
      if (!dkey) return res.redirect(302, await storage.presignGet(r.rows[0].object_key));

      const etag = '"' + dkey + '"';
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', CACHE);
      res.setHeader('ETag', etag);
      const stream = await storage.getObjectStream(dkey);
      stream.on('error', (e) => {
        console.error('[crm-photos] stream failed:', e.message);
        if (!res.headersSent) res.status(502).end(); else res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[crm-photos] derived view failed:', err.message);
      if (!res.headersSent) return res.status(500).json({ ok: false, error: 'view error' });
    }
  }
  // ---- XOÁ ảnh (btl) — E08-D040 §3g ----
  // Ghim chữa «mặt khách sai». Xoá chữa «tấm này không nên nằm trong hồ sơ này»
  // — ca thật tối 08/08: cửa đông, PG bấm nhầm thẻ rồi chụp MẶT NGƯỜI KHÁC, mà
  // vé này còn cho PG xem ĐỦ kho ảnh. Ghim không gỡ được tấm đó.
  //
  // XOÁ = GỠ BẢN GHI, KHÔNG GỠ FILE. Object trên MinIO giữ nguyên; audit chép đủ
  // ba key ⇒ chèn lại một dòng là ảnh trở lại (AC-18 — đường này đã chạy thật để
  // trả ảnh cho thẻ #305 tối 05/08, không phải thiết kế trên giấy).
  //
  // M8 — audit ghi THẲNG bằng client.query trong cùng transaction, KHÔNG qua
  // logAudit: hàm đó bọc try/catch và chỉ console.error, nghĩa là audit hỏng mà
  // ảnh vẫn mất. Với xoá thì audit là BẢN GHI DUY NHẤT còn lại ⇒ audit hỏng phải
  // cuộn luôn DELETE. Nguyên văn chốt D036 — và D036 đã chứng minh bằng dữ liệu
  // thật: giờ đến gốc của thẻ #248/#29 giờ chỉ còn tồn tại trong audit.
  app.delete('/crm/photos/:id', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const p = (await client.query(
        `SELECT p.id, p.guest_id, p.interaction_id, p.object_key, p.thumb_key, p.preview_key,
                p.content_type, p.size, p.uploaded_by, p.created_at, g.avatar_photo_id, g.full_name
           FROM crm_photos p JOIN crm_guests g ON g.id = p.guest_id
          WHERE p.id = $1 FOR UPDATE OF p`, [id])).rows[0];
      if (!p) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Không thấy ảnh.' }); }
      // M9 — chép cả avatar_photo_id CŨ: xoá đúng tấm đang ghim thì
      // ON DELETE SET NULL đưa cột về NULL, không còn dấu vết nó từng được ghim.
      await client.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'photo_delete','guest',$2,$3::jsonb,$4)`,
        [req.actor.email, String(p.guest_id),
          JSON.stringify({
            photo_id: p.id, guest_id: p.guest_id, guest_ten: p.full_name,
            object_key: p.object_key, thumb_key: p.thumb_key, preview_key: p.preview_key,
            content_type: p.content_type, size: p.size,
            cu_uploaded_by: p.uploaded_by, cu_created_at: p.created_at,
            interaction_id: p.interaction_id,
            cu_avatar_photo_id: p.avatar_photo_id || null,
            ghi_chu: 'Object trên kho GIỮ NGUYÊN — chèn lại một dòng crm_photos với ba key trên là khôi phục.',
          }), hashIp(ipOf(req))]);
      // M10 — KHÔNG đụng crm_interactions: dòng đó ghi việc khách TẶNG QUÀ, không
      // phải ghi cái ảnh. Xoá ảnh không được xoá sự kiện.
      await client.query('DELETE FROM crm_photos WHERE id = $1', [id]);
      await client.query('COMMIT');
      client.release();
      return res.json({ ok: true, guest_id: String(p.guest_id),
        la_anh_ghim: String(p.avatar_photo_id || '') === String(p.id) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      console.error('[crm-photos] delete failed:', err.message);
      return res.status(500).json({ ok: false, error: 'delete error' });
    }
  });

  app.get('/crm/photos/:id/thumb', requireCrmAuth, (req, res) => serveDerived(req, res, 'thumb_key'));
  app.get('/crm/photos/:id/preview', requireCrmAuth, (req, res) => serveDerived(req, res, 'preview_key'));

  // View a photo: auth-gated redirect to a short-lived presigned URL (private bucket).
  app.get('/crm/photos/:id', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const r = await pool.query('SELECT object_key FROM crm_photos WHERE id = $1', [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const url = await storage.presignGet(r.rows[0].object_key);
      return res.redirect(302, url);
    } catch (err) {
      console.error('[crm-photos] view failed:', err.message);
      return res.status(500).json({ ok: false, error: 'view error' });
    }
  });
}

module.exports = { mount };
