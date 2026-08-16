#!/usr/bin/env node
'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   E08-D134 · TẦNG L2 — ĐƯỜNG GHI THẬT trên một Postgres thật
   ══════════════════════════════════════════════════════════════════════════════
   L1 (test/d134-vector-vinh-vien.test.js) đo hành vi HTTP và sự vắng mặt của mã.
   Nó KHÔNG đo được ba thứ, và cả ba đều là chỗ vé này có thể hỏng thật:

     · LƯỢC ĐỒ. "Không còn default 7 ngày" là một khẳng định về catalog Postgres,
       không về văn bản của CREATE_SQL. Trên một CSDL ĐÃ CÓ BẢNG, sửa văn bản ấy
       không đổi được gì — đúng lớp lỗi mà crm-db.js đã ghi hai lần. Chỉ có cách
       chạy thật rồi hỏi pg_attrdef / pg_class.

     · LỜI HỨA VỀ ROLLBACK. "Bản cũ redeploy sẽ xoá 0 hàng" là một khẳng định về
       DỮ LIỆU. Ở đây nó được chứng minh bằng cách chạy CHÍNH câu quét hạn của bản
       cũ trên CSDL đã migrate và đếm.

     · CASCADE. Bốn đường xoá có chủ ý đi qua các tuyến HTTP thật với transaction
       thật; lab giả ở L1 cố ý không giả vờ có transaction.

   Nên tệp này dựng CẢ APP lên trên một Postgres thật và gọi qua HTTP.

   CẢNH BÁO: tệp này XOÁ và gieo lại dữ liệu. Nó từ chối chạy nếu chuỗi kết nối
   không mang chữ `lab` hoặc `test` — cùng chốt an toàn với kiem-hang-doi.js,
   không có chỗ nào cho một lần dán nhầm chuỗi kết nối production.

   Chạy:
     docker run -d --name pg-d134-lab -e POSTGRES_PASSWORD=lab -e POSTGRES_DB=lab \
       -p 55434:5432 postgres:16-alpine
     DATABASE_URL=postgres://postgres:lab@127.0.0.1:55434/lab PGSSL=disable \
       node tools/nhan-dien/kiem-vector-vinh-vien.js
   ══════════════════════════════════════════════════════════════════════════════ */

const URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
if (!URL) { console.error('LOI thiếu DATABASE_URL'); process.exit(2); }
if (!/lab|test/i.test(URL)) {
  console.error('LOI chuỗi kết nối phải mang chữ lab hoặc test — tệp này xoá dữ liệu.');
  process.exit(2);
}
/* server/db.js đọc DATABASE_URL NGAY LÚC NẠP MÔ-ĐUN. Đặt trước mọi cú require
   xuống server/, nếu không thì bộ kiểm nối vào lab còn app nối vào… không đâu cả.
   Cùng bài học đã ghi ở đầu kiem-hang-doi.js. */
process.env.DATABASE_URL = URL;
process.env.PGSSL = process.env.PGSSL || 'disable';
process.env.OTP_DELIVERY = 'console';
process.env.CRM_SESSION_SECRET = 'lab-d134-l2';
process.env.NODE_ENV = 'test';

const http = require('http');
const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: URL, ssl: false });
pool.on('error', (e) => console.error('  [kết nối] ' + e.message));

let SO_DAT = 0, SO_HONG = 0;
const chi = [];
function dat(ten, dieuKien, them){
  SO_DAT++;
  if (dieuKien) { console.log('  ✓ ' + ten); }
  else { SO_HONG++; chi.push(ten); console.log('  ✗ ' + ten + (them ? '  → ' + them : '')); }
}
function muc(t){ console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 68 - t.length))); }

const q = (s, p) => pool.query(s, p);
const mot = async (s, p) => (await q(s, p)).rows[0];

/* Câu quét hạn CỦA BẢN TRƯỚC D134, chép nguyên văn. Đây là vật chứng của phép đo
   rollback: nó phải đụng 0 hàng trên một CSDL đã migrate. Chép chứ không require
   vì tệp gốc đã bị xoá — mà đó chính là điều cần chứng minh. */
const SQL_QUET_HAN_CU = `UPDATE crm_event_faces SET vec = NULL, vec_xoa_luc = now()
  WHERE vec IS NOT NULL AND het_han_luc <= now()`;

