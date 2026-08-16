'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   E08-D134 · TẦNG L1 — vector khuôn mặt giữ vĩnh viễn
   ══════════════════════════════════════════════════════════════════════════════
   Tầng này đo hai thứ mà một CSDL thật KHÔNG đo tốt hơn:

     · HÀNH VI HTTP và CÂU SQL ĐÃ GỬI ĐI. Phòng thí nghiệm ở lab.js gom mọi câu
       vào `db.sql`, nên khẳng định "tuyến này không ghi gì" trở thành một phép đo
       chứ không phải một lời hứa. Với một Postgres thật thì "không có gì đổi" chỉ
       chứng minh được bằng cách so trước/sau — yếu hơn hẳn.

     · SỰ VẮNG MẶT của mã. Đây là chỗ đặc biệt của vé D134: thứ cần bảo đảm không
       phải "hàm này trả đúng" mà "không còn đường nào xoá vector theo đồng hồ".
       Một hàm đã bị xoá thì không có gì để gọi và không có gì để đo bằng hành vi.
       Nên bốn phép cuối tệp đọc chính mã nguồn và đếm — chúng là bộ phát hiện đột
       biến của AC-4, và chúng đỏ ngay khi có người thêm lại một câu quét hạn.

   Đường GHI thật (Docker PG + CREATE_SQL) là tầng L2, ở
   tools/nhan-dien/kiem-vector-vinh-vien.js — tệp này cố ý không giả vờ thay thế nó.
   ══════════════════════════════════════════════════════════════════════════════ */

/* Đặt TRƯỚC require đầu tiên: auth.js đọc OTP_DELIVERY một lần lúc nạp mô-đun.
   Cùng khuôn với test/d128-otp-staff-anh-su-kien.test.js. */
process.env.OTP_DELIVERY = 'console';
process.env.CRM_SESSION_SECRET = 'lab-d134-secret';
process.env.NODE_ENV = 'test';
delete process.env.CRM_SMOKE_BEARER;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { moLab, dangNhap } = require('./lab');

const GOC = path.join(__dirname, '..');
const doc = (p) => fs.readFileSync(path.join(GOC, p), 'utf8');

/* Bỏ mọi chú thích trước khi soi. Cả ba tệp bị vé này đụng đều GIỮ LẠI phần chú
   thích mô tả cơ chế đã gỡ — cố ý, để người đọc sau biết chúng đã đi đâu. Soi
   nguyên văn thì mọi phép dưới đây xanh/đỏ theo lời văn chứ không theo mã chạy
   được, tức đo nhầm thứ. */
/* Hình dạng của "một câu xoá vector". KHÔNG bám vào `SET vec = NULL`: mã thật
   viết `SET deleted_at = now(), vec = NULL, vec_xoa_luc = now()`, nên một regex
   đòi `SET` đứng ngay trước sẽ đếm ra 0 và phép canh gác xanh giả — nó sẽ không
   thấy cả bốn cascade đang có lẫn một câu TTL mới thêm.
   Ranh giới \b chặn `vec_xoa_luc = NULL` (sau `vec` là dấu gạch dưới, không phải
   dấu bằng) và chặn cả `vec IS NULL` (so sánh, không phải gán).

   Đòi có `SET` đứng trước trong vòng 200 ký tự, và đó không phải để cho chặt hơn
   mà để KHỎI ĐẾM VĂN XUÔI: event-photos.js có một dòng audit ghi chú tiếng Việt
   nhắc đúng chữ `vec = NULL` để giải thích cho người đọc sổ. Đếm nó là đếm một câu
   không chạy, và tệ hơn — nó dạy người sửa sau rằng con số trong danh sách trắng
   không có nghĩa gì.
   KHÔNG bám vào tên bảng sau `UPDATE`: chế độ hoàn tác của tool dùng tên bảng
   động (`UPDATE ${bang}`), nên một regex đòi tên bảng viết cứng sẽ bỏ sót đúng
   chỗ nguy hiểm nhất. */
const XOA_VEC = /\bSET\b[\s\S]{0,200}?\bvec\s*=\s*NULL/gi;

