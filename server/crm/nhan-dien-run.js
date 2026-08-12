'use strict';
/* E08-D124 · BẤM ĐỒNG BỘ LÀ MÁY ĐOÁN MẶT — không cần chúng ta.
 * E08-D126 · …VÀ NHÌN THẤY NÓ ĐANG LÀM GÌ, DỪNG ĐƯỢC, TIẾP TỤC ĐƯỢC.
 *
 * Trước D124, đợt nhận diện chỉ chạy được từ máy của anh Kha. D124 dựng cái nút
 * và sổ việc. Tối 11/08 chạy thật 5 luồng thì lộ ra rằng «một việc, chạy hoặc
 * xong» không đủ để vận hành: 5 luồng chết trong 11 phút, không ai biết cho tới
 * lúc mở terminal ra xem, và không có cách nào dừng ngoài `kill`.
 *
 * D126 giữ nguyên ba ràng buộc của D124 và thêm ba điều:
 *
 *  1 · KHÔNG nhét engine vào máy chủ (FR-1 của D077 còn nguyên). Vé này vẫn
 *      KHÔNG import engine — nó SINH tiến trình con chạy `batch.js`. Đổi ở chỗ
 *      cờ: nay là `--truc`, tức tiến trình xin việc theo tấm chứ không nhận một
 *      cửa sổ tính sẵn.
 *
 *  2 · KHÔNG đoán trong một request HTTP. POST vẫn chỉ MỞ ĐỢT rồi trả 202.
 *
 *  3 · MỘT ĐỢT MỘT LÚC, khoá đặt ở CSDL. D124 chặn «một việc»; nay chặn «một
 *      đợt», và một đợt đang TẠM DỪNG vẫn là đợt đang mở.
 *
 *  4 · WEB KHÔNG RA LỆNH TRỰC TIẾP CHO MÁY QUÉT. Máy chủ web ở production không
 *      có engine (`.railwayignore` loại hẳn `tools/`, model 37 MB không nằm
 *      trong git) — đó là chủ ý của D077, không phải sơ suất. Nên đường chính là:
 *      web đổi CỜ trong CSDL, máy quét đọc cờ đó giữa hai tấm ảnh rồi tự nghe
 *      theo. Đúng triết lý D095: «Dừng là cờ, không phải abort».
 *      Hệ quả phải nói thẳng: nút chỉ điều khiển được khi CÓ máy quét đang trực.
 *
 *  5 · ĐƯỜNG SPAWN CỦA D124 GIỮ NGUYÊN, không xoá. Khi web và engine ở cùng máy
 *      (máy kỹ thuật, hoặc sau này máy chủ có engine) thì bấm Bắt đầu là máy chủ
 *      tự dựng đủ luồng. Ở prod hiện nay đường đó vẫn nói «thiếu engine» — đúng
 *      và trung thực — nên đợt vẫn được xếp sẵn cho máy quét trực nhận.
 *
 *  6 · AI ĐÓNG SỔ. D124 đóng sổ bằng cách nghe `close` của tiến trình con nó vừa
 *      sinh. Nay tiến trình con có thể nằm ở MÁY KHÁC, nên chủ ngữ đổi: nhịp dọn
 *      dưới đây là thứ duy nhất đóng sổ, và nó đóng theo NHỊP THỞ chứ không theo
 *      vòng đời tiến trình máy chủ.
 *
 * Máy vẫn CHỈ GỢI Ý: `batch.js` ghi mọi thứ ở trạng thái `cho` (CR-127). Vé này
 * không mở một đường nào tự đưa ảnh vào album.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pool } = require('../db');
const { hashIp } = require('./audit');
const { ipOf } = require('./auth');

const THU_MUC = path.join(__dirname, '..', '..', 'tools', 'nhan-dien');
const BATCH = path.join(THU_MUC, 'batch.js');
const MODEL = ['yunet.onnx', 'sface.onnx'];
/* Cờ khoá cứng ở đây, KHÔNG nhận từ request: một tuyến HTTP cho phép chọn cờ là
   một tuyến cho phép chọn ngưỡng. `--mot-luot` để tiến trình con của máy chủ
   thoát khi đợt đóng — chỉ máy quét của người vận hành mới đứng trực mãi. */
const CO = ['--truc', '--mot-luot'];
const NGUON_HOP_LE = ['tay', 'nap-kho'];

/* Ngưỡng gợi ý — khoá 0,45 ngày 10/08 (Bước 0, soi tay). Vé này KHÔNG đổi nó và
   KHÔNG nhận nó từ request; con số ghi xuống sổ đợt để AC-10 kiểm được đợt nào
   chạy ở ngưỡng nào, và để máy quét đọc lại từ sổ thay vì mỗi máy tự mang một
   con số riêng. */
const NGUONG = 0.45;

/* Trần số luồng. Không phải con số kỹ thuật mà là con số AN TOÀN: mỗi luồng là
   một đường TLS đi ra internet tới MinIO và Postgres, và tối 11/08 đúng 5 luồng
   đã làm máy cạn cổng mạng khả dụng (EADDRNOTAVAIL). Một cú bấm không được phép
   dựng 100 luồng cào kho ảnh. */
const SO_LUONG_TOI_DA = 6;

