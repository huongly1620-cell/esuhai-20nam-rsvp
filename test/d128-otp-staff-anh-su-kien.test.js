'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   E08-D128 · AC-1…AC-8 · Nhân viên OTP vào Ảnh sự kiện (tách công tắc cửa)
   ══════════════════════════════════════════════════════════════════════════════
   Mỗi `test()` dưới đây mang đúng tên của một AC trong spec, để đọc kết quả là
   đọc thẳng bảng nghiệm thu — không phải dịch từ tên kỹ thuật sang AC.

   Biến môi trường đặt TRƯỚC `require` đầu tiên: `auth.js` đọc `OTP_DELIVERY` một
   lần lúc nạp mô-đun (còn `CRM_DOOR_OPEN` / `CRM_ANH_SIGNUP` thì đọc mỗi lần gọi,
   nên bốn phép đầu bật tắt được chúng ngay trong lượt chạy). */
process.env.OTP_DELIVERY = 'console';
process.env.CRM_SESSION_SECRET = 'lab-d128-secret';
process.env.NODE_ENV = 'test';
delete process.env.CRM_SMOKE_BEARER;

const test = require('node:test');
const assert = require('node:assert');
const { moLab, dangNhap, batLog } = require('./lab');

let lab;
test.before(async () => { lab = await moLab(); });
test.after(async () => { await lab.dong(); });

// Dọn giữa các phép: mỗi AC phải đứng một mình, không thừa hưởng dòng nào.
function reset(env) {
  lab.db.staff_users.clear();
  lab.db.crm_auth_codes.clear();
  lab.db.audit.length = 0;
  lab.db.sql.length = 0;
  delete process.env.CRM_DOOR_OPEN;
  delete process.env.CRM_DOOR_SIGNUP;
  delete process.env.CRM_ANH_SIGNUP;
  Object.assign(process.env, env || {});
}

// Xin mã và trả về những gì quan sát được: mã HTTP, mã OTP in ra log, số dòng
// `crm_auth_codes` sau lượt gọi.
async function xinMa(email) {
  const bat = batLog();
  let r;
  try { r = await lab.goi('/auth/request-code', { method: 'POST', body: { email } }); }
  finally { bat.tha(); }
  return { status: r.status, ma: bat.ma(email), soMa: lab.db.crm_auth_codes.size,
    taiKhoan: lab.db.staff_users.get(email) || null };
}

/* ── AC-1 ─────────────────────────────────────────────────────────────────────
   Cửa ĐANG MỞ (đúng cấu hình LIVE hôm nay) + công tắc ảnh bật + email công ty
   chưa có trong danh sách ⇒ vẫn phải có mã. Đây là chính cái hỏng của LIVE. */
test('AC-1 · cửa mở + CRM_ANH_SIGNUP=1 + @esuhai.com mới ⇒ mint đúng 1 mã, 202', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const kq = await xinMa('nhanvien.moi@esuhai.com');
  assert.strictEqual(kq.status, 202);
  assert.strictEqual(kq.soMa, 1, 'phải có đúng 1 dòng crm_auth_codes');
  assert.match(String(kq.ma), /^\d{6}$/, 'mã 6 chữ số phải in ra log (OTP_DELIVERY=console)');
  assert.ok(kq.taiKhoan, 'phải sinh một dòng staff_users');
  assert.strictEqual(kq.taiKhoan.role, 'staff', 'tự đăng ký KHÔNG BAO GIỜ ra btl');
  assert.strictEqual(kq.taiKhoan.active, true);
});

test('AC-1b · @esuworks.vn cũng là miền công ty', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const kq = await xinMa('ai.do@esuworks.vn');
  assert.strictEqual(kq.status, 202);
  assert.strictEqual(kq.soMa, 1);
});

/* ── AC-2 ─────────────────────────────────────────────────────────────────────
   Miền ngoài ⇒ KHÔNG mint. Và câu trả lời vẫn y hệt AC-1 (FR-7): người gõ thử
   không được suy ra email nào có trong hệ thống. */
test('AC-2 · miền ngoài chưa có trong staff_users ⇒ 0 mã, vẫn 202', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const kq = await xinMa('nguoi.la@gmail.com');
  assert.strictEqual(kq.status, 202, 'anti-enumeration: mã trạng thái không được khác AC-1');
  assert.strictEqual(kq.soMa, 0);
  assert.strictEqual(kq.ma, null);
  assert.strictEqual(kq.taiKhoan, null, 'không được đẻ tài khoản cho miền ngoài');
});