function boChuThich(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

let lab;
before(async () => { lab = await moLab(); });
after(async () => { if (lab) await lab.dong(); });

/* Mỗi phép đứng một mình — không thừa hưởng người dùng, mã OTP hay câu SQL nào
   của phép trước. `sql` phải sạch vì AC-4a đếm trên chính mảng ấy. */
beforeEach(() => {
  lab.db.staff_users.clear();
  lab.db.crm_auth_codes.clear();
  lab.db.audit.length = 0;
  lab.db.sql.length = 0;
  lab.db.khoVector.soAudit.length = 0;
  process.env.CRM_DOOR_OPEN = '1';
  process.env.CRM_ANH_SIGNUP = '1';
});

/* Vai `btl` phải có TRƯỚC lượt đăng nhập: tự đăng ký không bao giờ ra btl (D128),
   nên gieo sẵn hàng staff_users rồi mới đi qua đường OTP thật. */
async function dangNhapBtl(email) {
  lab.db.staff_users.set(email, { email, role: 'btl', active: true });
  return dangNhap(lab, email);
}

/* ── AC-4 · TUYẾN QUÉT HẠN NGHỈ HƯU, KHÔNG CÒN KHẢ NĂNG XOÁ ───────────────── */

test('AC-4a · quet-han trả retired và KHÔNG gửi một câu SQL nào', async () => {
  const ck = await dangNhapBtl('btl@esuhai.com');

  const truoc = lab.db.sql.length;
  const r = await lab.goi('/crm/face-match/quet-han', { method: 'POST', cookie: ck, body: {} });
  const sau = lab.db.sql.length;

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.retired, true, 'phải tự khai là đã nghỉ hưu');
  assert.strictEqual(r.json.da_xoa, 0);
  /* Điều kiện của FR-1: tuyến không được ghi DB. Đo bằng SỐ CÂU đã gửi, không
     bằng phản hồi — một tuyến vẫn có thể ghi rồi trả về ok. */
  assert.strictEqual(sau, truoc,
    'tuyến nghỉ hưu phải gửi 0 câu SQL, đã gửi: ' + lab.db.sql.slice(truoc).join(' | '));
});

test('AC-4b · hai khoá cũ giữ nguyên tên và bằng 0 (script cũ đọc con_lai vẫn đúng)', async () => {
  const ck = await dangNhapBtl('btl@esuhai.com');
  const r = await lab.goi('/crm/face-match/quet-han', { method: 'POST', cookie: ck, body: {} });
  assert.strictEqual(r.json.qua_han_truoc, 0);
  assert.strictEqual(r.json.con_lai, 0, 'runbook cũ dạy đọc con_lai — nay đúng theo cấu tạo');
});

/* ── AC-11 · RBAC giữ nguyên, tuyến đo không lộ gì ────────────────────────── */

test('AC-11a · quet-han vẫn 403 với staff (hàng RBAC của D128 không mất)', async () => {
  const ck = await dangNhap(lab, 'nhanvien@esuhai.com');
  const r = await lab.goi('/crm/face-match/quet-han', { method: 'POST', cookie: ck, body: {} });
  assert.strictEqual(r.status, 403);
});

test('AC-11b · kho-vector: btl 200 · staff 403 · chưa đăng nhập không 200', async () => {
  const ckStaff = await dangNhap(lab, 'nhanvien@esuhai.com');
  const rStaff = await lab.goi('/crm/face-match/kho-vector', { cookie: ckStaff });
  assert.strictEqual(rStaff.status, 403, 'đồ nghề vận hành — không nới cho staff');

  const rKhach = await lab.goi('/crm/face-match/kho-vector');
  assert.notStrictEqual(rKhach.status, 200, 'chưa đăng nhập thì không được đọc');

  const ckBtl = await dangNhapBtl('btl@esuhai.com');
  const rBtl = await lab.goi('/crm/face-match/kho-vector', { cookie: ckBtl });
  assert.strictEqual(rBtl.status, 200, rBtl.text);
  assert.strictEqual(rBtl.json.ok, true);
  assert.strictEqual(rBtl.json.mat.thieu_vec, 4);
  assert.strictEqual(rBtl.json.mau.khoi_phuc_duoc, 1);
  /* Chưa chạy backfill lần nào ⇒ null, KHÔNG phải 0. "Chưa từng chạy" và "chạy
     xong không khôi phục được gì" là hai câu khác nhau. */
  assert.strictEqual(rBtl.json.backfill_gan_nhat, null);
});

