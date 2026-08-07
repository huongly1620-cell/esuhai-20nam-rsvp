'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   E08-D059 — TRANG /admin ĐÃ GỠ. ĐỪNG KHÔI PHỤC.

   Sponsor chốt 06/08 23:4x: «xoá trang admin, không cần dùng tới. dùng crm là
   được.» → «xoá luôn».

   VÌ SAO GỠ, không phải vì gọn gàng:
   `/admin` là một ĐƯỜNG VẬN HÀNH SONG SONG với CRM trên cùng dữ liệu, và hai
   trong số các tuyến của nó GHI THẲNG vào `crm_guests` bằng luật KHÁC hẳn luật
   của CRM:
     · `import-tables` — ô Bàn rỗng ghi NULL ⇒ một file sai xoá sạch sơ đồ chỗ
       ngồi (đã 410 từ E08-D050, CR-33 chốt bỏ từ 05/08 mà chưa ai bỏ).
     · `import-crm`    — `crmImport.importRows` chèn/sửa thẳng thẻ khách, không
       đi qua dry-run hai pha của vòng D032.
   Giữ một màn thứ hai làm được những việc đó, với một mật khẩu khác, trong đêm
   sự kiện, là giữ một cách hỏng dữ liệu mà không ai đang canh.

   VÌ SAO GIỜ MỚI GỠ ĐƯỢC: CR-40 từng giữ `export-seating.csv` vì đó là đường
   DUY NHẤT lấy `guest_ext_id`. Hết rồi — CRM xuất «Mã khách (KHOÁ)» và
   393/393 thẻ đã có `guest_ext_id` (đo 07/08).

   VÌ SAO 410 CHỨ KHÔNG 302 SANG /crm:
     · `/admin/api/*` là API. 302 trả HTML cho người gọi đang chờ JSON, và với
       `import-crm` (POST kèm FILE) thì chuyển hướng POST là hành vi không thống
       nhất giữa client — có client POST LẠI NGUYÊN FILE sang đích mới. Giết một
       mìn bằng cách đẩy file sang tuyến khác là đổi mìn lấy mìn.
     · 410 nói đúng nghĩa «từng có, đã CỐ Ý gỡ». 404 nghe như gõ nhầm, 302 nghe
       như dọn chỗ — cả hai đều mời người ta đi tìm tiếp.
     · E08-D050 đã đặt tiền lệ 410 ngay trong chính tệp này.

   KHÔNG ĐỤNG (phiếu §3): `POST /api/rsvp` ở index.js:26 — landing vẫn gửi;
   bảng `rsvp_submissions` giữ nguyên, không DROP.

   Toàn bộ phiên đăng nhập admin (cookie ký, ADMIN_USER/ADMIN_PASSWORD,
   requireAuth, maskPhone, csvCell…) đã gỡ theo, vì không còn tuyến nào dùng.
   Để lại là mã chết mang theo một đường đăng nhập thứ hai.
   ═══════════════════════════════════════════════════════════════════════════ */

const THAY_BANG = '/crm';

// Thân JSON cho các tuyến API — cùng khuôn D050 đã dùng cho `import-tables`.
const goneJson = (them) => (req, res) => res.status(410).json(Object.assign({
  ok: false,
  error: 'Trang quản trị đã gỡ (E08-D059). Dùng CRM: ' + THAY_BANG,
  thay_bang: THAY_BANG,
}, them || {}));

/* `GET /admin` là thứ NGƯỜI mở bằng trình duyệt, không phải máy gọi. Trả JSON
   trần ở đây thì người mở nhận một cục {"ok":false} giữa màn trắng và không
   biết đi đâu. Cùng mã 410, khác thân theo người đọc. */
const GONE_HTML = '<!doctype html><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Trang quản trị đã gỡ</title>'
  + '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'padding:24px;text-align:center;font-family:system-ui,Segoe UI,Arial,sans-serif;'
  + 'color:#eee;background:#0b1a30">'
  + '<div><h2 style="margin:0 0 10px">Trang quản trị đã gỡ</h2>'
  + '<p style="color:#b9b096;margin:0 0 18px;line-height:1.5">Mọi việc nay làm trên CRM.</p>'
  + '<a href="' + THAY_BANG + '" style="display:inline-block;background:#d8b876;color:#1a1204;'
  + 'padding:10px 20px;border-radius:8px;font-weight:700;text-decoration:none">Mở CRM</a>'
  + '</div></div>';

function mount(app) {
  // ---- mặt trang ----
  app.get('/admin', (req, res) => res.status(410).type('html').send(GONE_HTML));

  // ---- đăng nhập admin: gỡ cả hai đầu ----
  app.post('/admin/login', goneJson());
  app.post('/admin/logout', goneJson());

  // ---- API đọc ----
  app.get('/admin/api/summary', goneJson());
  app.get('/admin/api/responses', goneJson());
  app.get('/admin/api/export.csv', goneJson());
  // CR-40 đã hết hiệu lực: CRM xuất «Mã khách (KHOÁ)» thay cho tuyến này.
  app.get('/admin/api/export-seating.csv', goneJson({ thay_bang: '/crm → ⬇ Xuất để CẬP NHẬT' }));

  // ---- API GHI: hai tuyến nguy hiểm nhất của trang này ----
  // `import-tables` đã 410 từ E08-D050 — giữ nguyên câu chữ đã qua Gate 2.
  app.post('/admin/api/import-tables', (req, res) => res.status(410).json({
    ok: false,
    error: 'Tuyến này đã khoá (E08-D050). Nạp bàn/ghế qua CRM → «Nhập file CẬP NHẬT (D032)». '
         + 'Lý do: ô Bàn rỗng ở đây ghi NULL, một file sai là xoá sạch sơ đồ chỗ ngồi.',
    thay_bang: THAY_BANG,
  }));
  // `import-crm` cùng họ mìn: ghi thẳng crm_guests, không qua dry-run hai pha.
  app.post('/admin/api/import-crm', goneJson({
    thay_bang: '/crm → ⬆ Nhập CSV/Excel (có bước kiểm thử trước khi ghi)',
  }));
}

module.exports = { mount };
