'use strict';
/* E08-D126 · GIAO THỨC HÀNG ĐỢI — tách khỏi batch.js có chủ ý.
 *
 * Đây là phần duy nhất của máy quét quyết định «tấm này thuộc về ai», và nó là
 * phần DUY NHẤT không cần engine để chạy: chỉ SQL. Nằm chung trong batch.js thì
 * muốn kiểm nó phải có model 37 MB, onnxruntime, sharp và một kho ảnh thật — tức
 * là không ai kiểm, và bất biến «không tấm nào bị soi hai lần» lại quay về chỗ
 * cũ: một lời hứa chứng minh bằng lập luận. Ở đây nó chứng minh được bằng
 * `node kiem-hang-doi.js` trên một Postgres rỗng trong 20 giây.
 *
 * Mọi hàm nhận `q` — bất cứ thứ gì có .query(): một Pool, hay một client đang mở
 * giao dịch. Không hàm nào ở đây tự mở kết nối, tự đọc biến môi trường, hay tự
 * ghi log: chúng là những câu SQL có tên.
 *
 * KHÔNG có hàm nào ở đây đụng tới bảng khách, ảnh mẫu hay vector.
 */

/* Bao nhiêu tấm một lượt xin. Đủ NHỎ để bấm Tạm dừng ăn trong vài giây (một
   luồng chỉ phải soi nốt tấm đang cầm rồi nhả phần còn lại), đủ LỚN để không
   biến mỗi tấm thành một vòng đi về cơ sở dữ liệu. */
const GIU_MOI_LUOT = 25;

/* ── XIN MỘT LUỒNG ───────────────────────────────────────────────────────────
   Năm tiến trình sinh ra trong cùng một phần nghìn giây phải nhận năm luồng khác
   nhau. SKIP LOCKED là chỗ khác nhau giữa «xếp hàng» và «bỏ qua»: tiến trình thứ
   hai KHÔNG đợi tiến trình thứ nhất nhả khoá rồi nhận lại đúng hàng ấy — nó nhìn
   thấy hàng đang bị giữ, bỏ qua, và lấy hàng kế tiếp.

   Chỉ nhận luồng của đợt đang CHẠY. Đợt đang tạm dừng thì để yên: nhận một luồng
   trong đó nghĩa là ngay lập tức phải ngủ, mà một máy quét đang ngủ vẫn chiếm
   một luồng của người khác. */
async function xinLuong(q, may) {
  const r = await q.query(`
    UPDATE crm_nhan_dien_luong l
       SET trang_thai = 'chay', may = $1,
           bat_dau = coalesce(l.bat_dau, now()), nhip_cuoi = now()
     WHERE l.id = (SELECT k.id FROM crm_nhan_dien_luong k
                     JOIN crm_nhan_dien_runs r ON r.id = k.run_id
                    WHERE k.trang_thai = 'cho' AND r.trang_thai = 'chay'
                    ORDER BY k.run_id, k.so
                    LIMIT 1 FOR UPDATE OF k SKIP LOCKED)
    RETURNING l.id, l.run_id, l.so`, [may]);
  if (!r.rows.length) return null;
  const l = r.rows[0];
  const d = (await q.query('SELECT nguong FROM crm_nhan_dien_runs WHERE id = $1', [l.run_id])).rows[0];
  return { id: Number(l.id), runId: Number(l.run_id), so: l.so, nguong: d ? d.nguong : null };
}

/* ── XIN VIỆC: LẤY VÀ ĐÓNG DẤU TRONG MỘT CÂU ─────────────────────────────────
   Đây là câu thay cho toàn bộ cách chia việc bằng `--bo-qua/--gioi-han`. Vì sao
   một câu chứ không hai: tách «chọn 25 tấm» khỏi «đóng dấu 25 tấm ấy» là mở lại
   đúng cửa sổ mà vé này sinh ra để đóng — giữa hai câu, một luồng khác chọn
   trúng cùng những tấm đó.

   FOR UPDATE SKIP LOCKED nằm trong CTE `lay`: nó khoá đúng những hàng nó chọn,
   và bỏ qua hàng nào đang bị luồng khác khoá. Kết quả là hai luồng không thể
   nhận cùng một tấm, kể cả khi khởi động cùng giây, kể cả khi luồng thứ sáu vào
   giữa lúc đang chạy — không cần ai tính offset, không cần khởi động lệch giờ. */
async function xinAnh(q, luongId, n) {
  const r = await q.query(`
    WITH lay AS (
      SELECT id FROM crm_event_photos
       WHERE deleted_at IS NULL AND soi_luc IS NULL AND soi_luong_id IS NULL
       ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
    UPDATE crm_event_photos p
       SET soi_luong_id = $1, soi_giu_luc = now()
      FROM lay WHERE p.id = lay.id
    RETURNING p.id, p.orig_name, p.width, p.height,
              coalesce(p.preview_key, p.object_key) AS k`, [luongId, n]);
  return r.rows;
}

