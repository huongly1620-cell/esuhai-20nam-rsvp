'use strict';
/* E08-D128 · Máy chủ cho phép đo GIAO DIỆN (AC-7).
   Dựng lab (xem test/lab.js), đổ một ít khách + ảnh, đăng nhập thật hai vai, rồi
   in MỘT dòng JSON `{url, cookieStaff, cookieBtl}` ra stdout và ngồi im.
   `test/ui/do-ac7.py` gọi nó, đọc dòng ấy, mở Chromium.

   Vì sao tách làm hai tiến trình: Playwright ở repo này là bản Python
   (tools/smoke-crm-ui.py đã dùng), còn app là Node. Cách rẻ nhất để hai bên gặp
   nhau là một dòng JSON trên stdout. */
process.env.OTP_DELIVERY = 'console';
process.env.CRM_SESSION_SECRET = 'lab-d128-secret';
process.env.CRM_DOOR_OPEN = '1';      // đúng cấu hình LIVE đang hỏng
process.env.CRM_ANH_SIGNUP = '1';
delete process.env.CRM_SMOKE_BEARER;

const { moLab, dangNhap } = require('../lab');

/* Hai khách, và khách đầu CÓ CẢ hai loại tấm — đó là chỗ AC-7 phải phân biệt:
   `btl` thấy cả gợi ý chờ, `staff` chỉ thấy tấm đã vào album. */
const KHACH = [
  { id: 1, full_name: 'Ông Lê Văn Ngỡi', name_jp: null, org: 'ESUHAI', org_jp: null,
    so_album: 2, so_cho: 3, so_mau: 1 },
  { id: 2, full_name: 'Bà Trần Thị Mai', name_jp: null, org: 'ESUWORKS', org_jp: null,
    so_album: 1, so_cho: 0, so_mau: 0 },
];
const ANH = [
  { guest_id: 1, candidate_id: 101, event_photo_id: 9001, trang_thai: 'xac-nhan', score: 0.91 },
  { guest_id: 1, candidate_id: 102, event_photo_id: 9002, trang_thai: 'xac-nhan', score: 0.88 },
  { guest_id: 1, candidate_id: 103, event_photo_id: 9003, trang_thai: 'cho', score: 0.61 },
  { guest_id: 1, candidate_id: 104, event_photo_id: 9004, trang_thai: 'cho', score: 0.52 },
  { guest_id: 1, candidate_id: 105, event_photo_id: 9005, trang_thai: 'cho', score: 0.44 },
  { guest_id: 2, candidate_id: 201, event_photo_id: 9010, trang_thai: 'xac-nhan', score: 0.77 },
];

(async () => {
  const lab = await moLab({ anhGia: true });
  lab.db.fixture.khach = KHACH;
  lab.db.fixture.anh = ANH;
  ANH.filter((a) => a.trang_thai === 'xac-nhan')
    .forEach((a) => lab.db.daDuyet.add(String(a.event_photo_id)));

  lab.db.staff_users.set('truong.ban@esuhai.com',
    { email: 'truong.ban@esuhai.com', role: 'btl', active: true });

  const cookieStaff = await dangNhap(lab, 'nhan.vien@esuhai.com');
  const cookieBtl = await dangNhap(lab, 'truong.ban@esuhai.com');

  process.stdout.write(JSON.stringify({ url: lab.url, cookieStaff, cookieBtl }) + '\n');

  const thoat = async () => { await lab.dong(); process.exit(0); };
  process.on('SIGTERM', thoat);
  process.on('SIGINT', thoat);
  process.stdin.on('end', thoat);
  process.stdin.resume();
})().catch((e) => { console.error(e); process.exit(1); });
