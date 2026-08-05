'use strict';

// E08-D029 AC-4 — sinh bản thu nhỏ (256px) và bản vừa (1024px) cho ảnh đã có.
//
//   node server/crm/backfill-thumbs.js              → DRY-RUN: đo thật một mẫu nhỏ rồi ước lượng
//   node server/crm/backfill-thumbs.js --commit     → chạy hết và GHI (CHỜ SPONSOR GO RIÊNG)
//   ... --sample 12        số ảnh xử lý thật trong dry-run (mặc định 8)
//   ... --only-missing     (mặc định) chỉ ảnh còn thiếu bản dẫn xuất
//
// CHẠY TỪ MÁY R1, không phải trong ảnh production. Máy chủ cố ý KHÔNG có thư viện
// ảnh: thêm một phụ thuộc biên dịch gốc vào production ba ngày trước lễ mà build
// hỏng là cả app không lên được. Ở đây dùng `sips` có sẵn trên macOS.
//
// AN TOÀN:
//  * Chỉ ĐỌC object cũ và GHI object ở KEY MỚI (`<key>.t256.jpg` / `.t1024.jpg`).
//    Không sửa, không xoá, không đụng object gốc.
//  * TUYỆT ĐỐI không `railway up` / `redeploy` vào service `minio` — sự cố 8 phút
//    hôm 31/07 đến từ đúng chỗ đó.
//  * Chạy lại được: key tất định, và chỉ đụng dòng còn thiếu khoá.
//  * Bản dẫn xuất ≥ ảnh gốc thì BỎ QUA (ảnh vốn đã nhẹ).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pool } = require('../db');
const { logAudit } = require('./audit');
const storage = require('./storage');

const COMMIT = process.argv.includes('--commit');
const argN = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : dflt;
};
const SAMPLE = argN('--sample', 8);
const ACTOR = 'backfill-thumbs-d029';

const SIZES = [
  { col: 'thumb', suffix: '.t256.jpg', px: 256, q: 75 },
  { col: 'preview', suffix: '.t1024.jpg', px: 1024, q: 80 },
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd029-'));
const kb = (n) => (n / 1024).toFixed(1).padStart(7) + ' KB';
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

async function readAll(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

// sips từ chối file không có đuôi quen thuộc → luôn ghi ra .bin rồi ép format.
function shrink(buf, px, q) {
  const src = path.join(TMP, 'src.bin');
  const out = path.join(TMP, `out-${px}.jpg`);
  fs.writeFileSync(src, buf);
  try { fs.unlinkSync(out); } catch (_) {}
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q),
    '-Z', String(px), src, '--out', out], { stdio: 'ignore' });
  return fs.readFileSync(out);
}

