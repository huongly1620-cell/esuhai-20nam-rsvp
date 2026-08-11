'use strict';

const path = require('path');
const auth = require('./auth');
const audit = require('./audit');
const importUpdate = require('./import-update');
const guests = require('./guests');
const stats = require('./stats');
const photos = require('./photos');
const eventPhotos = require('./event-photos');
const faceMatch = require('./face-match');
const nhanDienRun = require('./nhan-dien-run');
const albumLink = require('./album-link');
const importer = require('./import');

// Which app shell to serve for the authed /crm entry.
// CRM_UI=new  -> mockup-based UI (crm-app-v2.html). Default 'classic' keeps the
// current shell live so cutover is a single env flip, and rollback is instant
// (E08-D017 / AC-17). /crm/classic ALWAYS serves the old shell for fallback.
function appShell() {
  return (process.env.CRM_UI || 'classic').toLowerCase() === 'new'
    ? 'crm-app-v2.html'
    : 'crm-app.html';
}

// Mounts all CRM + auth routes. Kept fully separate from /admin and /api/rsvp.
function mount(app) {
  // Mobile UI entry: login screen if no valid CRM cookie, else the app shell.
  // Hai lối vào, hai diện người dùng (anh Kha chốt 05/08):
  //   * Trang cửa `/checkin-*.html` — PG đăng nhập bằng OTP như mọi người, tài
  //     khoản role `staff`. Ai có trong danh sách đón tiếp thì vào được.
  //   * Bảng điều khiển `/crm` — CHỈ role `btl` (5 người). Trước đây bất kỳ
  //     phiên hợp lệ nào cũng mở được shell, nên thêm một PG là thêm một người
  //     xoá được khách và tải được nhật ký PII.
  // E08-D066 — sơ đồ bàn dùng chung session cửa/CRM
  const DOOR_PATHS = ['/checkin-toadam.html', '/checkin-gala.html', '/sodoban-gala.html'];
  function serveShell(req, res, file) {
    const a = auth.currentActor(req);
    // PG bấm nhầm link /crm sau khi đã đăng nhập: đưa thẳng về cửa, đừng bắt
    // đăng nhập lại — họ ĐÃ đăng nhập, chỉ là không có quyền vào bảng này.
    const next = String(req.query.next || '');
    if (a && DOOR_PATHS.indexOf(next) > -1) return res.redirect(302, next);
    if (!a) return res.sendFile(path.join(__dirname, 'views', 'crm-login.html'));
    // Làn smoke là CÔNG CỤ, không phải người: nó vốn đã đọc được toàn bộ danh
    // sách khách qua API, nên chặn nó xem trang HTML không bảo vệ thêm gì mà
    // làm mù phép kiểm sau mỗi lần deploy. Nó vẫn là role `staff` nên vẫn bị
    // requireRole('btl') chặn ở xoá khách / import / nhật ký — đó mới là chỗ
    // đáng chặn, và smoke dùng chính điều đó để khẳng định RBAC còn nguyên.
    if (a.role !== 'btl' && a.email !== auth.SMOKE_EMAIL) return res.status(403).send(doorOnlyPage());
    return res.sendFile(path.join(__dirname, 'views', file));
  }
  function doorOnlyPage() {
    return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Trang đón tiếp</title>'
      + '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;'
      + 'font-family:system-ui,Segoe UI,Arial,sans-serif;color:#eee;background:#0b1a30">'
      + '<div><div style="font-size:44px">🎫</div>'
      + '<h2 style="margin:10px 0">Tài khoản này dùng cho trang cửa</h2>'
      + '<p style="color:#b9b096;max-width:340px;margin:0 auto">Bảng điều khiển CRM dành cho ban tổ chức. '
      + 'Anh/chị mở đúng cửa mình phụ trách:</p>'
      + '<div style="margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">'
      + '<a href="/checkin-toadam.html" style="background:#0F955A;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Cửa Tọa đàm</a>'
      + '<a href="/checkin-gala.html" style="background:#2E7FCC;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Cửa Gala</a>'
      + '</div></div></div>';
  }

  app.get('/crm', (req, res) => serveShell(req, res, appShell()));

  // Rollback lane: the classic shell, regardless of CRM_UI. Same auth gate.
  app.get('/crm/classic', (req, res) => serveShell(req, res, 'crm-app.html'));

  /* E08-D106 (CR-161) · MỘT lối vào «Ảnh sự kiện», ba tab. Trước D106 là hai nút
     rời trên /crm — «Kho ảnh sự kiện» (D082) và «Nhận diện ảnh khách» (D077) —
     nhưng với người dùng đó là MỘT việc: ảnh của sự kiện.

     Vì sao mỗi tab một URL thật chứ không một tài liệu ba khung:
       * Tab Kho và tab Phân loại là hai trang HTML đã sống, mỗi trang ~2 500 và
         ~900 dòng với chrome, i18n, theme riêng. Nhét chung vào một tài liệu là
         viết lại Picker/đồng bộ — đúng thứ vé này cấm.
       * FR-5 đòi back/forward phản ánh tab đang mở. Điều hướng thật cho việc đó
         miễn phí và không thể lệch; pushState giả trong iframe thì phải tự giữ
         đồng bộ, và mỗi chỗ tự giữ là một chỗ sẽ lệch.
     Phiên đăng nhập là cookie nên đi qua mọi tuyến — đổi tab không đăng nhập lại.

     `/crm/anh-su-kien` (không đuôi) = tab Phân loại, giữ đúng thứ tự D102 «ảnh
     trước, tên gắn sau». Một tab một URL: không có URL thứ hai cho cùng một tab. */
  app.get('/crm/anh-su-kien', (req, res) => serveShell(req, res, 'crm-nhan-dien.html'));
  app.get('/crm/anh-su-kien/theo-khach', (req, res) => serveShell(req, res, 'crm-nhan-dien.html'));
  app.get('/crm/anh-su-kien/kho', (req, res) => serveShell(req, res, 'crm-kho-anh.html'));
  // Người gõ tay đường đoán được nhất của tab mặc định — đưa về URL chuẩn, đừng 404.
  app.get('/crm/anh-su-kien/phan-loai', (req, res) => res.redirect(302, '/crm/anh-su-kien'));

  /* URL cũ đã nằm trong bookmark và trong tin nhắn Signal của ban tổ chức từ
     D077/D082 — không được chết. 302 chứ không 301: 301 bị trình duyệt nhớ vĩnh
     viễn, mà nếu vòng sau phải đổi lại lối vào thì không gỡ ra khỏi máy ai được. */
  app.get('/crm/kho-anh', (req, res) => res.redirect(302, '/crm/anh-su-kien/kho'));
  app.get('/crm/nhan-dien', (req, res) => {
    const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(302, '/crm/anh-su-kien' + q);
  });

  /* Ảnh mẫu cờ xoay EXIF cho phép dò AC-9. Thư mục `views/` KHÔNG nằm trong
     express.static, nên phải có tuyến riêng — và tuyến này đi cùng gác cổng với
     trang dùng nó, đừng để một file kiểm thử thành lối vào không khoá. */
  app.get('/crm/kho-anh/exif6.fixture.js', (req, res) => {
    const a = auth.currentActor(req);
    if (!a || (a.role !== 'btl' && a.email !== auth.SMOKE_EMAIL)) return res.status(403).end();
    res.type('application/javascript');
    return res.sendFile(path.join(__dirname, 'views', 'exif6.fixture.js'));
  });

  /* E08-D091 · Google Drive Picker config. Trả Client ID / API key / project
     number để frontend bật nút Google Drive. Thiếu ≥1 biến → 204 (nút giữ
     disabled, AC-2). Không trả client secret — flow thuần browser (GIS token). */
  app.get('/crm/kho-anh/picker-config', auth.requireCrmAuth, auth.requireRole('btl'), (req, res) => {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const apiKey   = process.env.GOOGLE_PICKER_API_KEY;
    const appId    = process.env.GOOGLE_CLOUD_PROJECT_NUMBER;
    if (!clientId || !apiKey || !appId) return res.status(204).end();
    res.json({ clientId, apiKey, appId });
  });

  auth.mount(app);
  // E08-D041 — tuyến mở khoá SĐT. Đặt cạnh auth vì nó là gác cổng, không phải
  // dữ liệu khách.
  auth.mountPhoneUnlock(app);                                  // /auth/* + /crm/me
  guests.mount(app, auth.requireCrmAuth, auth.requireRole, auth.requireDoorOrAuth);
  stats.mount(app, auth.requireCrmAuth);
  photos.mount(app, auth.requireCrmAuth, auth.requireRole, auth.requireDoorOrAuth);
  // E08-D082 — kho ảnh sự kiện. KHÔNG nhận `requireDoorOrAuth`: mọi tuyến ở đây
  // là `btl`, cửa không có việc gì ở kho ảnh phóng sự.
  eventPhotos.mount(app, auth.requireCrmAuth, auth.requireRole);
  faceMatch.mount(app, auth.requireCrmAuth, auth.requireRole);
  /* E08-D124 — nút Đồng bộ nhận diện. Cùng gác cổng `btl` như cả ngăn nhận diện;
     KHÔNG nhận `requireDoorOrAuth`, vì mở việc là ra lệnh cho máy chủ chứ không
     phải xem một con số. Tách khỏi face-match.js để phần sinh tiến trình con nằm
     gọn một chỗ — đó là thứ duy nhất trong CRM đụng tới `child_process`. */
  nhanDienRun.mount(app, auth.requireCrmAuth, auth.requireRole);
  /* E08-D120 — link album riêng của khách. KHÔNG nhận `requireDoorOrAuth`:
     tạo/đọc token là việc của `btl` có OTP, cửa mở (CRM_DOOR_OPEN) không đụng
     vào. Trang khách `/album/:token` nằm trong module này và cố ý KHÔNG có gác
     cổng CRM nào — token là chìa duy nhất; nó được mount ở đây, tức TRƯỚC
     express.static của index.js, nên không tệp tĩnh nào che được tuyến ấy. */
  albumLink.mount(app, auth.requireCrmAuth, auth.requireRole);
  importer.mount(app, auth.requireCrmAuth, auth.requireRole);
  audit.mount(app, auth.requireCrmAuth, auth.requireRole);
  // E08-D032 — hai lệnh TÁCH BẠCH: /crm/import-update/dry-run và /commit.
  importUpdate.mount(app, auth.requireCrmAuth, auth.requireRole, importer.upload, importer.parseUpload);
}

module.exports = { mount };
