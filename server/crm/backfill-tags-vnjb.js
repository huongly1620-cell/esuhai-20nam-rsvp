'use strict';

// E08-D028 AC-F6 — gắn tag hạng/quan hệ từ cột 4 SoT «KHÁCH VIP/THƯỜNG · VIP/一般»
// lên các thẻ `vnjb-*` đã import.
//
//   node server/crm/backfill-tags-vnjb.js            → DRY-RUN, chỉ in bảng đếm
//   node server/crm/backfill-tags-vnjb.js --commit   → ghi thật (CHỜ SPONSOR GO RIÊNG)
//
// LUẬT (rút từ sự cố Pha 2):
//  * MERGE, không bao giờ `tags = $x`. Pha 2 gán đè cả mảng và **phá 58 thẻ** —
//    mất `tgd116` + `kcode:Kxxx`, tile "trong đó N từ DS Sếp" trên /crm tụt
//    114 → 30. Ở đây chỉ THÊM tag còn thiếu, đọc-ghi trong cùng transaction có
//    `FOR UPDATE` để không đè mất thay đổi song song.
//  * Không đụng tag buổi (`toa-dam`/`gala`/`khong-du`/`chua-ro-buoi`) — D026 dựa
//    vào chúng để giữ ba nhóm buổi RỜI NHAU.
//  * Chỉ thẻ `deleted_at IS NULL`.
//  * Luật map tag nằm ở `vnjb-keys.js`, DÙNG CHUNG với importer — không chép lại.

const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../db');
const { logAudit } = require('./audit');
const { norm, nameKey, codeOfParts, hangTags } = require('./vnjb-keys');

const COMMIT = process.argv.includes('--commit');
const WB = process.env.VNJB_XLSX
  || path.join(__dirname, '..', '..', 'data', 'inbox', 'IMPOR-BTK_DS KHACH MOI.xlsx');
const SHEET = 'Khách Việt Nam+Nhat Ban';
const ACTOR = 'backfill-tags-vnjb';
const C = { phanloai: 2, vip: 4, donvi: 5, chucvu: 6, ten: 7 };

function readRows() {
  const wb = XLSX.readFile(WB);
  // Ly chốt SoT = ĐÚNG sheet này và cấm sheet ẩn. Kiểm lại thay vì tin tên.
  const meta = (wb.Workbook && wb.Workbook.Sheets || []).find((s) => s.name === SHEET);
  if (meta && meta.Hidden) throw new Error('sheet SoT đang bị ẩn — dừng');
  const ws = wb.Sheets[SHEET];
  if (!ws) throw new Error('không thấy sheet ' + SHEET);
  const A = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  // Sheet có MỘT dòng tiêu đề lặp lại giữa vùng dữ liệu ("KHÁCH VIP/THƯỜNG
  // VIP/一般" ⟂ "Phân loại khách 顧客分類"). Nó không sinh thẻ khách nào trên
  // prod, nhưng nếu để lọt vào bảng đếm thì số sẽ lệch 1 so với báo cáo trước.
  return A.slice(1)
    .filter((r) => norm(r[C.ten]))
    .filter((r) => !/^(họ và tên|phân loại khách)/i.test(norm(r[C.phanloai]) + norm(r[C.ten])));
}

const tagArr = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

