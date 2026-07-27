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

function mount(app, requireCrmAuth) {
  // Upload a photo attached to a guest → MinIO object + Postgres metadata.
  app.post('/crm/guests/:id/photos', requireCrmAuth, upload.single('photo'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    if (!storage.isConfigured()) return res.status(503).json({ ok: false, error: 'Kho ảnh (MinIO) chưa cấu hình.' });
    if (!req.file || !req.file.buffer) return res.status(400).json({ ok: false, error: 'Thiếu file ảnh.' });
    const ct = req.file.mimetype || 'application/octet-stream';
    if (ALLOWED.indexOf(ct) === -1) return res.status(400).json({ ok: false, error: 'Định dạng ảnh không hỗ trợ.' });
    try {
      const g = await pool.query('SELECT id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const key = await storage.putObject(id, req.file.buffer, ct);
      const r = await pool.query(
        `INSERT INTO crm_photos (guest_id, object_key, content_type, size, uploaded_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [id, key, ct, req.file.size, req.actor.email]);
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'photo_upload', target_type: 'guest', target_id: id, meta: { key }, ip: ipOf(req) });
      return res.status(201).json({ ok: true, id: String(r.rows[0].id), url: '/crm/photos/' + r.rows[0].id });
    } catch (err) {
      console.error('[crm-photos] upload failed:', err.message);
      return res.status(500).json({ ok: false, error: 'upload error' });
    }
  });

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
