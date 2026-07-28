'use strict';

// One-shot backfill: mirror all existing RSVP (status=yes) submissions into
// crm_guests. Idempotent — safe to run more than once (upsert by
// phone_norm / guest_ext_id, never duplicates).
//   DATABASE_URL=... node server/crm/backfill-rsvp.js
// CLI only (needs DATABASE_URL); no public/unauth endpoint.
const { pool } = require('../db');
const { syncFromRsvp } = require('./sync-from-rsvp');

async function main() {
  const before = await pool.query('SELECT count(*)::int n FROM crm_guests WHERE deleted_at IS NULL');
  const subs = await pool.query(
    `SELECT id, source, rep_name, rep_org, rep_phone, rep_email, guests
     FROM rsvp_submissions WHERE status = 'yes' ORDER BY id`);
  let n = 0;
  for (const s of subs.rows) {
    await syncFromRsvp(pool, {
      id: s.id,
      source: s.source,
      rep: { name: s.rep_name, phone: s.rep_phone, email: s.rep_email, org: s.rep_org },
      guests: Array.isArray(s.guests) ? s.guests : [],
    });
    n++;
  }
  const after = await pool.query('SELECT count(*)::int n FROM crm_guests WHERE deleted_at IS NULL');
  console.log(`[crm-backfill] processed ${n} RSVP(yes) submissions · crm_guests ${before.rows[0].n} -> ${after.rows[0].n}`);
  await pool.end();
}

main().catch((e) => { console.error('[crm-backfill] failed:', e.message); process.exit(1); });
