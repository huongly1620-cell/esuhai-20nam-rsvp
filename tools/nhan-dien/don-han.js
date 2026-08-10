'use strict';
/* Q3 · THI HÀNH hạn 7 ngày của vector.
   Trước bản này `het_han_luc` và index `idx_event_faces_can_don` có mặt nhưng
   KHÔNG ai đọc: grep cả nhánh chỉ ra đúng một file là lược đồ. Cột + index là
   chuẩn bị; nếu không có lệnh dọn thì "chỉ lưu tạm 7 ngày" là lời hứa trên lược
   đồ chứ không phải hành vi — vector sinh trắc chỉ biến mất khi có người gỡ ảnh.

   Xoá vector, GIỮ hình học: hộp/cạnh/độ nét không phải mẫu sinh trắc, và giao
   diện lẫn kiểm toán còn cần chúng. `vec_xoa_luc` để sự vắng mặt CHỨNG MINH
   được, không chỉ quan sát thấy trống.

   Mặc định THỬ; chỉ xoá khi có --commit. */
const { Pool } = require('pg');
const CO = process.argv.slice(2);
const GHI = CO.includes('--commit');
const URL_DB = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!URL_DB) { console.error('LOI thiếu DATABASE_URL — chạy qua `railway run`'); process.exit(1); }
const pool = new Pool({ connectionString: URL_DB, ssl: { rejectUnauthorized: false } });

async function don(){
  const q = s => pool.query(s);
  const truoc = (await q(`SELECT
      count(*) FILTER (WHERE vec IS NOT NULL)::int con_vec,
      count(*) FILTER (WHERE vec IS NOT NULL AND het_han_luc <= now())::int qua_han,
      min(het_han_luc) som_nhat FROM crm_event_faces WHERE deleted_at IS NULL`)).rows[0];
  console.log((GHI ? '── DỌN THẬT ──' : '── THỬ (không xoá gì) ──'));
  console.log('  mặt còn giữ vector: ' + truoc.con_vec + ' · trong đó QUÁ HẠN: ' + truoc.qua_han);
  console.log('  hạn sớm nhất: ' + (truoc.som_nhat || '—'));
  if (!GHI){ console.log('  (thêm --commit để xoá thật)'); return; }
  const r = await q(`UPDATE crm_event_faces
    SET vec = NULL, vec_xoa_luc = now()
    WHERE vec IS NOT NULL AND het_han_luc <= now()`);
  /* N1 · Mẫu KHÔNG nằm trong phạm vi dọn theo đồng hồ — xem chú thích ở
     crm-db.js. Dọn mẫu ở đây thì lượt batch kế tiếp tính lại chính nó, và hàng
     ra khỏi đó vừa giữ vector vừa mang dấu đã xoá. */
  console.log('  đã xoá vector: ' + r.rowCount + ' mặt sự kiện');
  const con = (await q(`SELECT count(*)::int n FROM crm_event_faces
    WHERE deleted_at IS NULL AND vec IS NOT NULL AND het_han_luc <= now()`)).rows[0].n;
  console.log('  còn sót quá hạn sau khi dọn: ' + con + '  (mong 0)');
}
don().then(() => pool.end()).catch(e => { console.error('LOI ' + e.message); process.exit(1); });