/* Bốn kiểu «gần giống miền công ty». Dấu `@` trong hậu tố là thứ chặn cả bốn:
   nó neo phép so vào ĐÚNG ranh giới tên miền, nên `endsWith` ở đây tương đương
   «tên miền bằng đúng chuỗi này» chứ không phải «kết thúc bằng chuỗi này». */
test('AC-2b · miền na ná KHÔNG lọt', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  for (const e of ['gia.mao@esuhai.com.vn', 'gia.mao@notesuhai.com',
    'gia.mao@sub.esuhai.com', 'gia.mao@esuhai.com.attacker.tld']) {
    lab.db.crm_auth_codes.clear();
    const kq = await xinMa(e);
    assert.strictEqual(kq.status, 202, e);
    assert.strictEqual(kq.soMa, 0, e + ' không được nhận mã');
  }
});

test('AC-2c · hoa/thường và khoảng trắng vẫn về đúng miền công ty', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const kq = await xinMa('  Nhan.Vien@ESUHAI.COM  ');
  assert.strictEqual(kq.soMa, 1, 'normEmail chạy TRƯỚC phép kiểm miền');
  assert.ok(lab.db.staff_users.has('nhan.vien@esuhai.com'));
});

/* ── AC-3 ─────────────────────────────────────────────────────────────────────
   Tắt công tắc là trở về đúng hành vi hôm nay. Nếu phép này xanh cả khi công tắc
   bật lẫn khi tắt thì nó không đo gì cả — nó phải ĐỎ ở nhánh bật (AC-1 lo). */
test('AC-3 · không có CRM_ANH_SIGNUP + cửa mở + email mới ⇒ 0 mã', async () => {
  reset({ CRM_DOOR_OPEN: '1' });
  const kq = await xinMa('nhanvien.moi@esuhai.com');
  assert.strictEqual(kq.status, 202);
  assert.strictEqual(kq.soMa, 0, 'tắt công tắc phải giữ nguyên hành vi trước D128');
});

test('AC-3b · CRM_ANH_SIGNUP=0 cũng là tắt', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '0' });
  assert.strictEqual((await xinMa('nhanvien.moi@esuhai.com')).soMa, 0);
});

/* ── AC-4 · nhánh `lookupAllowed` không đổi ───────────────────────────────── */
test('AC-4 · email đã có staff_users.active ⇒ vẫn nhận mã dù công tắc ảnh tắt', async () => {
  reset({ CRM_DOOR_OPEN: '1' });
  lab.db.staff_users.set('sep@ngoaidomain.com', { email: 'sep@ngoaidomain.com', role: 'btl', active: true });
  const kq = await xinMa('sep@ngoaidomain.com');
  assert.strictEqual(kq.soMa, 1);
  assert.strictEqual(kq.taiKhoan.role, 'btl', 'quyền của người có sẵn không bị hạ xuống staff');
});

test('AC-4b · active=false ⇒ không mã (BTL tắt được từng người)', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  lab.db.staff_users.set('bi.tat@esuhai.com', { email: 'bi.tat@esuhai.com', role: 'staff', active: false });
  const kq = await xinMa('bi.tat@esuhai.com');
  assert.strictEqual(kq.status, 202);
  assert.strictEqual(kq.soMa, 0, 'người đã bị tắt không được signup bật lại');
});

/* ── FR-1 · cửa giữ nguyên nghĩa cũ ───────────────────────────────────────── */
test('FR-1 · CRM_DOOR_SIGNUP vẫn CHỈ có tác dụng khi cửa ĐÓNG', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_DOOR_SIGNUP: '1' });
  assert.strictEqual((await xinMa('pg.nao.do@gmail.com')).soMa, 0, 'cửa mở ⇒ signup cửa tắt (M6/D041)');
  reset({ CRM_DOOR_SIGNUP: '1' });
  assert.strictEqual((await xinMa('pg.nao.do@gmail.com')).soMa, 1, 'cửa đóng ⇒ signup cửa bật, mọi miền');
});

/* ── AC-5 · shell ─────────────────────────────────────────────────────────── */
test('AC-5 · staff mở được HTML Theo khách (200) nhưng /crm vẫn 403', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const ck = await dangNhap(lab, 'nhanvien@esuhai.com');

  const theoKhach = await lab.goi('/crm/anh-su-kien/theo-khach', { cookie: ck });
  assert.strictEqual(theoKhach.status, 200);
  assert.match(theoKhach.text, /Ảnh sự kiện/, 'phải là trang nhận diện thật');

  const crm = await lab.goi('/crm', { cookie: ck });
  assert.strictEqual(crm.status, 403, 'bảng điều khiển CRM vẫn chỉ ban tổ chức');
  const classic = await lab.goi('/crm/classic', { cookie: ck });
  assert.strictEqual(classic.status, 403);

  const kho = await lab.goi('/crm/anh-su-kien/kho', { cookie: ck });
  assert.strictEqual(kho.status, 200, 'FR-4 · shell kho vẫn phục vụ staff');
});

