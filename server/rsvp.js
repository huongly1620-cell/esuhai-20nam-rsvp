'use strict';

const crypto = require('crypto');
const { pool } = require('./db');

// ---- config ----
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes per phone (R3.3)
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'esuhai20-dev-salt';

// In-memory rate-limit map: normalizedPhone -> lastAcceptedTimestamp(ms).
// One web service in wave 1, so a process-local map is sufficient. A DB
// fallback query guards against a process restart wiping the window.
const recentByPhone = new Map();

// Basic VN phone: strip spaces/dots/dashes, accept 0xxxxxxxxx or +84xxxxxxxxx.
function normalizePhone(raw) {
  return String(raw || '').replace(/[\s.\-()]/g, '');
}
function isValidVNPhone(p) {
  return /^(0|\+84)\d{9,10}$/.test(p);
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip) + IP_HASH_SALT).digest('hex').slice(0, 32);
}

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Map the real front-end collect() payload onto DB columns.
// Payload shape (from dang-ky.html / tiec-toi.html):
// { status, source, honeypot, sessions[], rep{name,org,phone,email}, dietary, wish, note, guests[], submittedAt }
function buildRow(body, req) {
  const status = body.status === 'no' ? 'no' : 'yes';
  const rep = body.rep && typeof body.rep === 'object' ? body.rep : {};
  const guests = Array.isArray(body.guests) ? body.guests : [];
  const sessions = Array.isArray(body.sessions) ? body.sessions.map(clean).filter(Boolean) : [];

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  return {
    source: body.source === 'tiec-toi' ? 'tiec-toi' : 'dang-ky',
    status,
    rep_name: clean(rep.name),
    rep_org: clean(rep.org) || null,
    rep_phone: clean(rep.phone) || null,
    rep_email: clean(rep.email) || null,
    sessions: sessions.join(' · ') || null,
    dietary: clean(body.dietary) || null,
    wish: clean(body.wish) || null,
    note: clean(body.note) || null,
    guest_count: status === 'yes' ? guests.length : 0,
    guests: JSON.stringify(status === 'yes' ? guests : []),
    ip_hash: ip ? hashIp(ip) : null,
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300) || null,
    submitted_at: parseDate(body.submittedAt),
  };
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Validation mirrors the front-end validate() so the server is the source of truth.
function validate(row, body) {
  if (!row.rep_name) return 'Thiếu họ tên người đại diện.';
  if (row.status === 'yes') {
    if (!row.sessions) return 'Chưa chọn phần tham dự.';
    if (!row.rep_phone) return 'Thiếu số điện thoại liên hệ.';
    if (!isValidVNPhone(normalizePhone(row.rep_phone))) return 'Số điện thoại không hợp lệ.';
    const guests = Array.isArray(body.guests) ? body.guests : [];
    for (let i = 0; i < guests.length; i++) {
      if (!clean(guests[i] && guests[i].name)) return 'Thiếu họ tên khách trong đoàn.';
    }
  }
  return null;
}

async function handleRsvp(req, res) {
  const body = req.body || {};

  // Honeypot (D5): a real user never fills the hidden field. Pretend success,
  // write nothing — bots get a 201 and no row is created.
  if (clean(body.honeypot)) {
    return res.status(201).json({ ok: true, id: null });
  }

  const row = buildRow(body, req);

  const vErr = validate(row, body);
  if (vErr) return res.status(400).json({ ok: false, error: vErr });

  // Rate-limit by phone within the window (only meaningful for "yes" w/ phone).
  if (row.rep_phone) {
    const key = normalizePhone(row.rep_phone);
    const last = recentByPhone.get(key);
    const nowMs = Date.now();
    if (last && nowMs - last < RATE_LIMIT_MS) {
      return res.status(429).json({ ok: false, error: 'Bạn vừa gửi xác nhận. Vui lòng thử lại sau ít phút.' });
    }
    // DB fallback in case the in-memory window was lost on a restart.
    try {
      const dup = await pool.query(
        `SELECT 1 FROM rsvp_submissions
         WHERE rep_phone = $1 AND created_at > now() - interval '5 minutes' LIMIT 1`,
        [row.rep_phone]
      );
      if (dup.rowCount > 0) {
        recentByPhone.set(key, nowMs);
        return res.status(429).json({ ok: false, error: 'Bạn vừa gửi xác nhận. Vui lòng thử lại sau ít phút.' });
      }
    } catch (_) { /* if the guard query fails, fall through to insert */ }
    recentByPhone.set(key, nowMs);
  }

  try {
    const result = await pool.query(
      `INSERT INTO rsvp_submissions
        (source, status, rep_name, rep_org, rep_phone, rep_email, sessions,
         dietary, wish, note, guest_count, guests, ip_hash, user_agent, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
       RETURNING id`,
      [row.source, row.status, row.rep_name, row.rep_org, row.rep_phone, row.rep_email,
       row.sessions, row.dietary, row.wish, row.note, row.guest_count, row.guests,
       row.ip_hash, row.user_agent, row.submitted_at]
    );
    return res.status(201).json({ ok: true, id: String(result.rows[0].id) });
  } catch (err) {
    console.error('[rsvp] insert failed:', err.message); // no PII, no stack to client
    return res.status(500).json({ ok: false, error: 'Có lỗi khi lưu. Vui lòng thử lại.' });
  }
}

module.exports = { handleRsvp, normalizePhone, isValidVNPhone };
