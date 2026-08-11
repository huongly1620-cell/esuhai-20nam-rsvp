'use strict';
/* E08-D124 · BẤM ĐỒNG BỘ LÀ MÁY ĐOÁN MẶT — không cần chúng ta.
 *
 * Trước vé này, đợt nhận diện chỉ chạy được từ máy của anh Kha:
 * `railway run --service esuhai-web -- node tools/nhan-dien/batch.js --commit`.
 * Nghĩa là mọi mẫu BTL khoanh tay nằm chờ cho tới khi có người kỹ thuật rảnh —
 * đúng thứ Sponsor gọi là «không có chúng ta app vẫn phải chạy được».
 *
 * Ba ràng buộc định hình toàn bộ mã dưới đây:
 *
 *  1 · KHÔNG nhét engine vào máy chủ (FR-1 của D077 còn nguyên). ONNX + sharp là
 *      phụ thuộc biên dịch gốc; hỏng build là cả app không lên được. Nên vé này
 *      KHÔNG import engine — nó SINH một tiến trình con chạy đúng `batch.js` đã
 *      sống từ D077, với đúng hai cờ `--commit --khop-lai`. Cờ khoá cứng ở đây,
 *      không nhận từ request: một tuyến HTTP cho phép chọn cờ là một tuyến cho
 *      phép chọn ngưỡng.
 *
 *  2 · KHÔNG đoán trong một request HTTP. Cả kho là ~20 phút; một request treo
 *      20 phút thì proxy cắt, người dùng bấm lại, và không ai biết việc còn chạy
 *      hay đã chết. Nên tuyến POST chỉ MỞ việc rồi trả 202 ngay, còn trạng thái
 *      sống trong một bảng — F5 vẫn đọc lại được (luật 4).
 *
 *  3 · MỘT VIỆC MỘT LÚC, và khoá đặt ở CSDL chứ không ở biến trong RAM. Biến RAM
 *      chết theo tiến trình: deploy giữa chừng là khoá biến mất trong khi việc cũ
 *      vẫn đang ghi. Unique một phần trên `trang_thai='chay'` thì hai cú bấm — kể
 *      cả từ hai tab, hai người, hai tiến trình — chỉ một cú thắng.
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
const CO = ['--commit', '--khop-lai'];
const NGUON_HOP_LE = ['tay', 'nap-kho'];

/* Trần bộ nhớ cho log tiến trình con. `batch.js` in vài chục dòng số, nhưng một
   ngày nào đó nó có thể in nhiều hơn — giữ cả stdout của một việc 20 phút trong
   RAM máy chủ là một chỗ phình không có trần. Chỉ cần phần ĐUÔI để đọc số và câu
   lỗi cuối. */
const TRAN_LOG = 64 * 1024;

/* ── Kiểm bộ nhận diện TRƯỚC khi sinh tiến trình (luật 5) ────────────────────
   Hai thứ khác nhau đều làm việc chết ngay ở dòng đầu, và cả hai đều là «máy
   chưa có bộ nhận diện» dưới mắt người bấm nút:
     · thiếu file model/*.onnx — `batBuoc()` trong batch.js ném;
     · thiếu onnxruntime-node / sharp — `require('./engine')` ném MODULE_NOT_FOUND.
   Không kiểm thì cả hai hiện ra dưới dạng một vết ngăn xếp trong ô lỗi. Mỗi hỏng
   phải nói đúng tên của nó — cùng luật với `kiemMoiTruong()` của batch.js.

   Và KHÔNG tự tải model (AC-5): một máy chủ tự kéo file về lúc có người bấm nút
   thì «0 egress lúc chạy» không còn kiểm được, mà file kéo về có thể khác file đã
   duyệt. Thiếu thì nói thiếu, để người kỹ thuật cài. */
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

/* ── Đọc số từ log của batch.js ──────────────────────────────────────────────
   Ba con số luật 4 đòi, lấy từ đúng những dòng batch.js đã in từ D077 — nên vé
   này KHÔNG phải sửa batch.js (AC-7). Dòng vắng mặt nghĩa là 0 việc thuộc loại
   ấy: `tinhMauKhoanhTay` và `khopMauMoiVoiMatCu` đều thoát sớm trước khi log khi
   không có gì để làm. Vắng ⇒ 0, không phải ⇒ «không biết». */
