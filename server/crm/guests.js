'use strict';

const { pool } = require('../db');
const { logAudit, hashIp } = require('./audit');
const { ipOf, phoneUnlocked } = require('./auth');
// E08-D031: một luật trạng thái tham dự dùng chung cho list · detail · stats.
const att = require('./attendance');

// E08-D038 §3c/§3d — bảng ánh xạ nhãn → tag, TƯỜNG MINH. Bảy tag đầu do R1 đo
// thật trên prod 06/08 (394 thẻ còn sống); `pl:nhan-vien` là nhãn mới của vé này,
// hiện 0 thẻ. Sửa bảng này là việc có Gate, không phải việc gõ thêm một dòng.
const PL_NHAN = [
  ['PTGĐ', 'pl:ptgd'],                       // 145 thẻ
  ['TGĐ', 'pl:tgd'],                         // 101
  ['Đối tác / Khách hàng', 'pl:doi-tac-khach-hang'], // 23
  ['OB Esuhai', 'pl:ob'],                    // 22  ⚠️ KHÔNG phải slug("OB Esuhai")
  ['Người hợp tác', 'pl:nguoi-hop-tac'],     // 20
  ['Cơ quan công quyền', 'pl:co-quan-cong-quyen'], // 6
  ['HR', 'pl:hr'],                           // 4
  ['Nhân viên', 'pl:nhan-vien'],             // 0 — nhãn mới, chính tả chốt đúng một dạng
];
const PL_TAGS = PL_NHAN.map((x) => x[1]);

function normPhone(p) { return String(p || '').replace(/\D/g, ''); }
function clean(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v)); }

// staff may update these; never id/response_id/deleted_at/guest_ext_id.
const PATCH_WHITELIST = ['full_name', 'phone', 'email', 'org', 'title', 'note', 'tags'];

// E08-D042 §3a — DANH SÁCH TRƯỜNG RIÊNG CHO `btl`, KHÔNG nâng cả tuyến PATCH lên
// `btl`. Nâng cả tuyến là chặn luôn PG sửa ghi chú/SĐT — hồi quy một năng lực
// đang chạy (M1). Hai cột này là SƠ ĐỒ CHỖ NGỒI của lễ nên chỉ BTL ghi được.
//
// E08-D054 — thêm ba trường TIẾNG NHẬT vào ĐÂY, dứt khoát KHÔNG vào
// PATCH_WHITELIST.
//
// ⚠️ SỬA LẠI LÝ DO (commit 12): bản đầu R1 viết «CRM_DOOR_SIGNUP=1 đang bật ⇒ ai
// có link cửa là thành staff» — SAI, vì `doorSignup()` (auth.js) đòi
// `!doorOpen() && CRM_DOOR_SIGNUP==='1'`. Prod đang `CRM_DOOR_OPEN=1` nên
// self-signup ĐANG TẮT (đúng M6/CR-61: cửa mở thì signup tắt). R1 dẫn một tiền
// đề mà không grep — cùng lớp lỗi với `ttKey` và `not_yet`.
//
// LÝ DO ĐÚNG, vẫn dẫn tới cùng kết luận: PATCH_WHITELIST mở cho MỌI `staff`, và
// tập `staff` KHÔNG cố định theo thời gian — chỉ cần ai đó tắt `CRM_DOOR_OPEN`
// (đóng cửa sau lễ, hoặc gạt nhầm) là signup bật lại và tài khoản mọc tự do.
// Ba trường này HIỆN LÊN MÀN CỬA, nên quyền sửa chúng phải buộc vào VAI (`btl`,
// 5 tài khoản), không buộc vào một cần gạt môi trường có thể đổi sau lưng.
// Đặt ở đây thì đúng 5 tài khoản BTL, và chị Ly đã nằm trong đó (đo prod: cả 5
// tài khoản đều `btl` — yêu cầu «nâng quyền cho chị Ly» hoá ra không phải việc
// phải làm, thứ chặn chị là danh sách này cộng form thiếu ô).
//
// Ba trường này HIỆN LÊN MÀN CỬA qua pairVJ() — sai một chữ Kanji thì hôm nay
// không có đường nào sửa: không qua CRM, không qua file cập nhật D032
// (import-update.js chỉ UPDATE org·title·table_no·seat_no·att_override), chỉ nạp
// được bằng script chạy tay import-vnjb.js.
const PATCH_BTL_ONLY = ['table_no', 'seat_no', 'name_jp', 'title_jp', 'org_jp'];

