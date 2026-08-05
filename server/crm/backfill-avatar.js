'use strict';

// E08-D040 AC-2/AC-3/AC-4 — ghim `avatar_photo_id` = ĐÚNG TẤM ĐANG HIỆN.
//
//   node server/crm/backfill-avatar.js            → DRY-RUN: đếm, so trước/sau, KHÔNG ghi
//   node server/crm/backfill-avatar.js --commit   → ghi thật (CHỜ SPONSOR GO RIÊNG)
//
// M1 — VÌ SAO ĐÂY LÀ SCRIPT CLI CHỨ KHÔNG NẰM TRONG MIGRATION:
// `crm-db.js` chạy migration MỖI LẦN BOOT. Nhét backfill vào đó thì tối 08/08 app
// restart giữa buổi ⇒ tấm PG vừa chụp bị GHIM NGAY ⇒ chụp lại tấm đẹp hơn không
// đổi được nữa. Tức là vé sinh ra để chống «không lùi được» lại tự dựng đúng cái
// đó. Ba lớp chặn: không lời gọi nào từ crm-db.js · không từ index.js · và script
// đòi cờ --commit tường minh, gõ nhầm thì chỉ chạy dry-run rồi thoát.
//
// AN TOÀN:
//  * Chỉ ghi MỘT cột, chỉ ở dòng đang NULL ⇒ chạy lại lần hai đổi 0 dòng (AC-3).
//  * Ghim đúng biểu thức mà mã đang chạy dùng để chọn avatar ⇒ 0 thẻ đổi ảnh
//    đang hiện (AC-2). Đây là điểm cốt lõi: backfill KHÔNG chọn ảnh mới, nó chỉ
//    ĐÓNG BĂNG lựa chọn hiện tại.
//  * KHÔNG lọc `deleted_at`: thẻ xoá mềm có thể được phục hồi, lúc đó ghim theo
//    trạng thái hôm nay vẫn đúng hơn là để NULL rồi lấy tấm mới nhất của tương lai.
//  * Khách CHƯA có ảnh nào thì để NULL — không tạo ghim từ hư không. Đó là lối
//    thoát cho PG chụp trượt ở cửa (AC-6): tấm 1 rồi tấm 2 vẫn đổi được.

const { pool } = require('../db');
const { logAudit } = require('./audit');

const COMMIT = process.argv.includes('--commit');

// Đúng biểu thức của guests.js nhánh lùi — tấm chân dung MỚI NHẤT.
const SQL_TAM_DANG_HIEN = `
  SELECT g.id AS guest_id,
         (SELECT ph.id FROM crm_photos ph
           WHERE ph.guest_id = g.id AND ph.interaction_id IS NULL
           ORDER BY ph.created_at DESC LIMIT 1) AS tam
    FROM crm_guests g`;

(async () => {
  console.log('\n=== E08-D040 · backfill ảnh đại diện — ' + (COMMIT ? 'GHI THẬT' : 'DRY-RUN (không ghi)') + ' ===\n');

  const truoc = (await pool.query(`
    SELECT count(*)::int tong,
           count(*) FILTER (WHERE deleted_at IS NULL)::int con_song,
           count(*) FILTER (WHERE avatar_photo_id IS NOT NULL)::int da_ghim
      FROM crm_guests`)).rows[0];
  const co = (await pool.query(`
    SELECT count(*)::int n, count(*) FILTER (WHERE x.deleted_at IS NULL)::int n_song
      FROM (${SQL_TAM_DANG_HIEN}) t
      JOIN crm_guests x ON x.id = t.guest_id
     WHERE t.tam IS NOT NULL`)).rows[0];

  console.log('  thẻ tổng ' + truoc.tong + ' (còn sống ' + truoc.con_song + ') · đã ghim sẵn ' + truoc.da_ghim);
  console.log('  thẻ CÓ ảnh chân dung: ' + co.n + ' (còn sống ' + co.n_song + ')  ← đây là số sẽ ghim');

  const client = await pool.connect();
  let daGhim = 0;
  try {
    await client.query('BEGIN');
    const r = await client.query(`
      UPDATE crm_guests g SET avatar_photo_id = t.tam
        FROM (${SQL_TAM_DANG_HIEN}) t
       WHERE g.id = t.guest_id AND t.tam IS NOT NULL AND g.avatar_photo_id IS NULL
      RETURNING g.id`);
    daGhim = r.rowCount;

    // AC-2 — so TRƯỚC/SAU ngay trong cùng transaction: tấm mã CŨ chọn so với tấm
    // mã MỚI sẽ chọn (COALESCE ghim → lùi). Đếm thẻ LỆCH, kỳ vọng 0.
    const lech = (await client.query(`
      SELECT count(*)::int n FROM crm_guests g
       WHERE g.deleted_at IS NULL
         AND (SELECT ph.id FROM crm_photos ph
               WHERE ph.guest_id = g.id AND ph.interaction_id IS NULL
               ORDER BY ph.created_at DESC LIMIT 1)
         IS DISTINCT FROM
             COALESCE(
               (SELECT ap.id FROM crm_photos ap
                 WHERE ap.id = g.avatar_photo_id AND ap.guest_id = g.id AND ap.interaction_id IS NULL),
               (SELECT ph.id FROM crm_photos ph
                 WHERE ph.guest_id = g.id AND ph.interaction_id IS NULL
                 ORDER BY ph.created_at DESC LIMIT 1))`)).rows[0].n;

    console.log('\n  → ' + (COMMIT ? 'ĐÃ ghim' : 'SẼ ghim') + ': ' + daGhim + ' thẻ');
    console.log('  → AC-2 · thẻ còn sống ĐỔI ảnh đang hiện: ' + lech + (lech === 0 ? '  ✅' : '  ❌ PHẢI LÀ 0'));

    if (lech !== 0) {
      await client.query('ROLLBACK');
      console.log('\n  ⛔ HOÀN TÁC — có thẻ đổi ảnh, không được ghi.\n');
      client.release(); await pool.end(); process.exit(1);
    }
    if (!COMMIT) {
      await client.query('ROLLBACK');
      console.log('\n  ĐÃ HOÀN TÁC (dry-run). Chạy lại với --commit để ghi thật.\n');
    } else {
      await logAudit(client, { actor_email: 'r1@esuhai.local', event_type: 'avatar_backfill',
        target_type: 'crm_guests', meta: { daGhim, thẻCóẢnh: co.n, lech } });
      await client.query('COMMIT');
      console.log('\n  ĐÃ GHI ✅\n');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('  LỖI — đã hoàn tác:', e.message);
    client.release(); await pool.end(); process.exit(1);
  }
  client.release();
  await pool.end();
})();