function docSo(log) {
  const lay = (re) => { const m = log.match(re); return m ? Number(m[1]) : 0; };
  return {
    so_mau: lay(/mẫu khoanh tay chờ tính:\s*\d+\s*·\s*tính xong\s*(\d+)/),
    so_tam: lay(/ảnh sự kiện cần xử lý:\s*(\d+)/),
    so_goi_y: lay(/gợi ý ≥\s*[\d.,]+:\s*(\d+)/)
            + lay(/mẫu mới: thêm\s*(\d+)\s*gợi ý/),
  };
}

/* Câu lỗi NGẮN, và đi qua một lượt bôi đen. `batch.js` không in chuỗi kết nối
   (kiemMoiTruong chỉ kể TÊN biến), nhưng ô lỗi này hiện thẳng lên màn của BTL và
   được ghi vào CSDL — chỗ như thế không được phép phụ thuộc vào việc mọi câu lỗi
   tương lai đều lịch sự. Cắt 300 ký tự vì đây là câu để người đọc, không phải
   nhật ký chẩn đoán; nhật ký đầy đủ nằm ở log máy chủ. */
function cauLoi(txt) {
  const dong = String(txt || '').split('\n').map((s) => s.trim()).filter(Boolean);
  /* Ưu tiên dòng `LOI …` — đó là câu batch.js tự viết cho người đọc. Dòng CUỐI
     chỉ là phương án hai: onnxruntime in mấy chục dòng cảnh báo ra stderr ngay lúc
     mở phiên, và một ngày nào đó chúng có thể rơi xuống sau câu lỗi thật. Lấy bừa
     dòng cuối là hiện «Initializer fc1_gamma appears in graph inputs…» cho một
     người đang tự hỏi vì sao cái nút không chạy. */
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

/* ── Việc mồ côi ─────────────────────────────────────────────────────────────
   Tiến trình con là con của MÁY CHỦ NÀY. Máy chủ dựng lại (deploy, restart) thì
   không còn ai đọc kết cuộc của nó — hàng `chay` nằm lại và khoá vĩnh viễn cái
   nút, vì unique không cho mở việc thứ hai. Nên mọi hàng `chay` bắt đầu TRƯỚC
   lúc tiến trình này lên đều là mồ côi: đánh dấu `loi` và nói đúng vì sao.

   Mốc lấy từ ĐỒNG HỒ CỦA CSDL, không của Node: `bat_dau` là `now()` của Postgres,
   so hai đồng hồ khác nhau thì lệch vài giây là đủ để hoặc bỏ sót hàng mồ côi,
   hoặc — tệ hơn — giết chính việc mình vừa mở. Đọc lười, vì `crm.mount()` chạy
   TRƯỚC `migrateCrm()` (server/index.js) nên lúc nạp module bảng có thể chưa có.

   Giả định: một tiến trình máy chủ. Nếu ngày nào đó chạy nhiều bản sao, mốc này
   phải đổi thành «của bản sao nào» — hàng cần thêm một cột danh tính tiến trình. */
let MOC = null;
async function mocKhoiDong() {
  if (!MOC) MOC = (await pool.query('SELECT now() AS t')).rows[0].t;
  return MOC;
}
async function donMoCoi() {
  try {
    const moc = await mocKhoiDong();
    const r = await pool.query(
      `UPDATE crm_nhan_dien_runs SET trang_thai = 'loi', xong_luc = now(),
              loi = 'Máy chủ khởi động lại giữa chừng — không theo dõi được kết cuộc. Bấm lại nếu cần.'
        WHERE trang_thai = 'chay' AND bat_dau < $1`, [moc]);
    if (r.rowCount) console.log('[nhan-dien-run] đóng ' + r.rowCount + ' việc mồ côi từ lần chạy trước');
  } catch (e) {
    /* Bảng chưa migrate là bình thường lúc mới boot — đừng làm ồn. */
    if (!/does not exist/i.test(e.message)) console.error('[nhan-dien-run] dọn mồ côi lỗi:', e.message);
  }
}

/* Giữ tham chiếu tiến trình con để đóng nó lại nếu máy chủ thoát êm. Không đăng
   ký bộ nghe SIGTERM: đăng ký là CHẶN hành vi mặc định của Node, và một máy chủ
   không chịu tắt khi Railway bảo tắt thì mỗi lần deploy phải đợi SIGKILL. */
let VIEC = null;
process.on('exit', () => { if (VIEC) { try { VIEC.kill(); } catch (_) { /* đang tắt */ } } });

function mount(app, requireCrmAuth, requireRole) {
  const btl = [requireCrmAuth, requireRole('btl')];

  /* Quét mồ côi một lần lúc khởi động — cùng khuôn `quetHan` của face-match.js:
     đợi migrate xong rồi hẵng đụng bảng. Hai tuyến bên dưới cũng tự gọi lại nó,
     nên ai bấm sớm hơn 20 giây cũng không gặp một cái nút khoá vô cớ. */
  const hen = setTimeout(donMoCoi, 20 * 1000);
  if (hen.unref) hen.unref();          // đừng giữ tiến trình sống chỉ vì cái hẹn này

  /* ── MỞ VIỆC ──────────────────────────────────────────────────────────────
     202, không 200: việc CHƯA xong lúc câu trả lời rời máy chủ, và mã trạng thái
     nói đúng điều đó. */
  app.post('/crm/face-match/dong-bo', ...btl, async (req, res) => {
    const nguon = NGUON_HOP_LE.indexOf(String((req.body || {}).nguon)) > -1
      ? String(req.body.nguon) : 'tay';
    try {
      await donMoCoi();

      /* Cú INSERT này LÀ cái khoá. Không hỏi trước «có ai đang chạy không» rồi mới
         ghi: giữa hai câu ấy là một cửa sổ đủ rộng cho hai tab bấm cùng lúc, và
         kết quả là hai tiến trình cùng dò một kho. */
      let run;
      try {
        run = (await pool.query(
          `INSERT INTO crm_nhan_dien_runs (nguon, boi) VALUES ($1,$2)
           RETURNING id, bat_dau`, [nguon, req.actor.email])).rows[0];
      } catch (e) {
        if (e.code === '23505') {
          const dang = (await pool.query(
            `SELECT id, bat_dau, boi FROM crm_nhan_dien_runs
              WHERE trang_thai = 'chay' ORDER BY id DESC LIMIT 1`)).rows[0];
          return res.status(409).json({ ok: false, dang_chay: true,
            run_id: dang ? String(dang.id) : null,
            bat_dau: dang ? dang.bat_dau : null, boi: dang ? dang.boi : null,
            error: 'Đang có một việc chạy — chờ xong đã.' });
        }
        throw e;
      }

      const thieu = thieuBoNhanDien();
      if (thieu.length) {
        /* Hàng vẫn được ghi, và ghi ở trạng thái `loi` (AC-5): một cú bấm không
           làm gì cả mà cũng không để lại dấu vết thì lần sau người ta bấm lại,
           rồi lại bấm lại. Ghi xuống thì F5 vẫn thấy đúng câu ấy. */
        await pool.query(
          `UPDATE crm_nhan_dien_runs SET trang_thai = 'loi', xong_luc = now(), loi = $2
            WHERE id = $1`,
          [run.id, 'Máy chủ chưa có bộ nhận diện (thiếu: ' + thieu.join(', ') + ').']);
        await ghiAudit('nhan_dien_dong_bo_tu_choi', req.actor.email, run.id,
          { nguon, thieu }, ipOf(req));
        return res.status(503).json({ ok: false, run_id: String(run.id), thieu,
          error: 'Máy chủ chưa có bộ nhận diện — nhờ kỹ thuật cài rồi bấm lại.' });
      }

      try {
        chay(run.id, req.actor.email);
      } catch (e) {
        await ketThuc(run.id, req.actor.email, 'loi', null, cauLoi(e.message));
        return res.status(500).json({ ok: false, run_id: String(run.id),
          error: 'Không mở được việc nhận diện.' });
      }

      await ghiAudit('nhan_dien_dong_bo', req.actor.email, run.id, { nguon }, ipOf(req));
      return res.status(202).json({ ok: true, run_id: String(run.id),
        trang_thai: 'chay', bat_dau: run.bat_dau, nguon });
    } catch (e) {
      console.error('[nhan-dien-run] mở việc:', e.message);
      return res.status(500).json({ ok: false, error: 'loi' });
    }
  });

  /* ── ĐỌC TRẠNG THÁI ───────────────────────────────────────────────────────
     Việc GẦN NHẤT, không phải «việc đang chạy»: sau khi xong, màn hình vẫn phải
     nói được lượt vừa rồi ra sao — nếu không thì bấm nút xong đợi ba phút, quay
     lại thấy trắng trơn và không biết máy đã làm gì. */
  app.get('/crm/face-match/dong-bo', ...btl, async (req, res) => {
    try {
      await donMoCoi();
      const r = await pool.query(
        `SELECT id, trang_thai, nguon, boi, bat_dau, xong_luc, so_mau, so_tam, so_goi_y, loi
           FROM crm_nhan_dien_runs ORDER BY id DESC LIMIT 1`);
      const x = r.rows[0] || null;
      return res.json({ ok: true, san_sang: thieuBoNhanDien().length === 0,
        viec: x ? { run_id: String(x.id), trang_thai: x.trang_thai, nguon: x.nguon,
          boi: x.boi, bat_dau: x.bat_dau, xong: x.xong_luc,
          so_mau: x.so_mau, so_tam: x.so_tam, so_goi_y: x.so_goi_y, loi: x.loi } : null });
    } catch (e) {
      console.error('[nhan-dien-run] đọc trạng thái:', e.message);
      return res.status(500).json({ ok: false, error: 'loi' });
    }
  });
}

/* ── Tiến trình con ──────────────────────────────────────────────────────────
   `spawn` chứ không `exec`: exec đi qua shell, và mọi thứ đi qua shell là một chỗ
   để một chuỗi lạ thành một câu lệnh. Ở đây không có tham số nào từ người dùng,
   nhưng cái nút này sẽ sống lâu hơn vé này.

   `stdio` là ba ống, KHÔNG 'inherit': ống thì log của việc nằm trong tay mã này
   (đọc số, cắt trần); 'inherit' thì nó trộn thẳng vào log máy chủ và không ai
   tách ra được. stdin đóng hẳn — việc này không hỏi gì ai.

   env thừa hưởng nguyên của máy chủ: batch.js cần DATABASE_URL + MINIO_* và
   chúng vốn đã ở đó. KHÔNG in env ra đâu cả. */
function chay(runId, email) {
  const con = spawn(process.execPath, [BATCH].concat(CO), {
    cwd: THU_MUC, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  VIEC = con;

  let ra = '', loi = '';
  const gom = (o, s) => (o + s).slice(-TRAN_LOG);
  con.stdout.on('data', (d) => { ra = gom(ra, String(d)); });
  con.stderr.on('data', (d) => { loi = gom(loi, String(d)); });

  /* 'error' là hỏng của chính cú sinh (không thấy node, không quyền chạy) — nó
     KHÔNG kèm 'close' có mã lỗi hữu ích, nên phải đóng sổ ở đây. */
  con.on('error', (e) => {
    VIEC = null;
    ketThuc(runId, email, 'loi', null, cauLoi('Không chạy được batch.js: ' + e.message));
  });

  con.on('close', (ma) => {
    VIEC = null;
    if (ma === 0) {
      const so = docSo(ra);
      console.log('[nhan-dien-run] việc ' + runId + ' xong · mẫu ' + so.so_mau
        + ' · tấm ' + so.so_tam + ' · gợi ý ' + so.so_goi_y);
      ketThuc(runId, email, 'xong', so, null);
    } else {
      /* Câu lỗi ưu tiên stderr (batch.js in `LOI <message>` rồi thoát 1); nếu
         stderr rỗng thì ít nhất nói được mã thoát, đừng để ô lỗi trống. */
      const cau = cauLoi(loi) || ('batch.js thoát với mã ' + ma);
      console.error('[nhan-dien-run] việc ' + runId + ' lỗi: ' + cau);
      ketThuc(runId, email, 'loi', docSo(ra), cau);
    }
  });
  return con;
}

async function ketThuc(runId, email, trangThai, so, loi) {
  try {
    await pool.query(
      `UPDATE crm_nhan_dien_runs
          SET trang_thai = $2, xong_luc = now(),
              so_mau = $3, so_tam = $4, so_goi_y = $5, loi = $6
        WHERE id = $1 AND trang_thai = 'chay'`,
      [runId, trangThai, so ? so.so_mau : null, so ? so.so_tam : null,
        so ? so.so_goi_y : null, loi]);
    /* Kết cuộc vào sổ audit (AC-6): «ai bấm, lúc nào, kết cuộc». Chỉ số đếm và
       câu lỗi đã bôi đen — không tên khách, không token, không chuỗi kết nối. */
    await ghiAudit('nhan_dien_dong_bo_ket', email, runId,
      Object.assign({ ket_cuoc: trangThai }, so || {}, loi ? { loi } : {}), null);
  } catch (e) {
    console.error('[nhan-dien-run] đóng sổ việc ' + runId + ' lỗi:', e.message);
  }
}

module.exports = { mount };
