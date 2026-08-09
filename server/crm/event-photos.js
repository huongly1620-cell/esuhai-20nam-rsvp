'use strict';

/* E08-D082 Pha 1 · KHO ẢNH SỰ KIỆN — nạp từ máy vào MinIO + Postgres.
 *
 * Khác `photos.js` ở đúng một điểm bản chất: ảnh ở đây CHƯA biết của khách nào.
 * Vì thế bảng riêng `crm_event_photos`, không cột `guest_id`, và không con đường
 * nào từ đây đụng tới avatar khách. Việc gán ảnh↔khách là D077, chỉ ghi sau khi
 * BTL bấm Xác nhận tay (CR-127).
 *
 * Máy chủ KHÔNG thu nhỏ ảnh: giữ nguyên quyết định D029 (thêm `sharp` = phụ
 * thuộc biên dịch gốc, hỏng build là cả app không lên được). Trình duyệt gửi lên
 * sẵn ba bản 2048/1024/256 — bản 2048 là bản CHÍNH thay cho ảnh gốc, đúng chốt
 * của Sponsor: khách nhận ảnh 2048px, ai cần bản in khổ lớn thì xin phóng viên.
 */

const { pool } = require('../db');
const { logAudit, hashIp } = require('./audit');
const { ipOf } = require('./auth');
const storage = require('./storage');

let multer = null;
try { multer = require('multer'); } catch (_) { /* dep not installed yet */ }

const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } })
  : { fields: () => (req, res, next) => next() };

// Trần cho từng bản dẫn xuất. Bản 2048 q0.82 của ảnh máy ảnh thật đo được
// ~0,4–0,9 MB; 8 MB là chỗ để thở, không phải mức trông đợi. Vượt trần nghĩa là
// client gửi sai thứ — từ chối cả tấm chứ KHÔNG lưu nửa vời, vì ở đây bản 2048
// LÀ bản chính, không có ảnh gốc nào đứng sau để lùi về.
const MAX_WEB = 8 * 1024 * 1024;
const MAX_PREVIEW = 3 * 1024 * 1024;
const MAX_THUMB = 512 * 1024;

const SOURCES = ['thiet-bi', 'dropbox', 'onedrive', 'google-drive'];
const SHA_RE = /^[0-9a-f]{64}$/;

// Khoá suy TẤT ĐỊNH từ sha256 — cùng bài học D022/D029: chạy lại một đợt nạp
// map về đúng một object thay vì đẻ bản sao. Cắt 2 ký tự đầu làm thư mục cho kho
// khỏi phình một prefix phẳng vài nghìn object.
const WEB_KEY = (sha) => 'events/' + sha.slice(0, 2) + '/' + sha + '.jpg';
const THUMB_KEY = (k) => k + '.t256.jpg';
const PREVIEW_KEY = (k) => k + '.t1024.jpg';

const CACHE = 'private, max-age=604800, immutable';

function clean(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v)); }
function intOrNull(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }

function pickPart(files, name, max) {
  const f = files && files[name] && files[name][0];
  if (!f || !f.buffer || !f.buffer.length) return null;
  if (f.buffer.length > max) return null;
  if (String(f.mimetype || '').indexOf('image/') !== 0) return null;
  return f;
}