test('AC-11c · kho-vector chỉ trả SỐ — không vector, không khoá kho, không PII', async () => {
  const ck = await dangNhapBtl('btl@esuhai.com');
  lab.db.khoVector.soAudit.push({
    event_type: 'face_vec_backfill', created_at: '2026-08-16T10:00:00Z',
    meta: { mat_khoi_phuc: 12, mau_khoi_phuc: 3, mat_loi: 1 },
  });
  const r = await lab.goi('/crm/face-match/kho-vector', { cookie: ck });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.backfill_gan_nhat.khoi_phuc, 15);

  const CAM = ['vec', 'moc', 'object_key', 'preview_key', 'thumb_key', 'orig_name',
    'full_name', 'email', 'guest_id', 'sha256'];
  (function soi(v, duong) {
    if (v === null || typeof v !== 'object') return;
    assert.ok(!Buffer.isBuffer(v), 'byte thô lọt ra ở ' + duong);
    for (const k of Object.keys(v)) {
      assert.ok(CAM.indexOf(k) < 0, 'khoá cấm "' + k + '" lọt ra ở ' + duong);
      soi(v[k], duong + '.' + k);
    }
  })(r.json, 'kho-vector');
});

/* ── AC-2 / AC-4 · BỘ PHÁT HIỆN ĐỘT BIẾN (đọc mã nguồn) ───────────────────────
   Bốn phép dưới đây là lý do tệp này tồn tại. Chúng đỏ khi có người khôi phục một
   đường TTL — kể cả khi đường ấy chưa từng được gọi trong phép kiểm nào. */

test('AC-2a · face-match.js không còn nhịp hẹn giờ nào', () => {
  const m = boChuThich(doc('server/crm/face-match.js'));
  assert.ok(!/setInterval|setTimeout/.test(m),
    'nhịp quét hạn đã quay lại — D134 bỏ cả lượt boot lẫn nhịp giờ');
});

test('AC-2b · không mã chạy được nào còn đọc het_han_luc của mặt sự kiện', () => {
  for (const f of ['server/crm/face-match.js', 'tools/nhan-dien/batch.js',
    'tools/nhan-dien/khoi-phuc-vector.js']) {
    assert.ok(!/het_han_luc/.test(boChuThich(doc(f))),
      f + ' còn đọc het_han_luc — cột này đã nghỉ hưu, cấm dùng làm điều kiện xoá');
  }
});

test('AC-4c · KHÔNG câu lệnh nào vừa xoá vector vừa nhắc het_han_luc', () => {
  /* Đây là hình dạng CHÍNH XÁC của đột biến cần chặn. Một câu xoá vector là hợp
     lệ (cascade); một câu nhắc het_han_luc là vô hại (bảng album link dùng tên
     cột trùng). Chỉ HAI THỨ ĐI CÙNG NHAU mới là TTL quay lại. */
  const canSoi = DUOC_XOA_VEC.filter((x) => !x.vat_chung).map((x) => x.tep)
    .concat(['server/crm-db.js']);
  for (const f of canSoi) {
    const src = boChuThich(doc(f));
    const cau = src.split(';');
    for (const c of cau) {
      if (new RegExp(XOA_VEC.source, 'i').test(c)) {
        assert.ok(!/het_han_luc/.test(c),
          f + ' có một câu vừa xoá vector vừa dùng het_han_luc — đó là TTL, đã bị cấm');
      }
    }
  }
});

/* Danh sách trắng của mọi chỗ được phép xoá vector, kèm SỐ LẦN. Con số là phần
   quan trọng: thêm một chỗ thứ hai trong cùng một tệp cũng phải làm phép kiểm đỏ,
   nếu không thì danh sách trắng chỉ chặn được tệp mới chứ không chặn được dòng mới. */