(async () => {
  const rows = readRows();

  const client = await pool.connect();
  const plan = [];                      // {id, add:[...], tags}
  const lane = { ext: 0, ten: 0, trungTen: 0, khongThay: 0 };
  let noTag = 0;
  const already = {};
  const gain = {};
  try {
    await client.query('BEGIN');

    // Dò thẻ theo ĐÚNG bậc thang của importer (`import-vnjb.js` ~L172): ext id
    // trước, rồi tên khớp DUY NHẤT. Không tự nghĩ luật khác — D026 đã cho thấy
    // hai bản chuẩn hoá song song lệch nhau 12/23 ca và 4 thẻ khách thật thành
    // không ai tìm ra.
    const prod = (await client.query(
      'SELECT id, guest_ext_id, full_name, tags FROM crm_guests WHERE deleted_at IS NULL')).rows;
    const byExt = new Map(prod.filter((p) => p.guest_ext_id).map((p) => [p.guest_ext_id, p]));
    const byName = new Map();
    prod.forEach((p) => { const k = nameKey(p.full_name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); });

    const want = new Map();             // id thẻ -> Set(tag)
    for (const r of rows) {
      const tg = hangTags(r[C.vip]);
      if (!tg.length) { noTag++; continue; }
      const hitExt = byExt.get(codeOfParts(r[C.ten], r[C.donvi], r[C.chucvu]));
      const hits = byName.get(nameKey(r[C.ten])) || [];
      let g = null;
      if (hitExt) { g = hitExt; lane.ext++; }
      else if (hits.length === 1) { g = hits[0]; lane.ten++; }
      else if (hits.length > 1) { lane.trungTen++; }     // trùng tên → KHÔNG đoán
      else { lane.khongThay++; }
      if (!g) continue;
      const s = want.get(g.id) || new Set();
      tg.forEach((x) => s.add(x));
      want.set(g.id, s);
    }

    for (const [id, set] of want) {
      const q = await client.query(
        'SELECT id, tags FROM crm_guests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!q.rowCount) continue;
      const have = new Set(tagArr(q.rows[0].tags));
      const add = [...set].filter((x) => !have.has(x));
      [...set].forEach((x) => { if (have.has(x)) already[x] = (already[x] || 0) + 1; });
      add.forEach((x) => { gain[x] = (gain[x] || 0) + 1; });
      if (add.length) plan.push({ id, add, tags: q.rows[0].tags });
    }

    console.log('\n=== AC-F6 backfill tag cột 4 — ' + (COMMIT ? 'GHI THẬT' : 'DRY-RUN') + ' ===');
    console.log('workbook           : ' + path.basename(WB) + ' · sheet «' + SHEET + '»');
    console.log('dòng khách trên SoT: ' + rows.length + '  (' + noTag + ' dòng «Thường»/trống — không sinh tag)');
    console.log('\n  dò thẻ theo bậc thang importer');
    console.log('    khớp guest_ext_id   : ' + lane.ext);
    console.log('    khớp TÊN duy nhất   : ' + lane.ten);
    console.log('    trùng tên → bỏ qua  : ' + lane.trungTen);
    console.log('    không thấy thẻ nào  : ' + lane.khongThay);
    console.log('  thẻ liên quan        : ' + want.size);
    console.log('  thẻ SẼ ĐƯỢC SỬA      : ' + plan.length);
    console.log('\n  tag              thêm mới   đã có sẵn');
    const keys = [...new Set([...Object.keys(gain), ...Object.keys(already)])].sort();
    for (const k of keys) {
      console.log('  ' + k.padEnd(18) + String(gain[k] || 0).padStart(6) + String(already[k] || 0).padStart(12));
    }

    if (!COMMIT) {
      await client.query('ROLLBACK');
      console.log('\nDRY-RUN — không ghi gì. Thêm --commit khi anh GO riêng.');
      return;
    }

    let n = 0;
    for (const p of plan) {
      // MERGE: nối thêm, không gán đè. Hàng đang bị khoá FOR UPDATE ở trên nên
      // giá trị `tags` đọc được vẫn là giá trị sẽ ghi đè lên.
      const merged = [...new Set(tagArr(p.tags).concat(p.add))].join(',');
      await client.query('UPDATE crm_guests SET tags = $2, updated_at = now() WHERE id = $1', [p.id, merged]);
      n++;
    }
    await logAudit(client, { actor_email: ACTOR, event_type: 'backfill_tags_vnjb',
      target_type: 'crm_guests', meta: { theSua: n, themTheoTag: gain, lane } });
    await client.query('COMMIT');
    console.log('\nĐÃ GHI ' + n + ' thẻ.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error('LỖI:', e.message); process.exit(1); });
