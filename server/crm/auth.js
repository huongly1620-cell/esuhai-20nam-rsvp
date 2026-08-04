'use strict';

const crypto = require('crypto');
const { pool } = require('../db');
const { logAudit } = require('./audit');

// CRM identity realm — SEPARATE from the /admin ADMIN_PASSWORD cookie.
const COOKIE = 'esuhai_crm';
const SECRET = process.env.CRM_SESSION_SECRET || process.env.SESSION_SECRET || 'esuhai20-crm-dev-secret';
const OTP_SALT = process.env.OTP_SALT || process.env.IP_HASH_SALT || 'esuhai20-otp-salt';
const OTP_DELIVERY = process.env.OTP_DELIVERY || 'console';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const CODE_TTL_MS = 10 * 60 * 1000; // 10 min (spec ≤10')
const MAX_ATTEMPTS = 5;

// request-code rate limit: max 5 / 10min per email+ip (in-memory, one web service).
const reqLimit = new Map();
const RL_WINDOW = 10 * 60 * 1000;
const RL_MAX = 10;

function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function sha(s) { return crypto.createHash('sha256').update(String(s) + OTP_SALT).digest('hex'); }
function ipOf(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function maskEmail(e) { const [u, d] = String(e || '').split('@'); return !d ? e : (u.slice(0, 2) + '***@' + d); }

// ---- OTP email via SMTP (lazy-require; only when OTP_DELIVERY=smtp) ----
// Never logs the code or credentials; on failure the caller logs err.code only.
let _mailer = null;
function mailer() {
  if (_mailer) return _mailer;
  const nodemailer = require('nodemailer'); // lazy: not loaded in console mode
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  _mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,       // office365 :587 = STARTTLS
    requireTLS: port !== 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _mailer;
}
async function sendOtpEmail(to, code) {
  await mailer().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Mã đăng nhập CRM đón tiếp · ESUHAI 20 năm',
    text: `Ma dang nhap CRM don tiep cua ban: ${code}\nMa co hieu luc 10 phut. Neu ban khong yeu cau, hay bo qua email nay.`,
    html: '<div style="font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a">'
      + '<p>Mã đăng nhập <b>CRM đón tiếp</b> — Kỷ niệm 20 năm ESUHAI Group:</p>'
      + '<p style="font-size:26px;font-weight:700;letter-spacing:6px;color:#0b1e38">' + code + '</p>'
      + '<p style="color:#666">Mã có hiệu lực 10 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p></div>',
  });
}

// ---- signed cookie session ----
function sign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return `${p}.${sig}`;
}
function verifyToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [p, sig] = tok.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  const a = Buffer.from(sig || ''); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); if (!o.exp || Date.now() > o.exp) return null; return o; }
  catch (_) { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
// ---- smoke bearer lane (E08-D024) ----
// Second auth lane, for the agent that smokes /crm after a deploy. People keep
// using OTP email; this lane exists only because the agent has no mailbox.
//
// Disabled unless CRM_SMOKE_BEARER is set, so unsetting the variable is a
// complete kill-switch. Role is deliberately 'staff', not 'btl': the smoke
// needs none of the btl-only lanes (delete guest, mass import, full-PII audit
// CSV), and running as staff lets the smoke assert RBAC is still intact —
// DELETE must answer 403. A leaked token must not be able to empty the guest
// list four days before the event.
const SMOKE_EMAIL = 'crm-smoke-agent@esuhai.local';
const SMOKE_MIN_LEN = 32;
let smokeWarned = false;

// The cookie lane leaves a `login_success` row when a session opens; the bearer
// lane had no equivalent, so a token could read all 173 guests — names, orgs,
// raw phones — and leave zero trace (only write endpoints call logAudit).
// A second auth lane into real PII must be visible in the audit log even when
// it only reads. Throttled so a smoke run writes one row, not one per request.
const SMOKE_AUDIT_EVERY_MS = 10 * 60 * 1000;
let smokeAuditAt = 0;
function noteSmokeAuth(req) {
  const now = Date.now();
  if (now - smokeAuditAt < SMOKE_AUDIT_EVERY_MS) return;
  smokeAuditAt = now;
  // fire-and-forget: audit must never break or slow the request it describes
  Promise.resolve()
    .then(() => logAudit(pool, {
      actor_email: SMOKE_EMAIL, event_type: 'smoke_auth', target_type: 'session',
      meta: { path: String(req.originalUrl || req.url || '').slice(0, 200) }, ip: ipOf(req),
    }))
    .catch(() => {});
}

function bearerActor(req) {
  const want = (process.env.CRM_SMOKE_BEARER || '').trim();  // biến dán tay dễ dính \n
  if (!want) return null;
  if (want.length < SMOKE_MIN_LEN) {
    // Refuse to honour a weak token rather than silently accepting it.
    if (!smokeWarned) { smokeWarned = true; console.error('[crm-auth] CRM_SMOKE_BEARER quá ngắn (<' + SMOKE_MIN_LEN + ') — nhánh smoke bị tắt.'); }
    return null;
  }
  const hdr = req.headers.authorization || '';
  if (hdr.slice(0, 7) !== 'Bearer ') return null;
  const a = Buffer.from(hdr.slice(7).trim(), 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  noteSmokeAuth(req);
  return { email: SMOKE_EMAIL, role: 'staff' };
}

// Cookie first (unchanged OTP path), bearer only as fallback. Putting it here
// rather than in requireCrmAuth means /crm picks the app shell for the smoke
// agent too (index.js decides via currentActor), so Playwright can open the
// real UI with an Authorization header — no session cookie has to be minted.
function currentActor(req) { return verifyToken(parseCookies(req)[COOKIE]) || bearerActor(req); }

// ---- RBAC middleware ----
function requireCrmAuth(req, res, next) {
  const a = currentActor(req);
  if (!a || !a.email) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.actor = { email: a.email, role: a.role || 'staff' };
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.actor) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (req.actor.role !== role) return res.status(403).json({ ok: false, error: 'forbidden' });
    next();
  };
}

