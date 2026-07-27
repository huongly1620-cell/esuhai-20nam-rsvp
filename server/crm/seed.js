'use strict';

// Seed / update the staff allowlist from a JSON file.
//   node server/crm/seed.js fixtures/allowlist-sample.json
// Each entry: { email, role: 'staff'|'btl', active: true }
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { migrateCrm } = require('../crm-db');

async function main() {
  const file = process.argv[2] || path.join(__dirname, '..', '..', 'fixtures', 'allowlist-sample.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error('allowlist must be a JSON array');
  await migrateCrm();
  let n = 0;
  for (const u of list) {
    const email = String(u.email || '').trim().toLowerCase();
    const role = u.role === 'btl' ? 'btl' : 'staff';
    const active = u.active !== false;
    if (!email) continue;
    await pool.query(
      `INSERT INTO staff_users (email, role, active) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active`,
      [email, role, active]);
    n++;
  }
  console.log(`[crm-seed] upserted ${n} staff_users from ${file}`);
  await pool.end();
}

main().catch((e) => { console.error('[crm-seed] failed:', e.message); process.exit(1); });