function mount(app, requireCrmAuth, requireRole) {
  const btl = [requireCrmAuth, requireRole('btl')];

  /* ── Hỏi trước, tải sau ──────────────────────────────────────────────────
     Trình duyệt gửi danh sách sha256 của những tấm người dùng vừa tick, hỏi cái
     nào đã nằm trong kho. Không có bước này thì chọn nhầm lại thư mục cũ là
     ngồi chờ đẩy lại cả nghìn tấm rồi mới biết là thừa. */
  app.post('/crm/event-photos/check', ...btl, async (req, res) => {
    const list = (req.body && Array.isArray(req.body.sha256)) ? req.body.sha256 : null;
    if (!list) return res.status(400).json({ ok: false, error: 'Thiếu danh sách sha256.' });
    // Trần 500 KHÔNG phải con số tròn cho đẹp: `express.json` toàn cục giới hạn
    // 64 KB (server/index.js). Một sha256 trong JSON tốn ~68 byte ⇒ 500 mã ≈ 34 KB,
    // còn 2000 mã ≈ 136 KB sẽ bị chặn 413 — và bị chặn đúng lúc kho lớn nhất,
    // tức lúc khó lần ra nhất. Client tự chia lô; nới trần toàn cục để lách chỗ
    // này thì đổi hành vi của mọi route khác, không đáng.
    if (list.length > 500) return res.status(400).json({ ok: false, error: 'Mỗi lượt hỏi tối đa 500 mã.' });
    const shas = list.map(clean).filter((s) => SHA_RE.test(s));
    if (!shas.length) return res.json({ ok: true, da_co: {} });
    try {
      const r = await pool.query(
        'SELECT id, sha256 FROM crm_event_photos WHERE deleted_at IS NULL AND sha256 = ANY($1::text[])', [shas]);
      const daCo = {};
      r.rows.forEach((row) => { daCo[row.sha256] = String(row.id); });
      return res.json({ ok: true, da_co: daCo, hoi: shas.length, trung: r.rowCount });
    } catch (err) {
      console.error('[event-photos] check failed:', err.message);
      return res.status(500).json({ ok: false, error: 'check error' });
    }
  });

  /* ── Nạp một tấm ─────────────────────────────────────────────────────────
     Ba phần `web` (2048, BẮT BUỘC) + `preview` (1024) + `thumb` (256) do trình
     duyệt dựng. Thiếu `web` là từ chối: không có bản gốc nào ở đây để lùi về.  */
  app.post('/crm/event-photos', ...btl,
    upload.fields([{ name: 'web', maxCount: 1 }, { name: 'preview', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
    async (req, res) => {
      if (!storage.isConfigured()) return res.status(503).json({ ok: false, error: 'Kho ảnh (MinIO) chưa cấu hình.' });

      const b = req.body || {};
      const sha = clean(b.sha256).toLowerCase();
      const origName = clean(b.orig_name);
      const batchId = clean(b.batch_id);
      const source = SOURCES.indexOf(clean(b.source)) > -1 ? clean(b.source) : 'thiet-bi';
      const relPath = clean(b.rel_path).slice(0, 1024) || null;
      const width = intOrNull(b.width);
      const height = intOrNull(b.height);

      if (!SHA_RE.test(sha)) return res.status(400).json({ ok: false, error: 'sha256 không hợp lệ.' });
      // M9 — `orig_name` là thứ DUY NHẤT nối bản trong kho về tấm gốc trên đĩa
      // phóng viên. Mất tên là sau này không ai đối chiếu được nữa.
      if (!origName) return res.status(400).json({ ok: false, error: 'Thiếu tên file gốc.' });
      if (!batchId) return res.status(400).json({ ok: false, error: 'Thiếu batch_id.' });

      const web = pickPart(req.files, 'web', MAX_WEB);
      if (!web) return res.status(400).json({ ok: false, error: 'Thiếu bản 2048px (hoặc vượt trần).' });
      // AC-9 ở phía máy chủ: client PHẢI khai kích thước bản đã thu nhỏ. Không
      // khai thì không có cách nào chứng minh về sau ảnh dọc vào kho có còn dọc.
      if (!width || !height) return res.status(400).json({ ok: false, error: 'Thiếu kích thước bản 2048px.' });

      // Ngày chụp: lấy `lastModified` của file trên đĩa. KHÔNG đọc EXIF DateTime
      // ở vé này — vé chỉ hứa nạp ảnh, và một trường ngày sai lặng lẽ còn tệ hơn
      // không có trường ngày.
      let takenAt = null;
      const lm = parseInt(b.taken_at_ms, 10);
      if (Number.isFinite(lm) && lm > 0) takenAt = new Date(lm);

      try {
        const trung = await pool.query(
          'SELECT id FROM crm_event_photos WHERE sha256 = $1 AND deleted_at IS NULL', [sha]);
        if (trung.rows[0]) {
          return res.status(200).json({ ok: true, trung_lap: true, id: String(trung.rows[0].id) });
        }

        const key = WEB_KEY(sha);
        await storage.putObjectAt(key, web.buffer, 'image/jpeg');

        let tKey = null; let tSize = null; let pKey = null; let pSize = null;
        try {
          const th = pickPart(req.files, 'thumb', MAX_THUMB);
          if (th) { tKey = await storage.putObjectAt(THUMB_KEY(key), th.buffer, 'image/jpeg'); tSize = th.buffer.length; }
          const pv = pickPart(req.files, 'preview', MAX_PREVIEW);
          if (pv) { pKey = await storage.putObjectAt(PREVIEW_KEY(key), pv.buffer, 'image/jpeg'); pSize = pv.buffer.length; }
        } catch (e) {
          // Bản chính ĐÃ trên kệ — lỗi bản phụ chỉ làm lưới chậm, không mất ảnh.
          console.error('[event-photos] derivative put failed:', e.message);
        }

        const r = await pool.query(
          `INSERT INTO crm_event_photos
             (batch_id, source, sha256, orig_name, rel_path, taken_at, object_key, content_type,
              size, width, height, thumb_key, thumb_size, preview_key, preview_size, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'image/jpeg',$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [batchId, source, sha, origName.slice(0, 512), relPath, takenAt, key,
            web.buffer.length, width, height, tKey, tSize, pKey, pSize, req.actor.email]);

        // Hai tab cùng đẩy một tấm: unique một phần chặn ở DB, nhánh này trả về
        // đúng bản ghi đã có thay vì 500.
        if (!r.rows[0]) {
          const lai = await pool.query(
            'SELECT id FROM crm_event_photos WHERE sha256 = $1 AND deleted_at IS NULL', [sha]);
          return res.status(200).json({ ok: true, trung_lap: true, id: lai.rows[0] ? String(lai.rows[0].id) : null });
        }

        const id = r.rows[0].id;
        await logAudit(pool, {
          actor_email: req.actor.email, event_type: 'event_photo_upload',
          target_type: 'event_photo', target_id: String(id),
          meta: { sha256: sha, orig_name: origName, batch_id: batchId, source, key, width, height,
            thumb: !!tKey, preview: !!pKey },
          ip: ipOf(req),
        });
        return res.status(201).json({ ok: true, id: String(id), url: '/crm/event-photos/' + id });
      } catch (err) {
        console.error('[event-photos] upload failed:', err.message);
        return res.status(500).json({ ok: false, error: 'upload error' });
      }
    });

  // ── Đếm: hai số cho AC-6 và cho câu «đợt này nạp được bao nhiêu» ──
  app.get('/crm/event-photos/stats', ...btl, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL)               AS con,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)           AS da_go,
                count(DISTINCT batch_id) FILTER (WHERE deleted_at IS NULL) AS so_dot,
                coalesce(sum(size) FILTER (WHERE deleted_at IS NULL),0)  AS tong_byte
           FROM crm_event_photos`);
      const g = await pool.query('SELECT count(*)::int AS n FROM crm_photos');
      return res.json({ ok: true, kho_su_kien: r.rows[0], crm_photos: g.rows[0].n });
    } catch (err) {
      console.error('[event-photos] stats failed:', err.message);
      return res.status(500).json({ ok: false, error: 'stats error' });
    }
  });

  // ── Danh sách ──
  app.get('/crm/event-photos', ...btl, async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const batch = clean(req.query.batch);
    try {
      const args = [limit, offset];
      let where = 'deleted_at IS NULL';
      if (batch) { args.push(batch); where += ' AND batch_id = $3'; }
      const r = await pool.query(
        `SELECT id, batch_id, source, sha256, orig_name, rel_path, taken_at,
                size, width, height, thumb_key, preview_key, uploaded_by, created_at
           FROM crm_event_photos
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $1 OFFSET $2`, args);
      return res.json({
        ok: true,
        items: r.rows.map((x) => ({
          id: String(x.id), batch_id: x.batch_id, source: x.source, sha256: x.sha256,
          orig_name: x.orig_name, rel_path: x.rel_path, taken_at: x.taken_at,
          size: x.size, width: x.width, height: x.height,
          co_thumb: !!x.thumb_key, co_preview: !!x.preview_key,
          uploaded_by: x.uploaded_by, created_at: x.created_at,
          thumb_url: '/crm/event-photos/' + x.id + '/thumb',
          preview_url: '/crm/event-photos/' + x.id + '/preview',
        })),
      });
    } catch (err) {
      console.error('[event-photos] list failed:', err.message);
      return res.status(500).json({ ok: false, error: 'list error' });
    }
  });

  async function serveDerived(req, res, col) {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const r = await pool.query(
        `SELECT object_key, ${col} AS dkey FROM crm_event_photos WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const dkey = r.rows[0].dkey || r.rows[0].object_key;   // chưa có bản phụ → dùng bản 2048
      const etag = '"' + dkey + '"';
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', CACHE);
      res.setHeader('ETag', etag);
      const stream = await storage.getObjectStream(dkey);
      stream.on('error', (e) => {
        console.error('[event-photos] stream failed:', e.message);
        if (!res.headersSent) res.status(502).end(); else res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      console.error('[event-photos] derived view failed:', err.message);
      if (!res.headersSent) return res.status(500).json({ ok: false, error: 'view error' });
    }
  }
  app.get('/crm/event-photos/:id/thumb', ...btl, (req, res) => serveDerived(req, res, 'thumb_key'));
  app.get('/crm/event-photos/:id/preview', ...btl, (req, res) => serveDerived(req, res, 'preview_key'));

  app.get('/crm/event-photos/:id', ...btl, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const r = await pool.query(
        'SELECT object_key FROM crm_event_photos WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      return res.redirect(302, await storage.presignGet(r.rows[0].object_key));
    } catch (err) {
      console.error('[event-photos] view failed:', err.message);
      return res.status(500).json({ ok: false, error: 'view error' });
    }
  });

  /* ── Gỡ ───────────────────────────────────────────────────────────────────
     GỠ BẢN GHI, GIỮ OBJECT — cùng luật với D040 §3g. Audit ghi THẲNG trong cùng
     transaction chứ không qua logAudit: hàm đó nuốt lỗi bằng console.error, mà ở
     đây audit là bản ghi duy nhất còn lại sau khi gỡ (bài học D036).            */
  app.delete('/crm/event-photos/:id', ...btl, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const p = (await cli.query(
        `SELECT id, batch_id, source, sha256, orig_name, rel_path, object_key, thumb_key, preview_key,
                size, width, height, uploaded_by, created_at
           FROM crm_event_photos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!p) { await cli.query('ROLLBACK'); cli.release(); return res.status(404).json({ ok: false, error: 'Không thấy ảnh.' }); }
      await cli.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'event_photo_delete','event_photo',$2,$3::jsonb,$4)`,
        [req.actor.email, String(p.id), JSON.stringify({
          sha256: p.sha256, orig_name: p.orig_name, rel_path: p.rel_path, batch_id: p.batch_id,
          source: p.source, object_key: p.object_key, thumb_key: p.thumb_key, preview_key: p.preview_key,
          size: p.size, width: p.width, height: p.height,
          cu_uploaded_by: p.uploaded_by, cu_created_at: p.created_at,
          ghi_chu: 'Object trên kho GIỮ NGUYÊN — đặt deleted_at về NULL là ảnh trở lại.',
        }), hashIp(ipOf(req))]);
      await cli.query('UPDATE crm_event_photos SET deleted_at = now() WHERE id = $1', [id]);
      await cli.query('COMMIT');
      cli.release();
      return res.json({ ok: true, id: String(id) });
    } catch (err) {
      await cli.query('ROLLBACK').catch(() => {});
      cli.release();
      console.error('[event-photos] delete failed:', err.message);
      return res.status(500).json({ ok: false, error: 'delete error' });
    }
  });

  /* M10 — gỡ CẢ ĐỢT. Nạp nhầm thư mục 3.000 tấm mà chỉ có nút gỡ từng tấm thì
     đường lùi trên giấy có, trên thực tế không ai đi nổi. */
  app.delete('/crm/event-photos/batch/:batchId', ...btl, async (req, res) => {
    const batchId = clean(req.params.batchId);
    if (!batchId) return res.status(400).json({ ok: false, error: 'Thiếu mã đợt.' });
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const rows = (await cli.query(
        `SELECT id, sha256, orig_name, object_key, thumb_key, preview_key
           FROM crm_event_photos WHERE batch_id = $1 AND deleted_at IS NULL FOR UPDATE`, [batchId])).rows;
      if (!rows.length) { await cli.query('ROLLBACK'); cli.release(); return res.status(404).json({ ok: false, error: 'Đợt này không còn ảnh nào.' }); }
      await cli.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'event_photo_batch_delete','event_photo_batch',$2,$3::jsonb,$4)`,
        [req.actor.email, batchId, JSON.stringify({
          batch_id: batchId, so_anh: rows.length, anh: rows,
          ghi_chu: 'Object trên kho GIỮ NGUYÊN — đặt deleted_at về NULL cho các id trên là cả đợt trở lại.',
        }), hashIp(ipOf(req))]);
      const up = await cli.query(
        'UPDATE crm_event_photos SET deleted_at = now() WHERE batch_id = $1 AND deleted_at IS NULL', [batchId]);
      await cli.query('COMMIT');
      cli.release();
      return res.json({ ok: true, batch_id: batchId, da_go: up.rowCount });
    } catch (err) {
      await cli.query('ROLLBACK').catch(() => {});
      cli.release();
      console.error('[event-photos] batch delete failed:', err.message);
      return res.status(500).json({ ok: false, error: 'batch delete error' });
    }
  });
}

module.exports = { mount };