/* Bao lâu không nhịp thì coi là chết. 3 phút, không ngắn hơn: một tấm mất ~1,3
   giây nhưng một lượt tải ảnh nặng gặp mạng xấu có thể treo lâu hơn nhiều, và
   đánh chết oan một luồng đang sống nghĩa là nhả ảnh nó đang cầm cho luồng khác
   soi — đúng cái ĐÔI TẤM mà cả vé này sinh ra để chặn. */
const HAN_NHIP_GIAY = 180;
const NHIP_DON = 30 * 1000;

/* Trần bộ nhớ cho log tiến trình con (giữ từ D124). Chỉ cần phần ĐUÔI để đọc câu
   lỗi cuối; số đếm nay nằm ở sổ luồng, không phải ở stdout. */
const TRAN_LOG = 64 * 1024;

/* Điều kiện «đợt đang mở». Viết một lần, dùng khắp nơi: đây là định nghĩa mà cái
   khoá unique ở crm-db.js đang canh, và hai chỗ nói khác nhau thì có lúc web cho
   mở đợt thứ hai còn CSDL từ chối — người dùng nhận 500 không hiểu vì sao. */
const DOT_MO = "trang_thai IN ('chay','tam-dung')";

/* ── Kiểm bộ nhận diện TRƯỚC khi sinh tiến trình (giữ nguyên D124) ───────────
   Hai thứ khác nhau đều làm việc chết ngay ở dòng đầu, và cả hai đều là «máy
   chưa có bộ nhận diện» dưới mắt người bấm nút:
     · thiếu file model/*.onnx — `batBuoc()` trong batch.js ném;
     · thiếu onnxruntime-node / sharp — `require('./engine')` ném MODULE_NOT_FOUND.
   Và KHÔNG tự tải model (AC-5 của D124): một máy chủ tự kéo file về lúc có người
   bấm nút thì «0 egress lúc chạy» không còn kiểm được. Thiếu thì nói thiếu.

   D126 đổi HỆ QUẢ của việc thiếu, không đổi phép kiểm: D124 từ chối mở việc
   (503) vì không ai khác chạy được nó. Nay máy quét trực ở máy khác mới là đường
   chính, nên thiếu engine tại chỗ chỉ có nghĩa «máy chủ này không tự chạy được»
   — đợt vẫn được xếp, và bảng nói rõ chưa có máy quét nào trực (FR-10). */
function thieuBoNhanDien() {
  const thieu = [];
  for (const f of MODEL) {
    if (!fs.existsSync(path.join(THU_MUC, 'model', f))) thieu.push('model/' + f);
  }
  for (const m of ['onnxruntime-node', 'sharp']) {
    try { require.resolve(m, { paths: [THU_MUC] }); } catch (_) { thieu.push(m); }
  }
  return thieu;
}

/* Câu lỗi NGẮN, và đi qua một lượt bôi đen (giữ nguyên D124). Ô lỗi này hiện
   thẳng lên màn của BTL và được ghi vào CSDL — chỗ như thế không được phép phụ
   thuộc vào việc mọi câu lỗi tương lai đều lịch sự. */
