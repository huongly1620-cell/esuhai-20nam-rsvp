'use strict';

const { Pool } = require('pg');

// Railway provides DATABASE_URL for the Postgres plugin.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Fail fast with a clear message rather than a confusing pg error later.
  console.error('[db] DATABASE_URL is not set. Add the Postgres plugin on Railway or set it locally.');
}

// Railway's internal network does not need SSL; public proxy connections do.
// Toggle via PGSSL=require when connecting over the public proxy.
const ssl = process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false;

const pool = new Pool({ connectionString, ssl });

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS rsvp_submissions (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  status       TEXT NOT NULL,
  rep_name     TEXT NOT NULL,
  rep_org      TEXT,
  rep_phone    TEXT,
  rep_email    TEXT,
  sessions     TEXT,
  dietary      TEXT,
  wish         TEXT,
  note         TEXT,
  guest_count  INT NOT NULL DEFAULT 0,
  guests       JSONB NOT NULL DEFAULT '[]'::jsonb,
  ip_hash      TEXT,
  user_agent   TEXT,
  submitted_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rsvp_created ON rsvp_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rsvp_phone   ON rsvp_submissions (rep_phone);
`;

// Idempotent migration — safe to run on every boot.
async function migrate() {
  await pool.query(CREATE_TABLE_SQL);
  console.log('[db] migration ok (rsvp_submissions ready)');
}

module.exports = { pool, migrate };