async function lookupAllowed(email) {
  const r = await pool.query('SELECT email, role, active FROM staff_users WHERE email = $1', [email]);
  const u = r.rows[0];
  return (u && u.active) ? u : null;
}

// ---- routes ----
function mount(app) {
  // Do NOT reveal whether the email is in the allowlist (always 202).
  app.post('/auth/request-code', async (req, res) => {
    const email = normEmail(req.body && req.body.email);
    const ip = ipOf(req);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email không hợp lệ.' });
    }
    // rate-limit
    const key = email + '|' + ip;
    const now = Date.now();
    const arr = (reqLimit.get(key) || []).filter((t) => now - t < RL_WINDOW);
    if (arr.length >= RL_MAX) return res.status(429).json({ ok: true, note: 'rate' }); // still generic
    arr.push(now); reqLimit.set(key, arr);

    try {
      const user = await lookupAllowed(email);
      if (user) {
        const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
        const expires = new Date(now + CODE_TTL_MS).toISOString();
        await pool.query(
          `INSERT INTO crm_auth_codes (email, code_hash, expires_at, attempts, created_at)
           VALUES ($1,$2,$3,0,now())
           ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now()`,
          [email, sha(code), expires]
        );
        if (OTP_DELIVERY === 'smtp') {
          // Send via SMTP. Never log the code/credentials; on failure log only err.code.
          try { await sendOtpEmail(email, code); }
          catch (e) { console.error('[crm-auth] otp email failed:', (e && e.code) || 'send-error'); }
        } else {
          // console mode (local/fixture): print to server log only.
          console.log(`[crm-otp] code for ${email}: ${code} (expires in 10m)`);
        }
      }
      // Always generic response.
      return res.status(202).json({ ok: true });
    } catch (err) {
      console.error('[crm-auth] request-code failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Có lỗi, thử lại sau.' });
    }
  });

  app.post('/auth/verify', async (req, res) => {
    const email = normEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').trim();
    if (!email || !code) return res.status(400).json({ ok: false, error: 'Thiếu email hoặc mã.' });
    try {
      const user = await lookupAllowed(email);
      const r = await pool.query('SELECT code_hash, expires_at, attempts FROM crm_auth_codes WHERE email = $1', [email]);
      const row = r.rows[0];
      if (!user || !row) return res.status(401).json({ ok: false, error: 'Mã không đúng hoặc đã hết hạn.' });
      if (new Date(row.expires_at).getTime() < Date.now()) return res.status(401).json({ ok: false, error: 'Mã đã hết hạn.' });
      if (row.attempts >= MAX_ATTEMPTS) return res.status(429).json({ ok: false, error: 'Nhập sai quá nhiều lần, xin mã mới.' });
      const okCode = Buffer.from(sha(code)).length === Buffer.from(row.code_hash).length
        && crypto.timingSafeEqual(Buffer.from(sha(code)), Buffer.from(row.code_hash));
      if (!okCode) {
        await pool.query('UPDATE crm_auth_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
        return res.status(401).json({ ok: false, error: 'Mã không đúng.' });
      }
      await pool.query('DELETE FROM crm_auth_codes WHERE email = $1', [email]); // one-time
      const token = sign({ email: user.email, role: user.role, exp: Date.now() + SESSION_TTL_MS });
      const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
      res.setHeader('Set-Cookie',
        `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=${SESSION_TTL_MS / 1000}`);
      await logAudit(pool, { actor_email: user.email, event_type: 'login_success', target_type: 'staff_user', target_id: user.email, ip: ipOf(req) });
      return res.json({ ok: true, email: user.email, role: user.role });
    } catch (err) {
      console.error('[crm-auth] verify failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Có lỗi, thử lại sau.' });
    }
  });

  app.post('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return res.json({ ok: true });
  });

  // Who am I (for the mobile UI to know role / gate btl controls).
  app.get('/crm/me', requireCrmAuth, (req, res) => res.json({ ok: true, email: req.actor.email, role: req.actor.role }));
}

module.exports = { mount, requireCrmAuth, requireRole, currentActor, ipOf, maskEmail };