function cauLoi(txt) {
  const dong = String(txt || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const loi = dong.filter((s) => /^LOI\b/.test(s));
  const cuoi = loi.length ? loi[loi.length - 1] : (dong.length ? dong[dong.length - 1] : '');
  return cuoi.replace(/[a-z+]+:\/\/[^\s]*@[^\s]*/gi, '«đã ẩn»').slice(0, 300);
}

function ghiAudit(loai, email, runId, meta, ip) {
  return pool.query(
    `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
     VALUES ($1,$2,'nhan_dien_run',$3,$4::jsonb,$5)`,
    [email, loai, String(runId), JSON.stringify(meta), ip ? hashIp(ip) : null]
  ).catch((e) => { console.error('[nhan-dien-run] audit lỗi:', e.message); });
}

/* ── NHỊP DỌN — chủ ngữ của mọi việc đóng sổ ─────────────────────────────────
   D124 đóng việc mồ côi bằng MỐC KHỞI ĐỘNG của máy chủ: hàng `chay` nào bắt đầu
   trước lúc tiến trình này lên thì coi như mồ côi. Cách ấy đúng khi tiến trình
   con là con của chính máy chủ này — và SAI HẲN từ D126, vì máy quét nay chạy ở
   máy Sponsor: một lần Railway deploy giữa chừng sẽ giết một đợt đang chạy tốt
   trên máy khác. Nên mốc đổi từ «máy chủ lên lúc nào» sang «luồng thở lần cuối
   lúc nào» — thứ duy nhất thật sự nói lên máy quét còn sống hay không.

   Bốn việc, đúng thứ tự, và mỗi việc chạy lại bao nhiêu lần cũng vô hại:
     1 · luồng quá hạn nhịp   → mat-lien-lac
     2 · ảnh do luồng KHÔNG CÒN SỐNG giữ → nhả về hàng đợi
     3 · luồng `cho` của một đợt đã hết việc → huy (không có máy quét nào tới nhận)
     4 · đợt không còn luồng nào sống/chờ → đóng sổ, cộng số từ sổ luồng

   Vì sao thứ tự ấy: bước 2 dựa vào kết quả bước 1, bước 4 dựa vào bước 3. Đảo
   lại thì mỗi nhịp dọn chỉ tiến được một bước và một đợt chết mất 2 phút mới
   đóng xong sổ. */
/* ── E08-D127 · SỔ MÁY QUÉT ĐANG TRỰC ────────────────────────────────────────
   Tách hẳn khỏi sổ luồng, và đó là cả điểm của nó: một máy quét đang ĐỨNG CHỜ
   chưa có luồng nào để thở vào, nên D126 không có chỗ nào ghi nhận nó tồn tại.
   Hai hàm dưới đây là toàn bộ phần web đụng vào bảng ấy — web chỉ ĐỌC và DỌN,
   người GHI là máy quét (tools/nhan-dien/batch.js --truc, upsert mỗi 10 giây).

   Cùng hạn 3 phút với nhịp luồng, cố ý: hai con số hạn khác nhau nghĩa là có lúc
   bảng nói "có máy trực" mà luồng của chính máy ấy đã bị đánh mất-liên-lạc, và
   không ai giải thích nổi màn hình đang nói gì. */
async function donMayChet() {
  try {
    await pool.query(
      `DELETE FROM crm_nhan_dien_may WHERE nhip_cuoi < now() - make_interval(secs => $1)`,
      [HAN_NHIP_GIAY]);
  } catch (e) {
    if (!/does not exist/i.test(e.message)) console.error('[nhan-dien-run] dọn máy lỗi:', e.message);
  }
}

/* Danh sách máy CÒN THỞ. Một hàng một tiến trình `--truc` (khoá (may,pid)), nên
   ba cửa sổ terminal trên cùng một máy tính đếm ra 3 — đúng thứ người vận hành
   nhìn để chọn số luồng. `danh_may` trả về đúng số phần tử ấy chứ không gộp trùng
   tên: `so_may_truc === danh_may.length` là bất biến kiểm được từ ngoài.
   Bảng chưa migrate ⇒ danh sách rỗng, KHÔNG ném: một máy chủ vừa boot phải trả
   được trạng thái, và "chưa thấy máy nào" là câu trả lời đúng lúc ấy. */
async function danhMayTruc() {
  try {
    const r = await pool.query(
      `SELECT may FROM crm_nhan_dien_may
        WHERE nhip_cuoi > now() - make_interval(secs => $1)
        ORDER BY may, pid`, [HAN_NHIP_GIAY]);
    return r.rows.map((x) => ({ may: x.may }));
  } catch (e) {
    if (!/does not exist/i.test(e.message)) console.error('[nhan-dien-run] đọc máy lỗi:', e.message);
    return [];
  }
}

async function donLuongChet() {
  await donMayChet();
  try {
    const chet = await pool.query(
      `UPDATE crm_nhan_dien_luong
          SET trang_thai = 'mat-lien-lac', xong_luc = now(),
              loi = coalesce(loi, 'Máy quét mất liên lạc — không có nhịp nào quá ' || $1 || ' giây.')
        WHERE trang_thai IN ('chay','tam-dung')
          AND nhip_cuoi IS NOT NULL
          AND nhip_cuoi < now() - make_interval(secs => $1)
        RETURNING id, so`, [HAN_NHIP_GIAY]);
    /* `nhip_cuoi IS NOT NULL` KHÔNG phải chi tiết thừa — nó là ranh giới giữa
       «đã chết» và «chưa từng sống». Một luồng chưa máy quét nào nhận thì không
       có nhịp nào, và bản trước của câu này coi đó là mất liên lạc: bấm Tạm dừng
       tất cả khi chưa có máy quét trực là 30 giây sau cả đợt bị đóng sổ với câu
       «mất liên lạc» — đo được ở lab, không phải giả định. Luồng chưa ai nhận
       nằm chờ, đúng lời hứa FR-10; thứ dọn nó là vế hàng-đợi-đã-cạn bên dưới. */

    /* Nhả ảnh theo QUAN HỆ, không theo danh sách id vừa đánh dấu: một tấm có thể
       đang bị giữ bởi một luồng đã chết từ nhịp trước, hoặc bởi một hàng luồng đã
       bị xoá theo đợt. Hỏi «luồng giữ tấm này có còn sống không» thì mọi lối đi
       tới trạng thái kẹt đều được gỡ, kể cả lối chưa ai nghĩ ra. */
    const nha = await pool.query(
      `UPDATE crm_event_photos p SET soi_luong_id = NULL, soi_giu_luc = NULL
        WHERE p.soi_luc IS NULL AND p.soi_luong_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM crm_nhan_dien_luong l
                           WHERE l.id = p.soi_luong_id
                             AND l.trang_thai IN ('chay','tam-dung'))`);

    /* Luồng còn nằm `cho` mà hàng đợi đã cạn: không còn việc cho nó, và để nguyên
       thì đợt không bao giờ đóng — nút Bắt đầu khoá vĩnh viễn.

       Hai vế của điều kiện, mỗi vế chặn một cách hiểu sai:
        · chỉ huỷ khi KHÔNG còn tấm nào chưa soi — còn việc thì cứ để đó chờ, đúng
          lời hứa FR-10 («việc xếp sẵn, máy quét bật lên là nhận»);
        · và chỉ huỷ khi đã có một máy quét NHẬN được luồng nào đó của đợt, hoặc
          luồng đã chờ quá 2 phút. Không có vế này thì một đợt mở ra lúc kho đã soi
          hết bị đóng sổ trong 30 giây — mà đợt ấy vẫn có việc thật: tính vector
          cho mẫu BTL vừa khoanh tay rồi khớp lại với mặt cũ. Đó chính là việc
          D124 sinh ra để làm, và nó không nằm trong hàng đợi ẢNH. */
    let huy = { rowCount: 0 };
    const conViec = (await pool.query(
      `SELECT EXISTS (SELECT 1 FROM crm_event_photos
                       WHERE deleted_at IS NULL AND soi_luc IS NULL) AS con`)).rows[0].con;
    if (!conViec) {
      huy = await pool.query(
        `UPDATE crm_nhan_dien_luong l SET trang_thai = 'huy', xong_luc = now(),
                loi = coalesce(l.loi, 'Hàng đợi đã cạn trước khi máy quét nhận luồng này.')
          WHERE l.trang_thai = 'cho'
            AND (EXISTS (SELECT 1 FROM crm_nhan_dien_luong k
                          WHERE k.run_id = l.run_id AND k.may IS NOT NULL)
                 OR l.created_at < now() - interval '2 minutes')`);
    }

    /* Đóng sổ đợt. Kết cuộc lấy từ chính các luồng: có luồng nào ĐI TỚI CÙNG
       (`xong`, hoặc `huy` vì hết việc) thì đợt xong; toàn mat-lien-lac / loi thì
       đợt là `loi` — nói thật, đừng gắn nhãn «xong» cho một đợt chết giữa chừng.
       Đợt bị người bấm Dừng hẳn đã mang `huy` ở mức ĐỢT nên không lọt vào đây. */
    const XONG = `EXISTS (SELECT 1 FROM crm_nhan_dien_luong l
                           WHERE l.run_id = r.id AND l.trang_thai IN ('xong','huy'))`;
    const dong = await pool.query(
      `UPDATE crm_nhan_dien_runs r
          SET trang_thai = CASE WHEN ${XONG} THEN 'xong' ELSE 'loi' END,
              xong_luc = now(),
              so_tam   = (SELECT coalesce(sum(da_soi),0)::int FROM crm_nhan_dien_luong l WHERE l.run_id = r.id),
              so_goi_y = (SELECT coalesce(sum(goi_y),0)::int  FROM crm_nhan_dien_luong l WHERE l.run_id = r.id),
              loi = CASE WHEN ${XONG} THEN r.loi
                         ELSE coalesce(r.loi, (SELECT l.loi FROM crm_nhan_dien_luong l
                                                WHERE l.run_id = r.id AND l.loi IS NOT NULL
                                                ORDER BY l.so LIMIT 1)) END
        WHERE ${DOT_MO}
          AND EXISTS (SELECT 1 FROM crm_nhan_dien_luong l WHERE l.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM crm_nhan_dien_luong l
                           WHERE l.run_id = r.id AND l.trang_thai IN ('cho','chay','tam-dung'))
        RETURNING id, trang_thai`);

    if (chet.rowCount || nha.rowCount || huy.rowCount || dong.rowCount) {
      console.log('[nhan-dien-run] dọn: ' + chet.rowCount + ' luồng mất liên lạc · '
        + nha.rowCount + ' tấm nhả về hàng đợi · ' + huy.rowCount + ' luồng chờ bị huỷ · '
        + dong.rowCount + ' đợt đóng sổ');
    }
  } catch (e) {
    /* Bảng chưa migrate là bình thường lúc mới boot — đừng làm ồn mỗi 30 giây. */
    if (!/does not exist/i.test(e.message)) console.error('[nhan-dien-run] dọn lỗi:', e.message);
  }
}

/* Giữ tham chiếu các tiến trình con để đóng chúng lại nếu máy chủ thoát êm. Không
   đăng ký bộ nghe SIGTERM: đăng ký là CHẶN hành vi mặc định của Node, và một máy
   chủ không chịu tắt khi Railway bảo tắt thì mỗi lần deploy phải đợi SIGKILL.
   D124 giữ MỘT tiến trình; nay giữ mảng vì một đợt có tới 6 luồng. */
const VIEC = [];
process.on('exit', () => {
  for (const c of VIEC) { try { c.kill(); } catch (_) { /* đang tắt */ } }
});

/* ── Số toàn kho ─────────────────────────────────────────────────────────────
   AC-5 đòi `đã soi + còn lại = kho tổng` trong CÙNG một nhịp đọc. Nên ba con số
   phải ra từ MỘT câu truy vấn: hỏi ba lần thì giữa lần một và lần ba máy quét đã
   soi thêm mấy tấm, và bảng hiện một phép cộng sai mà không ai giải thích nổi.

   `toc_do_phut` đo theo CỬA SỔ MỘT PHÚT VỪA QUA, không phải trung bình từ lúc
   bắt đầu: người vận hành tăng giảm số luồng để nhìn tốc độ đổi, mà trung bình
   tích luỹ thì phải mười phút sau mới nhúc nhích. */
async function soToanKho() {
  const r = (await pool.query(
    `SELECT count(*)::int AS kho,
            count(*) FILTER (WHERE soi_luc IS NOT NULL)::int AS da_soi,
            count(*) FILTER (WHERE soi_luc IS NULL)::int     AS con_lai,
            count(*) FILTER (WHERE soi_luc > now() - interval '1 minute')::int AS phut_qua,
            coalesce(sum(soi_so_mat),0)::int AS so_mat
       FROM crm_event_photos WHERE deleted_at IS NULL`)).rows[0];
  const goiY = (await pool.query(
    `SELECT count(DISTINCT event_photo_id)::int AS n FROM crm_face_candidates
      WHERE deleted_at IS NULL AND trang_thai = 'cho'`)).rows[0].n;
  return {
    kho: r.kho, da_soi: r.da_soi, con_lai: r.con_lai,
    so_mat: r.so_mat, goi_y_cho: goiY,
    toc_do_phut: r.phut_qua,
    du_kien_giay: r.phut_qua > 0 ? Math.round(r.con_lai / r.phut_qua * 60) : null,
  };
}

/* Đợt đang mở, kèm sổ luồng. Trả về null khi không có đợt nào mở. */
async function dotDangMo() {
  const r = await pool.query(
    `SELECT id, trang_thai, bat_dau, boi, so_luong, nguong
       FROM crm_nhan_dien_runs WHERE ${DOT_MO} ORDER BY id DESC LIMIT 1`);
  return r.rows[0] || null;
}

async function soLuong(runId) {
  const r = await pool.query(
    `SELECT id, so, trang_thai, may, da_soi, so_mat, goi_y, so_loi, anh_hien_tai, loi,
            EXTRACT(EPOCH FROM (now() - nhip_cuoi))::int AS nhip_cuoi_giay
       FROM crm_nhan_dien_luong WHERE run_id = $1 ORDER BY so`, [runId]);
  return r.rows.map((x) => ({
    id: String(x.id), so: x.so, trang_thai: x.trang_thai, may: x.may,
    da_soi: x.da_soi, so_mat: x.so_mat, goi_y: x.goi_y,
    /* `loi` là SỐ TẤM lỗi (bảng tô đỏ khi vượt 5%); `cau_loi` là một câu cho
       người đọc. Hai thứ khác nhau, cố ý không gộp — con số để nhìn, câu để
       hiểu vì sao luồng tự hãm. */
    loi: x.so_loi, cau_loi: x.loi,
    nhip_cuoi_giay: x.nhip_cuoi_giay, anh_hien_tai: x.anh_hien_tai,
  }));
}

function mount(app, requireCrmAuth, requireRole) {
  const btl = [requireCrmAuth, requireRole('btl')];

  /* Dọn ngay sau khi migrate rồi lặp — cùng khuôn `quetHan` của face-match.js:74.
     20 giây đầu là để đợi migrate xong rồi hẵng đụng bảng. */
  const hen1 = setTimeout(donLuongChet, 20 * 1000);
  if (hen1.unref) hen1.unref();
  const hen2 = setInterval(donLuongChet, NHIP_DON);
  if (hen2.unref) hen2.unref();   // đừng giữ tiến trình sống chỉ vì cái hẹn này

  /* ── MỞ ĐỢT ───────────────────────────────────────────────────────────────
     202, không 200: việc CHƯA xong lúc câu trả lời rời máy chủ. */
  app.post('/crm/face-match/dong-bo', ...btl, async (req, res) => {
    const than = req.body || {};
    const nguon = NGUON_HOP_LE.indexOf(String(than.nguon)) > -1 ? String(than.nguon) : 'tay';
    /* Thiếu `so_luong` ⇒ 1, đúng hành vi D124: trang kho ảnh gọi tuyến này sau mỗi
       lượt nạp và nó không biết gì về luồng. */
    const soLuongXin = than.so_luong == null ? 1 : Number(than.so_luong);
    if (!Number.isInteger(soLuongXin) || soLuongXin < 1 || soLuongXin > SO_LUONG_TOI_DA) {
      return res.status(400).json({ ok: false, toi_da: SO_LUONG_TOI_DA,
        error: 'Số luồng phải là số nguyên từ 1 tới ' + SO_LUONG_TOI_DA + '.' });
    }
    try {
      await donLuongChet();

      /* Cú INSERT này LÀ cái khoá (giữ nguyên lập luận D124). Không hỏi trước «có
         ai đang chạy không» rồi mới ghi: giữa hai câu ấy là một cửa sổ đủ rộng
         cho hai tab bấm cùng lúc, và kết quả là hai đợt cùng tranh một hàng đợi. */
      let run;
      try {
        run = (await pool.query(
          `INSERT INTO crm_nhan_dien_runs (nguon, boi, so_luong, nguong)
           VALUES ($1,$2,$3,$4) RETURNING id, bat_dau`,
          [nguon, req.actor.email, soLuongXin, NGUONG])).rows[0];
      } catch (e) {
        if (e.code === '23505') {
          const dang = (await pool.query(
            `SELECT id, bat_dau, boi, trang_thai FROM crm_nhan_dien_runs
              WHERE ${DOT_MO} ORDER BY id DESC LIMIT 1`)).rows[0];
          /* Giữ nguyên hình dáng thân 409 của D124 — trang kho ảnh đọc nó. */
          return res.status(409).json({ ok: false, dang_chay: true,
            run_id: dang ? String(dang.id) : null,
            bat_dau: dang ? dang.bat_dau : null, boi: dang ? dang.boi : null,
            trang_thai: dang ? dang.trang_thai : null,
            error: 'Đang có một đợt mở — chờ xong, hoặc bấm Dừng hẳn đợt đó.' });
        }
        throw e;
      }

      /* Sổ luồng dựng NGAY, trước khi sinh tiến trình nào: đây là hàng đợi việc
         mà máy quét trực (ở máy khác) sẽ tới nhận. Không có nó thì «bật máy quét
         lên là nhận việc» không có chỗ nào để xảy ra. */
      const luong = (await pool.query(
        `INSERT INTO crm_nhan_dien_luong (run_id, so)
         SELECT $1, i FROM generate_series(1,$2) i RETURNING id`,
        [run.id, soLuongXin])).rows.map((x) => String(x.id));

      /* Đường spawn của D124 — GIỮ NGUYÊN, chỉ đổi cờ. Có engine tại chỗ thì máy
         chủ tự dựng đủ luồng; thiếu thì đợt vẫn nằm đó chờ máy quét trực, và câu
         trả lời nói rõ thiếu gì để bảng cảnh báo đúng (FR-10). */
      const thieu = thieuBoNhanDien();
      let tuChay = 0;
      if (!thieu.length) {
        for (let i = 0; i < soLuongXin; i++) {
          try { chay(run.id); tuChay++; }
          catch (e) {
            console.error('[nhan-dien-run] không sinh được luồng:', e.message);
            await pool.query(
              `UPDATE crm_nhan_dien_luong SET trang_thai = 'loi', xong_luc = now(), loi = $2
                WHERE id = $1 AND trang_thai = 'cho'`,
              [luong[i], cauLoi('Không chạy được batch.js: ' + e.message)]);
          }
        }
      }

      await ghiAudit('nhan_dien_dot_mo', req.actor.email, run.id,
        { nguon, so_luong: soLuongXin, nguong: NGUONG, tu_chay: tuChay, thieu }, ipOf(req));
      return res.status(202).json({ ok: true, run_id: String(run.id), luong,
        trang_thai: 'chay', bat_dau: run.bat_dau, nguon,
        so_luong: soLuongXin, tu_chay: tuChay,
        san_sang: thieu.length === 0, thieu });
    } catch (e) {
      console.error('[nhan-dien-run] mở đợt:', e.message);
      return res.status(500).json({ ok: false, error: 'loi' });
    }
  });

  /* ── ĐỌC TRẠNG THÁI ───────────────────────────────────────────────────────
     Một tuyến, hai lớp người đọc:
       · `viec` — y nguyên D124 (việc GẦN NHẤT). Trang kho ảnh đọc đúng khối này,
         nên mọi trường ở đó giữ nguyên TÊN và NGHĨA. Sau khi đợt xong màn hình
         vẫn phải nói được lượt vừa rồi ra sao.
       · phần D126 — số toàn kho, sổ luồng, có máy trực hay không.
     Gộp vào một tuyến chứ không mở tuyến thứ hai: bảng đọc 3 giây một lần, và
     hai tuyến nghĩa là hai ảnh chụp lệch nhau vài trăm mili giây rồi cộng ra một
     con số không khớp (AC-5). */
  app.get('/crm/face-match/dong-bo', ...btl, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, trang_thai, nguon, boi, bat_dau, xong_luc, so_mau, so_tam, so_goi_y,
                loi, so_luong, nguong
           FROM crm_nhan_dien_runs ORDER BY id DESC LIMIT 1`);
      const x = r.rows[0] || null;
      const kho = await soToanKho();
      const mo = x && (x.trang_thai === 'chay' || x.trang_thai === 'tam-dung') ? x : null;
      /* Sổ luồng của đợt GẦN NHẤT, không chỉ của đợt đang mở: F5 sau khi một đợt
         vừa chết phải còn nhìn thấy luồng nào mất liên lạc và vì sao (AC-7). */
      const luong = x ? await soLuong(x.id) : [];
      /* D127 · FR-1 — «có máy quét nào đang trực không» KHÔNG còn suy từ nhịp của
         luồng. Suy như thế thì câu trả lời chỉ đúng SAU khi đã có người bấm Bắt
         đầu: sáng 12/08 ba máy quét đứng chờ mà trang vẫn nói không có máy nào,
         vì đợt gần nhất đã đóng từ đêm trước và không luồng nào còn thở. Nay hỏi
         thẳng sổ máy — thứ máy quét ghi cả lúc rỗi việc. */
      const danhMay = await danhMayTruc();
      return res.json(Object.assign({
        ok: true, san_sang: thieuBoNhanDien().length === 0,
        viec: x ? { run_id: String(x.id), trang_thai: x.trang_thai, nguon: x.nguon,
          boi: x.boi, bat_dau: x.bat_dau, xong: x.xong_luc,
          so_mau: x.so_mau, so_tam: x.so_tam, so_goi_y: x.so_goi_y, loi: x.loi } : null,
      }, kho, {
        dot_mo: mo ? String(mo.id) : null,
        so_luong: x ? x.so_luong : null,
        nguong: x && x.nguong != null ? Number(x.nguong) : NGUONG,
        luong, co_may_truc: danhMay.length > 0, so_may_truc: danhMay.length, danh_may: danhMay,
        toi_da: SO_LUONG_TOI_DA, han_nhip_giay: HAN_NHIP_GIAY,
      }));
    } catch (e) {
      console.error('[nhan-dien-run] đọc trạng thái:', e.message);
      return res.status(500).json({ ok: false, error: 'loi' });
    }
  });

  /* ── CỜ: TẠM DỪNG · TIẾP TỤC ──────────────────────────────────────────────
     Web KHÔNG giết tiến trình nào. Nó đổi một chữ trong CSDL; máy quét đọc chữ
     ấy sau MỖI TẤM rồi tự nghe theo. Đó là lý do «tạm dừng» ăn trong vài giây mà
     không tấm nào bị bỏ dở: tấm đang cầm vẫn được soi xong, số tấm còn giữ mà
     chưa soi thì chính máy quét nhả ra.

     Vì sao không cho web nhả ảnh hộ ở đây: máy quét vẫn đang cầm chúng trong
     vòng lặp của nó thêm một hai giây nữa. Web nhả sớm là mở đúng cái cửa sổ để
     luồng thứ hai xin được tấm mà luồng thứ nhất sắp ghi kết quả lên. */
  async function doiCo(req, res, sang) {
    const than = req.body || {};
    try {
      const dot = await dotDangMo();
      if (!dot) return res.status(409).json({ ok: false, error: 'Không có đợt nào đang mở.' });

      /* TIẾP TỤC không phải là «đặt lại thành chay» cho mọi luồng. Một luồng chưa
         máy quét nào nhận (may IS NULL) phải quay về `cho` — đó là trạng thái duy
         nhất mà máy quét đi xin việc nhìn thấy. Đặt nó thành `chay` là tạo ra một
         luồng mang nhãn đang-chạy mà không có ai chạy nó, và nó nằm như thế cho
         tới khi có người bấm Dừng hẳn. */
      const DICH = sang === 'tam-dung'
        ? `'tam-dung'` : `CASE WHEN may IS NULL THEN 'cho' ELSE 'chay' END`;
      const TU = sang === 'tam-dung' ? ['cho', 'chay'] : ['tam-dung'];

      let doi;
      if (than.tat_ca === true) {
        doi = await pool.query(
          `UPDATE crm_nhan_dien_luong SET trang_thai = ${DICH}
            WHERE run_id = $1 AND trang_thai = ANY($2) RETURNING id, so`, [dot.id, TU]);
      } else {
        const id = Number(than.luong_id);
        if (!Number.isInteger(id) || id < 1) {
          return res.status(400).json({ ok: false, error: 'Thiếu luong_id hoặc tat_ca.' });
        }
        doi = await pool.query(
          `UPDATE crm_nhan_dien_luong SET trang_thai = ${DICH}
            WHERE id = $1 AND run_id = $2 AND trang_thai = ANY($3) RETURNING id, so`,
          [id, dot.id, TU]);
      }

      /* Một luồng vừa được TIẾP TỤC thì đợt không còn ngủ nữa; ngược lại, đợt chỉ
         ngủ khi KHÔNG còn luồng nào chạy. Không suy ra từ cú bấm mà HỎI LẠI sổ —
         bấm tạm dừng luồng cuối cùng cũng phải làm đợt ngủ, dù người bấm chỉ định
         nói về một luồng. */
      if (sang === 'chay') {
        await pool.query(`UPDATE crm_nhan_dien_runs SET trang_thai = 'chay' WHERE id = $1 AND ${DOT_MO}`, [dot.id]);
      } else {
        await pool.query(
          `UPDATE crm_nhan_dien_runs r SET trang_thai = 'tam-dung'
            WHERE r.id = $1 AND r.trang_thai = 'chay'
              AND NOT EXISTS (SELECT 1 FROM crm_nhan_dien_luong l
                               WHERE l.run_id = r.id AND l.trang_thai IN ('cho','chay'))`, [dot.id]);
      }

      await ghiAudit(sang === 'tam-dung' ? 'nhan_dien_tam_dung' : 'nhan_dien_tiep_tuc',
        req.actor.email, dot.id,
        { tat_ca: than.tat_ca === true, luong: doi.rows.map((x) => x.so) }, ipOf(req));
      return res.json({ ok: true, doi: doi.rows.map((x) => String(x.id)) });
    } catch (e) {
      console.error('[nhan-dien-run] đổi cờ:', e.message);
      return res.status(500).json({ ok: false, error: 'loi' });
    }
  }

  app.post('/crm/face-match/dong-bo/tam-dung', ...btl, (req, res) => doiCo(req, res, 'tam-dung'));
  app.post('/crm/face-match/dong-bo/tiep-tuc', ...btl, (req, res) => doiCo(req, res, 'chay'));

  /* ── DỪNG HẲN ĐỢT ─────────────────────────────────────────────────────────
     Khác tạm dừng ở chỗ đợt ĐÓNG: máy quét thấy `huy` thì nhả tấm và thoát sạch,
     và nút Bắt đầu mở lại được ngay.

     Ở đây web NHẢ ẢNH HỘ, ngược với tạm dừng — vì đây là đường thoát cuối cùng.
     Người bấm Dừng hẳn thường bấm đúng lúc máy quét đã chết mà chưa quá 3 phút
     nhịp, tức không còn ai nhả hộ. Cửa sổ đua với một máy quét còn sống thì vô
     hại: cú đánh dấu đã-soi của nó có điều kiện «tôi còn giữ tấm này», nên nó
     thua cuộc một cách sạch sẽ và tấm quay lại hàng đợi thay vì bị ghi đôi. */
  app.post('/crm/face-match/dong-bo/dung', ...btl, async (req, res) => {
    const id = Number((req.body || {}).run_id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ ok: false, error: 'Thiếu run_id.' });
    }
    try {
      const r = await pool.query(
        `UPDATE crm_nhan_dien_runs SET trang_thai = 'huy', xong_luc = now(),
                loi = coalesce(loi, 'Người vận hành bấm Dừng hẳn.')
          WHERE id = $1 AND ${DOT_MO} RETURNING id`, [id]);
      if (!r.rowCount) return res.status(409).json({ ok: false, error: 'Đợt này không còn mở.' });

      await pool.query(
        `UPDATE crm_nhan_dien_luong SET trang_thai = 'huy', xong_luc = now()
          WHERE run_id = $1 AND trang_thai IN ('cho','chay','tam-dung')`, [id]);
      const nha = await pool.query(
        `UPDATE crm_event_photos SET soi_luong_id = NULL, soi_giu_luc = NULL
          WHERE soi_luc IS NULL AND soi_luong_id IN
                (SELECT id FROM crm_nhan_dien_luong WHERE run_id = $1)`, [id]);

      /* Cộng số của đợt vừa dừng từ sổ luồng — nếu không thì màn hình nói «0 tấm»
         cho một đợt vừa soi mấy nghìn tấm. */
      await pool.query(
        `UPDATE crm_nhan_dien_runs r
            SET so_tam   = (SELECT coalesce(sum(da_soi),0)::int FROM crm_nhan_dien_luong l WHERE l.run_id = r.id),
                so_goi_y = (SELECT coalesce(sum(goi_y),0)::int  FROM crm_nhan_dien_luong l WHERE l.run_id = r.id)
          WHERE r.id = $1`, [id]);

      await ghiAudit('nhan_dien_dung', req.actor.email, id, { da_nha: nha.rowCount }, ipOf(req));
      return res.json({ ok: true, da_nha: nha.rowCount });
    } catch (e) {
      console.error('[nhan-dien-run] dừng đợt:', e.message);
      return res.status(500).json({ ok: false, error: 'loi' });
    }
  });
}

/* ── Tiến trình con ──────────────────────────────────────────────────────────
   Giữ nguyên mọi lập luận của D124:
   `spawn` chứ không `exec` — exec đi qua shell, và mọi thứ đi qua shell là một
   chỗ để một chuỗi lạ thành một câu lệnh. Ở đây không có tham số nào từ người
   dùng, nhưng cái nút này sẽ sống lâu hơn vé này.
   `stdio` ba ống, KHÔNG 'inherit': ống thì log nằm trong tay mã này (cắt trần);
   'inherit' thì nó trộn vào log máy chủ và không ai tách ra được. stdin đóng hẳn.
   env thừa hưởng nguyên của máy chủ: batch.js cần DATABASE_URL + MINIO_* và
   chúng vốn đã ở đó. KHÔNG in env ra đâu cả.

   Đổi ở D126: KHÔNG truyền id luồng vào dòng lệnh. Tiến trình con tự XIN một
   luồng trong sổ bằng cùng phép giữ nguyên tử mà nó dùng để xin ảnh — nên sinh 5
   tiến trình cùng một phần nghìn giây vẫn ra 5 luồng khác nhau, và nếu một tiến
   trình chết ngay lúc sinh thì luồng nó chưa kịp cầm vẫn còn nguyên cho máy quét
   khác nhận. Và KHÔNG đọc số từ stdout nữa: số nay nằm ở sổ luồng, do chính máy
   quét ghi theo nhịp — đó là thứ duy nhất còn đúng khi máy quét ở máy khác. */
function chay(runId) {
  const con = spawn(process.execPath, [BATCH].concat(CO), {
    cwd: THU_MUC, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  VIEC.push(con);

  let loi = '';
  const gom = (o, s) => (o + s).slice(-TRAN_LOG);
  con.stdout.on('data', () => { /* số đã ở sổ luồng; log dài không giữ trong RAM */ });
  con.stderr.on('data', (d) => { loi = gom(loi, String(d)); });

  const quen = () => { const i = VIEC.indexOf(con); if (i > -1) VIEC.splice(i, 1); };

  /* 'error' là hỏng của chính cú sinh (không thấy node, không quyền chạy) — nó
     KHÔNG kèm 'close' có mã lỗi hữu ích. Không có luồng nào để ghi vào (tiến
     trình chưa kịp xin), nên chỉ ghi log máy chủ; nhịp dọn sẽ đóng đợt nếu không
     luồng nào tới nhận. */
  con.on('error', (e) => {
    quen();
    console.error('[nhan-dien-run] đợt ' + runId + ': không chạy được batch.js: ' + e.message);
  });

  con.on('close', (ma) => {
    quen();
    if (ma === 0) return;
    /* Tiến trình chết TRƯỚC khi kịp xin luồng thì sổ không có chỗ nào ghi. Ghi
       hộ vào một luồng còn `cho` của đợt — thà một câu lỗi đúng chỗ còn hơn một
       luồng nằm im mãi không ai hiểu vì sao. */
    const cau = cauLoi(loi) || ('batch.js thoát với mã ' + ma);
    console.error('[nhan-dien-run] đợt ' + runId + ' một luồng lỗi: ' + cau);
    pool.query(
      `UPDATE crm_nhan_dien_luong SET trang_thai = 'loi', xong_luc = now(), loi = $2
        WHERE id = (SELECT id FROM crm_nhan_dien_luong
                     WHERE run_id = $1 AND trang_thai = 'cho' ORDER BY so LIMIT 1)`,
      [runId, cau]).catch((e) => console.error('[nhan-dien-run] ghi lỗi luồng:', e.message));
  });
  return con;
}

/* `donLuongChet` xuất ra để bộ kiểm (tools/nhan-dien/kiem-hang-doi.js) chạy được
   ĐÚNG hàm này, không phải một bản chép lại — một bản chép lại thì nó kiểm chính
   nó, và cái nó bỏ sót là cái sẽ hỏng trên prod. */
module.exports = { mount, donLuongChet };