test('AC-5b · staff vào /crm/anh-su-kien (không đuôi) ⇒ 302 sang Theo khách', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const ck = await dangNhap(lab, 'nhanvien@esuhai.com');
  const r = await lab.goi('/crm/anh-su-kien', { cookie: ck });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/crm/anh-su-kien/theo-khach');

  const rq = await lab.goi('/crm/anh-su-kien?khach=7', { cookie: ck });
  assert.strictEqual(rq.headers.get('location'), '/crm/anh-su-kien/theo-khach?khach=7',
    'giữ nguyên query của lối vào sâu D107');
});

test('AC-5c · chưa đăng nhập ⇒ trang đăng nhập, không phải 302 hay 403', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const r = await lab.goi('/crm/anh-su-kien');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /crm-login|đăng nhập|Đăng nhập/i);
});

/* ── AC-6 · ĐỌC được, GHI thì không ───────────────────────────────────────── */
test('AC-6 · staff gọi được các GET của Theo khách', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const ck = await dangNhap(lab, 'nhanvien@esuhai.com');

  const me = await lab.goi('/crm/me', { cookie: ck });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.role, 'staff');

  for (const d of ['/crm/face-match/guests', '/crm/face-match/khoi',
    '/crm/face-match/khoi/1', '/crm/face-match/album/1']) {
    const r = await lab.goi(d, { cookie: ck });
    assert.strictEqual(r.status, 200, d + ' phải mở cho staff');
    assert.strictEqual(r.json.ok, true, d);
  }
});

test('AC-6b · mọi đường GHI vẫn 403 với staff', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const ck = await dangNhap(lab, 'nhanvien@esuhai.com');
  const cam = [
    ['POST', '/crm/face-match/confirm', { id: 1 }],
    ['POST', '/crm/face-match/reject', { id: 1 }],
    ['POST', '/crm/face-match/skip', { id: 1 }],
    ['POST', '/crm/face-match/quyet-nhieu', { ids: [1], trang_thai: 'xac-nhan' }],
    ['POST', '/crm/face-match/assign', { event_photo_id: 1, guest_id: 1 }],
    ['POST', '/crm/face-match/sample', { guest_id: 1 }],
    ['DELETE', '/crm/face-match/sample/1', null],
    ['POST', '/crm/face-match/quet-han', {}],
    ['POST', '/crm/face-match/dong-bo', { nguon: 'tay', so_luong: 1 }],
    ['POST', '/crm/face-match/dong-bo/dung', { run_id: 1 }],
    ['POST', '/crm/face-match/dong-bo/tam-dung', { tat_ca: true }],
    ['POST', '/crm/event-photos', {}],
    ['DELETE', '/crm/event-photos/1', null],
  ];
  for (const [method, duong, body] of cam) {
    const r = await lab.goi(duong, { method, cookie: ck, body });
    assert.strictEqual(r.status, 403, method + ' ' + duong + ' phải 403 với staff');
  }
});

/* Gác D107 giữ nguyên: `staff` lấy được byte của tấm ĐÃ duyệt, không lấy được
   tấm chưa duyệt. 500 ở nhánh «đã duyệt» là do lab không có MinIO — điều cần đo ở
   đây là CỔNG GÁC, và 500 chứng minh yêu cầu đã đi qua nó. */
test('AC-6e · thumb/preview: tấm đã xac-nhan qua được gác, tấm chưa thì 403', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  lab.db.daDuyet.add('11');
  const ck = await dangNhap(lab, 'nhanvien@esuhai.com');

  for (const d of ['/crm/event-photos/11/thumb', '/crm/event-photos/11/preview?dl=1']) {
    const r = await lab.goi(d, { cookie: ck });
    assert.notStrictEqual(r.status, 403, d + ' · tấm đã duyệt phải qua gác D107');
  }
  for (const d of ['/crm/event-photos/99/thumb', '/crm/event-photos/99/preview?dl=1']) {
    const r = await lab.goi(d, { cookie: ck });
    assert.strictEqual(r.status, 403, d + ' · tấm chưa duyệt vẫn cấm');
  }
});

