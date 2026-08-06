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

const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { logAudit } = require('./audit');

const COMMIT = process.argv.includes('--commit');

// Tấm SẼ GHIM cho thẻ chưa ghim = tấm chân dung MỚI NHẤT.
//
// E08-D053 — ĐỌC KỸ TRƯỚC KHI SỬA: đây KHÔNG phải «ảnh đang hiện». Nó chỉ TRÙNG
// với ảnh đang hiện ở đúng nhóm thẻ mà backfill chạm tới (`avatar_photo_id IS
// NULL`), vì ở nhóm đó COALESCE của guests.js rơi về đúng nhánh này. Dùng nó ở
// câu UPDATE là ĐÚNG; dùng nó để SO trước/sau là SAI — chính chỗ đó là bệnh
// D053 phải vá (xem `bieuThucDangHien` bên dưới).
const SQL_TAM_SE_GHIM = `
  SELECT g.id AS guest_id,
         (SELECT ph.id FROM crm_photos ph
           WHERE ph.guest_id = g.id AND ph.interaction_id IS NULL
           ORDER BY ph.created_at DESC LIMIT 1) AS tam
    FROM crm_guests g`;

/* ---- E08-D053 · MỘT NGUỒN DUY NHẤT cho «ảnh đang hiện» ----
   Hàng rào AC-2 cũ chép tay nhánh lùi rồi so với COALESCE-ghim, tức đo «mã cũ
   vs mã mới» trong khi COALESCE-ghim đã LIVE từ D040. Nó không đo thứ nó tưởng
   mình đo, và vì thế chặn nhầm 3 thẻ đã ghim hợp lệ từ trước — 33 thẻ hở nằm
   lại, đúng thứ backfill sinh ra để chặn.

   Chống tái phát bằng cách KHÔNG chép nữa: đọc thẳng biểu thức đang chạy ra từ
   `guests.js` lúc chạy. `guests.js` đổi thì phép đo đổi theo, không có bản thứ
   hai để lệch. Không đụng một dòng nào của `guests.js` (ràng buộc §5).

   FAIL-CLOSED: bóc không ra thì DỪNG HẲN, không lặng lẽ rơi về bản chép tay —
   rơi về bản chép tay chính là cách bệnh này ra đời. */
function bieuThucDangHien() {
  const p = path.join(__dirname, 'guests.js');
  const src = fs.readFileSync(p, 'utf8');
  // Neo vào mệnh đề KHÔNG THỂ trùng chỗ khác trong tệp, rồi nới ra hai đầu.
  const neo = src.indexOf('ap.id = g.avatar_photo_id');
  const dau = neo < 0 ? -1 : src.lastIndexOf('SELECT COALESCE(', neo);
  const cuoi = dau < 0 ? -1 : src.indexOf(') AS id', dau);
  if (neo < 0 || dau < 0 || cuoi < 0) {
    console.error('\n⛔ D053 — KHÔNG bóc được biểu thức avatar từ server/crm/guests.js.');
    console.error('   guests.js đã đổi hình dạng. DỪNG, không đoán, không dùng bản chép tay.');
    console.error('   Sửa hàm bieuThucDangHien() cho khớp rồi chạy lại.\n');
    process.exit(1);
  }
  const bt = 'COALESCE(' + src.slice(dau + 'SELECT COALESCE('.length, cuoi) + ')';

  /* ---- E08-D053 · KIỂM HÌNH DẠNG sau khi bóc (CR-95) ----
     Bốn kiểu bóp méo đã thử đều fail-closed NGAY tại khâu bóc. Còn một kiểu thì
     không: chèn thêm một `) AS id` NẰM GIỮA hai neo ⇒ `indexOf` bắt phải dấu
     đóng sớm ⇒ biểu thức bị CẮT CỤT nhưng vẫn «bóc được». Lúc đó script vẫn
     dừng — nhưng dừng ở khâu CHẠY, và kêu bằng một thông báo lỗi cú pháp của
     Postgres.

     Vì sao hai dòng này đáng: TOÀN BỘ lý do D053 tồn tại là một hàng rào KÊU
     SAI CHỖ. CR-84 báo «3 thẻ đổi ảnh» trong khi bệnh thật là «hàng rào đang so
     với nhánh đã chết», và phải mất một vòng đo mới tìm ra. Lặp lại đúng hình
     dạng đó lúc 2 giờ sáng trước lễ đắt hơn nhiều so với hai dòng mã.

     Hai mảnh dưới đây là hai NHÁNH của COALESCE — thiếu bất kỳ mảnh nào nghĩa
     là thứ bóc ra không còn là «ảnh đang hiện», dù nó vẫn là SQL hợp lệ. */
  const CAN = [['avatar_photo_id', 'nhánh GHIM'], ['ORDER BY ph.created_at DESC', 'nhánh LÙI']];
  const thieu = CAN.filter((x) => bt.indexOf(x[0]) < 0);
  if (thieu.length) {
    console.error('\n⛔ D053 — bóc RA được nhưng SAI HÌNH DẠNG: thiếu ' + thieu.map((x) => x[1]).join(' + ') + '.');
    console.error('   Biểu thức lấy từ guests.js không còn là «ảnh đang hiện» ⇒ phép AC-2 sẽ đo nhầm.');
    console.error('   DỪNG ở đây, kêu đúng chỗ — không để Postgres kêu hộ bằng lỗi cú pháp.\n');
    process.exit(1);
  }
  return bt;
}
const DANG_HIEN = bieuThucDangHien();   // dùng alias `g` cho crm_guests