function mount(app, requireCrmAuth, requireRole, requireDoorOrAuth) {
  // E08-D041 — nếu chưa nối làn cửa thì rơi về gác cổng cũ: quên wire là
  // FAIL-CLOSED (cửa đòi auth), không phải fail-open.
  var doorAuth = requireDoorOrAuth || requireCrmAuth;
  // ---- search (staff sees all; ?mine=1 filters to actor's assignments) ----
  // Session tags written by the D018 importer (Wave A uses tags, not a schema
  // column — see E08-D020). Only these two are filterable; anything else 400s.
  const SESSION_TAGS = { 'toa-dam': 'toa-dam', gala: 'gala' };
  // Buổi khai trên form nằm ở `rsvp_submissions.sessions` — **free text** người
  // dùng gõ trên form công khai (rsvp.js không whitelist). Sau E08-D028 chuỗi
  // này QUYẾT ĐỊNH ai lên /checkin-gala.html, nên phải khớp có BIÊN TỪ:
  // '%ala%' cũ khớp cả "Salad" và "Balalaika".
  // Một hằng dùng chung cho ?session= và cho field du_* — không viết hai bản.
  // E08-D031 chuyển sang `attendance.js` để `/crm/stats` dùng ĐÚNG chuỗi này,
  // thay vì mỗi file giữ một bản chép tay rồi lệch nhau lúc nào không ai biết.
  const SESSION_RE = att.SESSION_RE;

  app.get('/crm/guests', doorAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const mine = String(req.query.mine || '') === '1';
    const session = String(req.query.session || '').trim();
    if (session && !SESSION_TAGS[session]) return res.status(400).json({ ok: false, error: 'session không hợp lệ (toa-dam|gala).' });
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 50));
    try {
      const params = []; const conds = ['g.deleted_at IS NULL'];
      let join = '';
      if (q) {
        params.push('%' + q + '%');
        conds.push(`(g.full_name ILIKE $${params.length} OR g.phone_norm ILIKE $${params.length} OR g.org ILIKE $${params.length})`);
      }
      if (session) {
        // MỘT SoT (E08-D028 AC-A): buổi = tag danh sách ∪ buổi khai trên form,
        // đúng luật KPI /crm/stats đang dùng.
        //
        // Trước đây chỉ lọc theo tag. Nhưng D026 gỡ tag buổi khỏi khách đã có
        // bản đăng ký (D016 luật 5 — ba nhóm phải rời nhau, buổi của họ đọc từ
        // form), nên bộ lọc này giấu mất họ: đo trên prod Gala 303 trong khi
        // thực tế 350 — 47 khách đã đăng ký KHÔNG hiện ở trang check-in, PG tra
        // không ra và màn không có dấu hiệu gì.
        params.push('%,' + SESSION_TAGS[session] + ',%');
        const tagIdx = params.length;
        params.push(SESSION_RE[session]);
        const formIdx = params.length;
        conds.push(`(
          (',' || COALESCE(g.tags,'') || ',') ILIKE $${tagIdx}
          OR (g.response_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM rsvp_submissions s
                WHERE s.id = g.response_id AND s.sessions ~* $${formIdx}))
        )`);
      }
      if (mine) {
        params.push(req.actor.email);
        join = `JOIN crm_assignments a ON a.guest_id = g.id AND a.staff_email = $${params.length}`;
      }
      // E08-D047: khoá join check-in theo buổi cửa (trước LIMIT).
      let ciSessIdx = null;
      if (session) {
        params.push(session);
        ciSessIdx = params.length;
      }
      params.push(limit);
      const limitIdx = params.length;
      const r = await pool.query(
        // du_toa_dam / du_gala: buổi HIỆU LỰC của khách = tag danh sách ∪ buổi
        // khai trên form. Trả sẵn từ máy chủ để tab, ?session= và KPI dùng CHUNG
        // một luật — trước đây client tự đếm tag nên nói 303 trong khi KPI nói
        // 350, và 47 khách đã đăng ký biến mất khỏi tab Gala.
        `SELECT g.id, g.guest_ext_id, g.full_name, g.phone, g.org, g.title, g.table_no, g.seat_no, g.tags, g.note,
                g.name_jp, g.title_jp, g.org_jp,
                ((',' || COALESCE(g.tags,'') || ',') ILIKE '%,toa-dam,%'
                 OR (g.response_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM rsvp_submissions s WHERE s.id = g.response_id
                         AND s.sessions ~* '${SESSION_RE['toa-dam']}'))) AS du_toa_dam,
                ((',' || COALESCE(g.tags,'') || ',') ILIKE '%,gala,%'
                 OR (g.response_id IS NOT NULL AND EXISTS (
                       SELECT 1 FROM rsvp_submissions s WHERE s.id = g.response_id
                         AND s.sessions ~* '${SESSION_RE.gala}'))) AS du_gala,
                ${att.attSql('g', att.duSql('g', 'g.response_id', "'" + SESSION_RE['toa-dam'] + "'", "'" + SESSION_RE.gala + "'"))} AS att_status,
                (g.response_id IS NOT NULL) AS from_rsvp,
                /* E08-D047: checked_in theo BUỔI khi ?session=; không session thì
                   «đã đến» = có check-in bất kỳ buổi (CRM tổng). */
                (ci.guest_id IS NOT NULL) AS checked_in, ci.checked_in_at, ci.actor_email AS checked_in_by,
                EXISTS(SELECT 1 FROM crm_check_ins x WHERE x.guest_id = g.id AND x.session = 'toa-dam') AS checked_in_toa,
                EXISTS(SELECT 1 FROM crm_check_ins x WHERE x.guest_id = g.id AND x.session = 'gala') AS checked_in_gala,
                -- E08-D029 AC-2: danh sách trỏ BẢN THU NHỎ, không phải file gốc.
                -- Route /thumb tự lùi về gốc khi thẻ chưa có bản dẫn xuất, nên
                -- không màn nào mất ảnh trong lúc backfill đang chạy dở.
                CASE WHEN p.id IS NULL THEN NULL ELSE '/crm/photos/' || p.id || '/thumb' END AS photo_url,
                -- AC-3b: bản vừa (1024px) cho khối hồ sơ; khung .pf-av là 190px
                -- CSS ≈ 570px thiết bị, dùng thumb 256px sẽ mờ.
                CASE WHEN p.id IS NULL THEN NULL ELSE '/crm/photos/' || p.id || '/preview' END AS photo_view_url
         FROM crm_guests g
         ${join}
         /* Có ?session= → một dòng CI đúng buổi. Không session (CRM) → LATERAL
            LIMIT 1 kẻo khách check-in cả hai buổi bị nhân đôi hàng danh sách. */
         ${ciSessIdx
           ? `LEFT JOIN crm_check_ins ci ON ci.guest_id = g.id AND ci.session = $${ciSessIdx}`
           : `LEFT JOIN LATERAL (
                SELECT guest_id, checked_in_at, actor_email
                  FROM crm_check_ins
                 WHERE guest_id = g.id
                 ORDER BY checked_in_at DESC LIMIT 1
              ) ci ON TRUE`}
         LEFT JOIN LATERAL (
           -- AC-G4: ảnh có interaction_id là ảnh QUÀ chụp tại quầy, không phải
           -- chân dung khách. Không loại ra thì tấm quà chụp sau cùng sẽ thành
           -- avatar của khách trên mọi danh sách. 202 ảnh cũ đều NULL nên điều
           -- kiện này không đổi gì với dữ liệu đang có.
           -- E08-D040: COALESCE cắt ngắn ⇒ thẻ ĐÃ GHIM không chạy câu con thứ hai.
           -- Đo trên prod: nhánh ghim là Index Scan khoá chính (2 buffers, 0,048 ms)
           -- so với nhánh lùi 5 buffers / 0,104 ms ⇒ sau backfill màn danh sách RẺ
           -- HƠN hôm nay. Nhánh lùi giữ NGUYÊN VĂN câu đang chạy ⇒ kế hoạch truy vấn
           -- không đổi, vẫn dùng idx_crm_photos_guest (guest_id, created_at DESC).
           SELECT COALESCE(
             -- M2 + M3 kiểm ngay trong nhánh ghim: ảnh quà hoặc ảnh của khách khác
             -- thì ra NULL ⇒ TỰ LÙI về tấm chân dung mới nhất, không bao giờ hiện
             -- nhầm mặt. PATCH vẫn chặn ở đầu vào — đây là lớp cuối.
             (SELECT ap.id FROM crm_photos ap
               WHERE ap.id = g.avatar_photo_id AND ap.guest_id = g.id AND ap.interaction_id IS NULL),
             (SELECT ph.id FROM crm_photos ph
               WHERE ph.guest_id = g.id AND ph.interaction_id IS NULL
               ORDER BY ph.created_at DESC LIMIT 1)
           ) AS id
         ) p ON TRUE
         ${'WHERE ' + conds.join(' AND ')}
         ORDER BY g.full_name ASC LIMIT $${limitIdx}`, params);
      /* E08-D041 M2 — SĐT bị GỠ KHỎI PHẢN HỒI khi chưa mở khoá. Che ở giao diện
         là thất bại: mở tab Network là thấy số đủ trong JSON. Gỡ ở TẦNG NÀY thì
         mọi màn — hai cửa, v2, classic, cả làn smoke — cùng không có số, không
         phải nhớ vá từng chỗ và không sót chỗ nào. */
      const moKhoaSdt = phoneUnlocked(req);
      if (!moKhoaSdt) r.rows.forEach((x) => { x.phone = null; });
      // M1 (E08-D032): `guest_ext_id` là KHOÁ để file xuất nhập ngược khớp
      // đúng người. Trước đây API không trả nó nên bản xuất rơi về `g.id` nội
      // bộ ⇒ nhập lại khớp 0/344, INSERT 344 khách trùng. Chỉ lộ cho `btl` —
      // 2 cửa (role staff) không cần và không nên thấy khoá nội bộ.
      if (!req.actor || req.actor.role !== 'btl') r.rows.forEach((x) => { delete x.guest_ext_id; });
      return res.json({ ok: true, rows: r.rows });
    } catch (err) {
      console.error('[crm-guests] search failed:', err.message);
      return res.status(500).json({ ok: false, error: 'search error' });
    }
  });

  // ---- guest detail ----
  app.get('/crm/guests/:id', doorAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      // du_toa_dam / du_gala phải có ở ĐÂY nữa, không chỉ ở list. Hồ sơ khách
      // đọc từ endpoint này; thiếu hai field thì `buoiOf()` ra "—" cho MỌI
      // khách — nặng hơn cả trạng thái trước vé. Dùng chung SESSION_RE.
      const g = await pool.query(
        `SELECT *,
           ((',' || COALESCE(tags,'') || ',') ILIKE '%,toa-dam,%'
            OR (response_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM rsvp_submissions s WHERE s.id = crm_guests.response_id
                    AND s.sessions ~* $2))) AS du_toa_dam,
           ((',' || COALESCE(tags,'') || ',') ILIKE '%,gala,%'
            OR (response_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM rsvp_submissions s WHERE s.id = crm_guests.response_id
                    AND s.sessions ~* $3))) AS du_gala,
           ${att.attSql('', att.duSql('', 'crm_guests.response_id', '$2', '$3'))} AS att_status
         FROM crm_guests WHERE id = $1 AND deleted_at IS NULL`,
        [id, SESSION_RE['toa-dam'], SESSION_RE.gala]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      const ci = await pool.query(
        'SELECT session, actor_email, checked_in_at, note FROM crm_check_ins WHERE guest_id = $1 ORDER BY checked_in_at DESC',
        [id]);
      const asg = await pool.query('SELECT staff_email, assigned_at FROM crm_assignments WHERE guest_id = $1', [id]);
      /* E08-D057 — `, id DESC` là TIE-BREAK. HAI lý do, và cả hai đều KHÔNG phải
         lý do R1 nêu lần đầu (xem phần «chỗ đã sai» cuối chú thích).

         ① Thứ tự TOÀN PHẦN rẻ hơn lập luận về xác suất. Không có tie-break thì
            tính đúng đắn của D056 phải tựa vào một tiền đề: «không yêu cầu nào
            ghi hai dòng cùng `kind`». Tiền đề đó đúng hôm nay — và đúng là loại
            tiền đề mà một vé sau vô tình phá, trong khi không ai còn nhớ là mình
            từng dựa vào nó.

         ② Ca trùng mốc BẢO ĐẢM thì CÓ THẬT, chỉ ở chỗ khác. `created_at` mặc
            định `now()`, mà `now()` ĐÓNG BĂNG theo transaction — đo prod: gọi
            hai lần cách 200 ms trong cùng giao dịch ra y hệt một giá trị, trong
            khi `clock_timestamp()` đã nhảy. Một lượt «Lưu ghi nhận» ở cửa đẩy
            `qua-tang` + `ghi-chu-quay` trong MỘT `items[]`, một transaction ⇒
            hai dòng đó mang y hệt một `created_at` ⇒ `histHtml` ĐẢO THỨ TỰ giữa
            hai vòng poll. Đó là AC-10 của D056, và nó chỉ ổn định sau dòng này.

         CHỖ R1 ĐÃ SAI — ghi lại để người sau không lặp: trạng thái tick của D056
         KHÔNG chạm ca bảo đảm ở ②. Không đường nào ghi hai dòng `qua-dap-le`
         trong một yêu cầu: `saveQuay` ở cửa sau D056 đẩy ZERO dòng loại đó,
         classic `recSave` gọi BA `jsend` riêng (ba transaction, ba mốc giờ —
         không phải một `items[]`), nút tick mỗi lần ghi một dòng. Hai dòng
         `quadaple` trùng mốc đòi HAI YÊU CẦU rơi cùng micro-giây: hiếm, không
         phải bảo đảm. Vá vẫn đáng — nhưng vì ① và ②, không vì lý do đã nêu sai.

         `id` là bigserial nên khớp đúng thứ tự chèn ⇒ thứ tự thành toàn phần.
         KHÔNG thêm `FOR UPDATE`: thiết kế append-only, không có đọc-rồi-ghi nào
         để tuần tự hoá; thêm khoá là đổi một bất định vô hại lấy một điểm tranh
         chấp thật ở cửa lúc đông. */
      const inter = await pool.query('SELECT id, actor_email, kind, body, created_at FROM crm_interactions WHERE guest_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [id]);
      const photos = await pool.query('SELECT id, object_key, content_type, uploaded_by, created_at, interaction_id FROM crm_photos WHERE guest_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
      const row = g.rows[0];
      /* E08-D058 §4b — `can_undo` do MÁY CHỦ tính, client CHỈ VẼ THEO CỜ. Cửa
         không được vẽ một nút chắc chắn ăn 403 — đó đúng lớp báo-xanh-giả ba vé
         gần nhất phải chữa. Cùng một luật với hàng rào ở tuyến DELETE; lệch hai
         chỗ là vẽ nút rồi từ chối, hoặc giấu nút của người có quyền.
         ADDITIVE: thêm một trường vào từng dòng, không đổi trường nào đang có,
         nên 4 màn đang đọc `checkIns[]` không vỡ. */
      const coTheHuy = (r) => !!(req.actor && (req.actor.role === 'btl'
        || (r.actor_email && r.actor_email === req.actor.email)));
      ci.rows.forEach((r) => { r.can_undo = coTheHuy(r); });

      return res.json({
        ok: true,
        guest: {
          id: row.id, full_name: row.full_name, phone: (phoneUnlocked(req) ? row.phone : null), email: row.email,
          org: row.org, title: row.title, note: row.note, tags: row.tags,
          table_no: row.table_no, seat_no: row.seat_no || null,
          response_id: row.response_id, created_at: row.created_at,
          du_toa_dam: row.du_toa_dam, du_gala: row.du_gala,
          name_jp: row.name_jp, title_jp: row.title_jp, org_jp: row.org_jp,
          att_status: row.att_status,
          att_override: row.att_override || null,
          att_override_by: row.att_override_by || null,
          att_override_at: row.att_override_at || null,
          // E08-D040 — màn cần biết tấm nào ĐANG ghim: để chọn đúng ảnh hồ sơ và
          // để đánh dấu nút «Đặt làm ảnh đại diện». Truy vấn hồ sơ dùng SELECT *
          // nên cột mới tự có, không phải sửa danh sách cột.
          avatar_photo_id: row.avatar_photo_id || null,
        },
        /* E08-D047: checkIns[] theo buổi; checkIn = bản mới nhất (tương thích màn cũ). */
        checkIns: ci.rows,
        checkIn: ci.rows[0] || null,
        assignments: asg.rows,
        interactions: inter.rows,
        // interaction_id: ảnh nào là ảnh QUÀ (gắn vào một ghi nhận tại quầy),
        // ảnh nào là chân dung khách. Màn cửa lấy avatar = tấm ĐẦU TIÊN có
        // interaction_id rỗng, khớp đúng luật của list ở trên.
        // url = gốc (giữ nguyên cho thư viện ảnh / tải về) · view_url = bản 1024
        // cho khối hồ sơ · thumb_url = 256 cho dải ảnh nhỏ.
        photos: photos.rows.map((p) => ({ id: p.id, url: '/crm/photos/' + p.id,
          view_url: '/crm/photos/' + p.id + '/preview', thumb_url: '/crm/photos/' + p.id + '/thumb',
          content_type: p.content_type, uploaded_by: p.uploaded_by, created_at: p.created_at, interaction_id: p.interaction_id })),
      });
    } catch (err) {
      console.error('[crm-guests] detail failed:', err.message);
      return res.status(500).json({ ok: false, error: 'detail error' });
    }
  });

  // ---- create (btl) ----
  app.post('/crm/guests', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const b = req.body || {};
    const name = clean(b.full_name);
    if (!name) return res.status(400).json({ ok: false, error: 'Thiếu họ tên.' });
    const phone = clean(b.phone);
    try {
      // E08-D032 — khách thêm tay PHẢI có guest_ext_id. Thiếu một thẻ là nút
      // «Xuất để CẬP NHẬT» chặn TOÀN BỘ danh sách (thẻ 437, 05/08), và thẻ đó
      // cũng không đi qua được vòng xuất-sửa-nhập. Khoá lấy từ chính id nên
      // duy nhất theo cấu tạo — không đụng va chạm như khoá băm từ tên.
      const cli = await pool.connect();
      let id;
      try {
        await cli.query('BEGIN');
        // E08-D042 §3a — tuyến này ĐÃ requireRole('btl') nên thêm hai cột vào
        // INSERT là đủ, không cần lớp chặn thứ hai. Trước vé này ô nhập ở form có
        // cũng vô nghĩa: máy chủ không đọc, khách mới luôn ra đời không có bàn.
        const r = await cli.query(
          `INSERT INTO crm_guests (full_name, phone, phone_norm, email, org, title, note, tags, table_no, seat_no)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [name, phone || null, phone ? normPhone(phone) : null, clean(b.email) || null,
           clean(b.org) || null, clean(b.title) || null, clean(b.note) || null, clean(b.tags) || null,
           clean(b.table_no) || null, clean(b.seat_no) || null]
        );
        id = r.rows[0].id;
        await cli.query('UPDATE crm_guests SET guest_ext_id = $1 WHERE id = $2', ['tay-' + id, id]);
        await cli.query('COMMIT');
      } catch (e) { await cli.query('ROLLBACK').catch(() => {}); cli.release(); throw e; }
      cli.release();
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'guest_create', target_type: 'guest', target_id: id, ip: ipOf(req) });
      return res.status(201).json({ ok: true, id: String(id) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ ok: false, error: 'Số điện thoại đã tồn tại.' });
      console.error('[crm-guests] create failed:', err.message);
      return res.status(500).json({ ok: false, error: 'create error' });
    }
  });

  // ---- patch (staff+, field whitelist) ----
  app.patch('/crm/guests/:id', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const b = req.body || {};

    /* E08-D042 §3a + M2 — CHẶN Ở ĐÂY, trước MỌI thứ khác.
       Từ đầu thân tuyến (parseInt id · đọc req.body) đến dòng này KHÔNG có một
       lời gọi pool.query/client.query nào, và logAudit nằm mãi phía dưới. Nên
       `return 403` tại điểm này là 0 CÂU SQL — chứng minh được bằng mắt, không
       phải bằng niềm tin (AC-3). Ghi một nửa rồi mới chặn là thứ M2 cấm. */
    const btlFields = PATCH_BTL_ONLY.filter((f) => Object.prototype.hasOwnProperty.call(b, f));
    if (btlFields.length && (!req.actor || req.actor.role !== 'btl')) {
      return res.status(403).json({ ok: false, error: 'Chỉ ban tổ chức mới sửa được Bàn / Ghế.' });
    }

    const sets = []; const params = []; const changed = {};
    for (const f of PATCH_WHITELIST.concat(btlFields)) {
      if (Object.prototype.hasOwnProperty.call(b, f)) {
        /* §3b + M3 — `clean(...) || null` biến "" thành NULL, tức Ô TRỐNG = XOÁ.
           Với table_no/seat_no đó là CỐ Ý và KHÁC luật COALESCE của D032 (§3b):
           ở đây là form MỘT khách, Ly NHÌN THẤY giá trị cũ điền sẵn nên xoá text
           là chủ ý; còn D032 là file 344 dòng, ô trống ở đó nghĩa «đừng đụng».
           Hai luật khác nhau trên cùng một cột là có chủ đích — ĐỪNG «đồng bộ
           hoá» chúng cho gọn. Lớp popup ở màn không đủ (gọi API trực tiếp vẫn
           xoá được) nên audit §3c bên dưới là thứ bắt buộc. */
        params.push(clean(b[f]) || null); sets.push(`${f} = $${params.length}`); changed[f] = true;
        if (f === 'phone') { params.push(clean(b[f]) ? normPhone(b[f]) : null); sets.push(`phone_norm = $${params.length}`); }
      }
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Không có trường hợp lệ để cập nhật.' });
    sets.push('updated_at = now()');
    params.push(id);

    /* §3c — audit phải chép GIÁ TRỊ CŨ → MỚI, không chỉ tên trường. Mất số bàn
       mà nhật ký chỉ ghi «đã sửa table_no» thì không có cách truy lại ai đổi từ
       gì sang gì. Chỉ nhánh CÓ bàn/ghế mới mở giao dịch + đọc thêm một câu:
       lượt PATCH thường (PG sửa ghi chú/SĐT) giữ NGUYÊN hình dạng và chi phí cũ. */
    if (btlFields.length) {
      /* `pool.connect()` phải nằm TRONG try. Để nó ngoài thì một nhịp chớp của
         CSDL (Railway restart / rớt mạng) làm nó ném NGAY tại đây: Express 4
         KHÔNG bắt promise bị reject của route handler, repo không có
         process.on('unhandledRejection') ⇒ Node 20+ biến nó thành
         uncaughtException và GIẾT CẢ TIẾN TRÌNH — hai cửa mất check-in cho tới
         khi Railway dựng lại. Cùng khuôn `let client` + `finally release` mà
         tuyến attendance đang dùng; và `finally` là chỗ trả kết nối DUY NHẤT,
         không rải release() ở từng nhánh return (bài học D016 B10). */
      let client;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        const cu = (await client.query(
          'SELECT table_no, seat_no FROM crm_guests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
        if (!cu) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'not found' }); }
        const r = await client.query(
          `UPDATE crm_guests SET ${sets.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL RETURNING table_no, seat_no`, params);
        if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'not found' }); }
        const meta = { fields: Object.keys(changed) };
        if (changed.table_no) meta.ban = { cu: cu.table_no, moi: r.rows[0].table_no };
        if (changed.seat_no) meta.ghe = { cu: cu.seat_no, moi: r.rows[0].seat_no };
        /* KHÔNG dùng logAudit() ở đây, dù đang truyền `client`. logAudit bọc
           try/catch và chỉ console.error — mà TRONG một giao dịch, câu INSERT
           hỏng đã đẩy giao dịch vào trạng thái aborted, và `COMMIT` trên giao
           dịch aborted KHÔNG ném lỗi: Postgres lặng lẽ ROLLBACK rồi trả về như
           thường. Kết quả sẽ là: màn báo «Đã lưu ✓», audit không có, và bàn ghế
           KHÔNG hề đổi — đúng lớp báo-xanh-giả mà cả D028 CỬA-2 lẫn D036 §3g
           sinh ra để chặn. Ghi thẳng ⇒ lỗi ném ra ⇒ catch bên dưới ROLLBACK và
           trả 500 thật. */
        await client.query(
          `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
           VALUES ($1,'guest_update','guest',$2,$3::jsonb,$4)`,
          [req.actor.email, String(id), JSON.stringify(meta), hashIp(ipOf(req))]);
        await client.query('COMMIT');
        return res.json({ ok: true, table_no: r.rows[0].table_no, seat_no: r.rows[0].seat_no });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return res.status(409).json({ ok: false, error: 'Số điện thoại đã tồn tại.' });
        console.error('[crm-guests] patch (btl) failed:', err.message);
        return res.status(500).json({ ok: false, error: 'update error' });
      } finally {
        if (client) client.release();
      }
    }

    try {
      const r = await pool.query(`UPDATE crm_guests SET ${sets.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL RETURNING id`, params);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'guest_update', target_type: 'guest', target_id: id, meta: { fields: Object.keys(changed) }, ip: ipOf(req) });
      return res.json({ ok: true });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ ok: false, error: 'Số điện thoại đã tồn tại.' });
      console.error('[crm-guests] patch failed:', err.message);
      return res.status(500).json({ ok: false, error: 'update error' });
    }
  });

  // ---- soft delete (btl) ----
  app.delete('/crm/guests/:id', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const r = await pool.query('UPDATE crm_guests SET deleted_at = now(), phone_norm = NULL WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'guest_delete', target_type: 'guest', target_id: id, ip: ipOf(req) });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[crm-guests] delete failed:', err.message);
      return res.status(500).json({ ok: false, error: 'delete error' });
    }
  });

  // ---- check-in THEO BUỔI (E08-D047) — một khách có thể có 2 dòng (toa-dam + gala)
  app.post('/crm/guests/:id/check-in', doorAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const sess = String((req.body && req.body.session) || req.query.session || '').trim();
    if (!SESSION_TAGS[sess]) {
      return res.status(400).json({ ok: false, error: 'Cần session=toa-dam|gala (check-in theo buổi).' });
    }
    try {
      const exists = await pool.query(
        'SELECT actor_email, checked_in_at FROM crm_check_ins WHERE guest_id = $1 AND session = $2',
        [id, sess]);
      if (exists.rows[0]) {
        return res.status(200).json({
          ok: true, already: true, session: sess,
          by: exists.rows[0].actor_email, at: exists.rows[0].checked_in_at,
        });
      }
      const g = await pool.query('SELECT id, tags FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      /* E08-D038 mảnh 5 — nhân viên KHÔNG check-in (Sponsor chốt). Chặn ở ĐÂY chứ
         không chỉ ẩn nút: tuyến này nằm trong allowlist cửa của D041 nên chạy được
         KHÔNG cần đăng nhập — ai mở sẵn hồ sơ, hoặc một vòng poll cũ, vẫn bắn được
         lệnh. Lấy cột tags ngay trong câu đang có, không thêm truy vấn thứ hai.
         Tách token đúng dấu phẩy, không indexOf — indexOf khớp luôn biến thể dài.
         Câu từ chối phải ĐỌC ĐƯỢC ở cửa: PG lúc đông không tra mã lỗi được. */
      const tg = String(g.rows[0].tags || '').split(',').map((x) => x.trim());
      if (tg.indexOf('pl:nhan-vien') > -1) {
        return res.status(409).json({ ok: false, laNhanVien: true, error: 'Nhân viên không cần check-in.' });
      }
      const ins = await pool.query(
        `INSERT INTO crm_check_ins (guest_id, session, actor_email, note) VALUES ($1,$2,$3,$4)
         ON CONFLICT (guest_id, session) DO NOTHING RETURNING checked_in_at`,
        [id, sess, req.actor.email, clean(req.body && req.body.note) || null]);
      if (!ins.rows[0]) {
        const e2 = await pool.query(
          'SELECT actor_email, checked_in_at FROM crm_check_ins WHERE guest_id = $1 AND session = $2',
          [id, sess]);
        return res.status(200).json({
          ok: true, already: true, session: sess,
          by: e2.rows[0].actor_email, at: e2.rows[0].checked_in_at,
        });
      }
      await logAudit(pool, {
        actor_email: req.actor.email, event_type: 'check_in', target_type: 'guest', target_id: id,
        meta: { session: sess }, ip: ipOf(req),
      });
      return res.status(201).json({ ok: true, already: false, session: sess, at: ins.rows[0].checked_in_at });
    } catch (err) {
      console.error('[crm-guests] check-in failed:', err.message);
      return res.status(500).json({ ok: false, error: 'check-in error' });
    }
  });

  // ---- ghim ảnh đại diện (btl) — E08-D040 ----
  // Quyền đổi avatar nằm ở CRM, KHÔNG ở cửa: ở cửa lúc đông rất dễ bấm nhầm, mà
  // avatar là thứ chị Ly chuẩn bị trước. Cửa chỉ chụp và xem.
  app.patch("/crm/guests/:id/avatar", requireCrmAuth, requireRole("btl"), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: "bad id" });
    const raw = req.body && req.body.photo_id;
    // photo_id = null ⇒ BỎ ghim, avatar lùi về tấm mới nhất. Giữ đường lùi để còn
    // sửa được khi ghim nhầm.
    const pid = (raw === null || raw === "" || raw === undefined) ? null : parseInt(raw, 10);
    if (pid !== null && !pid) return res.status(400).json({ ok: false, error: "bad photo_id" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cu = (await client.query("SELECT avatar_photo_id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id])).rows[0];
      if (!cu) { await client.query("ROLLBACK"); client.release(); return res.status(404).json({ ok: false, error: "not found" }); }
      if (pid !== null) {
        const ph = (await client.query("SELECT id, guest_id, interaction_id FROM crm_photos WHERE id = $1", [pid])).rows[0];
        if (!ph) { await client.query("ROLLBACK"); client.release(); return res.status(404).json({ ok: false, error: "Không thấy ảnh." }); }
        // M3 — ảnh phải thuộc ĐÚNG khách này, nếu không thì ghim được mặt người
        // khác lên thẻ. M2 — ảnh quà (có interaction_id) không làm avatar được.
        if (String(ph.guest_id) !== String(id)) { await client.query("ROLLBACK"); client.release(); return res.status(400).json({ ok: false, error: "Ảnh này không thuộc khách đó." }); }
        if (ph.interaction_id) { await client.query("ROLLBACK"); client.release(); return res.status(400).json({ ok: false, error: "Ảnh quà không dùng làm ảnh đại diện được." }); }
      }
      await client.query("UPDATE crm_guests SET avatar_photo_id = $1, updated_at = now() WHERE id = $2", [pid, id]);
      await logAudit(client, { actor_email: req.actor.email, event_type: "avatar_set", target_type: "guest", target_id: id,
        meta: { cu: cu.avatar_photo_id || null, moi: pid }, ip: ipOf(req) });
      await client.query("COMMIT");
      client.release();
      return res.json({ ok: true, avatar_photo_id: pid });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      console.error("[crm-guests] avatar set failed:", err.message);
      return res.status(500).json({ ok: false, error: "avatar error" });
    }
  });

  // ---- danh sách nhãn Phân loại (đọc) — E08-D038 ----
  // Màn KHÔNG chép lại bảng nhãn: v2 là tệp tĩnh, không require được, nên nó
  // ĐỌC từ đây. Một nguồn duy nhất ⇒ sửa bảng là cả máy chủ lẫn màn cùng đổi,
  // không có cảnh hai bên lệch nhau như bốn bản ttKey của D043 (phải dựng phép
  // kiểm băm mới yên tâm).
  app.get('/crm/phanloai/nhan', requireCrmAuth, (req, res) =>
    res.json({ ok: true, nhan: PL_NHAN.map((x) => ({ ten: x[0], tag: x[1] })) }));

  // ---- đổi PHÂN LOẠI khách (btl) — E08-D038 §3a Đường C ----
  //
  // §3b MÌN — vì sao KHÔNG dùng PATCH /crm/guests/:id sẵn có: nó ghi ĐÈ NGUYÊN
  // CHUỖI `tags` (tags = $n, không merge). Gửi "pl:nhan-vien" là thẻ đó mất sạch
  // `gala` · `vnjb-*` · `kcode:K0xx` · `tgd116` · tag hạng. Hậu quả KHÔNG hiện ra
  // ngay: mất `gala` ⇒ du_gala false ⇒ khách BIẾN MẤT khỏi cửa Gala. Ly đổi phân
  // loại xong màn vẫn xanh, tối 08/08 mới biết người đó không tra được ở cửa.
  //
  // Nên: đọc tags hiện có → thay ĐÚNG token pl:* → ghi lại cả chuỗi, trong CÙNG
  // giao dịch có FOR UPDATE. Merge ở MÁY CHỦ chứ không ở trình duyệt: ngày lễ
  // nhiều người dùng chung, hai tab cùng lưu sẽ ghi đè nhau nếu merge phía client.
  //
  // §3c BẪY — bảng ánh xạ TƯỜNG MINH, tuyệt đối không slug() nhãn tại chỗ:
  // `pl:ob` (22 thẻ) do vnjb-keys.js gắn tay, slug("OB Esuhai") ra `pl:ob-esuhai`
  // ⇒ chọn nhãn đó là 22 thẻ rời khỏi nhóm OB, nút lọc OB ở cửa rỗng đúng ngày lễ.
  // Bảy dòng đầu là tag R1 ĐO THẬT trên prod 06/08 (394 thẻ), không phải suy ra.
  app.patch('/crm/guests/:id/phanloai', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const tag = req.body && req.body.tag === null ? null : String((req.body && req.body.tag) || '');
    if (tag !== null && tag !== '' && PL_TAGS.indexOf(tag) < 0) {
      return res.status(400).json({ ok: false, error: 'Nhãn phân loại không hợp lệ.' });
    }
    const moi = (tag === null || tag === '') ? null : tag;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const g = (await client.query('SELECT tags FROM crm_guests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!g) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'not found' }); }
      const cu = String(g.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
      const giu = cu.filter((x) => x.slice(0, 3).toLowerCase() !== 'pl:');
      const cuPl = cu.filter((x) => x.slice(0, 3).toLowerCase() === 'pl:');
      if (moi) giu.push(moi);
      const chuoi = giu.join(',');
      await client.query('UPDATE crm_guests SET tags = $1, updated_at = now() WHERE id = $2', [chuoi || null, id]);
      await logAudit(client, { actor_email: req.actor.email, event_type: 'phanloai_set', target_type: 'guest', target_id: id,
        meta: { cu: cuPl, moi, soTagGiuLai: giu.length - (moi ? 1 : 0) }, ip: ipOf(req) });
      await client.query('COMMIT');
      client.release();
      return res.json({ ok: true, tags: chuoi, phanloai: moi });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      console.error('[crm-guests] phanloai failed:', err.message);
      return res.status(500).json({ ok: false, error: 'phanloai error' });
    }
  });

  // ---- đổi BUỔI của khách (btl) — E08-D063 ----
  //
  // §a VÌ SAO TUYẾN RIÊNG, không nhét field vào PATCH /crm/guests/:id: cùng mìn
  // D038 §3b — tuyến đó ghi ĐÈ nguyên chuỗi `tags` (tags = $n, không merge). Gộp
  // vào đấy là mỗi lần Ly sửa Buổi thì `vip` · `kcode:K0xx` · `pl:*` · `vnjb-*`
  // bay sạch. Merge ở MÁY CHỦ, trong một giao dịch có FOR UPDATE, chứ không ở
  // trình duyệt: tối 08/08 nhiều người dùng chung, hai tab cùng lưu sẽ đè nhau.
  //
  // §b GIỚI HẠN ĐÃ ĐO — ĐỌC TRƯỚC KHI «SỬA»:
  // Buổi HIỆU LỰC = tag ∪ buổi khai trên FORM (`att.duSql`, có từ D026; lọc theo
  // tag không thôi đã từng giấu 47 khách khỏi trang check-in — xem :92). Gỡ token
  // ở ĐÂY KHÔNG hạ được vế FORM. Đo prod 08/08: 414 thẻ sống · 48 thẻ có
  // `response_id`, trong đó **48 form khai Gala** và **7 form khai Tọa đàm** ⇒ với
  // đúng ngần ấy thẻ, thao tác «tắt» là VÔ HIỆU trên màn.
  //
  // Nên tuyến này ĐỌC LẠI buổi hiệu lực SAU KHI GHI và trả kèm `canh_bao`. Màn vẽ
  // theo số máy chủ trả, KHÔNG theo cái người dùng vừa bấm. Bỏ bước đó thì Ly bỏ
  // tick Gala → tick tắt → refresh thấy bật lại: đúng lớp báo-xanh-giả mà D028
  // CỬA-2 / D036 §3g / D049 sinh ra để chặn.
  //
  // Muốn TẮT THẬT (kể cả khi form khai) phải đổi luật ở BỐN chỗ SQL độc lập:
  // `att.duSql` · du_* ở list (:127) · du_* ở hồ sơ (:212) · và bộ lọc `?session=`
  // (:97) — chỗ cuối quyết định khách có hiện ở CỬA hay không. Sửa sót một chỗ là
  // hồ sơ nói «không Gala» mà cửa vẫn tra ra. Đó là phương án PC, Sponsor HOLD
  // sang sau lễ. Đừng làm nửa vời ngay tại đây.
  app.patch('/crm/guests/:id/buoi', requireCrmAuth, requireRole('btl'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const b = req.body || {};

    /* Chặn TRƯỚC mọi SQL. Bắt boolean THẬT chứ không ép kiểu: `"false"` và `0`
       ép ra kết quả khác nhau tuỳ chỗ viết, và một màn gửi nhầm kiểu sẽ TẮT buổi
       của khách mà không ai thấy. Thiếu field cũng chặn — vắng mặt KHÔNG phải là
       «giữ nguyên»: thân đủ hai field là hợp đồng của tuyến này, đoán hộ ở đây là
       tự chế một luật thứ hai. */
    const laBool = (v) => v === true || v === false;
    if (!laBool(b.toa_dam) || !laBool(b.gala)) {
      return res.status(400).json({ ok: false, error: 'Cần {toa_dam, gala} kiểu boolean.' });
    }
    const muon = { 'toa-dam': b.toa_dam, gala: b.gala };

    let client;
    try {
      /* `pool.connect()` TRONG try. Ngoài try thì lời hứa bị từ chối không ai
         bắt, Express 4 không thấy, Node 24 giết tiến trình — cùng vá D058 :655.
         Đây là mìn ① của phiếu D063. */
      client = await pool.connect();
      await client.query('BEGIN');

      const g0 = (await client.query(
        'SELECT tags, response_id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [id])).rows[0];
      if (!g0) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'not found' }); }

      /* Nhận diện token phải RỘNG BẰNG cách SQL đếm, kẻo gỡ hụt: SQL so
         `ILIKE '%,gala,%'` — không phân biệt hoa thường — nên một token `Gala`
         cũng được đếm là BẬT. Vậy khi tắt phải bỏ MỌI biến thể hoa/thường; bỏ
         sót một cái là màn báo đã tắt mà cửa vẫn tra ra khách.
         Ghi lại luôn ở dạng chữ thường chuẩn, không có khoảng trắng — vì cùng
         phép ILIKE đó đòi đúng `,gala,`: một token `, gala` (có dấu cách) sẽ
         KHÔNG được đếm là bật, tức là bật mà như tắt. */
      const cu = String(g0.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
      const laBuoi = (x) => x.toLowerCase() === 'toa-dam' || x.toLowerCase() === 'gala';
      const truocTag = {
        'toa-dam': cu.some((x) => x.toLowerCase() === 'toa-dam'),
        gala: cu.some((x) => x.toLowerCase() === 'gala'),
      };
      // Mọi token KHÁC giữ nguyên và giữ đúng thứ tự cũ — AC-3.
      const giu = cu.filter((x) => !laBuoi(x));
      if (muon['toa-dam']) giu.push('toa-dam');
      if (muon.gala) giu.push('gala');
      const chuoi = giu.join(',');

      await client.query('UPDATE crm_guests SET tags = $1, updated_at = now() WHERE id = $2',
        [chuoi || null, id]);

      /* Buổi hiệu lực đọc lại TRONG cùng giao dịch, bằng CHÍNH `att.duSql` mà
         list · hồ sơ · KPI · cửa đang dùng. Không chép luật ra bản thứ năm: bản
         chép là thứ lệch dần rồi không ai biết màn nào đang nói thật. */
      const du = att.duSql('', 'crm_guests.response_id', '$2', '$3');
      const g1 = (await client.query(
        `SELECT tags, ${du.td} AS du_toa_dam, ${du.ga} AS du_gala
           FROM crm_guests WHERE id = $1`,
        [id, SESSION_RE['toa-dam'], SESSION_RE.gala])).rows[0];

      const hieuLuc = { 'toa-dam': !!g1.du_toa_dam, gala: !!g1.du_gala };
      // Xin TẮT mà vẫn BẬT ⇒ form đang ghim. Đây đúng là thứ màn phải nói ra.
      const ghim = ['toa-dam', 'gala'].filter((k) => !muon[k] && hieuLuc[k]);

      /* Audit ghi THẲNG, KHÔNG qua `logAudit`: hàm đó nuốt lỗi có chủ đích
         (audit.js:18 «Never let audit failure break the main action»). Trong một
         giao dịch, nuốt lỗi lật ngược thành: audit hỏng ⇒ giao dịch đã abort ⇒
         `COMMIT` trên giao dịch abort âm thầm hoá ROLLBACK và KHÔNG NÉM ⇒ tuyến
         trả ok:true trong khi tag không đổi. Cùng lập luận D036 §3g · D040 M8 ·
         D049 M2. Đây là mìn ② của phiếu D063. */
      await client.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'buoi_set','guest',$2,$3::jsonb,$4)`,
        [req.actor.email, String(id),
          JSON.stringify({
            cu_toa: truocTag['toa-dam'], cu_gala: truocTag.gala,
            moi_toa: muon['toa-dam'], moi_gala: muon.gala,
            hieu_luc_toa: hieuLuc['toa-dam'], hieu_luc_gala: hieuLuc.gala,
            tags_truoc: g0.tags || null, tags_sau: chuoi || null,
            response_id: g0.response_id, form_ghim: ghim,
          }), hashIp(ipOf(req))]);

      await client.query('COMMIT');
      return res.json({
        ok: true,
        tags: g1.tags,
        du_toa_dam: hieuLuc['toa-dam'],
        du_gala: hieuLuc.gala,
        // null = làm được đúng như bấm. Khác null = màn phải nói vì sao còn bật.
        canh_bao: ghim.length ? { buoi: ghim, response_id: g0.response_id } : null,
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[crm-guests] buoi failed:', err.message);
      // Không lấy được kết nối ⇒ chưa ghi gì ⇒ 503 «thử lại», không phải 500.
      if (!client) return res.status(503).json({ ok: false, error: 'Máy chủ đang bận — CHƯA lưu được, thử lại.' });
      return res.status(500).json({ ok: false, error: 'buoi error' });
    } finally {
      if (client) client.release();
    }
  });

  // ---- huỷ check-in (btl) — E08-D036 ----
  // Bảng có `guest_id UNIQUE` nên huỷ = XOÁ DÒNG, không có cột đánh dấu. Sponsor
  // chốt hướng xoá thật vì `crm_check_ins` bị ĐỌC ở 5 chỗ (stats · list · hồ sơ ·
  // hai chỗ trong tuyến check-in); đánh dấu huỷ thì cả 5 phải thêm bộ lọc, sót
  // một chỗ là khách đã huỷ vẫn hiện ✓ hoặc KPI lệch danh sách. Xoá dòng thì cả
  // 5 chỗ tự đúng, không sửa câu đọc nào.
  //
  // Cái giá của xoá thật: giờ đến gốc mất vĩnh viễn ⇒ AC-7 bắt audit phải là bản
  // sao ĐỦ để dựng lại. Nên ở đây KHÔNG dùng logAudit(): hàm đó nuốt lỗi có chủ
  // đích (audit.js: "Never let audit failure break the main action") — đúng với
  // mọi tuyến khác, nhưng ở tuyến này nó lật ngược thành: ghi audit hỏng mà
  // DELETE vẫn commit ⇒ mất dữ liệu vĩnh viễn, IM LẶNG. Ghi thẳng bằng
  // client.query trong cùng giao dịch để lỗi ném ra ngoài và cuốn DELETE theo
  // (AC-16).
  /* E08-D058 — HẠ GUARD từ `requireCrmAuth + requireRole('btl')` xuống `doorAuth`.
     ĐÂY LÀ ĐẢO QUYẾT ĐỊNH D041 §3c, không phải bù chỗ sót: D041 cố ý gỡ nút huỷ
     khỏi cửa vì «cửa nay mở nên không để thao tác XOÁ DÒNG sau một URL». Sponsor
     chốt lại 06/08 22:4x, phạm vi «PG huỷ được dòng do chính mình ghi».

     ⚠️ RANH GIỚI «CHÍNH MÌNH» HẸP HƠN TÊN GỌI — đã đo, đừng ngạc nhiên rồi vá
     nhầm chỗ: `requireDoorOrAuth` có HAI danh tính; không đăng nhập mà cửa mở thì
     mọi người dùng chung `door@checkin.local` (auth.js:156). Prod 06/08 đã có 2/4
     dòng check-in mang email đó ⇒ tối 08/08 «của chính mình» xấp xỉ «của cửa».
     Phần còn cắn thật: dòng do NGƯỜI CÓ ĐĂNG NHẬP ghi thì phiên cửa KHÔNG huỷ
     được. Muốn cắn hơn thì bắt PG đăng nhập — quyết định VẬN HÀNH, ngoài vé này. */
  app.delete('/crm/guests/:id/check-in', doorAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    // E08-D047: huỷ đúng một buổi. Thiếu session mà khách có 2 dòng → 400 (không xoá cả hai im lặng).
    const sess = String((req.body && req.body.session) || req.query.session || '').trim();

    /* E08-D058 (vá) — `pool.connect()` phải nằm TRONG try, và chỉ CHỖ NÀY thôi.
       Dòng này có từ D036, không phải mã của vé D058. Nhưng D058 vừa hạ guard
       tuyến này xuống `doorAuth`, nên nó thành THỂ HIỆN DUY NHẤT của khuôn cũ mà
       một phiên CHƯA ĐĂNG NHẬP cũng chạm được — hai tuyến còn lại (`avatar`,
       `phanloai`) vẫn `btl`-only, đúng 5 tài khoản.

       Vì sao chết người: express 4.22.2 KHÔNG bắt promise bị reject của route
       handler, và cả `server/` không có `process.on('unhandledRejection')`
       (grep = 0) ⇒ Node 24 biến nó thành uncaughtException và GIẾT CẢ TIẾN
       TRÌNH. CSDL chớp một nhịp đúng lúc ai đó bấm huỷ ⇒ HAI CỬA NGỪNG CHECK-IN
       tới khi Railway dựng lại. Mà đây là nút «bấm nhầm» của đêm 08/08: lúc tải
       cao nhất, cũng là lúc Railway dễ restart nhất.

       CỐ Ý KHÔNG đổi sang khuôn `let client + finally release` của tuyến PATCH
       (:783), dù khuôn đó đúng kiểu dáng hơn: route này có SÁU lời gọi
       `client.release()` rải ở từng nhánh `return`, và nó vừa qua 21 phép thử.
       Gỡ cả sáu, 33 giờ trước lễ, là đổi một rủi ro ĐÃ ĐO lấy một rủi ro CHƯA
       ĐO. Bọc riêng một dòng thì bề mặt thay đổi bằng đúng một dòng. */
    let client;
    try {
      client = await pool.connect();
    } catch (e) {
      console.error('[crm-guests] check-in undo: không lấy được kết nối:', e.message);
      return res.status(503).json({ ok: false, error: 'Máy chủ đang bận — CHƯA huỷ được, thử lại.' });
    }

    try {
      await client.query('BEGIN');
      let cur;
      if (sess) {
        if (!SESSION_TAGS[sess]) {
          await client.query('ROLLBACK'); client.release();
          return res.status(400).json({ ok: false, error: 'session không hợp lệ (toa-dam|gala).' });
        }
        cur = await client.query(
          `SELECT ci.actor_email, ci.checked_in_at, ci.note, ci.session, g.full_name
             FROM crm_check_ins ci JOIN crm_guests g ON g.id = ci.guest_id
            WHERE ci.guest_id = $1 AND ci.session = $2 FOR UPDATE OF ci`, [id, sess]);
      } else {
        cur = await client.query(
          `SELECT ci.actor_email, ci.checked_in_at, ci.note, ci.session, g.full_name
             FROM crm_check_ins ci JOIN crm_guests g ON g.id = ci.guest_id
            WHERE ci.guest_id = $1 FOR UPDATE OF ci`, [id]);
        if (cur.rows.length > 1) {
          await client.query('ROLLBACK'); client.release();
          return res.status(400).json({
            ok: false,
            error: 'Khách đã check-in cả hai buổi — gửi session=toa-dam|gala để huỷ đúng buổi.',
            sessions: cur.rows.map((r) => r.session),
          });
        }
      }
      if (!cur.rows[0]) {
        await client.query('COMMIT');
        client.release();
        return res.status(200).json({ ok: true, already: false });
      }
      const c0 = cur.rows[0];

      /* §4a — HÀNG RÀO dựng lại BÊN TRONG, thay cho guard vừa hạ. Đặt SAU khi đã
         đọc `cur` (cần biết ai ghi dòng đó) nhưng TRƯỚC audit và TRƯỚC DELETE ⇒
         từ chối là ROLLBACK, 0 dòng bị xoá, 0 dòng audit rác. */
      const laBtl = !!(req.actor && req.actor.role === 'btl');
      const laCuaMinh = !!(req.actor && c0.actor_email && c0.actor_email === req.actor.email);
      if (!laBtl && !laCuaMinh) {
        await client.query('ROLLBACK'); client.release();
        /* Câu báo NÊU TÊN người đã ghi dòng — PG ở cửa phải biết đi hỏi ai, chứ
           «không có quyền» thì không đi tiếp được việc gì. */
        return res.status(403).json({ ok: false,
          error: 'Dòng check-in này do ' + (c0.actor_email || 'người khác')
               + ' ghi — chỉ người đó hoặc ban tổ chức mới huỷ được.',
          nguoiGhi: c0.actor_email || null });
      }

      await client.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'check_in_undo','guest',$2,$3::jsonb,$4)`,
        [req.actor.email, String(id),
          JSON.stringify({
            guest_id: id,
            guest_ten: c0.full_name,
            session: c0.session,
            cu_checked_in_at: c0.checked_in_at,
            cu_actor_email: c0.actor_email,
            cu_note: c0.note || null,
            /* §4e — phân biệt huỷ-từ-CỬA với huỷ-từ-/crm. Không có cờ này thì
               `door@checkin.local` trong audit đọc như một tài khoản người, và
               sáng 09/08 không ai biết dòng đó do một phiên ẩn danh ở cửa bấm. */
            boi_actor: req.actor.email,
            laCua: !!(req.actor && req.actor.laCua),
          }),
          hashIp(ipOf(req))]);
      await client.query('DELETE FROM crm_check_ins WHERE guest_id = $1 AND session = $2', [id, c0.session]);
      await client.query('COMMIT');
      client.release();
      return res.status(200).json({
        ok: true, already: true, session: c0.session,
        cu: { at: c0.checked_in_at, by: c0.actor_email },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      console.error('[crm-guests] check-in undo failed:', err.message);
      return res.status(500).json({ ok: false, error: 'undo error' });
    }
  });

  // ---- interaction ----
  // Nhận MỘT ghi nhận `{kind, body}` (như cũ) HOẶC nhiều ghi nhận cùng lúc
  // `{items:[{kind, body}, …]}` — nhiều thì ghi trong CÙNG MỘT transaction.
  //
  // E08-D028 L-02: bản cũ để client bắn ba POST tuần tự, mỗi cái tự commit. Job
  // 1 vào DB xong job 2 hỏng thì màn báo ĐỎ «CHƯA lưu được» trong khi dòng 1 ĐÃ
  // nằm trong bảng; PG bấm lại là ghi trùng. Không có route xoá interaction nên
  // dòng trùng nằm lại trên thẻ khách VIP và chị Thúy Hà đối soát quà sẽ đếm
  // sai. Một request + một transaction ⇒ hoặc vào hết, hoặc không dòng nào —
  // bấm lại bao nhiêu lần cũng không đẻ bản sao.
  app.post('/crm/guests/:id/interactions', doorAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });

    const raw = (req.body && Array.isArray(req.body.items)) ? req.body.items : [req.body || {}];
    if (raw.length > 20) return res.status(400).json({ ok: false, error: 'Quá nhiều ghi nhận trong một lượt.' });
    const items = raw
      .map((x) => ({ kind: (clean(x && x.kind) || 'khác').slice(0, 40), body: clean(x && x.body) }))
      .filter((x) => x.body);
    if (!items.length) return res.status(400).json({ ok: false, error: 'Thiếu nội dung ghi chú.' });

    let client;
    try {
      const g = await pool.query('SELECT id FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) return res.status(404).json({ ok: false, error: 'not found' });
      client = await pool.connect();
      const out = [];
      try {
        await client.query('BEGIN');
        for (const it of items) {
          const r = await client.query(
            'INSERT INTO crm_interactions (guest_id, actor_email, kind, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
            [id, req.actor.email, it.kind, it.body]);
          out.push({ id: String(r.rows[0].id), created_at: r.rows[0].created_at, kind: it.kind });
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      await logAudit(pool, { actor_email: req.actor.email, event_type: 'interaction_create', target_type: 'guest', target_id: id, meta: { kinds: items.map((x) => x.kind) }, ip: ipOf(req) });
      return res.status(201).json({ ok: true, id: out[0].id, created_at: out[0].created_at, items: out });
    } catch (err) {
      console.error('[crm-guests] interaction failed:', err.message);
      return res.status(500).json({ ok: false, error: 'interaction error' });
    } finally {
      // D016 B10 đã dạy một lần: quên trả kết nối về pool thì vài chục lượt là
      // hết pool và MỌI route chết theo, không riêng route này.
      if (client) client.release();
    }
  });

  // ---- E08-D031: đổi trạng thái THAM DỰ ----
  // Sponsor chốt phương án A (05/08): mọi tài khoản đã đăng nhập đổi được —
  // cửa nay có OTP nên không còn đường ẩn danh, mọi thao tác đều có email đứng
  // tên. Ba ràng buộc đi kèm, cài ở đây chứ không phải quy ước:
  //   1. Audit MỌI lần: actor + cũ→mới + thao tác từ đâu.
  //   2. Ghi vào `att_override`, KHÔNG phá tag gốc ⇒ xoá override là số trở về
  //      đúng nguyên trạng (gửi status = null để xoá).
  //   3. BTL xem được danh sách đã sửa tay — route ngay dưới.
  //
  // TUYỆT ĐỐI không đụng `crm_check_ins`: "không tham dự" và "chưa đến" là hai
  // trục khác nhau; gộp chúng là làm hỏng cả hai con số.
  // Phương án A: MỌI tài khoản đã đăng nhập đổi được. Cửa nay có OTP nên không
  // còn đường ẩn danh — requireCrmAuth là đủ và đúng.
  app.post('/crm/guests/:id/attendance', requireCrmAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const raw = req.body && req.body.status;
    const status = (raw === null || raw === '' || raw === undefined) ? null : String(raw);
    if (status !== null && !att.isStatus(status)) {
      return res.status(400).json({ ok: false, error: 'Trạng thái không hợp lệ (du|khong|cho).' });
    }
    // Ghi lại thao tác đến từ màn nào — cùng một người có thể đứng ở /crm hay ở
    // một trong hai cửa, và khi đối soát số thì cần biết.
    const src = clean(req.body && req.body.source).slice(0, 24) || 'crm';
    const duX = att.duSql('', 'crm_guests.response_id', '$2', '$3');
    let client;
    try {
      client = await pool.connect();
      let before; let after;
      // E08-D049 — cờ dựng TRONG giao dịch, đọc SAU commit: nhánh có clear tự ghi
      // audit rồi, nhánh thường vẫn đi đường logAudit cũ.
      let daGhiAudit = false; let daClear = null;
      try {
        await client.query('BEGIN');
        // Khoá hàng rồi mới đọc: hai người cùng bấm trên hai máy thì lần ghi sau
        // phải thấy giá trị của lần trước, không phải giá trị lúc mở trang.
        // E08-D049 — lấy LUÔN table_no/seat_no trong chính câu FOR UPDATE này,
        // không thêm truy vấn thứ hai: giá trị CŨ vừa là thứ để clear, vừa là
        // thứ audit phải chép (M2 — mất số bàn mà không truy lại được là hỏng).
        const b = await client.query(
          `SELECT ${att.attSql('', duX)} AS att_status, att_override, table_no, seat_no
             FROM crm_guests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [id, SESSION_RE['toa-dam'], SESSION_RE.gala]);
        if (!b.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'not found' }); }
        before = b.rows[0];
        await client.query(
          // Ép kiểu: `$2 IS NULL` trần thì Postgres không suy được kiểu tham số
          // và câu lệnh hỏng ngay khi chạy — node --check lẫn boot đều không bắt
          // được, chỉ gọi thật mới lộ.
          `UPDATE crm_guests SET att_override = $2::text,
                  att_override_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
                  att_override_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::text END,
                  updated_at = now()
            WHERE id = $1`, [id, status, req.actor.email]);
        const a = await client.query(
          `SELECT ${att.attSql('', duX)} AS att_status FROM crm_guests WHERE id = $1`,
          [id, SESSION_RE['toa-dam'], SESSION_RE.gala]);
        after = a.rows[0];

        /* ---- E08-D049 · KHÔNG THAM DỰ thì trả lại chỗ ngồi ----
           Ca thật: thẻ #301 (Nguyễn Trí Thông) — chị Ly bấm «không dự» 06/08 10:26,
           thấy bàn 17 / ghế 10 vẫn nguyên, 54 giây sau bấm trả lại «dự» (đọc được
           trong `crm_audit_events`). Sơ đồ chỗ ngồi vì thế giữ chỗ «ảo».

           Điều kiện là CHUYỂN TRẠNG THÁI, không phải «giá trị gửi lên là khong»:
             · `cho`→`du`, `du`→`cho`  ⇒ KHÔNG clear (M1)
             · đã `khong`, re-POST `khong` ⇒ KHÔNG clear — ô đã NULL thì clear lại
               chỉ đẻ một dòng audit rỗng, mà 39/41 thẻ `khong` trên prod đang mang
               chữ rác "Không tham dự" (rác cũ) — dọn chúng là việc của Ly/Excel,
               spec §6 xếp ngoài phạm vi. Quét hàng loạt 2 ngày trước lễ là ghi 41
               hàng không ai bấm.
           Đọc `after.att_status` chứ không đọc `status`: gửi status=null để XOÁ
           override mà tín hiệu gốc là tag `khong-du` thì kết quả vẫn là «không dự»
           — spec §3a nói «mọi đường đổi att sang khong», và đây là một đường. */
        const chuyenSangKhong = before.att_status !== 'khong' && after.att_status === 'khong';
        const coChoNgoi = before.table_no != null || before.seat_no != null;
        if (chuyenSangKhong && coChoNgoi) {
          await client.query(
            'UPDATE crm_guests SET table_no = NULL, seat_no = NULL, updated_at = now() WHERE id = $1', [id]);
          /* Audit ghi THẲNG bằng client.query trong CÙNG transaction, KHÔNG qua
             logAudit(): hàm đó nuốt lỗi có chủ đích (audit.js «Never let audit
             failure break the main action») — đúng với att thuần, nhưng ở đây nó
             lật ngược thành: audit hỏng mà số bàn vẫn mất, IM LẶNG, và audit là
             bản ghi DUY NHẤT còn lại. Cùng lập luận D036 §3g và D040 M8. */
          await client.query(
            `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
             VALUES ($1,'att_change','guest',$2,$3::jsonb,$4)`,
            [req.actor.email, String(id),
              JSON.stringify({
                tu: before.att_status, den: after.att_status, override: status, nguon: src,
                ban: { cu: before.table_no, moi: null },
                ghe: { cu: before.seat_no, moi: null },
              }), hashIp(ipOf(req))]);
          daGhiAudit = true;
          daClear = { ban: before.table_no, ghe: before.seat_no };
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }

      /* Không clear ⇒ giữ NGUYÊN VĂN đường cũ (audit sau COMMIT, nuốt lỗi). Đổi
         cả hai nhánh sang ghi-trong-giao-dịch là biến «audit hỏng» thành «không
         đổi được trạng thái» cho 300+ lượt att thường — hồi quy không ai xin. */
      if (!daGhiAudit) {
        await logAudit(pool, {
          actor_email: req.actor.email, event_type: 'att_change', target_type: 'guest', target_id: id,
          meta: { tu: before.att_status, den: after.att_status, override: status, nguon: src },
          ip: ipOf(req),
        });
      }
      return res.json({ ok: true, att_status: after.att_status, att_override: status,
        truoc: before.att_status, daXoaChoNgoi: daClear });
    } catch (err) {
      console.error('[crm-guests] attendance failed:', err.message);
      return res.status(500).json({ ok: false, error: 'attendance error' });
    } finally {
      if (client) client.release();
    }
  });

  // Ràng buộc 3 của phương án A: BTL nhìn được TẤT CẢ thẻ đã bị sửa tay, kèm ai
  // sửa và lúc nào — để đối soát số trước khi chốt báo cáo.
  app.get('/crm/attendance/overrides', requireCrmAuth, requireRole('btl'), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, full_name, att_override, att_override_by, att_override_at
           FROM crm_guests
          WHERE deleted_at IS NULL AND att_override IS NOT NULL
          ORDER BY att_override_at DESC LIMIT 500`);
      return res.json({ ok: true, rows: r.rows, count: r.rowCount });
    } catch (err) {
      console.error('[crm-guests] overrides failed:', err.message);
      return res.status(500).json({ ok: false, error: 'overrides error' });
    }
  });
}

module.exports = { PL_NHAN, PL_TAGS, mount, normPhone };