const DUOC_XOA_VEC = [
  /* Bốn cascade của CR-138: gỡ mềm một tấm (mặt + mẫu cắt tay), gỡ mềm cả đợt
     (mặt + mẫu cắt tay). Xoá cứng đi qua khoá ngoại nên không có câu nào ở đây. */
  { tep: 'server/crm/event-photos.js', so: 4, vi_sao: 'CR-138 cascade gỡ ảnh / gỡ đợt' },
  /* D134 phán quyết 1: gỡ mẫu nay xoá luôn vector của mẫu ấy. */
  { tep: 'server/crm/face-match.js', so: 1, vi_sao: 'D134 · gỡ mẫu' },
  /* Chế độ hoàn tác của tool backfill — mặc định THỬ, cần --commit và lệnh Sponsor. */
  { tep: 'tools/nhan-dien/khoi-phuc-vector.js', so: 1, vi_sao: 'D134 · hoàn tác backfill' },
  /* VẬT CHỨNG, không phải mã sản phẩm. Bộ kiểm L2 giữ NGUYÊN VĂN câu quét hạn của
     bản trước D134 để chạy nó trên một CSDL đã migrate và chứng minh nó đụng 0
     hàng — đó là toàn bộ lời hứa "rollback không tái kích hoạt TTL". Xoá câu ấy
     khỏi bộ kiểm là vứt đi bằng chứng duy nhất cho lời hứa ấy.
     Vì nó CỐ Ý vừa xoá vector vừa nhắc het_han_luc nên nó được miễn AC-4c — và
     chỉ mình nó. Đánh dấu bằng cờ chứ không bằng cách nới regex: nới regex là mở
     cửa cho mọi tệp khác đi qua. */
  { tep: 'tools/nhan-dien/kiem-vector-vinh-vien.js', so: 1, vat_chung: true,
    vi_sao: 'L2 · giữ nguyên văn câu quét hạn cũ để chứng minh nó đụng 0 hàng' },
  /* L3 dựng TRẠNG THÁI HỎNG để có cái mà khôi phục: 2 câu mô phỏng đúng thiệt hại
     TTL (mặt + mẫu), 3 câu dựng ca AC-8 (hàng đã gỡ, ảnh nguồn đã gỡ, mẫu đã gỡ).
     Đây là fixture, không phải đường chạy — nhưng vẫn phải khai, vì một bộ kiểm có
     quyền xoá vector mà không ai đếm cũng là một chỗ để giấu một câu TTL. */
  { tep: 'tools/nhan-dien/kiem-khoi-phuc-vector.js', so: 5, vat_chung: true,
    vi_sao: 'L3 · gieo thiệt hại TTL và ba ca đã-gỡ để đo đường khôi phục' },
];

test('AC-4d · chỉ đúng những chỗ trong danh sách trắng được xoá vector', () => {
  const RE = XOA_VEC;
  const bo = ['node_modules', '.git', 'model'];
  const thay = new Map();
  (function quet(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (bo.indexOf(e.name) > -1) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { quet(p); continue; }
      if (!/\.(js|sql)$/.test(e.name)) continue;
      const rel = path.relative(GOC, p);
      if (rel.startsWith('test' + path.sep)) continue;      // chính tệp này nhắc chuỗi đó
      const n = (boChuThich(fs.readFileSync(p, 'utf8')).match(RE) || []).length;
      if (n) thay.set(rel, n);
    }
  })(GOC);

  const mong = new Map(DUOC_XOA_VEC.map((x) => [x.tep, x.so]));
  for (const [tep, n] of thay) {
    assert.ok(mong.has(tep),
      'tệp NGOÀI danh sách trắng đang xoá vector: ' + tep + '\n'
      + 'Nếu đây là một đường xoá có chủ ý mới thì thêm vào DUOC_XOA_VEC kèm lý do; '
      + 'nếu là TTL quay lại thì đó chính là thứ D134 bỏ.');
    assert.strictEqual(n, mong.get(tep),
      tep + ': mong ' + mong.get(tep) + ' chỗ xoá vector, thấy ' + n);
  }
  for (const [tep, n] of mong) {
    assert.strictEqual(thay.get(tep), n, tep + ' mất chỗ xoá vector — cascade FR-3 đã hỏng?');
  }
});

/* ── AC-1 · LƯỢC ĐỒ (phần soi được không cần CSDL) ────────────────────────── */

test('AC-1a · CREATE_SQL không còn default 7 ngày và không dựng lại index dọn hạn', () => {
  const s = doc('server/crm-db.js');
  assert.ok(!/het_han_luc\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s*\(now\(\)\s*\+\s*interval\s*'7 days'\)/.test(s),
    'định nghĩa cột vẫn mang default 7 ngày');
  assert.ok(!/CREATE INDEX IF NOT EXISTS idx_event_faces_can_don/.test(s),
    'vẫn dựng lại chỉ mục dọn hạn');
  assert.match(s, /DROP INDEX IF EXISTS idx_event_faces_can_don/);
  assert.match(s, /ALTER COLUMN het_han_luc DROP DEFAULT/);
  assert.match(s, /ALTER COLUMN het_han_luc DROP NOT NULL/);
});

test('AC-1b · migrateCrm NULL hoá het_han_luc cũ — điều kiện của rollback an toàn', () => {
  const s = doc('server/crm-db.js');
  assert.match(s, /UPDATE crm_event_faces SET het_han_luc = NULL WHERE het_han_luc IS NOT NULL/,
    'không có câu này thì một lần rollback là một lần TTL quét lại toàn bộ hàng cũ');
});
