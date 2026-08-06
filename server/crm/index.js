'use strict';

const path = require('path');
const auth = require('./auth');
const audit = require('./audit');
const importUpdate = require('./import-update');
const guests = require('./guests');
const stats = require('./stats');
const photos = require('./photos');
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
  const DOOR_PATHS = ['/checkin-toadam.html', '/checkin-gala.html'];
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

  auth.mount(app);
  // E08-D041 — tuyến mở khoá SĐT. Đặt cạnh auth vì nó là gác cổng, không phải
  // dữ liệu khách.
  auth.mountPhoneUnlock(app);                                  // /auth/* + /crm/me
  guests.mount(app, auth.requireCrmAuth, auth.requireRole, auth.requireDoorOrAuth);
  stats.mount(app, auth.requireCrmAuth);
  photos.mount(app, auth.requireCrmAuth, auth.requireRole, auth.requireDoorOrAuth);
  importer.mount(app, auth.requireCrmAuth, auth.requireRole);
  audit.mount(app, auth.requireCrmAuth, auth.requireRole);
  // E08-D032 — hai lệnh TÁCH BẠCH: /crm/import-update/dry-run và /commit.
  importUpdate.mount(app, auth.requireCrmAuth, auth.requireRole, importer.upload, importer.parseUpload);
}

module.exports = { mount };