(async () => {
  if (!storage.isConfigured()) throw new Error('MinIO chưa cấu hình (thiếu MINIO_ACCESS_KEY/SECRET_KEY)');
  try { execFileSync('sips', ['--version'], { stdio: 'ignore' }); }
  catch (_) { throw new Error('không có `sips` — script này chạy trên máy macOS của R1, không phải trên server'); }

  const rows = (await pool.query(
    `SELECT id, object_key, size, content_type, thumb_key, preview_key, interaction_id
       FROM crm_photos ORDER BY id`)).rows;
  const todo = rows.filter((r) => !r.thumb_key || !r.preview_key);

  console.log('\n=== AC-4 backfill bản thu nhỏ — ' + (COMMIT ? 'GHI THẬT' : 'DRY-RUN') + ' ===');
  console.log('ảnh trong kho        : ' + rows.length + '  (' + mb(rows.reduce((a, r) => a + (r.size || 0), 0)) + ')');
  console.log('  trong đó ảnh quà   : ' + rows.filter((r) => r.interaction_id).length + '  (không làm avatar, vẫn sinh thumb cho thư viện)');
  console.log('đã đủ bản dẫn xuất   : ' + (rows.length - todo.length));
  console.log('CẦN XỬ LÝ            : ' + todo.length);

  const work = COMMIT ? todo : todo.slice(0, SAMPLE);
  if (!COMMIT) console.log('\nDRY-RUN: xử lý thật ' + work.length + ' ảnh đầu để LẤY SỐ, không ghi gì.');

  let okT = 0; let okP = 0; let skip = 0; let fail = 0;
  let srcBytes = 0; let tBytes = 0; let pBytes = 0;
  const failures = [];

  for (const r of work) {
    let orig;
    try { orig = await readAll(await storage.getObjectStream(r.object_key)); }
    catch (e) { fail++; failures.push('id ' + r.id + ': tải gốc lỗi — ' + e.message); continue; }
    srcBytes += orig.length;
    const set = {};
    for (const s of SIZES) {
      if (r[s.col + '_key']) continue;
      let out;
      try { out = shrink(orig, s.px, s.q); }
      catch (e) { fail++; failures.push('id ' + r.id + ' ' + s.col + ': sips lỗi — ' + e.message); continue; }
      // Ảnh vốn đã nhẹ hơn bản thu nhỏ → giữ gốc, đừng đẻ thêm object.
      if (out.length >= orig.length) { skip++; continue; }
      if (s.col === 'thumb') { okT++; tBytes += out.length; } else { okP++; pBytes += out.length; }
      set[s.col] = { key: r.object_key + s.suffix, buf: out };
    }
    if (!COMMIT || !Object.keys(set).length) continue;
    try {
      for (const col of Object.keys(set)) await storage.putObjectAt(set[col].key, set[col].buf, 'image/jpeg');
      const f = [];
      const v = [r.id];
      for (const col of Object.keys(set)) {
        v.push(set[col].key); f.push(`${col}_key = $${v.length}`);
        v.push(set[col].buf.length); f.push(`${col}_size = $${v.length}`);
      }
      await pool.query(`UPDATE crm_photos SET ${f.join(', ')} WHERE id = $1`, v);
    } catch (e) { fail++; failures.push('id ' + r.id + ': ghi lỗi — ' + e.message); }
  }

  console.log('\n  đã xử lý : ' + work.length + ' ảnh · gốc ' + mb(srcBytes));
  console.log('  bản 256px: ' + okT + ' cái · ' + mb(tBytes) + ' · trung bình ' + (okT ? kb(tBytes / okT) : '—'));
  console.log('  bản 1024 : ' + okP + ' cái · ' + mb(pBytes) + ' · trung bình ' + (okP ? kb(pBytes / okP) : '—'));
  console.log('  bỏ qua (gốc đã nhẹ hơn): ' + skip + ' · lỗi: ' + fail);
  failures.slice(0, 6).forEach((x) => console.log('    ! ' + x));

  if (!COMMIT) {
    if (okT) {
      const per = tBytes / okT;
      console.log('\n  Ước lượng cho cả ' + todo.length + ' ảnh (theo trung bình đo được):');
      console.log('    bản 256px  ≈ ' + mb(per * todo.length));
      console.log('    bản 1024px ≈ ' + mb((pBytes / (okP || 1)) * todo.length));
      console.log('    tải xuống  ≈ ' + mb((srcBytes / work.length) * todo.length));
      console.log('\n  Danh sách cửa Gala mở màn hiện kéo 13,03 MB cho 10 ảnh →');
      console.log('    dự kiến ≈ ' + mb(per * 10) + ' cho cùng 10 ảnh.');
    }
    console.log('\nDRY-RUN — không ghi gì (MinIO lẫn Postgres). Thêm --commit khi anh GO riêng.');
  } else {
    await logAudit(pool, { actor_email: ACTOR, event_type: 'backfill_thumbs',
      target_type: 'crm_photos', meta: { xuLy: work.length, ban256: okT, ban1024: okP, boQua: skip, loi: fail } });
    console.log('\nĐÃ GHI. bản 256px ' + okT + ' · bản 1024px ' + okP + ' · lỗi ' + fail);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  await pool.end();
})().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.error('LỖI:', e.message);
  process.exit(1);
});