(async () => {
  console.log('\n=== E08-D040 · backfill ảnh đại diện — ' + (COMMIT ? 'GHI THẬT' : 'DRY-RUN (không ghi)') + ' ===\n');

  const truoc = (await pool.query(`
    SELECT count(*)::int tong,
           count(*) FILTER (WHERE deleted_at IS NULL)::int con_song,
           count(*) FILTER (WHERE avatar_photo_id IS NOT NULL)::int da_ghim
      FROM crm_guests`)).rows[0];
  const co = (await pool.query(`
    SELECT count(*)::int n, count(*) FILTER (WHERE x.deleted_at IS NULL)::int n_song
      FROM (${SQL_TAM_SE_GHIM}) t
      JOIN crm_guests x ON x.id = t.guest_id
     WHERE t.tam IS NOT NULL`)).rows[0];

  console.log('  thẻ tổng ' + truoc.tong + ' (còn sống ' + truoc.con_song + ') · đã ghim sẵn ' + truoc.da_ghim);
  console.log('  thẻ CÓ ảnh chân dung: ' + co.n + ' (còn sống ' + co.n_song + ')  ← đây là số sẽ ghim');

  const client = await pool.connect();
  let daGhim = 0;
  try {
    await client.query('BEGIN');

    /* E08-D053 AC-1 — CHỤP TRẠNG THÁI TRƯỚC, bằng CHÍNH biểu thức đang chạy.
       Phải nằm TRƯỚC câu UPDATE, và trong cùng transaction để bản chụp biến mất
       cùng ROLLBACK (ON COMMIT DROP). Đây mới là «trước» thật; hàng rào cũ không
       có bước này nên nó buộc phải lấy một biểu thức khác làm mốc — và lấy nhầm. */
    await client.query(`CREATE TEMP TABLE d053_truoc ON COMMIT DROP AS
      SELECT g.id, (${DANG_HIEN}) AS anh FROM crm_guests g WHERE g.deleted_at IS NULL`);

    const r = await client.query(`
      UPDATE crm_guests g SET avatar_photo_id = t.tam
        FROM (${SQL_TAM_SE_GHIM}) t
       WHERE g.id = t.guest_id AND t.tam IS NOT NULL AND g.avatar_photo_id IS NULL
      RETURNING g.id`);
    daGhim = r.rowCount;

    /* AC-1 · PHÉP THẬT — cùng một biểu thức, hai thời điểm. Đây là ý nghĩa gốc
       của AC-2 D040, nguyên văn chú thích đầu tệp: «backfill KHÔNG chọn ảnh mới,
       nó chỉ ĐÓNG BĂNG lựa chọn hiện tại». */
    const lech = (await client.query(`
      SELECT count(*)::int n
        FROM crm_guests g JOIN d053_truoc t ON t.id = g.id
       WHERE g.deleted_at IS NULL AND (${DANG_HIEN}) IS DISTINCT FROM t.anh`)).rows[0].n;

    /* AC-6 · in CẢ phép cũ để lại vết cho người đọc sau — nhưng nói rõ nó KHÔNG
       phải cổng chặn. Nó so nhánh lùi (mã trước D040) với COALESCE-ghim (mã đang
       chạy), nên 3 thẻ đã ghim hợp lệ từ trước rồi có ảnh mới hơn sẽ luôn bị nó
       tính là «lệch» — dù backfill KHÔNG chạm chúng (`WHERE avatar_photo_id IS
       NULL`). Số đó là số của một câu hỏi khác, không phải câu AC-2 đang hỏi. */
    const lechCu = (await client.query(`
      SELECT count(*)::int n FROM crm_guests g
       WHERE g.deleted_at IS NULL
         AND (SELECT ph.id FROM crm_photos ph
               WHERE ph.guest_id = g.id AND ph.interaction_id IS NULL
               ORDER BY ph.created_at DESC LIMIT 1)
         IS DISTINCT FROM (${DANG_HIEN})`)).rows[0].n;

    // Sổ hở còn lại: thẻ sống, có ảnh chân dung, mà vẫn chưa ghim sau khi chạy.
    const hoLai = (await client.query(`
      SELECT count(*)::int n FROM crm_guests g
       WHERE g.deleted_at IS NULL AND g.avatar_photo_id IS NULL
         AND EXISTS (SELECT 1 FROM crm_photos p WHERE p.guest_id = g.id AND p.interaction_id IS NULL)`)).rows[0].n;

    console.log('\n  → ' + (COMMIT ? 'ĐÃ ghim' : 'SẼ ghim') + ': ' + daGhim + ' thẻ');
    console.log('  → AC-2 THẬT (cổng chặn) · ảnh ĐANG HIỆN đổi, cùng biểu thức trước/sau: '
      + lech + (lech === 0 ? '  ✅' : '  ❌ PHẢI LÀ 0'));
    console.log('  → sổ hở còn lại (sống · có ảnh · chưa ghim): ' + hoLai + (hoLai === 0 ? '  ✅' : ''));
    console.log('  → [tham khảo, KHÔNG chặn] phép CŨ (nhánh lùi vs đang chạy): ' + lechCu
      + ' — số này ≠ 0 là bình thường, xem chú thích D053 trong tệp');

    if (lech !== 0) {
      await client.query('ROLLBACK');
      console.log('\n  ⛔ HOÀN TÁC — có thẻ đổi ảnh đang hiện, không được ghi.\n');
      client.release(); await pool.end(); process.exit(1);
    }
    if (!COMMIT) {
      await client.query('ROLLBACK');
      console.log('\n  ĐÃ HOÀN TÁC (dry-run). Chạy lại với --commit để ghi thật.\n');
    } else {
      await logAudit(client, { actor_email: 'r1@esuhai.local', event_type: 'avatar_backfill',
        target_type: 'crm_guests', meta: { daGhim, theCoAnh: co.n, lech } });
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
