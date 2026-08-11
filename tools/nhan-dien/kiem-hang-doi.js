#!/usr/bin/env node
'use strict';
/* E08-D126 · KIỂM GIAO THỨC HÀNG ĐỢI — chạy được trên một Postgres rỗng.
 *
 * Vì sao tệp này tồn tại: bất biến quan trọng nhất của vé này — «không tấm nào
 * bị soi hai lần, không tấm nào bị bỏ» — trước nay chỉ được chứng minh bằng lập
 * luận về thứ tự khởi động, và tối 11/08 cho thấy lập luận không đủ. Ở đây nó
 * được chứng minh bằng cách CHẠY: nhiều luồng thật, cùng một cơ sở dữ liệu, cùng
 * đúng những câu SQL mà máy quét dùng (hang-doi.js), rồi đếm lại.
 *
 * KHÔNG cần engine, không cần model, không cần MinIO, không đụng kho ảnh thật.
 * Ảnh ở đây là hàng giả trong một cơ sở dữ liệu lab; «soi một tấm» là ngủ vài
 * mili giây rồi ghi một hàng mặt giả.
 *
 * Chạy:
 *   DATABASE_URL=postgres://…/lab node tools/nhan-dien/kiem-hang-doi.js
 *   DATABASE_URL=… node kiem-hang-doi.js --anh 600 --luong 5
 *
 * CẢNH BÁO: tệp này XOÁ và gieo lại dữ liệu ảnh trong cơ sở dữ liệu nó trỏ tới.
 * Nó từ chối chạy nếu chuỗi kết nối không mang chữ `lab` hoặc `test` — không có
 * chỗ nào cho một lần dán nhầm chuỗi kết nối production.
 */
const { Pool } = require('pg');
const HD = require('./hang-doi');

const CO = process.argv.slice(2);
const so = (k, m) => { const i = CO.indexOf(k); return i < 0 ? m : Number(CO[i + 1]); };
const SO_ANH = so('--anh', 400);
const SO_LUONG = so('--luong', 4);

const URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
if (!URL) { console.error('LOI thiếu DATABASE_URL'); process.exit(2); }
if (!/lab|test/i.test(URL)) {
  console.error('LOI chuỗi kết nối phải mang chữ lab hoặc test — tệp này xoá dữ liệu ảnh.');
  process.exit(2);
}

/* Nhịp dọn của web dùng `server/db`, và tệp ấy đọc DATABASE_URL NGAY LÚC NẠP
   MODULE. Đặt trước mọi cú require xuống server/, nếu không thì bộ kiểm nối vào
   lab còn nhịp dọn nối vào… không đâu cả. */
process.env.DATABASE_URL = URL;

const pool = new Pool({ connectionString: URL });
pool.on('error', (e) => console.error('  [kết nối] ' + e.message));
const ngu = (ms) => new Promise((r) => setTimeout(r, ms));

const KQ = [];
function cham(ten, dat, chi) {
  KQ.push({ ten, dat, chi });
  console.log((dat ? '  ✓ ' : '  ✗ ') + ten + (chi ? ' — ' + chi : ''));
}

async function gieo() {
  await pool.query('DELETE FROM crm_face_candidates');
  await pool.query('DELETE FROM crm_event_faces');
  await pool.query('DELETE FROM crm_event_photos');
  await pool.query('DELETE FROM crm_nhan_dien_luong');
  await pool.query('DELETE FROM crm_nhan_dien_runs');
  await pool.query(
    `INSERT INTO crm_event_photos (batch_id, sha256, orig_name, object_key, uploaded_by, width, height)
     SELECT 'kiem', 'sha-' || i, 'anh-' || i || '.jpg', 'key-' || i, 'kiem@lab', 2048, 1365
       FROM generate_series(1, $1) i`, [SO_ANH]);
  const run = (await pool.query(
    `INSERT INTO crm_nhan_dien_runs (nguon, boi, so_luong, nguong)
     VALUES ('tay', 'kiem@lab', $1, 0.45) RETURNING id`, [SO_LUONG])).rows[0];
  await pool.query(
    `INSERT INTO crm_nhan_dien_luong (run_id, so) SELECT $1, i FROM generate_series(1,$2) i`,
    [run.id, SO_LUONG]);
  return Number(run.id);
}