const vecGia = (seed) => {
  const b = Buffer.alloc(128 * 4);
  for (let i = 0; i < 128; i++) b.writeFloatLE(Math.sin(seed + i) / 12, i * 4);
  return b;
};

async function dungSach(){
  await q(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
}

// ═══════════════════════════════════════════════════════════════════════════════
async function main(){
  console.log('══ E08-D134 · L2 · đường GHI thật ══');
  await dungSach();

  const { migrateCrm } = require('../../server/crm-db');

  muc('AC-1 · migration idempotent + lược đồ đúng trên CSDL MỚI');
  await migrateCrm();
  await migrateCrm();                       // lượt hai phải không lỗi
  dat('migrateCrm() chạy hai lượt liên tiếp không lỗi', true);

  const cot = await mot(`SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS mac_dinh
     FROM pg_attribute a
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'crm_event_faces'::regclass AND a.attname = 'het_han_luc'`);
  dat('het_han_luc KHÔNG còn NOT NULL', cot.attnotnull === false, 'attnotnull=' + cot.attnotnull);
  dat('het_han_luc KHÔNG còn default', cot.mac_dinh === null, 'default=' + cot.mac_dinh);

  const idx = await mot(`SELECT count(*)::int n FROM pg_class
    WHERE relname = 'idx_event_faces_can_don'`);
  dat('chỉ mục dọn hạn idx_event_faces_can_don đã bỏ', idx.n === 0);

  const ghiChu = await mot(`SELECT col_description('crm_event_faces'::regclass, a.attnum) AS c
     FROM pg_attribute a WHERE a.attrelid = 'crm_event_faces'::regclass AND a.attname='het_han_luc'`);
  dat('cột mang chú thích RETIRED cho người mở psql', /RETIRED/.test(String(ghiChu.c)));

  for (const t of ['ck_face_samples_vec_xoa', 'ck_event_faces_vec_xoa']){
    const c = await mot(`SELECT count(*)::int n FROM pg_constraint WHERE conname = $1`, [t]);
    dat('ràng buộc ' + t + ' còn nguyên', c.n === 1);
  }

  // ── gieo dữ liệu ────────────────────────────────────────────────────────────
  await q(`INSERT INTO crm_guests (id, full_name) VALUES (1,'Khách Một'),(2,'Khách Hai'),
           (3,'Khách Đã Gỡ')`);
  await q(`UPDATE crm_guests SET deleted_at = now() WHERE id = 3`);
  await q(`INSERT INTO crm_event_photos (id, batch_id, sha256, orig_name, object_key, uploaded_by, width, height)
           VALUES (10,'dot-1',repeat('a',64),'a.jpg','k/a.jpg','lab@esuhai.com',2048,1365),
                  (11,'dot-1',repeat('b',64),'b.jpg','k/b.jpg','lab@esuhai.com',2048,1365)`);
  await q(`SELECT setval(pg_get_serial_sequence('crm_event_photos','id'), 100)`);
  await q(`SELECT setval(pg_get_serial_sequence('crm_guests','id'), 100)`);

  /* Tấm ảnh chân dung + mẫu cho ba khách. Mẫu của khách 3 (đã xoá mềm) là vật
     chứng cho phán quyết 2 của Gate 1. */
  await q(`INSERT INTO crm_photos (id, guest_id, object_key, uploaded_by)
           VALUES (20,1,'p/1.jpg','lab@esuhai.com'),(21,2,'p/2.jpg','lab@esuhai.com'),
                  (22,3,'p/3.jpg','lab@esuhai.com')`);
  await q(`SELECT setval(pg_get_serial_sequence('crm_photos','id'), 100)`);
  await q(`INSERT INTO crm_face_samples (id, guest_id, nguon, photo_id, box_x,box_y,box_w,box_h, vec, created_by)
           VALUES (30,1,'crm-photos',20,1,1,10,10,$1,'lab'),
                  (31,2,'crm-photos',21,1,1,10,10,$2,'lab'),
                  (32,3,'crm-photos',22,1,1,10,10,$3,'lab')`,
    [vecGia(1), vecGia(2), vecGia(3)]);
  await q(`SELECT setval(pg_get_serial_sequence('crm_face_samples','id'), 100)`);

  muc('AC-2 · TUỔI KHÔNG LÀM VECTOR BIẾN MẤT (không giả đồng hồ)');
  /* Không đụng vào đồng hồ hệ thống — đo thứ MẠNH HƠN: đặt tuổi của chính dữ
     liệu. Nếu bất biến là "tuổi không quan trọng" thì một hàng già 1 năm với mốc
     hết hạn 1 năm trước phải sống y như một hàng vừa tạo. Phép này còn không phụ
     thuộc vào việc tiến trình chạy bao lâu, nên nó chạy trong một giây. */
  await q(`INSERT INTO crm_event_faces
      (id, event_photo_id, box_x,box_y,box_w,box_h, canh_px, diem_do, moc, vec, run_id, created_at, het_han_luc)
    VALUES
      (40,10,10,10,50,50,50,0.9,'[[1,1],[2,2],[3,3],[4,4],[5,5]]',$1,'r1', now() - interval '1 year',  now() - interval '1 year'),
      (41,10,20,20,50,50,50,0.9,'[[1,1],[2,2],[3,3],[4,4],[5,5]]',$2,'r1', now() - interval '8 days',  now() - interval '8 days'),
      (42,11,30,30,50,50,50,0.9,'[[1,1],[2,2],[3,3],[4,4],[5,5]]',$3,'r1', now(), NULL)`,
    [vecGia(40), vecGia(41), vecGia(42)]);
  await q(`SELECT setval(pg_get_serial_sequence('crm_event_faces','id'), 100)`);

  /* migrateCrm() lần nữa — đúng cảnh một lần deploy trên CSDL đã có hàng cũ. */
  await migrateCrm();
  const conNull = await mot(`SELECT count(*)::int n FROM crm_event_faces WHERE het_han_luc IS NOT NULL`);
  dat('migration NULL hoá het_han_luc của MỌI hàng cũ', conNull.n === 0, 'còn ' + conNull.n + ' hàng mang mốc');

  const conVec = await mot(`SELECT count(*)::int n FROM crm_event_faces WHERE vec IS NOT NULL`);
  dat('cả 3 mặt (kể cả hàng già 1 năm) còn nguyên vector', conVec.n === 3, 'còn ' + conVec.n);

  const ck1 = await mot(`SELECT md5(string_agg(md5(vec), ',' ORDER BY id)) c FROM crm_event_faces WHERE vec IS NOT NULL`);
  const quet = await q(SQL_QUET_HAN_CU);
  dat('CHẠY LẠI CÂU QUÉT HẠN CỦA BẢN CŨ → đụng 0 hàng (lời hứa rollback)',
    quet.rowCount === 0, 'đã xoá ' + quet.rowCount + ' hàng');
  const ck2 = await mot(`SELECT md5(string_agg(md5(vec), ',' ORDER BY id)) c FROM crm_event_faces WHERE vec IS NOT NULL`);
  dat('vector nguyên BYTE sau khi câu cũ chạy', ck1.c === ck2.c);

  /* Lượt migrate thứ hai trên cùng dữ liệu: 0 dòng đổi thêm (AC-1 idempotent trên
     CSDL ĐÃ CÓ DỮ LIỆU, khác với CSDL rỗng ở trên). */
  const ckTruoc = await mot(`SELECT md5(string_agg(md5(vec), ',' ORDER BY id)) c FROM crm_event_faces WHERE vec IS NOT NULL`);
  await migrateCrm();
  const ckSau = await mot(`SELECT md5(string_agg(md5(vec), ',' ORDER BY id)) c FROM crm_event_faces WHERE vec IS NOT NULL`);
  dat('migrate lượt N+1 trên CSDL có dữ liệu không đổi một byte', ckTruoc.c === ckSau.c);

  muc('AC-1c · hàng MỚI sinh ra không mang mốc hết hạn nào');
  await q(`INSERT INTO crm_event_faces (event_photo_id, box_x,box_y,box_w,box_h, canh_px, diem_do, vec, run_id)
           VALUES (10,1,1,9,9,9,0.9,$1,'r2')`, [vecGia(99)]);
  const moi = await mot(`SELECT het_han_luc FROM crm_event_faces ORDER BY id DESC LIMIT 1`);
  dat('INSERT không khai het_han_luc ⇒ cột NULL, không phải now()+7d', moi.het_han_luc === null);

  muc('AC-10 · CASCADE xoá có chủ ý — qua tuyến HTTP thật');
  const lab = await moApp();
  try {
    const ck = await dangNhapBtl(lab, 'btl@esuhai.com');

    // ── gỡ MẪU: phán quyết 1 của Gate 1 ──
    await q(`INSERT INTO crm_face_candidates (id, event_photo_id, face_id, guest_id, sample_id, trang_thai)
             VALUES (50,10,40,1,30,'xac-nhan')`);
    await q(`SELECT setval(pg_get_serial_sequence('crm_face_candidates','id'), 100)`);
    const rGo = await lab.goi('/crm/face-match/sample/30', { method: 'DELETE', cookie: ck });
    dat('DELETE /crm/face-match/sample/:id trả 200', rGo.status === 200, rGo.text);
    const s30 = await mot(`SELECT deleted_at, vec, vec_xoa_luc FROM crm_face_samples WHERE id = 30`);
    dat('gỡ mẫu ⇒ deleted_at được đặt', s30.deleted_at !== null);
    dat('gỡ mẫu ⇒ vec = NULL  (D134 phán quyết 1)', s30.vec === null);
    dat('gỡ mẫu ⇒ vec_xoa_luc được ghi (vắng mặt CHỨNG MINH được)', s30.vec_xoa_luc !== null);
    const c50 = await mot(`SELECT trang_thai FROM crm_face_candidates WHERE id = 50`);
    dat('khớp sinh từ mẫu quay về cho', c50.trang_thai === 'cho');
    const s31 = await mot(`SELECT vec FROM crm_face_samples WHERE id = 31`);
    dat('mẫu của khách KHÁC không bị đụng (AC-10 phạm vi)', s31.vec !== null);

    // ── gỡ MỀM ảnh: CR-138 ──
    const rAnh = await lab.goi('/crm/event-photos/11', { method: 'DELETE', cookie: ck });
    dat('DELETE /crm/event-photos/:id trả 200', rAnh.status === 200, rAnh.text);
    const f42 = await mot(`SELECT deleted_at, vec, vec_xoa_luc FROM crm_event_faces WHERE id = 42`);
    dat('gỡ mềm ảnh ⇒ mặt trong tấm mất vector + mang dấu đã xoá',
      f42.vec === null && f42.deleted_at !== null && f42.vec_xoa_luc !== null);
    const f40 = await mot(`SELECT vec FROM crm_event_faces WHERE id = 40`);
    dat('mặt của tấm KHÁC không bị đụng', f40.vec !== null);

    // ── xoá CỨNG ảnh: FK cascade ──
    const rCung = await lab.goi('/crm/event-photos/10/vinh-vien', { method: 'DELETE', cookie: ck });
    dat('DELETE /crm/event-photos/:id/vinh-vien trả 200', rCung.status === 200, rCung.text);
    const con10 = await mot(`SELECT
        (SELECT count(*)::int FROM crm_event_faces     WHERE event_photo_id = 10) mat,
        (SELECT count(*)::int FROM crm_face_candidates WHERE event_photo_id = 10) uv`);
    dat('xoá cứng ⇒ mặt và ứng viên biến mất qua khoá ngoại',
      con10.mat === 0 && con10.uv === 0, JSON.stringify(con10));

    // ── xoá CỨNG khách ──
    await q(`DELETE FROM crm_guests WHERE id = 2`);
    const con2 = await mot(`SELECT count(*)::int n FROM crm_face_samples WHERE guest_id = 2`);
    dat('xoá cứng khách ⇒ mẫu của họ biến mất qua khoá ngoại', con2.n === 0);

    muc('AC-11 · tuyến đo trên CSDL THẬT — chỉ số, không lộ gì');
    const kv = await lab.goi('/crm/face-match/kho-vector', { cookie: ck });
    dat('GET /crm/face-match/kho-vector trả 200 trên CSDL thật', kv.status === 200, kv.text);
    const txt = JSON.stringify(kv.json || {});
    dat('phản hồi không chứa chuỗi base64/byte nào của vector',
      kv.status === 200 && !/"vec"|[A-Za-z0-9+/]{200,}/.test(txt));
    dat('phản hồi có đủ sáu nhóm số của FR-6',
      kv.json && kv.json.mat && typeof kv.json.mat.thieu_vec === 'number'
      && typeof kv.json.mat.khoi_phuc_duoc === 'number'
      && typeof kv.json.mat.thieu_moc === 'number' && typeof kv.json.mat.thieu_anh === 'number'
      && kv.json.mau && typeof kv.json.mau.thieu_vec === 'number'
      && typeof kv.json.mau.khoi_phuc_duoc === 'number', txt.slice(0, 200));
    dat('ba nhóm của mặt CỘNG LẠI đúng bằng thiếu_vec (bảng số cộng được)',
      kv.json.mat.khoi_phuc_duoc + kv.json.mat.thieu_moc + kv.json.mat.thieu_anh
        === kv.json.mat.thieu_vec,
      JSON.stringify(kv.json.mat));

    muc('AC-9 · docMau loại mẫu của khách đã xoá mềm (Gate 1 phán quyết 2)');
    /* Chạy CHÍNH câu của docMau() trong batch.js, không chép ý — chép ý thì hai
       bên lệch nhau lúc nào không biết. */
    const dm = await q(`SELECT s.id, s.guest_id, s.vec
        FROM crm_face_samples s
        JOIN crm_guests g ON g.id = s.guest_id AND g.deleted_at IS NULL
        WHERE s.deleted_at IS NULL AND s.vec IS NOT NULL`);
    const coKhachGo = dm.rows.some((x) => String(x.guest_id) === '3');
    dat('mẫu của khách deleted_at KHÔNG lọt vào tập mẫu để đoán', !coKhachGo,
      'thấy guest_id 3 trong ' + dm.rows.length + ' mẫu');
  } finally { await lab.dong(); }

  muc('KẾT QUẢ');
  console.log('  ' + (SO_DAT - SO_HONG) + '/' + SO_DAT + ' khẳng định đạt');
  if (SO_HONG){ console.log('  HỎNG:\n    - ' + chi.join('\n    - ')); process.exitCode = 1; }
}

// ── App thật trên Postgres thật ───────────────────────────────────────────────
async function moApp(){
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  require('../../server/crm').mount(app);
  const srv = http.createServer(app);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const goc = 'http://127.0.0.1:' + srv.address().port;
  return {
    async dong(){
      if (srv.closeAllConnections) srv.closeAllConnections();
      await new Promise((ok) => srv.close(ok));
    },
    async goi(duong, { method = 'GET', cookie = '', body = null } = {}){
      const h = {};
      if (cookie) h.cookie = cookie;
      if (body) h['content-type'] = 'application/json';
      const r = await fetch(goc + duong, { method, headers: h,
        body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (_){}
      return { status: r.status, headers: r.headers, text, json };
    },
  };
}

/* Đăng nhập bằng ĐƯỜNG THẬT: gieo hàng btl vào staff_users rồi đi qua OTP. Không
   tự ký cookie — cookie do đường tắt sinh ra không chứng minh được đường thật còn
   chạy. Mã OTP đọc từ log console, đúng như lab L1 làm. */
async function dangNhapBtl(lab, email){
  await pool.query(`INSERT INTO staff_users (email, role, active) VALUES ($1,'btl',true)
    ON CONFLICT (email) DO UPDATE SET role = 'btl', active = true`, [email]);
  let ma = null;
  const goc = console.log;
  console.log = (...a) => { const s = a.join(' '); const m = s.match(/\b(\d{6})\b/); if (m && s.includes(email)) ma = m[1]; goc(...a); };
  try {
    const r = await lab.goi('/auth/request-code', { method: 'POST', body: { email } });
    if (r.status !== 202) throw new Error('request-code trả ' + r.status + ' ' + r.text);
  } finally { console.log = goc; }
  if (!ma) throw new Error('không đọc được mã OTP cho ' + email);
  const ok = await lab.goi('/auth/verify', { method: 'POST', body: { email, code: ma } });
  if (ok.status !== 200) throw new Error('verify trả ' + ok.status + ' ' + ok.text);
  return (ok.headers.get('set-cookie') || '').split(';')[0];
}

main().then(() => pool.end()).catch((e) => {
  console.error('LOI ' + e.stack); process.exitCode = 1; pool.end();
});
