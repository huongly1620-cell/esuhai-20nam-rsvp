'use strict';

const path = require('path');
const express = require('express');
const { migrate } = require('./db');
const { migrateCrm } = require('./crm-db');
const { handleRsvp } = require('./rsvp');
const admin = require('./admin');
const crm = require('./crm');
const crmStorage = require('./crm/storage');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway terminates TLS in front of us

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// Health (Railway healthcheck)
app.get('/health', (req, res) => res.json({ ok: true }));

// Public RSVP write endpoint
app.post('/api/rsvp', handleRsvp);

// Admin (login + read + export)
admin.mount(app);

// CRM đón tiếp (magic-link auth + RBAC + MinIO) — fully separate realm
crm.mount(app);

// One SoT (E08-D019): the mock crm.html is no longer an operational tool.
// Redirect it to the real /crm app BEFORE static can serve the file. The file
// stays in the repo (R0 layout kept) but its 116-guest data was emptied.
app.get(['/crm.html', '/crm.htm'], (req, res) => res.redirect(302, '/crm'));

// Do not expose backend source / internal docs / vcs / fixtures as static assets.
const BLOCKED = ['/server', '/reports', '/apps-script', '/tools', '/.git', '/fixtures', '/docker-compose.crm.yml'];
app.use((req, res, next) => {
  if (BLOCKED.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
    return res.status(404).send('Not found');
  }
  next();
});

// Static landing pages + config.js (same-origin => no CORS for /api/rsvp)
app.use(express.static(ROOT, { extensions: ['html'], index: 'index.html' }));

// Fallback
app.use((req, res) => res.status(404).send('Not found'));

async function start() {
  try {
    await migrate();
    await migrateCrm();
  } catch (err) {
    console.error('[startup] migration failed:', err.message);
    // Keep serving static + health so the deploy is diagnosable; writes will 500.
  }
  try {
    await crmStorage.ensureBucket();
  } catch (err) {
    console.warn('[startup] MinIO not ready (photo upload disabled):', err.message);
  }
  app.listen(PORT, () => console.log(`[startup] listening on :${PORT}`));
}

start();