/* ── NHẢ ẢNH ─────────────────────────────────────────────────────────────────
   Chỉ những tấm CHƯA soi. Tấm soi xong không còn mang dấu giữ (xem danhDauDaSoi),
   nên câu này về bản chất không thể chạm vào việc đã làm — đó là lý do gọi nó
   thừa bao nhiêu lần cũng vô hại, và mọi đường thoát đều gọi nó. */
async function nhaAnh(q, luongId) {
  const r = await q.query(
    `UPDATE crm_event_photos SET soi_luong_id = NULL, soi_giu_luc = NULL
      WHERE soi_luong_id = $1 AND soi_luc IS NULL`, [luongId]);
  return r.rowCount;
}

/* Nhả ĐÚNG MỘT tấm — đường của tấm lỗi.
   Vì sao không dùng nhaAnh() cho việc này: một tấm hỏng thì cả 25 tấm còn cầm
   cũng bị nhả, mà vòng lặp vẫn đi tiếp trên danh sách trong bộ nhớ. Từ tấm ấy
   trở đi, mọi cú đánh dấu đều trượt điều kiện «tôi còn giữ tấm này» và bị bỏ —
   24 tấm đã tải, đã dò, đã nhúng xong bị vứt đi rồi soi lại từ đầu ở lượt sau.
   Không mất dữ liệu, nhưng là công đôi, và đúng lúc mạng đang xấu nhất. */
async function nhaMotAnh(q, luongId, anhId) {
  const r = await q.query(
    `UPDATE crm_event_photos SET soi_luong_id = NULL, soi_giu_luc = NULL
      WHERE id = $2 AND soi_luong_id = $1 AND soi_luc IS NULL`, [luongId, anhId]);
  return r.rowCount;
}

/* ── ĐÁNH DẤU ĐÃ SOI ─────────────────────────────────────────────────────────
   Bản đảm bảo CUỐI CÙNG của AC-2, và nó nằm ở điều kiện chứ ở đâu khác:

     soi_luc IS NULL         — chưa ai soi tấm này
     soi_luong_id = tôi      — và tôi vẫn là người đang giữ nó

   Nếu giữa lúc tôi dò tấm này mà web đã nhả nó (người bấm Dừng hẳn) hoặc nhịp
   dọn đã cướp nó (tôi bị coi là đã chết), câu này đụng 0 dòng. Người gọi phải
   quay đầu cả giao dịch — không ghi một hàng mặt nào. Tấm quay lại hàng đợi sạch
   sẽ, thay vì mang hai bộ kết quả của hai luồng.

   Và soi xong thì NHẢ: soi_luong_id về NULL. Nhờ vậy «đang giữ mà đã soi» là một
   trạng thái không tồn tại được — đúng câu truy vấn thứ hai của AC-2. */
async function danhDauDaSoi(q, anhId, luongId, soMat) {
  const r = await q.query(
    `UPDATE crm_event_photos
        SET soi_luc = now(), soi_so_mat = $3, soi_luong_id = NULL, soi_giu_luc = NULL
      WHERE id = $1 AND soi_luc IS NULL AND soi_luong_id IS NOT DISTINCT FROM $2`,
    [anhId, luongId, soMat]);
  return r.rowCount > 0;
}

/* ── GHI NHỊP VÀ ĐỌC CỜ TRONG CÙNG MỘT CÂU ───────────────────────────────────
   Hai câu riêng thì giữa chúng có một khoảng mà máy quét đã báo «tôi còn sống»
   nhưng chưa biết mình vừa bị bảo dừng — ở nhịp 1,3 giây một tấm, khoảng ấy đủ
   để soi thêm một tấm sau khi người ta đã bấm Tạm dừng.

   Trả về CẢ HAI cờ: nút «tạm dừng tất cả» đổi cờ ĐỢT, nút của từng luồng đổi cờ
   LUỒNG. Máy quét phải nghe cả hai, nếu không thì một trong hai nút im lặng
   không làm gì — kiểu hỏng tệ nhất cho một cái nút.

   Tham số nào truyền null thì cột ấy giữ nguyên (coalesce), nên gọi nó để thở
   không mà không kèm số cũng an toàn. */
