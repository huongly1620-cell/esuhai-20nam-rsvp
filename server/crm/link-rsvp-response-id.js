'use strict';

// E08-CR-109b — gắn `response_id` cho 6 thẻ VIP + khép RSVP #12.
//
//   node server/crm/link-rsvp-response-id.js              → DRY-RUN: in bảng, KHÔNG ghi
//   node server/crm/link-rsvp-response-id.js --commit      → ghi thật (CHỜ PM TỔNG DUYỆT BẢNG)
//   node server/crm/link-rsvp-response-id.js --tao-moi …   → xem §«#12» bên dưới
//
// VÌ SAO LÀ SCRIPT CLI, KHÔNG PHẢI TUYẾN: đây là ops dữ liệu một lần, chạm 7
// dòng đã đo tên. Đặt sau một URL là để nó chạy lại nhầm lúc nào không ai biết.
// Cùng khuôn `backfill-avatar.js`: dry-run mặc định, `--commit` tường minh.
//
// CẤM (phiếu §Context): `backfill-rsvp.js` · `syncFromRsvp` hàng loạt ·
// đổi `full_name`/`phone` của 6 thẻ gắn · đụng thẻ #195.

const { pool } = require('../db');
const { hashIp } = require('./audit');

const COMMIT = process.argv.includes('--commit');
const TAO_MOI = process.argv.includes('--tao-moi');
const ACTOR = 'r1@esuhai.local';

// Bảng gắn CỨNG theo phiếu — cố ý không «đo lại chọn id khác».
const GAN = [
  { rsvp: 45, guest: 89, ten: 'Ông Phạm Đình Bắc' },
  { rsvp: 36, guest: 185, ten: 'Ông Đỗ Năng Khánh' },
  { rsvp: 35, guest: 186, ten: 'Ông Tào Bằng Huy' },
  { rsvp: 28, guest: 76, ten: 'Ông Đoàn Thái Kiên' },
  { rsvp: 26, guest: 154, ten: 'Bà Nguyễn Thị Thùy Trang' },
  { rsvp: 20, guest: 60, ten: 'Ông Phạm Anh Thắng' },
];
const RSVP_12 = 12;
const THE_12_CU = 7;          // thẻ `rsvp:12:rep` đang bị xoá mềm — xem §«#12»

/* Nguyên văn `dropSessionTags` của sync-from-rsvp.js (:29-32). Chép vào đây vì
   tệp đó KHÔNG export nó; giữ từng chữ để hai đường không lệch nhau. Buổi của
   khách đọc từ FORM qua `response_id`, nên để lại tag buổi là đếm hai lần và
   KPI `integrity.disjoint` vỡ. */
function dropSessionTags(csv) {
  return String(csv || '').split(',').map((s) => s.trim())
    .filter((s) => s && s !== 'toa-dam' && s !== 'gala').join(',');
}
const normPhone = (p) => String(p || '').replace(/\D/g, '');

function bang(ten, rows) {
  console.log('\n── ' + ten + ' ──');
  if (!rows.length) { console.log('   (không dòng nào)'); return; }
  console.table(rows);
}

