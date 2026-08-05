'use strict';

const { pool } = require('../db');
const { logAudit } = require('./audit');
const { ipOf } = require('./auth');
const storage = require('./storage');

let multer = null;
try { multer = require('multer'); } catch (_) { /* dep not installed yet */ }

const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } }) // 12MB
  : { single: () => (req, res, next) => next() };

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

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

function mount(app, requireCrmAuth) {
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

      const r = await pool.query(
        `INSERT INTO crm_photos (guest_id, object_key, content_type, size, uploaded_by, interaction_id,
                                 thumb_key, thumb_size, preview_key, preview_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [id, key, ct, req.file.size, req.actor.email, interId, tKey, tSize, pKey, pSize]);
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'photo_upload', target_type: 'guest', target_id: id, meta: { key, interaction_id: interId, thumb: !!tKey, preview: !!pKey }, ip: ipOf(req) });
      return res.status(201).json({ ok: true, id: String(r.rows[0].id), url: '/crm/photos/' + r.rows[0].id });
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
