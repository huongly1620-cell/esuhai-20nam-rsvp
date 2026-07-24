'use strict';

const path = require('path');
const express = require('express');
const { migrate } = require('./db');
const { handleRsvp } = require('./rsvp');
const admin = require('./admin');

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

// Do not expose backend source / internal docs / vcs as static assets.
const BLOCKED = ['/server', '/reports', '/apps-script', '/tools', '/.git'];
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
  } catch (err) {
    console.error('[startup] migration failed:', err.message);
    // Keep serving static + health so the deploy is diagnosable; writes will 500.
  }
  app.listen(PORT, () => console.log(`[startup] listening on :${PORT}`));
}

start();