/* Một máy quét giả. Cùng vòng đời với chayMotLuong() của batch.js — xin luồng,
   xin ảnh, đọc cờ sau mỗi tấm, nhả khi tạm dừng — chỉ thay phần dò mặt bằng một
   giấc ngủ. Đó là chỗ duy nhất được phép khác, và nó không nằm trong bất biến. */
async function mayQuetGia(ten, kySu) {
  const luong = await HD.xinLuong(pool, ten);
  if (!luong) return null;
  kySu.nhan.push({ ten, so: luong.so, id: luong.id });
  const d = { da_soi: 0, so_mat: 0, goi_y: 0, so_loi: 0 };

  for (;;) {
    if (kySu.chet.has(ten)) return luong;      // giả lập kill -9: biến mất, không dọn gì
    const co = await HD.nhip(pool, luong.id, d);
    if (co.dot === 'huy' || co.luong === 'huy') {
      await HD.nhaAnh(pool, luong.id);
      await HD.chotLuong(pool, luong.id, 'huy', d, null);
      return luong;
    }
    if (co.luong === 'mat-lien-lac') { await HD.nhaAnh(pool, luong.id); return luong; }
    if (co.luong === 'tam-dung' || co.dot === 'tam-dung') {
      await HD.nhaAnh(pool, luong.id);
      await ngu(50);
      continue;
    }
    if (co.luong !== 'chay') { await HD.nhaAnh(pool, luong.id); return luong; }

    const tam = await HD.xinAnh(pool, luong.id, HD.GIU_MOI_LUOT);
    if (!tam.length) { await HD.chotLuong(pool, luong.id, 'xong', d, null); return luong; }

    for (const a of tam) {
      if (kySu.chet.has(ten)) return luong;
      await ngu(2 + Math.floor(Math.random() * 6));   // «dò mặt»
      const cli = await pool.connect();
      try {
        await cli.query('BEGIN');
        if (!await HD.danhDauDaSoi(cli, a.id, luong.id, 1)) { await cli.query('ROLLBACK'); continue; }
        await cli.query(
          `INSERT INTO crm_event_faces (event_photo_id,box_x,box_y,box_w,box_h,canh_px,diem_do,run_id)
           VALUES ($1,1,1,10,10,10,0.9,$2)`, [a.id, 'luong-' + luong.id]);
        await cli.query('COMMIT');
        d.da_soi++; d.so_mat++;
      } catch (e) {
        await cli.query('ROLLBACK').catch(() => {});
        d.so_loi++;
        await HD.nhaAnh(pool, luong.id).catch(() => {});
      } finally { cli.release(); }

      const co2 = await HD.nhip(pool, luong.id, Object.assign({ anh_hien_tai: a.orig_name }, d));
      if (co2.luong !== 'chay' || co2.dot !== 'chay') break;
    }
  }
}

async function dem(sql, args) {
  return Number((await pool.query('SELECT count(*)::int AS n FROM ' + sql, args)).rows[0].n);
}