test('AC-6c · các GET của tab Phân loại KHÔNG được nới', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const ck = await dangNhap(lab, 'nhanvien@esuhai.com');
  for (const d of ['/crm/face-match/photos', '/crm/face-match/queue',
    '/crm/face-match/photo/1/faces', '/crm/face-match/dong-bo',
    /* E08-D134 · tuyến đo kho vector là đồ nghề vận hành nhận diện, cùng ranh
       giới với /photos và /queue — thêm vào đây để một lần nới quyền tương lai
       không lặng lẽ bỏ sót nó. */
    '/crm/face-match/kho-vector',
    '/crm/event-photos', '/crm/event-photos/stats']) {
    const r = await lab.goi(d, { cookie: ck });
    assert.strictEqual(r.status, 403, d + ' là đồ nghề của người duyệt — vẫn btl');
  }
});

test('AC-6d · staff không đọc được dòng CHỜ DUYỆT nào (lọc ở SQL, không ở trình duyệt)', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  const ck = await dangNhap(lab, 'nhanvien@esuhai.com');

  lab.db.sql.length = 0;
  await lab.goi('/crm/face-match/khoi/1', { cookie: ck });
  const cauStaff = lab.db.sql.filter((s) => /crm_face_candidates/.test(s));
  assert.ok(cauStaff.length, 'phải có câu hỏi bảng candidate');
  assert.ok(cauStaff.every((s) => !/IN \('cho','xac-nhan'\)/.test(s)),
    'staff không được nhận trạng thái `cho`');
  assert.ok(cauStaff.some((s) => /IN \('xac-nhan'\)/.test(s)));

  // …và cùng tuyến ấy với btl thì vẫn hỏi cả hai trạng thái (không phá D103).
  lab.db.staff_users.set('bt@esuhai.com', { email: 'bt@esuhai.com', role: 'btl', active: true });
  const ckB = await dangNhap(lab, 'bt@esuhai.com');
  lab.db.sql.length = 0;
  await lab.goi('/crm/face-match/khoi/1', { cookie: ckB });
  assert.ok(lab.db.sql.some((s) => /IN \('cho','xac-nhan'\)/.test(s)),
    'btl vẫn thấy cả gợi ý chờ');
});

/* ── AC-8 · btl không mất gì ──────────────────────────────────────────────── */
test('AC-8 · regression btl: OTP, /crm, /crm/anh-su-kien, đường GHI', async () => {
  reset({ CRM_DOOR_OPEN: '1' });
  lab.db.staff_users.set('bt@esuhai.com', { email: 'bt@esuhai.com', role: 'btl', active: true });
  const ck = await dangNhap(lab, 'bt@esuhai.com');

  assert.strictEqual((await lab.goi('/crm', { cookie: ck })).status, 200);
  assert.strictEqual((await lab.goi('/crm/classic', { cookie: ck })).status, 200);

  const anh = await lab.goi('/crm/anh-su-kien', { cookie: ck });
  assert.strictEqual(anh.status, 200, 'btl KHÔNG bị 302 — tab Phân loại là màn chính của họ');

  assert.strictEqual((await lab.goi('/crm/face-match/photos', { cookie: ck })).status, 200);
  assert.strictEqual((await lab.goi('/crm/face-match/khoi', { cookie: ck })).status, 200);
  // Đường GHI: qua được cửa vai (không 403). Kết quả nghiệp vụ là việc của lab DB thật.
  const ghi = await lab.goi('/crm/face-match/quyet-nhieu',
    { method: 'POST', cookie: ck, body: { ids: [1], trang_thai: 'xac-nhan' } });
  assert.notStrictEqual(ghi.status, 403, 'btl phải qua được cửa vai của đường GHI');
});

/* ── FR-8 · không đụng cửa ────────────────────────────────────────────────── */
test('FR-8 · làn cửa (CRM_DOOR_OPEN) KHÔNG mở được trang ảnh', async () => {
  reset({ CRM_DOOR_OPEN: '1', CRM_ANH_SIGNUP: '1' });
  // Không cookie: `requireDoorOrAuth` cho qua ở tuyến cửa, nhưng shell ảnh và
  // face-match dùng `currentActor`/`requireCrmAuth` — phải là người có OTP.
  assert.strictEqual((await lab.goi('/crm/face-match/khoi')).status, 401);
  assert.strictEqual((await lab.goi('/crm/face-match/album/1')).status, 401);
  const shell = await lab.goi('/crm/anh-su-kien/theo-khach');
  assert.match(shell.text, /crm-login|đăng nhập|Đăng nhập/i, 'không cookie ⇒ màn đăng nhập');
});
