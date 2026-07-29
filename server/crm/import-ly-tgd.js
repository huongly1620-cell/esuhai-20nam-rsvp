'use strict';

// One-shot importer for Ly's "Khách TGĐ - gia đình" xlsx (header on row 3,
// no phone numbers) into crm_guests. Idempotent by guest_ext_id
// ly-tgd-20260728-{STT}. Never commits the PII file (data/ is gitignored).
//   DATABASE_URL=... node server/crm/import-ly-tgd.js [path-to.xlsx]
const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../db');

const FILE = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'inbox', '2026-07-28-DS-khach-TGD-Gia-dinh.xlsx');
const SHEET = 'Khách TGĐ - gia đình';
const BATCH = 'ly-tgd-20260728';
const HEADER_ROW = 2; // 0-indexed → row 3

function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function normPhone(p) { return String(p || '').replace(/\D/g, ''); }
function mergeTags(existing, add) {
  const s = new Set(String(existing || '').split(',').map((x) => x.trim()).filter(Boolean));
  (add || []).forEach((t) => { t = clean(t); if (t) s.add(t); });
  return Array.from(s).join(',');
}

async function upsert(db, { ext_id, full_name, phone, org, title, tags, note }) {
  full_name = clean(full_name);
  if (!full_name) return 'skip';
  const pn = phone ? normPhone(phone) : null;
  const ex = await db.query('SELECT id, tags FROM crm_guests WHERE guest_ext_id = $1', [ext_id]);
  if (ex.rows[0]) {
    await db.query(
      `UPDATE crm_guests SET full_name=$1, phone=COALESCE($2,phone), phone_norm=COALESCE($3,phone_norm),
         org=COALESCE($4,org), title=COALESCE($5,title), tags=$6, note=COALESCE($7,note), updated_at=now()
       WHERE id=$8`,
      [full_name, phone || null, pn, org || null, title || null, mergeTags(ex.rows[0].tags, String(tags).split(',')), note || null, ex.rows[0].id]);
    return 'update';
  }
  await db.query(
    `INSERT INTO crm_guests (guest_ext_id, full_name, phone, phone_norm, org, title, tags, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ext_id, full_name, phone || null, pn, org || null, title || null, tags, note || null]);
  return 'create';
}

async function main() {
  const wb = XLSX.readFile(FILE);
  const sh = wb.Sheets[SHEET] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  const hdr = (rows[HEADER_ROW] || []).map(clean);
  const find = (...keys) => { for (const k of keys) { const i = hdr.findIndex((h) => h.toLowerCase().includes(k.toLowerCase())); if (i >= 0) return i; } return -1; };
  const I = {
    stt: find('STT'), tinh: find('Tỉnh'), phanloai: find('Phân loại'), vip: find('VIP'),
    ban: find('bàn'), menu: find('MENU'), org: find('Đơn vị'), name: find('Họ và tên'),
    gioitinh: find('Giới tính'), title: find('Chức vụ'), s2: find('phụ trách'),
    chieu: find('chiều'), toi: find('tối', 'buổi tối'), sdt: find('SĐT', 'điện thoại'), ghichu: find('Ghi chú'),
  };
  if (I.name < 0) throw new Error('Không tìm thấy cột "Họ và tên" ở dòng tiêu đề (row 3).');

  const data = rows.slice(HEADER_ROW + 1).filter((r) => r.some((c) => clean(c) !== ''));
  let created = 0; let updated = 0; let skipped = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let k = 0; k < data.length; k++) {
      const r = data[k];
      const get = (i) => (i >= 0 ? clean(r[i]) : '');
      const name = get(I.name);
      if (!name) { skipped++; continue; }
      const stt = get(I.stt) || String(k + 1);
      const ext_id = `${BATCH}-${stt}`;
      const chieu = get(I.chieu).toUpperCase() === 'O';
      const toi = get(I.toi).toUpperCase() === 'O';
      const tags = ['ly-tgd', get(I.phanloai), get(I.vip), chieu ? 'toa-dam' : '', toi ? 'gala' : ''].filter(Boolean).join(',');
      const noteParts = [];
      if (get(I.tinh)) noteParts.push('Tỉnh: ' + get(I.tinh));
      if (get(I.menu)) noteParts.push('Menu: ' + get(I.menu));
      if (get(I.ban)) noteParts.push('Bàn: ' + get(I.ban));
      if (get(I.s2)) noteParts.push('S2 phụ trách: ' + get(I.s2));
      if (get(I.gioitinh)) noteParts.push('Giới tính: ' + get(I.gioitinh));
      if (get(I.ghichu)) noteParts.push(get(I.ghichu));
      const res = await upsert(client, {
        ext_id, full_name: name, phone: get(I.sdt), org: get(I.org), title: get(I.title),
        tags, note: noteParts.join(' · ') || null,
      });
      if (res === 'create') created++; else if (res === 'update') updated++; else skipped++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();
  console.log(`[import-ly-tgd] created=${created} updated=${updated} skipped=${skipped} (data rows=${data.length})`);
  await pool.end();
}

main().catch((e) => { console.error('[import-ly-tgd] failed:', e.message); process.exit(1); });
