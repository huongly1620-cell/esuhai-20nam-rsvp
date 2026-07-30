'use strict';

// MERGE importer for the 116-guest K-code SoT (E08-D018). Approved plan
// (anh Kha): MATCH existing production guests by kcode-tag → then by name
// (honorifics KEPT so "Chú" ≠ "Cô") → UPDATE + tag kcode:Kxxx; INSERT only
// truly-new. NEVER blind-insert (would double the ~106 overlaps). Ambiguous
// (name matches ≥2 rows) is skipped for BTL to resolve on the UI. Idempotent:
// rerun matches by kcode-tag, so re-running a newer file version is safe.
//
//   DATABASE_URL=... node server/crm/import-tgd-116.js [file.xlsx] [--commit]
//
// Without --commit it runs in DRY mode (no writes) and prints the plan.

const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../db');
const { logAudit } = require('./audit');

const FILE = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'))
  || path.join(__dirname, '..', '..', 'data', 'inbox', '20260729_v1_TGD_IMPORT_DS_KHACH_GALA_20NAM.xlsx');
const COMMIT = process.argv.includes('--commit');
const SHEET = 'DS Khách';

function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function stripD(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd'); }
// name key KEEPS honorifics on purpose (Chú Tư Viễn ≠ Cô Tư Viễn).
function nameKey(s) { return stripD(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function normPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d || null; }
function tagList(s) { return new Set(String(s || '').split(',').map((x) => x.trim()).filter(Boolean)); }

function readGuests(file) {
  const wb = XLSX.readFile(file);
  const sh = wb.Sheets[SHEET] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  let hr = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (/mã khách|họ và tên|họ tên/.test(rows[i].map(clean).join('|').toLowerCase())) { hr = i; break; }
  }
  const hdr = (rows[hr] || []).map(clean);
  const find = (...ks) => { for (const k of ks) { const i = hdr.findIndex((h) => h.toLowerCase().includes(k.toLowerCase())); if (i >= 0) return i; } return -1; };
  const C = {
    k: find('Mã khách', 'mã'), name: find('Họ và tên', 'họ tên'), gender: find('Giới tính'),
    title: find('Chức danh', 'chức vụ'), org: find('Đơn vị'), buoi: find('Buổi tham dự', 'buổi'),
    am: find('Ẩm thực'), phone: find('SĐT', 'điện thoại'), vaitro: find('Vai trò'),
    s2: find('phụ trách'), phanloai: find('Phân loại'), vip: find('Hạng VIP', 'VIP'),
    ban: find('Số bàn', 'bàn'), ghichu: find('Ghi chú'),
  };
  return rows.slice(hr + 1).filter((r) => clean(r[C.name]) !== '').map((r) => {
    const g = (i) => (i >= 0 ? clean(r[i]) : '');
    const buoi = g(C.buoi);
    const tags = new Set(['tgd116']);
    if (g(C.k)) tags.add('kcode:' + g(C.k));
    if (g(C.phanloai)) tags.add(g(C.phanloai));
    if (g(C.vip)) tags.add(g(C.vip));
    if (/tọa đàm|toa dam/i.test(buoi)) tags.add('toa-dam');
    if (/gala/i.test(buoi)) tags.add('gala');
    const note = [
      g(C.gender) && 'Giới tính: ' + g(C.gender), g(C.vaitro) && 'Vai trò: ' + g(C.vaitro),
      buoi && 'Buổi: ' + buoi, g(C.am) && 'Ẩm thực: ' + g(C.am),
      g(C.ban) && 'Số bàn (SoT): ' + g(C.ban), g(C.s2) && 'S2: ' + g(C.s2), g(C.ghichu),
    ].filter(Boolean).join(' · ') || null;
    const phoneRaw = g(C.phone);
    const phone = /^n\/?a$/i.test(phoneRaw) ? '' : phoneRaw;
    return {
      kcode: g(C.k), full_name: g(C.name), title: g(C.title) || null, org: g(C.org) || null,
      phone: phone || null, tags, note, nkey: nameKey(g(C.name)),
    };
  });
}

async function main() {
  const guests = readGuests(FILE);
  console.log(`[import-tgd-116] SoT rows: ${guests.length} · mode: ${COMMIT ? 'COMMIT' : 'DRY (no writes)'}`);

  // index existing production guests
  const ex = await pool.query('SELECT id, guest_ext_id, full_name, tags FROM crm_guests WHERE deleted_at IS NULL');
  const byKcode = new Map(); const byName = new Map();
  for (const row of ex.rows) {
    const tags = tagList(row.tags);
    for (const t of tags) if (t.startsWith('kcode:')) byKcode.set(t.slice(6), row);
    const nk = nameKey(row.full_name);
    if (!byName.has(nk)) byName.set(nk, []);
    byName.get(nk).push(row);
  }

  const plan = { update: [], insert: [], ambiguous: [] };
  for (const g of guests) {
    const kHit = g.kcode && byKcode.get(g.kcode);
    if (kHit) { plan.update.push({ g, row: kHit, how: 'kcode' }); continue; }
    const nHits = byName.get(g.nkey) || [];
    if (nHits.length === 1) plan.update.push({ g, row: nHits[0], how: 'name' });
    else if (nHits.length >= 2) plan.ambiguous.push({ g, rows: nHits });
    else plan.insert.push({ g });
  }
  console.log(`  → UPDATE(merge): ${plan.update.length}  INSERT(new): ${plan.insert.length}  AMBIGUOUS(skip→BTL): ${plan.ambiguous.length}`);

  if (!COMMIT) {
    console.log('  DRY: no DB writes. Re-run with --commit to apply.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  let updated = 0; let created = 0;
  try {
    await client.query('BEGIN');
    for (const u of plan.update) {
      const merged = tagList(u.row.tags); u.g.tags.forEach((t) => merged.add(t));
      await client.query(
        `UPDATE crm_guests SET full_name=$1, title=COALESCE($2,title), org=COALESCE($3,org),
           phone=COALESCE($4,phone), phone_norm=COALESCE($5,phone_norm), tags=$6,
           note=COALESCE($7,note), updated_at=now() WHERE id=$8`,
        [u.g.full_name, u.g.title, u.g.org, u.g.phone, normPhone(u.g.phone),
         Array.from(merged).join(','), u.g.note, u.row.id]);
      updated++;
    }
    for (const ins of plan.insert) {
      await client.query(
        `INSERT INTO crm_guests (guest_ext_id, full_name, phone, phone_norm, org, title, tags, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        ['tgd-kcode-' + ins.g.kcode, ins.g.full_name, ins.g.phone, normPhone(ins.g.phone),
         ins.g.org, ins.g.title, Array.from(ins.g.tags).join(','), ins.g.note]);
      created++;
    }
    await logAudit(client, { actor_email: 'import:tgd-116', event_type: 'import_tgd116',
      target_type: 'import', meta: { updated, created, ambiguous: plan.ambiguous.length, rows: guests.length } });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release(); throw e;
  }
  client.release();
  console.log(`[import-tgd-116] COMMITTED: updated=${updated} created=${created} ambiguous(skipped)=${plan.ambiguous.length}`);
  await pool.end();
}

main().catch((e) => { console.error('[import-tgd-116] failed:', e.message); process.exit(1); });
