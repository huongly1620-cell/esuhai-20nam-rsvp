'use strict';

const crypto = require('crypto');
const { pool } = require('../db');

const IP_SALT = process.env.IP_HASH_SALT || 'esuhai20-dev-salt';
function hashIp(ip) { return ip ? crypto.createHash('sha256').update(String(ip) + IP_SALT).digest('hex').slice(0, 32) : null; }

// Write one audit row. `db` can be the pool or a transaction client.
async function logAudit(db, { actor_email, event_type, target_type, target_id, meta, ip }) {
  try {
    await db.query(
      `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [actor_email || null, event_type, target_type || null,
       target_id != null ? String(target_id) : null, JSON.stringify(meta || {}), hashIp(ip)]
    );
  } catch (err) {
    // Never let audit failure break the main action, but do log it.
    console.error('[crm-audit] write failed:', err.message);
  }
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// btl-only routes are mounted here; caller wraps with requireRole('btl').
function mount(app, requireCrmAuth, requireRole) {
  app.get('/crm/audit', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const actor = String(req.query.actor || '').trim();
    const type = String(req.query.type || '').trim();
    try {
      const params = []; const conds = [];
      if (actor) { params.push('%' + actor + '%'); conds.push(`actor_email ILIKE $${params.length}`); }
      if (type) { params.push(type); conds.push(`event_type = $${params.length}`); }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      params.push(limit);
      const r = await pool.query(
        `SELECT id, actor_email, event_type, target_type, target_id, meta, created_at
         FROM crm_audit_events ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return res.json({ ok: true, rows: r.rows });
    } catch (err) {
      console.error('[crm-audit] list failed:', err.message);
      return res.status(500).json({ ok: false, error: 'audit error' });
    }
  });

  app.get('/crm/audit/export.csv', requireCrmAuth, requireRole('btl'), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT created_at, actor_email, event_type, target_type, target_id, meta
         FROM crm_audit_events ORDER BY created_at DESC`);
      const header = ['Thoi gian', 'Actor', 'Su kien', 'Doi tuong', 'ID', 'Chi tiet'];
      const lines = [header.map(csvCell).join(',')];
      for (const x of r.rows) {
        lines.push([
          new Date(x.created_at).toISOString(), x.actor_email, x.event_type,
          x.target_type, x.target_id, JSON.stringify(x.meta || {}),
        ].map(csvCell).join(','));
      }
      const csv = '﻿' + lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="crm-audit.csv"');
      return res.send(csv);
    } catch (err) {
      console.error('[crm-audit] export failed:', err.message);
      return res.status(500).json({ ok: false, error: 'audit export error' });
    }
  });
}

module.exports = { logAudit, hashIp, mount };