async function nhip(q, luongId, d) {
  const x = d || {};
  const r = await q.query(`
    UPDATE crm_nhan_dien_luong l
       SET nhip_cuoi = now(),
           da_soi = coalesce($2, l.da_soi), so_mat = coalesce($3, l.so_mat),
           goi_y = coalesce($4, l.goi_y), so_loi = coalesce($5, l.so_loi),
           anh_hien_tai = coalesce($6, l.anh_hien_tai),
           loi = coalesce($7, l.loi)
      FROM crm_nhan_dien_runs r
     WHERE l.id = $1 AND r.id = l.run_id
    RETURNING l.trang_thai AS luong, r.trang_thai AS dot`,
  [luongId, x.da_soi == null ? null : x.da_soi, x.so_mat == null ? null : x.so_mat,
    x.goi_y == null ? null : x.goi_y, x.so_loi == null ? null : x.so_loi,
    x.anh_hien_tai == null ? null : x.anh_hien_tai, x.loi == null ? null : x.loi]);
  /* Hàng biến mất (đợt bị xoá) thì trả về cặp cờ có nghĩa «thôi, buông đi» —
     người gọi không phải viết một nhánh riêng cho trường hợp không có hàng. */
  return r.rows[0] || { luong: 'mat-lien-lac', dot: 'huy' };
}

/* Chỉ thở, không mang số. Dùng cho cái đồng hồ chạy song song với việc: một tấm
   gặp mạng xấu có thể ngốn ba phút, và trong ba phút ấy luồng vẫn phải sống dưới
   mắt web. Điều kiện trạng thái là quan trọng — một luồng đã bị chốt sổ thì
   KHÔNG được phép hồi sinh bằng một nhịp thở đến muộn. */
async function tho(q, luongId) {
  const r = await q.query(
    `UPDATE crm_nhan_dien_luong SET nhip_cuoi = now()
      WHERE id = $1 AND trang_thai IN ('chay','tam-dung')`, [luongId]);
  return r.rowCount > 0;
}

async function chotLuong(q, luongId, trangThai, d, cau) {
  const x = d || {};
  await q.query(`
    UPDATE crm_nhan_dien_luong
       SET trang_thai = $2, xong_luc = now(), nhip_cuoi = now(), anh_hien_tai = NULL,
           da_soi = coalesce($3, da_soi), so_mat = coalesce($4, so_mat),
           goi_y = coalesce($5, goi_y), so_loi = coalesce($6, so_loi),
           loi = coalesce($7, loi)
     WHERE id = $1`,
  [luongId, trangThai, x.da_soi == null ? null : x.da_soi, x.so_mat == null ? null : x.so_mat,
    x.goi_y == null ? null : x.goi_y, x.so_loi == null ? null : x.so_loi, cau || null]);
}

/* ── TỰ HÃM KHI LỖI DỒN ──────────────────────────────────────────────────────
   Không phải SQL, nhưng ở đây vì cùng một lý do với cả tệp: nó là một quyết định
   quan trọng mà kiểm được không cần engine. Tối 11/08 luồng 1 cày hết 1.750 tấm
   với 1.601 tấm lỗi và tìm được 0 mặt — bảy phút phá kho ảnh mà không ai biết,
   vì mã chỉ cộng một biến đếm rồi in ra ở dòng tổng kết cuối.

   Hai con số, và mỗi con số chặn một cách hỏng:
     · CỬA SỔ 100 tấm gần nhất, không phải tổng từ đầu đợt. Đếm dồn thì một luồng
       hỏng ở nửa sau vẫn nằm dưới ngưỡng nhờ nửa đầu chạy tốt — tức là càng chạy
       lâu càng khó hãm, ngược hẳn với thứ mình muốn.
     · TỐI THIỂU 20 tấm mới xét. Không có sàn này thì tấm đầu tiên lỗi là hãm
       ngay (1/1 = 100%), và một cú chớp mạng lẻ giết cả luồng. Có sàn quá cao —
       đợi đủ 100 tấm — thì đã hai phút phá kho rồi mới dừng. */
const CUA_SO_LOI = 100;
const TOI_THIEU_XET = 20;
const TI_LE_TU_HAM = 0.20;

/* cuaSo là mảng boolean: true = tấm ấy lỗi. Trả về tỉ lệ khi nên hãm, null khi
   chưa. Không tự viết vào CSDL, không tự log — người gọi quyết định làm gì. */
function nenTuHam(cuaSo) {
  if (!cuaSo || cuaSo.length < TOI_THIEU_XET) return null;
  let loi = 0;
  for (const x of cuaSo) if (x) loi++;
  return loi / cuaSo.length > TI_LE_TU_HAM ? { loi, xet: cuaSo.length } : null;
}

module.exports = {
  GIU_MOI_LUOT, CUA_SO_LOI, TOI_THIEU_XET, TI_LE_TU_HAM,
  xinLuong, xinAnh, nhaAnh, nhaMotAnh, danhDauDaSoi, nhip, tho, chotLuong, nenTuHam,
};
