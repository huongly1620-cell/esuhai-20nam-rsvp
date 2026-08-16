'use strict';
/* E08-D077 · API cho màn nhận diện — chỉ `btl`.
   Nguyên tắc xuyên suốt: máy KHÔNG tự gán ai cho ảnh nào (CR-127). Mọi thứ batch
   sinh ra đều ở trạng thái 'cho'; chỉ một cú bấm của người mới đổi được. */
/* pool nằm ở ../db (crm-db chỉ xuất migrateCrm) — đúng như event-photos.js làm.
   Lấy nhầm đường thì `pool` là undefined và MỌI route ở đây ném 500; node --check
   không thấy được vì nó chỉ soi cú pháp. */
const { pool } = require('../db');
const { hashIp } = require('./audit');
const { ipOf } = require('./auth');

/* Tên bảng audit là crm_audit_events và nó có cột ip_hash — kiểm trong guests.js
   chứ không đoán. Ghi sai tên bảng thì mọi lần audit đều ném, và vì nó nằm sau
   khi đã cập nhật xong nên hỏng sẽ hiện ra dưới dạng "bấm Xác nhận báo lỗi 500
   nhưng dữ liệu vẫn đổi" — kiểu lỗi khó lần nhất. */
function ghiAudit(client, req, loai, targetType, targetId, meta){
  return client.query(
    `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [req.actor.email, loai, targetType, String(targetId), JSON.stringify(meta), hashIp(ipOf(req))]);
}

/* ══ E08-D115 · ALBUM ĐẾM THEO TẤM, KHÔNG THEO DÒNG ═════════════════════════
   Một khách có thể mang nhiều DÒNG candidate cho cùng một TẤM (một dòng do máy
   gợi ý theo khuôn mặt, một dòng do người gắn tay). Album là tập ẢNH của khách,
   nên đơn vị đếm phải là `event_photo_id`. Unique mới ở crm-db.js chặn đường đẻ
   ra dòng trùng từ nay; hai hàm dưới đây là vế còn lại — chúng làm con số ĐÚNG
   kể cả trên dữ liệu chưa gộp, để không có một cửa sổ nào mà bất biến chưa kịp
   ra đời còn màn hình thì đã nói sai.

   `khach` là mảnh SQL do CHÍNH mã này truyền vào (`g.id` hoặc `$1`) — không phải
   thứ người dùng gõ. Đừng nối chuỗi từ req vào đây.

   `demCho`: một tấm rơi vào ĐÚNG MỘT ngăn, 'xac-nhan' thắng 'cho'. Nếu không có
   vế NOT EXISTS thì tấm vừa vào album mà vẫn còn một gợi ý 'cho' của khuôn mặt
   thứ hai sẽ được đếm ở cả hai ngăn, và `so_album + so_cho` lại phồng đúng bằng
   cái vé này vừa bịt — chỉ là phồng ở chỗ khác. */
const demAlbum = (khach) => `(SELECT count(DISTINCT c.event_photo_id)::int
       FROM crm_face_candidates c
      WHERE c.guest_id = ${khach} AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan')`;
const demCho = (khach) => `(SELECT count(DISTINCT c.event_photo_id)::int
       FROM crm_face_candidates c
      WHERE c.guest_id = ${khach} AND c.deleted_at IS NULL AND c.trang_thai = 'cho'
        AND NOT EXISTS (SELECT 1 FROM crm_face_candidates a
                         WHERE a.guest_id = c.guest_id AND a.event_photo_id = c.event_photo_id
                           AND a.deleted_at IS NULL AND a.trang_thai = 'xac-nhan'))`;

/* ══ E08-D134 · KHÔNG CÒN CHỦ NGỮ NÀO CHO HẠN 7 NGÀY ═══════════════════════════
   Chỗ này từng là hàm `quetHan()` cùng một nhịp giờ, và lập luận N2 của D077 cho
   nó vẫn đúng trong khuôn của D077: nếu đã quyết xoá vector theo đồng hồ thì chủ
   ngữ chắc chắn nhất là chính tiến trình đang phục vụ, không phải một người nhớ gõ
   lệnh.

   Vé này bỏ chính CÁI QUYẾT ĐỊNH ấy, nên cơ chế thi hành nó không còn nghĩa.
   Sponsor 16/08/2026: giữ cả vector mẫu lẫn vector mặt sự kiện, giữ vĩnh viễn —
   vì khi CRM có avatar hoặc mẫu mới, đội vận hành phải tái tìm được ảnh của khách
   trên toàn bộ kho đã lưu, và việc đó cần vector của những khuôn mặt đã dò.

   ĐÃ GỠ Ở VÉ NÀY, cả bốn đường, không đường nào còn lại nửa vời:
     · hàm quetHan() và hằng NHIP_QUET (chính chỗ này);
     · lượt quét 20 giây sau khi khởi động, và nhịp mỗi giờ (trong mount());
     · bước pre-clean trước mỗi lượt ghi của tools/nhan-dien/batch.js;
     · tệp tools/nhan-dien/don-han.js (xoá hẳn — để lại dạng vô hiệu chỉ là giữ
       câu SQL nguy hiểm trong repo chờ ai đó bỏ dấu chú thích).

   ĐIỀU KHÔNG ĐỔI: mọi đường xoá CÓ CHỦ Ý vẫn nguyên. Gỡ mềm ảnh, gỡ cả đợt, xoá
   cứng ảnh, gỡ mẫu, xoá khách — xem event-photos.js và tuyến gỡ mẫu cuối tệp này.
   Cái bị bỏ là ĐỒNG HỒ, không phải đường xoá. */

function mount(app, requireCrmAuth, requireRole) {
  const btl = [requireCrmAuth, requireRole('btl')];
  /* E08-D128 · ĐỌC ≠ GHI.
     `doc` = phải có phiên OTP thật, nhưng không đòi vai `btl`. Dùng cho ĐÚNG ba
     tuyến mà tab «Theo khách» cần để chạy — danh sách khách, khối theo khách, và
     một khách. Không phải «mọi GET»: `/photos`, `/queue`, `/photo/:id/faces` là
     bộ đồ nghề của người DUYỆT (chúng trả toạ độ mặt, điểm khớp của từng gợi ý
     chưa ai xác nhận), và mở chúng ra là mở đúng thứ FR-5 giữ lại cho `btl`.

     KHÔNG có `requireDoorOrAuth` ở đây, cùng lý do D107 đã ghi cho tuyến album:
     làn `CRM_DOOR_OPEN` là một cánh cửa không tên, mà đây là tên và ảnh người
     thật. Phải là một người đã chứng minh được hộp thư của mình. */
  const doc = [requireCrmAuth];
  /* Vai nào thấy trạng thái nào. `staff` chỉ thấy tấm ĐÃ `xac-nhan` — cùng ranh
     giới mà `tamDaDuyet` (D107) đã gác trên chính các byte ảnh.
     Lọc ở MÁY CHỦ chứ không ở trình duyệt, và lý do không phải an ninh (byte ảnh
     đã có gác rồi) mà là ĐẾM: cả hai tuyến dưới phân trang và đếm ở tầng SQL, nên
     một bộ lọc đặt ở trình duyệt sẽ để lại «Trang 1/3 · 24 tấm» phía trên một lưới
     vẽ 5 ô. Bộ lọc phải đứng cùng chỗ với phép đếm, nếu không hai con số nói hai
     điều khác nhau — đúng bài học D115.
     Trả về một MẢNH SQL hằng, không nối chuỗi từ req: hai giá trị duy nhất, cả hai
     viết cứng tại đây. */
  const trangThaiXem = (req) => (req.actor.role === 'btl'
    ? `('cho','xac-nhan')` : `('xac-nhan')`);
  const chiAlbum = (req) => req.actor.role !== 'btl';

  /* D134 · KHÔNG còn setTimeout lúc khởi động và KHÔNG còn setInterval mỗi giờ.
     Chỗ này cố ý để trống kèm chú thích chứ không im lặng: hai cái hẹn ấy là thứ
     duy nhất từng làm vector biến mất mà không ai bấm gì, nên người đọc sau phải
     thấy chúng đã đi đâu, không phải tự hỏi đã có bao giờ tồn tại chưa. */

  /* ══ D134 · TUYẾN NGHỈ HƯU, GIỮ NGUYÊN CHỖ ĐỨNG ═══════════════════════════
     Route này ở lại thay vì bị xoá, và đó là một quyết định chứ không phải ngại
     dọn. Ba lý do, theo thứ tự sức nặng:

       1 · Nó là một hàng đang sống trong ma trận RBAC. test/d128-otp-staff-anh-
           su-kien.test.js khẳng định tuyến này trả 403 với vai staff. Bỏ tuyến thì
           hàng ấy phải bị xoá và 403 thành 404 — tức vé này làm GIẢM bề mặt RBAC
           đang được đo, đúng lúc AC-11 đòi giữ nguyên phép kiểm no-auth/staff/btl.

       2 · Có một con người được chỉ đích danh sẽ gọi nó. Runbook cũ giao nhiệm vụ
           POST tuyến này sau mỗi lần deploy và thứ Hai hàng tuần. Một cú 404 ở đó
           đọc như "deploy hỏng"; một câu trả lời retired nói đúng sự thật vào đúng
           khoảnh khắc người ta hành động theo thói quen cũ. Runbook đã viết lại,
           nhưng người ta không đọc lại runbook.

       3 · Không có client nào khác. Ngoài route, phép kiểm và runbook thì không
           chỗ nào gọi — giữ nó không nợ ai gì.

     KHÔNG MỘT CÂU SQL NÀO trong thân hàm. Đó là điều kiện của FR-1 ("không ghi
     DB") và nó ĐO ĐƯỢC: phòng thí nghiệm ở test/lab.js gom mọi câu đã gửi, nên
     phép kiểm khẳng định được số câu SQL không tăng sau lượt gọi — mạnh hơn hẳn
     việc chỉ nhìn phản hồi.

     Giữ nguyên hai khoá cũ qua_han_truoc / con_lai = 0: một script cũ đọc
     con_lai === 0 vẫn kết luận "không còn gì quá hạn", và nay câu ấy đúng THEO
     CẤU TẠO chứ không nhờ một lượt quét vừa chạy.
     Trả 200 chứ không 410: 410 làm cú curl của người vận hành trông như sự cố hạ
     tầng, mà việc cần nói là "đã nghỉ, không phải làm gì", không phải báo lỗi.
     Vẫn ...btl: nới quyền cho một tuyến đã vô hiệu là nới không lý do. */
  app.post('/crm/face-match/quet-han', ...btl, (req, res) => {
    res.json({ ok: true, retired: true, ve: 'E08-D134',
      qua_han_truoc: 0, con_lai: 0, da_xoa: 0,
      ghi_chu: 'Hạn 7 ngày đã bỏ (Sponsor 16/08/2026). Tuyến này không còn ghi gì. '
        + 'Vector giữ vĩnh viễn chừng nào bản ghi nguồn còn sống.' });
  });

  /* ══ D134 · PHÉP ĐO KHO VECTOR (FR-6) ═════════════════════════════════════
     Chỉ TRẢ SỐ. Không vector, không object key, không tên tệp, không id khách —
     vector là dữ liệu sinh trắc dù được giữ vĩnh viễn, và một tuyến đo mà lỡ trả
     ra một mẩu của nó thì chính nó là lỗ rò.

     Vì sao cần: sau vé này "kho có đủ vector chưa" trở thành câu hỏi vận hành
     thường trực — trước khi backfill, sau khi backfill, trước khi tái khớp. Không
     có tuyến này thì câu trả lời chỉ lấy được bằng cách gõ SQL thẳng vào prod, mà
     đó là thứ nên hiếm chứ không nên thành thói quen.

     ...btl chứ không ...doc: đây là đồ nghề của người vận hành nhận diện, cùng
     ranh giới với /photos và /queue (D128).

     Hai khối cuối đọc từ sổ audit thay vì một bảng mới. Bảng mới cho một con số
     là một bảng phải trả lời câu hỏi PDPL, phải migrate, phải dọn — mà sổ audit
     đã ghi đúng những lượt ấy rồi. */
  app.get('/crm/face-match/kho-vector', ...btl, async (req, res) => {
    try {
      const mau = (await pool.query(`
        SELECT count(*)::int AS song,
               count(*) FILTER (WHERE s.vec IS NOT NULL)::int AS co_vec,
               count(*) FILTER (WHERE s.vec IS NULL)::int     AS thieu_vec,
               /* Khôi phục được = thiếu vector VÀ nguồn còn sống. Với mẫu cắt tay
                  là tấm sự kiện chưa gỡ; với mẫu từ ảnh chân dung là hàng
                  crm_photos còn tồn tại — khoá ngoại ở đó là ON DELETE SET NULL
                  nên xoá cứng ảnh chân dung để lại mẫu MỒ CÔI, và mẫu mồ côi thì
                  không có gì để dựng lại vector từ đó. */
               count(*) FILTER (WHERE s.vec IS NULL
                                  AND ((s.nguon = 'cat-tay'    AND e.id IS NOT NULL)
                                    OR (s.nguon = 'crm-photos' AND p.id IS NOT NULL)))::int AS khoi_phuc_duoc,
               count(*) FILTER (WHERE s.vec IS NULL
                                  AND NOT ((s.nguon = 'cat-tay'    AND e.id IS NOT NULL)
                                        OR (s.nguon = 'crm-photos' AND p.id IS NOT NULL)))::int AS khong_khoi_phuc_duoc
          FROM crm_face_samples s
          LEFT JOIN crm_event_photos e ON e.id = s.event_photo_id AND e.deleted_at IS NULL
          LEFT JOIN crm_photos       p ON p.id = s.photo_id
         WHERE s.deleted_at IS NULL`)).rows[0];
      const mat = (await pool.query(`
        SELECT count(*)::int AS song,
               count(*) FILTER (WHERE f.vec IS NOT NULL)::int AS co_vec,
               count(*) FILTER (WHERE f.vec IS NULL)::int     AS thieu_vec,
               count(*) FILTER (WHERE f.vec IS NULL AND f.moc IS NOT NULL AND e.id IS NOT NULL)::int AS khoi_phuc_duoc,
               count(*) FILTER (WHERE f.vec IS NULL AND f.moc IS NULL)::int  AS thieu_moc,
               count(*) FILTER (WHERE f.vec IS NULL AND e.id IS NULL)::int   AS thieu_anh
          FROM crm_event_faces f
          LEFT JOIN crm_event_photos e ON e.id = f.event_photo_id AND e.deleted_at IS NULL
         WHERE f.deleted_at IS NULL`)).rows[0];
      /* Lượt backfill và lượt tái khớp gần nhất — cả hai do công cụ ngoài app ghi
         vào sổ audit dưới dạng SỐ ĐẾM. Chưa chạy lần nào thì trả null, không trả
         số 0 giả: "chưa từng chạy" và "chạy xong không khôi phục được gì" là hai
         câu khác nhau, và người vận hành cần phân biệt. */
      const soDo = async (loai) => (await pool.query(
        `SELECT created_at, meta FROM crm_audit_events
          WHERE event_type = $1 ORDER BY id DESC LIMIT 1`, [loai])).rows[0] || null;
      const bf = await soDo('face_vec_backfill');
      const kl = await soDo('face_khop_lai');
      res.json({ ok: true, mau, mat,
        backfill_gan_nhat: bf ? { luc: bf.created_at,
          khoi_phuc: (bf.meta.mat_khoi_phuc || 0) + (bf.meta.mau_khoi_phuc || 0),
          loi: (bf.meta.mat_loi || 0) + (bf.meta.mau_loi || 0),
          bo_qua: (bf.meta.mat_thieu_moc || 0) + (bf.meta.mat_thieu_anh || 0)
                + (bf.meta.mau_mo_coi || 0) } : null,
        khop_lai_gan_nhat: kl ? { luc: kl.created_at,
          goi_y_cho_moi: kl.meta.goi_y_cho_moi || 0 } : null });
    } catch (e){ console.error('[face-match] kho-vector:', e.message);
      res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* Home của ngăn nhận diện = DANH SÁCH KHÁCH, không phải hàng đợi ảnh (FR-4c).
     Hàng đợi là công cụ; danh sách khách mới là thứ người ta đến đây để làm. */
  app.get('/crm/face-match/guests', ...doc, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const args = [];
      let loc = '';
      if (q) { args.push('%' + q + '%');
        loc = `AND (g.full_name ILIKE $1 OR g.org ILIKE $1 OR g.name_jp ILIKE $1 OR g.org_jp ILIKE $1)`; }
      const r = await pool.query(`
        SELECT g.id, g.full_name, g.name_jp, g.org, g.org_jp,
          ${demAlbum('g.id')} AS so_album,
          ${demCho('g.id')} AS so_cho,
          (SELECT count(*)::int FROM crm_face_samples s
             WHERE s.guest_id = g.id AND s.deleted_at IS NULL AND s.vec IS NOT NULL) AS so_mau
        FROM crm_guests g
        WHERE g.deleted_at IS NULL ${loc}
        ORDER BY g.full_name`, args);
      res.json({ ok: true, items: r.rows });
    } catch (e) { console.error('[face-match] guests:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* E08-D102 (CR-159) · LƯỚI ẢNH — home mới của ngăn nhận diện.
     Route `/crm/event-photos` đã liệt kê ảnh rồi, nhưng nó không biết gì về gợi ý
     hay album, mà lưới ở đây sống bằng đúng hai con số ấy: tấm nào máy có ý kiến,
     tấm nào chưa ai gắn tên. Ghép ở trình duyệt thì phải kéo cả 3 479 dòng candidate
     về máy khách chỉ để đếm — nên đếm ở chỗ có dữ liệu. Thêm route mới, KHÔNG đụng
     contract của kho ảnh (AC-8).
     Không trả `vec`, không trả toạ độ mặt: lưới chỉ cần thumb và hai con số. */
  app.get('/crm/face-match/photos', ...btl, async (req, res) => {
    try {
      const limit = Math.min(120, Math.max(1, Number(req.query.limit) || 60));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      /* Ba bộ lọc của FR-H1. Tên gửi lên là tiếng Việt không dấu vì đây là API nội
         bộ của đúng một màn hình; đặt tên máy kiểu `filter=pending` rồi lại dịch
         ngược ở UI chỉ thêm một lớp phải nhớ. */
      const loc = String(req.query.filter || 'tat-ca');
      let dieuKien = '';
      if (loc === 'co-goi-y') {
        dieuKien = `AND EXISTS (SELECT 1 FROM crm_face_candidates c
          WHERE c.event_photo_id = e.id AND c.deleted_at IS NULL AND c.trang_thai = 'cho')`;
      } else if (loc === 'chua-album') {
        /* "Chưa gắn album" = chưa có dòng nào đã xác nhận. Định nghĩa này phải khớp
           đúng chữ hiện trên UI, nếu không người dùng lọc ra một tập không giải
           thích được. */
        dieuKien = `AND NOT EXISTS (SELECT 1 FROM crm_face_candidates c
          WHERE c.event_photo_id = e.id AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan')`;
      }
      const r = await pool.query(`
        SELECT e.id, e.orig_name, e.width, e.height,
          (SELECT count(*)::int FROM crm_face_candidates c
             WHERE c.event_photo_id = e.id AND c.deleted_at IS NULL AND c.trang_thai = 'cho') AS so_cho,
          /* D115 · con số này đứng trên một TẤM nên nó đếm KHÁCH, không đếm ảnh:
             DISTINCT ở đây là guest_id — dán nhầm event_photo_id vào là luôn 1. */
          (SELECT count(DISTINCT c.guest_id)::int FROM crm_face_candidates c
             WHERE c.event_photo_id = e.id AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan') AS so_album,
          (SELECT count(*)::int FROM crm_event_faces f
             WHERE f.event_photo_id = e.id AND f.deleted_at IS NULL) AS so_mat
        FROM crm_event_photos e
        WHERE e.deleted_at IS NULL ${dieuKien}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $1 OFFSET $2`, [limit, offset]);
      const tong = await pool.query(`SELECT count(*)::int n FROM crm_event_photos e
        WHERE e.deleted_at IS NULL ${dieuKien}`);
      res.json({ ok: true, tong: tong.rows[0].n, offset, items: r.rows.map(x => ({
        id: String(x.id), orig_name: x.orig_name, width: x.width, height: x.height,
        so_cho: x.so_cho, so_album: x.so_album, so_mat: x.so_mat,
        thumb_url: '/crm/event-photos/' + x.id + '/thumb',
      })) });
    } catch (e) { console.error('[face-match] photos:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* ══ E08-D103 (CR-160) · KHỐI ẢNH THEO TỪNG KHÁCH ══
     Vì sao phải có route riêng thay vì ghép ở trình duyệt: màn khối hiện nhiều
     khách cùng lúc, ghép từ `album/:id` + `queue?guest_id=` là 2 lượt gọi mỗi
     khách — 20 khách một trang thành 40 lượt, và vẫn không phân trang đúng được
     vì hai nguồn đếm riêng. Một câu hỏi, một câu trả lời.
     KHÔNG trả `vec`, không trả toạ độ mặt: khối chỉ cần thumb + trạng thái. */
  const SAP_XEP_ANH = `CASE c.trang_thai WHEN 'xac-nhan' THEN 0 ELSE 1 END,
                       c.score DESC NULLS LAST, c.id`;
  /* D115 · CÙNG thứ tự ấy, nhưng trên bảng đã gộp một-dòng-một-tấm (bí danh `m`).
     Lưới cũng phải theo TẤM: một tấm mang hai dòng của cùng khách thì bản cũ vẽ
     hai thumb giống hệt nhau cạnh nhau — người duyệt tưởng khách có hai ảnh.
     Gộp bằng DISTINCT ON, và vì SAP_XEP_ANH cho 'xac-nhan' đứng trước nên dòng
     sống lại đúng là dòng đã vào album (khớp luật N2 ở demCho). */
  const SAP_XEP_ANH_M = `CASE m.trang_thai WHEN 'xac-nhan' THEN 0 ELSE 1 END,
                         m.score DESC NULLS LAST, m.candidate_id`;
  const K_MOI_KHOI = 12;                    // trần ảnh mỗi khối trên màn danh sách

  function locKhoi(loc, chi){
    if (loc === 'co-album') return 'AND k.so_album > 0';
    if (loc === 'tat-ca')   return '';
    /* D128 · mặc định của `btl` là «khách đang có gợi ý chờ» (FR-5 của D103) — chỗ
       có việc để làm. `staff` không duyệt gì, và với họ mục ấy là một danh sách
       khách mà mỗi khối đều rỗng. Mặc định của họ là «đã có ảnh trong album». */
    return chi ? 'AND k.so_album > 0' : 'AND k.so_cho > 0';
  }

  app.get('/crm/face-match/khoi', ...doc, async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const q = String(req.query.q || '').trim();
      const args = [limit, offset];
      /* Hai câu dùng chung điều kiện tìm nhưng KHÁC số thứ tự tham số: câu lấy
         trang có $1=limit $2=offset nên chuỗi tìm là $3, còn câu đếm không có hai
         cái đó nên phải là $1. Dùng lại nguyên chuỗi cho cả hai là lỗi «bind
         message supplies 1 parameters» chỉ nổ khi có người gõ vào ô tìm. */
      let tim = '', timDem = '';
      if (q) { args.push('%' + q + '%');
        const dk = (n) => `AND (k.full_name ILIKE $${n} OR k.org ILIKE $${n}`
          + ` OR k.name_jp ILIKE $${n} OR k.org_jp ILIKE $${n})`;
        tim = dk(3); timDem = dk(1); }
      /* `so_mau` đi cùng vì khách KHÔNG có mẫu thì máy không đoán được — khối rỗng
         của họ có nguyên nhân khác hẳn khối rỗng của người đã có mẫu. D077 đã học
         bài này một lần (AC-6 của nó), đừng để màn mới đánh mất lời giải thích. */
      const nen = `
        WITH k AS (
          SELECT g.id, g.full_name, g.name_jp, g.org, g.org_jp,
            ${demAlbum('g.id')} AS so_album,
            ${demCho('g.id')} AS so_cho,
            (SELECT count(*)::int FROM crm_face_samples s
               WHERE s.guest_id = g.id AND s.deleted_at IS NULL AND s.vec IS NOT NULL) AS so_mau
          FROM crm_guests g WHERE g.deleted_at IS NULL
        )`;
      const chi = chiAlbum(req);
      const loc = locKhoi(req.query.loc, chi);
      /* Nhiều gợi ý chờ nhất lên trước (FR-5): người duyệt vào chỗ đông nhất, không
         phải cuộn theo bảng chữ cái để tìm việc.
         D128 · `staff` không có «việc» nào để vào, nên với họ thứ tự là album dày
         trước — xếp theo một con số họ không nhìn thấy thì thứ tự đọc ra ngẫu nhiên. */
      const sapXep = chi
        ? 'ORDER BY k.so_album DESC, k.full_name'
        : 'ORDER BY k.so_cho DESC, k.so_album DESC, k.full_name';
      const r = await pool.query(`${nen}
        SELECT * FROM k WHERE true ${loc} ${tim}
        ${sapXep}
        LIMIT $1 OFFSET $2`, args);
      const tong = await pool.query(`${nen}
        SELECT count(*)::int n FROM k WHERE true ${loc} ${timDem}`, args.slice(2));

      let anhTheoKhach = new Map();
      if (r.rows.length){
        const ids = r.rows.map(x => x.id);
        const a = await pool.query(`
          SELECT * FROM (
            SELECT m.*, row_number() OVER (PARTITION BY m.guest_id ORDER BY ${SAP_XEP_ANH_M}) AS rn
            FROM (
              SELECT DISTINCT ON (c.guest_id, c.event_photo_id)
                     c.guest_id, c.id AS candidate_id, c.event_photo_id, c.trang_thai, c.score
              FROM crm_face_candidates c
              JOIN crm_event_photos e ON e.id = c.event_photo_id AND e.deleted_at IS NULL
              WHERE c.guest_id = ANY($1::bigint[]) AND c.deleted_at IS NULL
                AND c.trang_thai IN ${trangThaiXem(req)}
              ORDER BY c.guest_id, c.event_photo_id, ${SAP_XEP_ANH}
            ) m
          ) t WHERE t.rn <= $2`, [ids, K_MOI_KHOI]);
        a.rows.forEach(x => {
          const g = String(x.guest_id);
          if (!anhTheoKhach.has(g)) anhTheoKhach.set(g, []);
          anhTheoKhach.get(g).push({
            candidate_id: String(x.candidate_id), event_photo_id: String(x.event_photo_id),
            trang_thai: x.trang_thai, score: x.score,
            thumb_url: '/crm/event-photos/' + x.event_photo_id + '/thumb' });
        });
      }
      res.json({ ok: true, tong: tong.rows[0].n, offset, moi_khoi: K_MOI_KHOI,
        items: r.rows.map(x => {
          const anh = anhTheoKhach.get(String(x.id)) || [];
          /* D128 · `staff` không nhận số gợi ý chờ: nó đếm những tấm họ không được
             xem và không quyết được. Zero hoá ở ĐÂY, trước khi `con_lai` dùng tới —
             để đúng một nguồn cho cả con số hiện lên lẫn nhãn «còn N tấm nữa». */
          const soCho = chi ? 0 : x.so_cho;
          return { guest_id: String(x.id), full_name: x.full_name, name_jp: x.name_jp,
            org: x.org, org_jp: x.org_jp, so_album: x.so_album, so_cho: soCho,
            so_mau: x.so_mau, anh,
            /* `con_lai` tính từ tổng thật, không từ độ dài mảng đã cắt — nhãn «còn N
               tấm nữa» phải là N thật, cùng nguyên tắc với nhãn nút xác nhận. */
            con_lai: Math.max(0, (x.so_album + soCho) - anh.length) };
        }) });
    } catch (e) { console.error('[face-match] khoi:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* Màn MỘT khách (FR-4) — chỗ đóng lỗ hổng «124 tấm không có lối vào».
     Phân trang ở tầng máy chủ, vì «đang hiện» của ràng buộc precision được định
     nghĩa là ĐÚNG trang này: nếu trình duyệt tự cắt từ một mảng lớn hơn thì
     «chọn tất cả trên trang» lại phủ thứ người dùng chưa nhìn. */
  app.get('/crm/face-match/khoi/:guestId', ...doc, async (req, res) => {
    try {
      const limit = Math.min(24, Math.max(1, Number(req.query.limit) || 24));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const g = await pool.query(
        `SELECT id, full_name, name_jp, org, org_jp FROM crm_guests
          WHERE id = $1 AND deleted_at IS NULL`, [req.params.guestId]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'không thấy' });
      /* D115 · MỘT nguồn cho cả trang lẫn hai con số: gộp về một dòng mỗi TẤM
         trước, rồi mới phân trang và đếm trên đúng tập ấy. Hai câu đi từ hai
         định nghĩa khác nhau là chuyện đã xảy ra ở màn này rồi — «24 tấm» ở
         nhãn mà lưới chỉ vẽ 23 ô, không ai giải thích được con số nào đúng. */
      const MOT_DONG_MOI_TAM = `
        SELECT DISTINCT ON (c.event_photo_id)
               c.id AS candidate_id, c.event_photo_id, c.trang_thai, c.score
          FROM crm_face_candidates c
          JOIN crm_event_photos e ON e.id = c.event_photo_id AND e.deleted_at IS NULL
         WHERE c.guest_id = $1 AND c.deleted_at IS NULL
           AND c.trang_thai IN ${trangThaiXem(req)}
         ORDER BY c.event_photo_id, ${SAP_XEP_ANH}`;
      const r = await pool.query(`
        SELECT * FROM (${MOT_DONG_MOI_TAM}) m
        ORDER BY ${SAP_XEP_ANH_M}
        LIMIT $2 OFFSET $3`, [req.params.guestId, limit, offset]);
      const d = await pool.query(`
        SELECT count(*) FILTER (WHERE m.trang_thai = 'xac-nhan')::int so_album,
               count(*) FILTER (WHERE m.trang_thai = 'cho')::int so_cho
        FROM (${MOT_DONG_MOI_TAM}) m`, [req.params.guestId]);
      res.json({ ok: true, khach: g.rows[0], offset, limit,
        so_album: d.rows[0].so_album, so_cho: d.rows[0].so_cho,
        tong: d.rows[0].so_album + d.rows[0].so_cho,
        items: r.rows.map(x => ({ candidate_id: String(x.candidate_id),
          event_photo_id: String(x.event_photo_id), trang_thai: x.trang_thai, score: x.score,
          thumb_url: '/crm/event-photos/' + x.event_photo_id + '/thumb' })) });
    } catch (e) { console.error('[face-match] khoi mot khach:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* Duyệt nhiều dòng trong MỘT lượt (D103).
     Ràng buộc precision không nằm ở đây mà ở giao diện — route này không biết
     người dùng đã nhìn tấm nào. Nên nó làm hai việc chống đỡ được ở tầng của mình:
     chặn trần 200, và ghi ĐÚNG MỘT dòng audit kèm đủ danh sách id. Dòng audit ấy
     là thứ duy nhất trả lời được «ai đã duyệt cái gì, lúc nào» khi có người hỏi vì
     sao khách B nhận ảnh khách A. */
  const TRAN_LO = 200;
  const TRANG_THAI_HOP_LE = ['xac-nhan', 'tu-choi', 'bo-qua'];
  app.post('/crm/face-match/quyet-nhieu', ...btl, async (req, res) => {
    const { ids, trang_thai } = req.body || {};
    if (TRANG_THAI_HOP_LE.indexOf(trang_thai) < 0)
      return res.status(400).json({ ok: false, error: 'trạng thái không hợp lệ' });
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ ok: false, error: 'thiếu danh sách' });
    if (ids.length > TRAN_LO)
      return res.status(400).json({ ok: false, error: 'quá ' + TRAN_LO + ' dòng một lượt' });
    const so = ids.map(Number).filter(x => Number.isFinite(x) && x > 0);
    if (so.length !== ids.length)
      return res.status(400).json({ ok: false, error: 'danh sách có phần tử không hợp lệ' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      let dong = [], daDoi = 0, daGop = 0;
      if (trang_thai === 'xac-nhan'){
        /* D115 · một lô có thể chứa hai dòng của CÙNG một (tấm, khách) — hai
           khuôn mặt của một người trong một khung hình, tick cả hai rồi bấm một
           lượt. Bản trước đẻ hai dòng album; nay `xacNhanCoGop` gộp trong chính
           transaction này, nên lô KHÔNG còn ROLLBACK vì đụng unique. */
        const co = await c.query(`SELECT id, guest_id, event_photo_id
          FROM crm_face_candidates WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [so]);
        const kq = await xacNhanCoGop(c, so, req);
        dong = co.rows;
        daGop = kq.gop.length;
        /* «Đã duyệt N» đếm những dòng người ta tick mà nay đã nằm trong album —
           kể cả dòng được gộp vào một dòng có sẵn: tấm ấy vẫn vào album, chỉ là
           không cần thêm một dòng nữa. Đếm cách khác thì nhãn báo ít hơn số ô
           vừa đổi màu trên màn. */
        daDoi = co.rows.filter(x => kq.song.has(String(x.id)) || kq.bo.has(String(x.id))).length;
      } else {
        const r = await c.query(`UPDATE crm_face_candidates
          SET trang_thai = $1, decided_by = $2, decided_at = now()
          WHERE id = ANY($3::bigint[]) AND deleted_at IS NULL
          RETURNING id, guest_id, event_photo_id`, [trang_thai, req.actor.email, so]);
        dong = r.rows; daDoi = r.rowCount;
      }
      await ghiAudit(c, req, 'face_' + trang_thai + '_nhieu', 'face_candidate',
        dong.length ? dong[0].id : 0,
        { so_dong: daDoi, da_gop: daGop, ids: dong.map(x => String(x.id)),
          guest_ids: [...new Set(dong.map(x => String(x.guest_id)))] });
      await c.query('COMMIT');
      res.json({ ok: true, da_doi: daDoi, da_gop: daGop });
    } catch (e) { await c.query('ROLLBACK');
      console.error('[face-match] quyet-nhieu:', e.message);
      res.status(500).json({ ok: false, error: 'loi' }); }
    finally { c.release(); }
  });

  /* Album của một khách = ĐÚNG những dòng đã xác nhận (FR-7 / AC-7).

     E08-D107 · TUYẾN DUY NHẤT của ngăn nhận diện mà `staff` đọc được.
     Sponsor 11/08 10:3x: «nhân viên phụ trách phải có quyền xem ảnh để còn tải
     về gửi cho khách đó». Mặt chính của phụ trách là CỬA (`serveShell` vẫn chặn
     `/crm` ở role staff), nên nếu tuyến này còn `...btl` thì phụ trách không có
     đường nào xem — lấp album chỉ trên CRM là lấp cho BTL xem một mình.

     Ba ranh giới, cố ý:
     · `requireCrmAuth` KHÔNG có `requireDoorOrAuth`: làn `CRM_DOOR_OPEN`/`door@`
       là một cánh cửa không tên, mà đây là dữ liệu người thật. Phải OTP.
     · MỌI khách, không lọc theo phụ trách (Sponsor 10:4x). Người gửi ảnh cho
       khách hôm nay chưa chắc là người đã đón khách ấy hôm qua.
     · Chỉ ĐỌC. Xác nhận / gán / kho / duyệt vẫn `...btl` — xem thêm được một
       thứ không có nghĩa là quyết định thêm được một thứ.

     Audit MỖI lượt đọc (AC-13): mở rộng người đọc thì phải mở rộng cả sổ ghi ai
     đã đọc — «ai đang hoạt động và hoạt động những gì» là điều kiện Sponsor đặt
     ra cùng lúc với việc nới quyền, không phải phần thêm cho đẹp. */
  app.get('/crm/face-match/album/:guestId', requireCrmAuth, async (req, res) => {
    const gid = Number(req.params.guestId);
    if (!Number.isInteger(gid) || gid <= 0) return res.status(400).json({ ok: false, error: 'thiếu id' });
    try {
      /* D115 · MỘT tấm một lần. Đây là tuyến người phụ trách dùng để tải ảnh gửi
         cho khách, nên trả hai dòng của cùng một tấm không chỉ là con số xấu —
         nó là gửi trùng cho người thật. Dòng sống ưu tiên dòng CÓ face_id, cùng
         luật N1 với khối gộp ở crm-db.js: dòng ấy mang khung mặt, tức mang
         `canh_px`/`do_net` mà cột dưới đang đọc. */
      const r = await pool.query(`
        SELECT * FROM (
          SELECT DISTINCT ON (c.event_photo_id)
                 c.id, c.event_photo_id, c.score, c.nguon, c.decided_by, c.decided_at,
                 e.orig_name, f.canh_px, f.do_net
          FROM crm_face_candidates c
          JOIN crm_event_photos e ON e.id = c.event_photo_id AND e.deleted_at IS NULL
          LEFT JOIN crm_event_faces f ON f.id = c.face_id
          WHERE c.guest_id = $1 AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan'
          ORDER BY c.event_photo_id, (c.face_id IS NULL), c.id
        ) a ORDER BY a.decided_at DESC NULLS LAST, a.id DESC`, [gid]);
      /* Ghi sổ TRƯỚC khi trả lời, và `await`: ghi kiểu bắn-rồi-quên thì lượt đọc
         cuối cùng trước khi tiến trình chết là lượt không có trong sổ — mà đó
         đúng là lượt người ta cần tra. Sổ hỏng thì thà 500 còn hơn trả ảnh ra
         mà không ai biết đã trả cho ai. */
      await ghiAudit(pool, req, 'album_xem', 'guest', gid,
        { so_tam: r.rows.length, vai: req.actor.role });
      res.json({ ok: true, items: r.rows });
    } catch (e) { console.error('[face-match] album:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* Hàng đợi gợi ý — LỐI PHỤ. Gom theo ảnh: người duyệt nhìn một khung hình rồi
     quyết cho từng khuôn mặt trong đó, chứ không nhảy giữa các ảnh rời rạc. */
  app.get('/crm/face-match/queue', ...btl, async (req, res) => {
    try {
      const gid = req.query.guest_id ? Number(req.query.guest_id) : null;
      const args = [Math.min(50, Number(req.query.limit) || 20)];
      let loc = '';
      if (gid) { args.push(gid); loc = 'AND c.guest_id = $2'; }
      const anh = await pool.query(`
        SELECT DISTINCT c.event_photo_id, e.orig_name, e.width, e.height
        FROM crm_face_candidates c
        JOIN crm_event_photos e ON e.id = c.event_photo_id AND e.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND c.trang_thai = 'cho' ${loc}
        ORDER BY c.event_photo_id LIMIT $1`, args);
      if (!anh.rows.length) return res.json({ ok: true, items: [] });
      const ids = anh.rows.map(x => x.event_photo_id);
      const goi = await pool.query(`
        SELECT c.id, c.event_photo_id, c.face_id, c.guest_id, c.score, c.sample_id,
               g.full_name, g.name_jp, g.org,
               f.box_x, f.box_y, f.box_w, f.box_h, f.canh_px, f.do_net
        FROM crm_face_candidates c
        JOIN crm_guests g ON g.id = c.guest_id
        LEFT JOIN crm_event_faces f ON f.id = c.face_id
        WHERE c.deleted_at IS NULL AND c.trang_thai = 'cho' AND c.event_photo_id = ANY($1::bigint[])
        ORDER BY c.event_photo_id, c.face_id, c.score DESC`, [ids]);
      const theoAnh = new Map(anh.rows.map(x => [String(x.event_photo_id),
        { ...x, goi_y: [] }]));
      goi.rows.forEach(x => theoAnh.get(String(x.event_photo_id))?.goi_y.push(x));
      res.json({ ok: true, items: [...theoAnh.values()] });
    } catch (e) { console.error('[face-match] queue:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* Mọi ảnh trong một khung — kể cả mặt chưa có gợi ý nào, để gán tay (FR-4b).

     E08-D102 · trả THÊM `goi_y` và `album` của đúng tấm này. Trước D102 màn hình
     lấy gợi ý từ `/queue`, vốn gom theo lô ảnh đang chờ; giờ người dùng mở MỘT tấm
     bất kỳ trong lưới — kể cả tấm không nằm trong hàng đợi — nên phải hỏi được theo
     ảnh. Thêm trường vào phản hồi, không đổi trường cũ: `items` giữ nguyên hình
     dạng, nên đây là thay đổi additive (AC-8). */
  app.get('/crm/face-match/photo/:id/faces', ...btl, async (req, res) => {
    try {
      /* Kích thước ảnh gốc đi kèm ngay đây. Khung mặt vẽ theo tỉ lệ với ảnh gốc,
         nên trang xem BẮT BUỘC có `width`/`height`; để nó tự nhặt từ danh sách lưới
         thì mở ảnh từ album của một khách (không đi qua lưới) sẽ vẽ trượt hết khung
         mà không báo lỗi gì — đúng kiểu hỏng im lặng. */
      const anh = await pool.query(`SELECT id, orig_name, width, height
        FROM crm_event_photos WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
      if (!anh.rows[0]) return res.status(404).json({ ok: false, error: 'không thấy' });
      const r = await pool.query(`SELECT id, box_x, box_y, box_w, box_h, canh_px, do_net, diem_do
        FROM crm_event_faces WHERE event_photo_id = $1 AND deleted_at IS NULL ORDER BY canh_px DESC`,
        [req.params.id]);
      const c = await pool.query(`
        SELECT c.id, c.face_id, c.guest_id, c.score, c.trang_thai, c.nguon,
               g.full_name, g.name_jp, g.org, g.org_jp,
               f.box_x, f.box_y, f.box_w, f.box_h, f.canh_px, f.do_net
        FROM crm_face_candidates c
        JOIN crm_guests g ON g.id = c.guest_id
        LEFT JOIN crm_event_faces f ON f.id = c.face_id
        WHERE c.event_photo_id = $1 AND c.deleted_at IS NULL
          AND c.trang_thai IN ('cho','xac-nhan')
        ORDER BY c.trang_thai, c.score DESC NULLS LAST, c.id`, [req.params.id]);
      res.json({ ok: true,
        anh: { id: String(anh.rows[0].id), orig_name: anh.rows[0].orig_name,
               width: anh.rows[0].width, height: anh.rows[0].height },
        items: r.rows,
        goi_y: c.rows.filter(x => x.trang_thai === 'cho'),
        album: c.rows.filter(x => x.trang_thai === 'xac-nhan') });
    } catch (e) { console.error('[face-match] faces:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* ══ E08-D115 · ĐỔI SANG 'xac-nhan' TỪ NAY PHẢI BIẾT GỘP ═══════════════════
     Trước vé này, xác nhận là một câu UPDATE và không có gì để đụng. Từ khi
     unique (event_photo_id, guest_id) WHERE trang_thai='xac-nhan' ra đời thì
     CHÍNH câu UPDATE ấy có thể va vào một dòng đã nằm sẵn trong album của cùng
     khách trên cùng tấm — và va là 500. Với `quyet-nhieu` còn nặng hơn: cả lô
     200 dòng nằm trong một transaction, một cặp trùng làm ROLLBACK sạch, người
     duyệt bấm «xác nhận cả trang» và không có gì xảy ra cả.

     Nên đường xác nhận phải tự gộp, chứ không phải tự tránh:
       · gom mọi dòng liên quan (dòng được yêu cầu + dòng album đang giữ cùng
         cặp) và KHOÁ chúng — hai người cùng duyệt một tấm là chuyện có thật;
       · mỗi cặp (tấm, khách) chọn MỘT dòng sống theo luật N1 — dòng có face_id,
         hoà thì id nhỏ nhất — y hệt luật của khối gộp trong crm-db.js. Hai chỗ
         lệch luật thì migrate và runtime giữ lại hai dòng khác nhau: không nổ ở
         đâu cả, chỉ âm thầm khác nhau;
       · XOÁ MỀM dòng thua TRƯỚC rồi mới nâng dòng sống. Đảo hai bước này là tự
         đâm vào đúng cái unique vừa dựng, vì trong một khoảnh khắc cả hai dòng
         cùng mang 'xac-nhan'.
     Trả về hai tập id (`song`, `bo`) để tuyến gọi biết dòng người dùng vừa bấm
     đã vào album hay đã được gộp vào một dòng có sẵn. */
  async function xacNhanCoGop(cli, ids, req){
    const r = await cli.query(`
      SELECT c.id, c.event_photo_id, c.guest_id, c.face_id, c.trang_thai
        FROM crm_face_candidates c
       WHERE c.deleted_at IS NULL
         AND (c.id = ANY($1::bigint[])
              OR (c.trang_thai = 'xac-nhan'
                  AND (c.event_photo_id, c.guest_id) IN (
                        SELECT d.event_photo_id, d.guest_id
                          FROM crm_face_candidates d
                         WHERE d.id = ANY($1::bigint[]) AND d.deleted_at IS NULL)))
       ORDER BY c.id
       FOR UPDATE`, [ids]);

    const nhom = new Map();
    for (const x of r.rows){
      const khoa = x.event_photo_id + '|' + x.guest_id;
      if (!nhom.has(khoa)) nhom.set(khoa, []);
      nhom.get(khoa).push(x);
    }
    const song = [], bo = [], gop = [], tamDaCo = new Set();
    for (const dong of nhom.values()){
      /* Tấm này đã nằm trong album của khách ấy TRƯỚC cú bấm chưa? Câu hỏi này
         không trùng với «dòng vừa bấm có thắng không»: người gắn tay tấm P cho
         khách G rồi mới bấm ✓ trên gợi ý máy của đúng tấm ấy thì dòng vừa bấm
         THẮNG (nó mang face_id) — nhưng album không hề có thêm tấm nào. Trả về
         cờ tính theo dòng-vừa-bấm là màn hình cộng thêm 1 cho một tấm đã đếm.
         Đo được ở lab trình duyệt, không suy ra được từ mã. */
      if (dong.some(x => x.trang_thai === 'xac-nhan')) dong.forEach(x => tamDaCo.add(String(x.id)));
      dong.sort((a, b) => (a.face_id ? 0 : 1) - (b.face_id ? 0 : 1) || Number(a.id) - Number(b.id));
      const nhat = dong[0];
      if (nhat.trang_thai !== 'xac-nhan') song.push(nhat.id);
      for (const t of dong.slice(1)){
        bo.push(t.id);
        gop.push({ anh: t.event_photo_id, khach: t.guest_id, id_song: nhat.id, id_bo: t.id });
      }
    }
    if (bo.length){
      await cli.query('UPDATE crm_face_candidates SET deleted_at = now() WHERE id = ANY($1::bigint[])', [bo]);
      for (const g of gop){
        await ghiAudit(cli, req, 'face_gop_doi', 'event_photo', g.anh,
          { ve: 'E08-D115', guest_id: String(g.khach), id_song: String(g.id_song),
            id_bo: String(g.id_bo), nguon: 'xac-nhan' });
      }
    }
    if (song.length){
      await cli.query(`UPDATE crm_face_candidates
        SET trang_thai = 'xac-nhan', decided_by = $1, decided_at = now()
        WHERE id = ANY($2::bigint[]) AND deleted_at IS NULL`, [req.actor.email, song]);
    }
    return { song: new Set(song.map(String)), bo: new Set(bo.map(String)), gop, tamDaCo };
  }

  const quyet = (trangThai) => async (req, res) => {
    const id = Number(req.body && req.body.id);
    if (!id) return res.status(400).json({ ok: false, error: 'thiếu id' });
    /* `tu-choi` / `bo-qua` đưa dòng RA khỏi album nên không đụng bất biến nào —
       giữ nguyên một câu UPDATE, đừng bắt chúng trả giá transaction của D115. */
    if (trangThai !== 'xac-nhan'){
      try {
        const r = await pool.query(`UPDATE crm_face_candidates
          SET trang_thai = $1, decided_by = $2, decided_at = now()
          WHERE id = $3 AND deleted_at IS NULL RETURNING id, guest_id, event_photo_id`,
          [trangThai, req.actor.email, id]);
        if (!r.rowCount) return res.status(404).json({ ok: false, error: 'không thấy' });
        await ghiAudit(pool, req, 'face_' + trangThai, 'face_candidate', id,
          { guest_id: r.rows[0].guest_id, event_photo_id: r.rows[0].event_photo_id });
        return res.json({ ok: true, id });
      } catch (e) { console.error('[face-match] quyet:', e.message);
        return res.status(500).json({ ok: false, error: 'loi' }); }
    }
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const co = await cli.query(`SELECT id, guest_id, event_photo_id FROM crm_face_candidates
        WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!co.rowCount){ await cli.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'không thấy' }); }
      const kq = await xacNhanCoGop(cli, [id], req);
      await ghiAudit(cli, req, 'face_xac-nhan', 'face_candidate', id,
        { guest_id: co.rows[0].guest_id, event_photo_id: co.rows[0].event_photo_id,
          da_gop: kq.gop.length });
      await cli.query('COMMIT');
      /* `da_trong_album` = TẤM ấy đã nằm trong album của khách trước cú bấm này
         (dù qua dòng nào). Màn hình cộng con số album tại chỗ, nên nó cần biết
         album có thật sự dày thêm một tấm hay không — không thì nó lại hiện «2»
         cho một tấm, tức bịt ở máy chủ rồi phá lại ở trình duyệt. */
      res.json({ ok: true, id, da_gop: kq.gop.length, da_trong_album: kq.tamDaCo.has(String(id)) });
    } catch (e) { await cli.query('ROLLBACK').catch(() => {});
      console.error('[face-match] quyet:', e.message);
      res.status(500).json({ ok: false, error: 'loi' }); }
    finally { cli.release(); }
  };
  app.post('/crm/face-match/confirm', ...btl, quyet('xac-nhan'));
  app.post('/crm/face-match/reject',  ...btl, quyet('tu-choi'));
  app.post('/crm/face-match/skip',    ...btl, quyet('bo-qua'));

  /* Gán tay (FR-4b): máy không đoán hoặc đoán sai thì người vẫn đưa được ảnh vào
     album. Ghi thẳng trạng thái đã xác nhận — người vừa quyết định xong rồi. */
  app.post('/crm/face-match/assign', ...btl, async (req, res) => {
    try {
      const { event_photo_id, guest_id, face_id } = req.body || {};
      if (!event_photo_id || !guest_id) return res.status(400).json({ ok: false, error: 'thiếu ảnh hoặc khách' });
      /* Q6 · ON CONFLICT DO NOTHING rồi vẫn trả ok:true là nói dối: đã có gợi ý
         máy 'cho' cùng (face_id, guest_id) thì không ghi gì, ảnh KHÔNG vào album,
         mà giao diện báo xong. Người gán tay đang RA QUYẾT ĐỊNH — nếu đã có dòng
         thì nâng nó lên đã-xác-nhận, chứ không im lặng bỏ qua. */
      const r = await pool.query(`INSERT INTO crm_face_candidates
        (event_photo_id, face_id, guest_id, score, nguon, trang_thai, decided_by, decided_at)
        VALUES ($1,$2,$3,NULL,'tay','xac-nhan',$4,now())
        ON CONFLICT DO NOTHING RETURNING id`,
        [event_photo_id, face_id || null, guest_id, req.actor.email]);
      let daCo = false;
      if (!r.rowCount){
        const nang = await pool.query(`UPDATE crm_face_candidates
          SET trang_thai = 'xac-nhan', decided_by = $1, decided_at = now()
          WHERE event_photo_id = $2 AND guest_id = $3 AND deleted_at IS NULL
            AND (face_id IS NOT DISTINCT FROM $4) AND trang_thai <> 'xac-nhan'
          RETURNING id`, [req.actor.email, event_photo_id, guest_id, face_id || null]);
        daCo = true;
        if (!nang.rowCount){
          /* Không chèn được, cũng không có gì để nâng ⇒ ảnh này đã nằm trong
             album khách đó rồi. Nói đúng như vậy thay vì báo "đã thêm". */
          return res.json({ ok: true, id: null, da_trong_album: true });
        }
      }
      await ghiAudit(pool, req, 'face_assign_tay', 'event_photo', event_photo_id, { guest_id, face_id: face_id || null });
      res.json({ ok: true, id: r.rows[0] ? r.rows[0].id : null, nang_tu_goi_y: daCo });
    } catch (e) { console.error('[face-match] assign:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* FR-10 · BTL khoanh mặt trên ảnh sự kiện → thành ảnh mẫu cho khách chưa có mẫu.
     Trang chỉ ghi KHUNG; vector do batch tính, vì engine không nằm trong app này. */
  app.post('/crm/face-match/sample', ...btl, async (req, res) => {
    try {
      const { event_photo_id, guest_id, box } = req.body || {};
      if (!event_photo_id || !guest_id || !box) return res.status(400).json({ ok: false, error: 'thiếu dữ liệu' });
      const r = await pool.query(`INSERT INTO crm_face_samples
        (guest_id, nguon, event_photo_id, box_x, box_y, box_w, box_h, created_by)
        VALUES ($1,'cat-tay',$2,$3,$4,$5,$6,$7) RETURNING id`,
        [guest_id, event_photo_id, box.x, box.y, box.w, box.h, req.actor.email]);
      await ghiAudit(pool, req, 'face_sample_cat_tay', 'face_sample', r.rows[0].id, { guest_id, event_photo_id, box });
      res.json({ ok: true, id: r.rows[0].id, cho_tinh: true });
    } catch (e) { console.error('[face-match] sample:', e.message); res.status(500).json({ ok: false, error: 'loi' }); }
  });

  /* AC-10 · gỡ mẫu khoanh tay. Các khớp sinh ra từ nó KHÔNG im lặng biến mất —
     chúng quay về 'cho' để người xem lại. Ảnh đã nằm trong album đã đánh dấu gửi
     thì không rút lại được, nên trả về số đó để giao diện cảnh báo.

     E08-D134 · GỠ MẪU NAY XOÁ LUÔN VECTOR CỦA MẪU ẤY.
     Trước vé này câu dưới chỉ đặt deleted_at, nên một mẫu đã gỡ vẫn ôm nguyên
     vector sinh trắc trong Postgres — chỉ là không ai đọc tới vì mọi câu đọc đều
     lọc deleted_at IS NULL. "Không ai đọc" không phải là "đã xoá".

     Chuyện ấy sống được suốt D077 vì lúc đó bảng còn có một cái đồng hồ phía sau.
     Vé này bỏ đồng hồ đi, nên nếu để nguyên thì "giữ vĩnh viễn" sẽ được đọc thành
     lời biện hộ cho đúng lớp dữ liệu lẽ ra phải biến mất — và spec cấm thẳng điều
     đó: không được mở rộng giữ vĩnh viễn thành giữ vector của hàng đã gỡ.

     Cùng khuôn với cascade gỡ ảnh ở event-photos.js: xoá vec, ghi LÚC xoá, để sự
     vắng mặt CHỨNG MINH được chứ không chỉ quan sát thấy trống. vec_xoa_luc và
     vec đặt cùng một câu nên ràng buộc ck_face_samples_vec_xoa luôn đúng ở mọi
     thời điểm quan sát được.
     Hệ quả kèm theo, có chủ ý: tinhMauKhoanhTay() của batch lọc
     vec IS NULL AND vec_xoa_luc IS NULL, nên mẫu đã gỡ KHÔNG bị lượt batch kế
     tiếp tính lại vector — đúng bài học N1 mà D077 đã ghi. Tool khôi phục vector
     của D134 cũng bỏ qua hàng deleted_at vì cùng lý do. */
  app.delete('/crm/face-match/sample/:id', ...btl, async (req, res) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const s = await c.query(`UPDATE crm_face_samples
        SET deleted_at = now(), vec = NULL, vec_xoa_luc = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING guest_id`, [req.params.id]);
      if (!s.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'không thấy' }); }
      const veCho = await c.query(`UPDATE crm_face_candidates
        SET trang_thai = 'cho', decided_by = NULL, decided_at = NULL
        WHERE sample_id = $1 AND deleted_at IS NULL AND trang_thai <> 'cho'
        RETURNING id, guest_id`, [req.params.id]);
      const daGui = await c.query(`SELECT count(*)::int n FROM crm_interactions i
        WHERE i.guest_id = $1 AND i.kind = 'Hình ảnh cảm ơn'`, [s.rows[0].guest_id]);
      await ghiAudit(c, req, 'face_sample_go', 'face_sample', req.params.id,
        { ve_cho: veCho.rowCount, guest_id: s.rows[0].guest_id });
      await c.query('COMMIT');
      res.json({ ok: true, ve_cho: veCho.rowCount, da_danh_dau_gui: daGui.rows[0].n });
    } catch (e) { await c.query('ROLLBACK'); console.error('[face-match] go sample:', e.message);
      res.status(500).json({ ok: false, error: 'loi' }); }
    finally { c.release(); }
  });
}
module.exports = { mount };