(async () => {
  console.log('\n=== CR-109b · gắn response_id — ' + (COMMIT ? 'GHI THẬT' : 'DRY-RUN (không ghi)') + ' ===');

  const client = await pool.connect();
  let daUpdate = 0; let daChen = 0; let daHoiSinh = 0;
  try {
    await client.query('BEGIN');

    /* Khoá 7 hàng rồi mới đọc: script này ghi `tags` theo kiểu đọc-sửa-ghi, nên
       phải khoá kẻo một lượt sửa khác chen vào giữa và bị đè. */
    const ids = GAN.map((x) => x.guest).concat([THE_12_CU]);
    const truoc = (await client.query(
      `SELECT id, guest_ext_id, full_name, phone, phone_norm, response_id, tags,
              (deleted_at IS NULL) AS song
         FROM crm_guests WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids])).rows;
    const byId = new Map(truoc.map((r) => [String(r.id), r]));

    bang('TRƯỚC', truoc.map((r) => ({
      id: r.id, ten: r.full_name, response_id: r.response_id,
      tags_buoi: [r.tags && r.tags.includes('toa-dam') ? 'toa-dam' : null,
        r.tags && r.tags.includes('gala') ? 'gala' : null].filter(Boolean).join(',') || '—',
      song: r.song,
    })));

    // ---- 6 UPDATE ----
    const ketQua = [];
    for (const g of GAN) {
      const cu = byId.get(String(g.guest));
      if (!cu) throw new Error('Không thấy thẻ #' + g.guest);
      if (cu.response_id !== null) {
        // Idempotent: chạy lần hai thì đã gắn rồi ⇒ bỏ qua, KHÔNG coi là lỗi.
        ketQua.push({ rsvp: g.rsvp, guest: g.guest, viec: 'đã gắn từ trước', tags_moi: '—' });
        continue;
      }
      const tagsMoi = dropSessionTags(cu.tags);
      const r = await client.query(
        `UPDATE crm_guests SET response_id = $2, tags = $3, updated_at = now()
          WHERE id = $1 AND response_id IS NULL AND deleted_at IS NULL`,
        [g.guest, g.rsvp, tagsMoi || null]);
      /* Fail-closed: phiếu bắt ROLLBACK nếu bất kỳ UPDATE nào rowCount ≠ 1. */
      if (r.rowCount !== 1) throw new Error('UPDATE #' + g.guest + ' đổi ' + r.rowCount + ' dòng (phải là 1)');
      daUpdate++;
      ketQua.push({ rsvp: g.rsvp, guest: g.guest, viec: 'gắn response_id + gỡ tag buổi',
        tags_moi: tagsMoi.length > 46 ? tagsMoi.slice(0, 46) + '…' : tagsMoi });
    }

    /* ---- #12 ----
       ⚠️ TIỀN ĐỀ PHIẾU SAI MỘT NỬA. Phiếu ghi «#12 chưa thấy thẻ ⇒ TẠO MỚI».
       Đo prod 07/08: thẻ **#7** (`rsvp:12:rep`) ĐÃ TỒN TẠI với đúng
       `response_id=12`, đúng tên «Trần Thị Thuỳ Trang», đúng org «Gia đình»,
       đúng tags `rsvp,dang-ky` — nhưng bị **XOÁ MỀM** trong đợt dọn trùng
       03–05/08 (30/50 thẻ `rsvp:*:rep` cùng chung số phận).
       Với 6 thẻ kia việc xoá là ĐÚNG: chúng trùng với thẻ VNJB/TGĐ còn sống.
       Với #12 thì KHÔNG có thẻ nào thay thế — đó chính là lý do nó nằm trong
       danh sách 7. Tức là nó bị dọn nhầm theo đợt.

       MẶC ĐỊNH: HỒI SINH thẻ #7 (một dòng, giữ đúng khoá `rsvp:12:rep` mà 50
       thẻ RSVP khác đang dùng).  `--tao-moi`: chèn thẻ mới đúng chữ phiếu.
       Chèn mới thì RSVP #12 có HAI dòng (một chết mang khoá tự nhiên, một sống
       mang khoá `rsvp-12-…` bịa riêng cho một hàng) — R1 không tự chọn đường
       đó, và cũng không tự chọn ngược lại: xem báo cáo, PM tổng chốt. */
    const the12 = byId.get(String(THE_12_CU));
    const rsvp12 = (await client.query(
      'SELECT id, rep_name, rep_org, rep_phone, sessions FROM rsvp_submissions WHERE id = $1', [RSVP_12])).rows[0];
    if (!rsvp12) throw new Error('Không thấy RSVP #12');

    let viec12;
    if (the12 && the12.song && String(the12.response_id) === String(RSVP_12)) {
      viec12 = { viec: 'đã sống + đã gắn từ trước — không làm gì', id: the12.id };
    } else if (!TAO_MOI) {
      const ph = normPhone(rsvp12.rep_phone);
      const r = await client.query(
        `UPDATE crm_guests SET deleted_at = NULL, response_id = $2,
                phone = COALESCE(phone, $3), phone_norm = COALESCE(phone_norm, $4),
                tags = $5, updated_at = now()
          WHERE id = $1 AND deleted_at IS NOT NULL`,
        [THE_12_CU, RSVP_12, rsvp12.rep_phone || null, ph || null,
          dropSessionTags(the12 && the12.tags) || 'rsvp,dang-ky']);
      if (r.rowCount !== 1) throw new Error('Hồi sinh #7 đổi ' + r.rowCount + ' dòng (phải là 1)');
      daHoiSinh = 1;
      viec12 = { viec: 'HỒI SINH thẻ #7 (rsvp:12:rep)', id: THE_12_CU, phone: rsvp12.rep_phone };
    } else {
      const ext = 'rsvp-12-' + Date.parse('2026-08-07T00:00:00Z');   // tất định, không dùng đồng hồ
      const ins = await client.query(
        `INSERT INTO crm_guests (guest_ext_id, full_name, org, phone, phone_norm, response_id, tags)
         VALUES ($1,$2,$3,$4,$5,$6,'rsvp,dang-ky')
         ON CONFLICT (guest_ext_id) DO NOTHING RETURNING id`,
        [ext, rsvp12.rep_name, rsvp12.rep_org || null,
          rsvp12.rep_phone || null, normPhone(rsvp12.rep_phone) || null, RSVP_12]);
      daChen = ins.rowCount;
      viec12 = { viec: 'TẠO MỚI (--tao-moi)', id: ins.rows[0] && ins.rows[0].id, ext };
    }

    bang('SẼ LÀM', ketQua);
    bang('#12', [viec12]);

    /* Audit ghi THẲNG trong giao dịch, KHÔNG qua logAudit (nó nuốt lỗi và chạy
       sau COMMIT). Ở đây audit là bản ghi duy nhất của việc «ai nối RSVP nào vào
       thẻ nào» — cùng lập luận D036 §3g / D049 M2. */
    if (COMMIT && (daUpdate || daChen || daHoiSinh)) {
      await client.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'rsvp_link','crm_guests',NULL,$2::jsonb,$3)`,
        [ACTOR, JSON.stringify({ ve: 'CR-109b', ds: ketQua, the12: viec12,
          soUpdate: daUpdate, soChen: daChen, soHoiSinh: daHoiSinh }), hashIp(null)]);
    }

    // ---- AC-1: còn RSVP `yes` nào chưa có thẻ sống trỏ về không ----
    const con = (await client.query(
      `SELECT s.id, s.rep_name FROM rsvp_submissions s
        WHERE s.status = 'yes'
          AND NOT EXISTS (SELECT 1 FROM crm_guests g WHERE g.response_id = s.id AND g.deleted_at IS NULL)
        ORDER BY s.id`)).rows;
    bang('AC-1 · RSVP «yes» còn hở SAU lượt này (phải rỗng)', con);

    const sau = (await client.query(
      `SELECT id, full_name, response_id, tags, (deleted_at IS NULL) AS song
         FROM crm_guests WHERE id = ANY($1) ORDER BY id`, [ids])).rows;
    bang('SAU', sau.map((r) => ({
      id: r.id, ten: r.full_name, response_id: r.response_id,
      con_tag_buoi: /(^|,)(toa-dam|gala)(,|$)/.test(r.tags || '') ? '⚠ CÒN' : 'không',
      song: r.song,
    })));

    console.log('\n  update ' + daUpdate + ' · hồi sinh ' + daHoiSinh + ' · chèn ' + daChen
      + ' · AC-1 còn hở: ' + con.length);

    if (!COMMIT) {
      await client.query('ROLLBACK');
      console.log('\n  ĐÃ HOÀN TÁC (dry-run). Duyệt bảng xong thì chạy lại với --commit.\n');
    } else {
      await client.query('COMMIT');
      console.log('\n  ĐÃ GHI ✅\n');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n  ⛔ LỖI — đã hoàn tác, KHÔNG ghi gì:', e.message, '\n');
    client.release(); await pool.end(); process.exit(1);
  }
  client.release();
  await pool.end();
})();
