const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const bad = await p.query(`SELECT id, full_name, table_no, tags FROM crm_guests
    WHERE deleted_at IS NULL AND NULLIF(trim(table_no),'') IS NOT NULL
      AND trim(table_no) !~ '^[0-9]+$' ORDER BY id`);
  const dist = await p.query(`SELECT trim(table_no) t, COUNT(*)::int n FROM crm_guests
    WHERE deleted_at IS NULL AND NULLIF(trim(table_no),'') IS NOT NULL
    GROUP BY 1 ORDER BY (trim(table_no) ~ '^[0-9]+$') DESC, 2 DESC LIMIT 25`);
  console.log(JSON.stringify({ so_the_ban_KHONG_phai_so: bad.rows.length, chi_tiet: bad.rows, phan_bo_ban: dist.rows }, null, 1));
  await p.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