(async () => {
  console.log('── KIỂM HÀNG ĐỢI ──  ' + SO_ANH + ' tấm · ' + SO_LUONG + ' luồng');
  const runId = await gieo();
  const kySu = { nhan: [], chet: new Set() };

  /* ── Phép thử 1 · nhiều luồng cùng cào một hàng đợi ────────────────────────
     Khởi động TẤT CẢ cùng lúc, không lệch giây nào — đúng điều mà cách chia việc
     bằng offset không chịu nổi. */
  const chay = [];
  for (let i = 1; i <= SO_LUONG; i++) chay.push(mayQuetGia('may-' + i, kySu));

  /* ── Phép thử 2 · Tạm dừng ăn trong 5 giây ─────────────────────────────────
     Đợi cho việc chạy được một lúc rồi bấm tạm dừng luồng đầu tiên nhận được. */
  await ngu(400);
  const nan = (await pool.query(
    `SELECT id, so FROM crm_nhan_dien_luong WHERE run_id = $1 AND trang_thai = 'chay'
      ORDER BY so LIMIT 1`, [runId])).rows[0];
  let acTamDung = null;
  if (nan) {
    const truoc = (await pool.query('SELECT da_soi FROM crm_nhan_dien_luong WHERE id = $1', [nan.id])).rows[0].da_soi;
    await pool.query(`UPDATE crm_nhan_dien_luong SET trang_thai = 'tam-dung' WHERE id = $1`, [nan.id]);
    await ngu(1200);
    const giu = await dem('crm_event_photos WHERE soi_luong_id = $1 AND soi_luc IS NULL', [nan.id]);
    const a = (await pool.query('SELECT da_soi FROM crm_nhan_dien_luong WHERE id = $1', [nan.id])).rows[0].da_soi;
    await ngu(600);
    const b = (await pool.query('SELECT da_soi FROM crm_nhan_dien_luong WHERE id = $1', [nan.id])).rows[0].da_soi;
    acTamDung = { giu, a, b, truoc };
    cham('AC-3 · tạm dừng: nhả hết tấm chưa soi trong 1,2 giây', giu === 0, 'còn giữ ' + giu + ' tấm');
    cham('AC-3 · tạm dừng: số tấm ngừng tăng ở hai nhịp đọc liên tiếp', a === b, a + ' rồi ' + b);
    /* Tiếp tục: việc giao theo TẤM nên không cần nhớ đang ở đâu. */
    await pool.query(`UPDATE crm_nhan_dien_luong SET trang_thai = 'chay' WHERE id = $1`, [nan.id]);
  }

  await Promise.all(chay);

  /* ── Phép thử 3 · đếm lại ──────────────────────────────────────────────────
     Hai câu của AC-2, nguyên văn. */
  const doi = await dem(
    `(SELECT event_photo_id FROM crm_event_faces
       GROUP BY event_photo_id HAVING count(DISTINCT run_id) > 1) t`, []);
  cham('AC-2 · không tấm nào bị hai luồng soi', doi === 0, doi + ' tấm bị soi hai lần');

  const giuMaSoi = await dem('crm_event_photos WHERE soi_luong_id IS NOT NULL AND soi_luc IS NOT NULL', []);
  cham('AC-2 · soi xong thì nhả dấu giữ', giuMaSoi === 0, giuMaSoi + ' tấm vừa soi vừa còn bị giữ');

  const chuaSoi = await dem('crm_event_photos WHERE soi_luc IS NULL', []);
  cham('không tấm nào bị bỏ sót', chuaSoi === 0, chuaSoi + ' tấm còn trong hàng đợi');

  const soMat = await dem('crm_event_faces', []);
  cham('mỗi tấm đúng một hàng mặt (không ghi đôi)', soMat === SO_ANH, soMat + '/' + SO_ANH);

  const tong = (await pool.query(
    'SELECT coalesce(sum(da_soi),0)::int AS n FROM crm_nhan_dien_luong WHERE run_id = $1', [runId])).rows[0].n;
  cham('AC-5 · số trên sổ luồng khớp số tấm đã soi', tong === SO_ANH, tong + '/' + SO_ANH);

  const kho = (await pool.query(
    `SELECT count(*)::int AS kho, count(*) FILTER (WHERE soi_luc IS NOT NULL)::int AS da,
            count(*) FILTER (WHERE soi_luc IS NULL)::int AS con
       FROM crm_event_photos WHERE deleted_at IS NULL`)).rows[0];
  cham('AC-5 · đã soi + còn lại = kho tổng', kho.da + kho.con === kho.kho,
    kho.da + ' + ' + kho.con + ' = ' + kho.kho);

  /* ── Phép thử 4 · AC-6 · đợt sau không soi lại gì ──────────────────────────
     Kể cả tấm không thấy mặt nào: ở đây mọi tấm đều được đánh dấu, nên hàng đợi
     của đợt kế tiếp phải là 0. */
  const hangDoiMoi = await dem(
    'crm_event_photos WHERE deleted_at IS NULL AND soi_luc IS NULL AND soi_luong_id IS NULL', []);
  cham('AC-6 · đợt mới thấy hàng đợi 0 tấm', hangDoiMoi === 0, hangDoiMoi + ' tấm');

  /* ── Phép thử 5 · AC-7 · máy quét chết thì ảnh về lại hàng đợi ─────────────
     Dựng một đợt mới, cho một luồng nhận việc rồi biến mất giữa chừng (không
     nhả gì, không chốt sổ) — đúng như `kill -9` hoặc đóng nắp máy. Rồi chạy nhịp
     dọn CỦA WEB (cùng hàm thật, không phải bản chép lại) với hạn nhịp kéo về 0
     để khỏi ngồi đợi ba phút. */
  await pool.query('DELETE FROM crm_event_faces');
  await pool.query('UPDATE crm_event_photos SET soi_luc = NULL, soi_so_mat = NULL, soi_luong_id = NULL');
  await pool.query(`UPDATE crm_nhan_dien_runs SET trang_thai = 'xong', xong_luc = now() WHERE id = $1`, [runId]);
  const run2 = (await pool.query(
    `INSERT INTO crm_nhan_dien_runs (nguon, boi, so_luong, nguong)
     VALUES ('tay','kiem@lab',1,0.45) RETURNING id`)).rows[0];
  await pool.query('INSERT INTO crm_nhan_dien_luong (run_id, so) VALUES ($1, 1)', [run2.id]);
  const l2 = await HD.xinLuong(pool, 'may-chet');
  const giuTruoc = (await HD.xinAnh(pool, l2.id, HD.GIU_MOI_LUOT)).length;
  await pool.query(
    `UPDATE crm_nhan_dien_luong SET nhip_cuoi = now() - interval '10 minutes' WHERE id = $1`, [l2.id]);

  const { donLuongChet } = require('../../server/crm/nhan-dien-run');
  await donLuongChet();

  const tt2 = (await pool.query('SELECT trang_thai FROM crm_nhan_dien_luong WHERE id = $1', [l2.id])).rows[0].trang_thai;
  cham('AC-7 · luồng quá hạn nhịp bị đánh mất liên lạc', tt2 === 'mat-lien-lac', 'trạng thái ' + tt2);
  const conGiu = await dem('crm_event_photos WHERE soi_luong_id = $1', [l2.id]);
  cham('AC-7 · tấm của luồng chết quay về hàng đợi', conGiu === 0,
    giuTruoc + ' tấm bị giữ, còn lại ' + conGiu);

  /* ── Phép thử 6 · AC-12 · tự hãm khi lỗi dồn ──────────────────────────────
     Phép quyết định thuần, không cần CSDL: bơm đúng những chuỗi kết cục mà tối
     11/08 đã xảy ra và những chuỗi KHÔNG được phép làm luồng dừng. */
  const day = (n, v) => Array.from({ length: n }, () => v);
  cham('AC-12 · 100% lỗi trong 20 tấm đầu thì hãm', !!HD.nenTuHam(day(20, true)));
  cham('AC-12 · một tấm lỗi lẻ KHÔNG làm dừng luồng', HD.nenTuHam([true]) === null);
  cham('AC-12 · 19 tấm chưa đủ để kết luận', HD.nenTuHam(day(19, true)) === null);
  cham('AC-12 · 20% chẵn thì chưa hãm (ngưỡng là VƯỢT 20%)',
    HD.nenTuHam(day(20, true).fill(false, 4)) === null);
  cham('AC-12 · 21/100 lỗi thì hãm',
    !!HD.nenTuHam(day(100, false).fill(true, 0, 21)));
  cham('AC-12 · luồng chạy sạch không bao giờ tự hãm', HD.nenTuHam(day(100, false)) === null);

  const hong = KQ.filter((x) => !x.dat);
  console.log('\n' + (KQ.length - hong.length) + '/' + KQ.length + ' phép thử đạt');
  await pool.end();
  process.exit(hong.length ? 1 : 0);
})().catch(async (e) => {
  console.error('LOI ' + e.message);
  try { await pool.end(); } catch (_) { /* đang thoát */ }
  process.exit(1);
});
