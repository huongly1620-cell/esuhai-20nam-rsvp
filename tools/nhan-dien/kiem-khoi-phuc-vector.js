#!/usr/bin/env node
'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   E08-D134 · TẦNG L3 — KHÔI PHỤC VECTOR trên engine thật, kho thật
   ══════════════════════════════════════════════════════════════════════════════
   Phép đo trung tâm của tệp này là MỘT CON SỐ:

       giongNhau(vector gốc, vector khôi phục)  ≥  0,99

   Vì sao nó quan trọng hơn mọi khẳng định khác trong vé: khôi phục vector là chỗ
   DUY NHẤT có thể hỏng mà không báo gì. Sai thang toạ độ thì catCan() vẫn trả về
   một ảnh 112×112, nhung() vẫn trả về 128 số hợp lệ, UPDATE vẫn thành công, số
   "đã khôi phục" vẫn đẹp — chỉ có điều vector ấy tả một vùng ảnh khác. Không có
   ngoại lệ nào ném ra, không có hàng nào đỏ. Chỉ vài tuần sau mới có người hỏi vì
   sao máy đoán kém hẳn đi, và lúc đó không ai lần ngược được về đây.

   Hai bảng lưu mốc theo HAI QUY ƯỚC NGƯỢC NHAU (2048 cho mặt sự kiện, thang
   buffer cho mẫu), nên phép đo này chạy cho CẢ HAI đường.

   Dữ liệu là mặt VẼ TAY bằng SVG — YuNet nhận ở 0,71–0,90 tuỳ seed (đo thật, xem
   khối chú thích ở phần gieo). Không ảnh người thật nào vào repo hay vào lab.

   Chạy:
     docker run -d --name pg-d134-lab -e POSTGRES_PASSWORD=lab -e POSTGRES_DB=lab \
       -p 55434:5432 postgres:16-alpine
     docker compose -f docker-compose.crm.yml up -d
     DATABASE_URL=postgres://postgres:lab@127.0.0.1:55434/lab PGSSL=disable \
     MINIO_ENDPOINT=127.0.0.1 MINIO_PORT=9000 MINIO_USE_SSL=false \
     MINIO_ACCESS_KEY=devminio MINIO_SECRET_KEY=devminio123 MINIO_BUCKET=lab-d134 \
       node tools/nhan-dien/kiem-khoi-phuc-vector.js
   ══════════════════════════════════════════════════════════════════════════════ */

const URL = process.env.DATABASE_URL || '';
if (!/lab|test/i.test(URL)) {
  console.error('LOI chuỗi kết nối phải mang chữ lab hoặc test — tệp này xoá dữ liệu.');
  process.exit(2);
}
process.env.PGSSL = process.env.PGSSL || 'disable';

const { execFileSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');
const Minio = require('minio');
const sharp = require('sharp');
const E = require('./engine');

const pool = new Pool({ connectionString: URL, ssl: false });
pool.on('error', (e) => console.error('  [kết nối] ' + e.message));
const mc = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT || 443),
  useSSL: String(process.env.MINIO_USE_SSL) === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY, secretKey: process.env.MINIO_SECRET_KEY });
const BUCKET = process.env.MINIO_BUCKET;

let SO = 0, HONG = 0; const chi = [];
function dat(ten, ok, them){
  SO++;
  if (ok) console.log('  ✓ ' + ten);
  else { HONG++; chi.push(ten); console.log('  ✗ ' + ten + (them ? '  → ' + them : '')); }
}
function muc(t){ console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 66 - t.length))); }
const q = (s, p) => pool.query(s, p);
const mot = async (s, p) => (await q(s, p)).rows[0];
const tuBytes = b => { const v = new Array(b.length / 4);
  for (let i = 0; i < v.length; i++) v[i] = b.readFloatLE(i * 4); return v; };

/* ── MẶT VẼ TAY ───────────────────────────────────────────────────────────────
   Mỗi seed cho một khuôn mặt khác nhau (màu da, tóc, khoảng cách mắt, miệng), đủ
   để SFace phân biệt được người này với người kia — nếu mọi mặt giống hệt nhau
   thì phép đo tái khớp ở cuối tệp sẽ xanh vì lý do sai. */
function svgMat(seed){
  const r = (n) => ((Math.sin(seed * 97 + n) + 1) / 2);
  const da  = `hsl(${20 + r(1) * 20},${45 + r(2) * 20}%,${62 + r(3) * 14}%)`;
  const toc = `hsl(${15 + r(4) * 25},${30 + r(5) * 30}%,${12 + r(6) * 22}%)`;
  const mt = 208 + r(11) * 6, mp = 304 + r(13) * 6, my = 222 + r(12) * 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
   <rect width="512" height="512" fill="hsl(${r(7) * 360},25%,80%)"/>
   <ellipse cx="256" cy="235" rx="${118 + r(8) * 14}" ry="${150 + r(9) * 16}" fill="${da}"/>
   <path d="M138 190 Q256 ${70 + r(10) * 25} 374 190 Q374 110 256 100 Q138 110 138 190Z" fill="${toc}"/>
   <ellipse cx="${mt}" cy="${my}" rx="21" ry="12" fill="#fff"/>
   <circle cx="${mt}" cy="${my}" r="9.5" fill="#3a2a1a"/><circle cx="${mt}" cy="${my}" r="4.5" fill="#000"/>
   <ellipse cx="${mp}" cy="${my}" rx="21" ry="12" fill="#fff"/>
   <circle cx="${mp}" cy="${my}" r="9.5" fill="#3a2a1a"/><circle cx="${mp}" cy="${my}" r="4.5" fill="#000"/>
   <path d="M176 200 Q208 188 238 199" stroke="${toc}" stroke-width="9" fill="none" stroke-linecap="round"/>
   <path d="M274 199 Q304 188 336 200" stroke="${toc}" stroke-width="9" fill="none" stroke-linecap="round"/>
   <path d="M256 236 L${244 + r(14) * 5} 285 Q256 293 ${268 + r(15) * 5} 285" stroke="hsl(20,40%,45%)" stroke-width="7" fill="none" stroke-linecap="round"/>
   <path d="M212 325 Q256 ${348 + r(16) * 14} 300 325 Q256 ${360 + r(17) * 10} 212 325Z" fill="hsl(0,45%,${42 + r(18) * 12}%)"/>
   <ellipse cx="176" cy="252" rx="17" ry="12" fill="hsl(0,40%,72%)" opacity="0.35"/>
   <ellipse cx="336" cy="252" rx="17" ry="12" fill="hsl(0,40%,72%)" opacity="0.35"/>
  </svg>`;
}

/* Một "khung phóng sự": nền 2048×1365 với vài khuôn mặt đặt rải. Bản 1024 là bản
   batch thật sự đọc (coalesce(preview_key, object_key)) — đó là cả nguồn gốc của
   bẫy thang toạ độ. */
async function anhSuKien(seeds, viTri){
  const lop = [];
  for (let i = 0; i < seeds.length; i++){
    const m = await sharp(Buffer.from(svgMat(seeds[i]))).resize(440, 440).png().toBuffer();
    lop.push({ input: m, left: viTri[i][0], top: viTri[i][1] });
  }
  const web = await sharp({ create: { width: 2048, height: 1365, channels: 3,
    background: { r: 232, g: 228, b: 220 } } })
    .composite(lop).jpeg({ quality: 88 }).toBuffer();
  const preview = await sharp(web).resize(1024).jpeg({ quality: 84 }).toBuffer();
  return { web, preview };
}
async function anhChanDung(seed){
  const web = await sharp(Buffer.from(svgMat(seed))).resize(1400, 1400).jpeg({ quality: 90 }).toBuffer();
  const preview = await sharp(web).resize(1024).jpeg({ quality: 85 }).toBuffer();
  return { web, preview };
}
const dat_ = (k, b) => mc.putObject(BUCKET, k, b);

// ═══════════════════════════════════════════════════════════════════════════════
async function main(){
  console.log('══ E08-D134 · L3 · khôi phục vector trên engine thật ══');
  if (!await mc.bucketExists(BUCKET).catch(() => false)) await mc.makeBucket(BUCKET);
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrateCrm } = require('../../server/crm-db');
  await migrateCrm();

  muc('GIEO · 3 khung sự kiện (4 mặt) + mẫu khoanh tay + 1 ảnh chân dung');
  const KHUNG = [
    { id: 10, seeds: [1, 2], viTri: [[300, 400], [1200, 380]] },
    { id: 11, seeds: [3],    viTri: [[820, 460]] },
    { id: 12, seeds: [1],    viTri: [[500, 500]] },      // khách 1 xuất hiện lần hai
  ];
  await q(`INSERT INTO crm_guests (id, full_name) VALUES (1,'Khách Một'),(2,'Khách Hai'),(3,'Khách Ba')`);
  await q(`SELECT setval(pg_get_serial_sequence('crm_guests','id'), 100)`);
  for (const k of KHUNG){
    const a = await anhSuKien(k.seeds, k.viTri);
    await dat_('ev/' + k.id + '.jpg', a.web);
    await dat_('ev/' + k.id + '.t1024.jpg', a.preview);
    await q(`INSERT INTO crm_event_photos (id,batch_id,sha256,orig_name,object_key,preview_key,
             uploaded_by,width,height) VALUES ($1,'dot-lab',$2,$3,$4,$5,'lab@esuhai.com',2048,1365)`,
      [k.id, String(k.id).padStart(64, '0'), 'khung-' + k.id + '.jpg',
       'ev/' + k.id + '.jpg', 'ev/' + k.id + '.t1024.jpg']);
  }
  await q(`SELECT setval(pg_get_serial_sequence('crm_event_photos','id'), 100)`);
  /* ── VÌ SAO MẪU Ở ĐÂY LÀ 'cat-tay' CHỨ KHÔNG PHẢI 'crm-photos' ─────────────
     Cửa ảnh mẫu của napMau() đòi điểm YuNet >= 0,90 (MAU_DIEM) — cố ý chặt, vì một
     mẫu sai đầu độc MỌI khớp của khách đó. Mặt vẽ tay đạt 0,71-0,90 tuỳ seed:
     ĐO ĐƯỢC, không phải phỏng đoán. Đuổi theo cửa ấy bằng SVG sẽ cho một phép
     kiểm chập chờn, mà hạ MAU_DIEM là sửa mã sản phẩm để phép kiểm xanh — cấm.

     Đường 'cat-tay' dùng cửa 0,3 (BTL đã tự khoanh, máy chỉ căn lại), nên nó bền
     với mặt vẽ tay. Nó cũng là ĐÚNG kịch bản nghiệp vụ của vé (BTL khoanh mặt cho
     khách không có ảnh chân dung) và đúng quy ước thang cần kiểm: moc của mẫu lưu
     ở THANG BUFFER, ngược với moc của mặt sự kiện.

     Đường 'crm-photos' vẫn được phủ, nhưng bằng một khẳng định khác — xem AC-8b:
     cửa 0,90 phải được TÔN TRỌNG lúc khôi phục, không được nới ra cho dễ. */
  await q(`INSERT INTO crm_face_samples (guest_id,nguon,event_photo_id,box_x,box_y,box_w,box_h,created_by)
           VALUES (1,'cat-tay',10,300,400,440,440,'lab'),
                  (2,'cat-tay',10,1200,380,440,440,'lab')`);
  /* Một ảnh chân dung + một mẫu 'crm-photos' KHÔNG có vector: vật đo cho AC-8b. */
  const acd = await anhChanDung(1);
  await dat_('cd/20.jpg', acd.web);
  await dat_('cd/20.t1024.jpg', acd.preview);
  await q(`INSERT INTO crm_photos (id,guest_id,object_key,preview_key,uploaded_by)
           VALUES (20,1,'cd/20.jpg','cd/20.t1024.jpg','lab@esuhai.com')`);
  await q(`SELECT setval(pg_get_serial_sequence('crm_photos','id'), 100)`);
  await q(`INSERT INTO crm_face_samples (id,guest_id,nguon,photo_id,box_x,box_y,box_w,box_h,created_by)
           VALUES (900,1,'crm-photos',20,100,100,600,600,'lab')`);

  muc('CHẠY BATCH THẬT — sinh crm_event_faces với vector và mốc');
  const env = Object.assign({}, process.env);
  execFileSync('node', [path.join(__dirname, 'batch.js'), '--commit'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const sauBatch = await mot(`SELECT
      (SELECT count(*)::int FROM crm_event_faces  WHERE vec IS NOT NULL) mat_co_vec,
      (SELECT count(*)::int FROM crm_event_faces)                        mat,
      (SELECT count(*)::int FROM crm_face_samples WHERE vec IS NOT NULL) mau,
      (SELECT count(*)::int FROM crm_event_photos WHERE soi_luc IS NOT NULL) da_soi`);
  dat('batch dựng được mặt có vector', sauBatch.mat_co_vec >= 3, JSON.stringify(sauBatch));
  dat('batch tính được vector cho mẫu khoanh tay', sauBatch.mau === 2, JSON.stringify(sauBatch));
  dat('cả 3 tấm đã mang dấu đã soi', sauBatch.da_soi === 3);

  /* Ảnh chụp TRẠNG THÁI GỐC — mọi khẳng định sau đều so về đây. */
  const goc = new Map((await q(`SELECT id, vec FROM crm_event_faces WHERE vec IS NOT NULL`))
    .rows.map(r => [String(r.id), tuBytes(r.vec)]));
  const gocMau = new Map((await q(`SELECT id, vec FROM crm_face_samples WHERE vec IS NOT NULL`))
    .rows.map(r => [String(r.id), tuBytes(r.vec)]));
  const truoc = await anhChup();

  muc('MÔ PHỎNG THIỆT HẠI TTL — đúng câu mà sweeper cũ đã chạy trên prod');
  /* Không bịa một trạng thái hỏng; chạy CHÍNH câu của bản trước D134. Hàng ra
     khỏi đây mang vec = NULL và vec_xoa_luc — đúng hình dạng của nạn nhân TTL
     đang nằm trong prod hôm nay. */
  const hong = await q(`UPDATE crm_event_faces SET vec = NULL, vec_xoa_luc = now()
    WHERE vec IS NOT NULL AND id IN (SELECT id FROM crm_event_faces ORDER BY id LIMIT 3)`);
  const hongMau = await q(`UPDATE crm_face_samples SET vec = NULL, vec_xoa_luc = now()
    WHERE vec IS NOT NULL AND id = (SELECT min(id) FROM crm_face_samples)`);
  console.log('  đã xoá vector của ' + hong.rowCount + ' mặt và ' + hongMau.rowCount + ' mẫu');

  muc('AC-5 · DRY-RUN không ghi một byte nào');
  const ckTruoc = await chuKy();
  const raThu = chay([]);
  const ckSau = await chuKy();
  dat('chữ ký vector TRƯỚC = SAU lượt thử', ckTruoc === ckSau, ckTruoc + ' vs ' + ckSau);
  dat('lượt thử tự khai đã đối chiếu chữ ký', /chữ ký trước\/sau BẰNG NHAU/.test(raThu));
  dat('lượt thử báo đủ nhóm số: khôi phục được / thiếu mốc / ảnh đã gỡ',
    /khôi phục được \d+ · thiếu mốc \d+ · ảnh nguồn đã gỡ \d+/.test(raThu));
  dat('lượt thử báo nhóm số của mẫu', /khôi phục được \d+ · mồ côi nguồn \d+/.test(raThu));

  muc('AC-6 + THANG TOẠ ĐỘ · commit — phép đo trung tâm của cả vé');
  const raGhi = chay(['--commit']);
  const daKhoi = /mặt: khôi phục (\d+)/.exec(raGhi);
  dat('tool báo đã khôi phục đúng số mặt vừa hỏng',
    daKhoi && Number(daKhoi[1]) === hong.rowCount, raGhi.split('\n').slice(-6).join(' | '));

  const lai = await q(`SELECT id, vec FROM crm_event_faces WHERE vec IS NOT NULL`);
  let doThapNhat = 1, soDo = 0;
  for (const r of lai.rows){
    const g = goc.get(String(r.id));
    if (!g) continue;
    const d = E.giongNhau(g, tuBytes(r.vec));
    doThapNhat = Math.min(doThapNhat, d); soDo++;
  }
  dat('MẶT · vector khôi phục ≈ vector gốc (thang 2048 đã đổi ngược đúng): '
    + 'thấp nhất ' + doThapNhat.toFixed(4) + ' trên ' + soDo + ' hàng',
    soDo > 0 && doThapNhat >= 0.99,
    'dưới 0,99 nghĩa là mốc bị đưa vào catCan ở sai thang');

  const laiMau = await q(`SELECT id, vec FROM crm_face_samples WHERE vec IS NOT NULL`);
  let dmMau = 1, sdMau = 0;
  for (const r of laiMau.rows){
    const g = gocMau.get(String(r.id));
    if (!g) continue;
    const d = E.giongNhau(g, tuBytes(r.vec));
    dmMau = Math.min(dmMau, d); sdMau++;
  }
  dat('MẪU · vector khôi phục ≈ vector gốc (thang buffer, quy ước NGƯỢC với mặt): '
    + 'thấp nhất ' + dmMau.toFixed(4) + ' trên ' + sdMau + ' hàng',
    sdMau > 0 && dmMau >= 0.99);

  const sau = await anhChup();
  dat('soi_luc của MỌI tấm không đổi', truoc.soi === sau.soi, truoc.soi + ' vs ' + sau.soi);
  dat('số hàng crm_event_faces không đổi (không nhân đôi mặt)', truoc.mat === sau.mat);
  dat('số hàng crm_face_candidates không đổi', truoc.uv === sau.uv);
  dat('phân bố trạng thái candidate không đổi', truoc.tt === sau.tt, truoc.tt + ' vs ' + sau.tt);
  dat('không mở đợt nhận diện nào', sau.run === 0);
  const mauThuan = await mot(`SELECT
      (SELECT count(*)::int FROM crm_event_faces  WHERE vec IS NOT NULL AND vec_xoa_luc IS NOT NULL) a,
      (SELECT count(*)::int FROM crm_face_samples WHERE vec IS NOT NULL AND vec_xoa_luc IS NOT NULL) b`);
  dat('không hàng nào vừa giữ vector vừa mang dấu đã xoá (CHECK)',
    mauThuan.a === 0 && mauThuan.b === 0, JSON.stringify(mauThuan));

  muc('AC-7 · chạy lại lần hai');
  const ck2 = await chuKy();
  const ra2 = chay(['--commit']);
  const ck3 = await chuKy();
  dat('lần hai khôi phục 0 mặt', /mặt: khôi phục 0/.test(ra2), ra2.split('\n').slice(-5).join(' | '));
  dat('lần hai không đổi chữ ký vector', ck2 === ck3);
  const sau2 = await anhChup();
  dat('lần hai không nhân đôi hàng nào', sau2.mat === sau.mat && sau2.uv === sau.uv);

  muc('AC-8 · hàng đã gỡ và nguồn đã gỡ KHÔNG được hồi sinh');
  /* Ba nhóm, ba lý do khác nhau — mỗi nhóm phải bị chặn bởi một vế WHERE khác. */
  await q(`UPDATE crm_event_faces SET deleted_at = now(), vec = NULL, vec_xoa_luc = now()
           WHERE id = (SELECT min(id) FROM crm_event_faces)`);
  await q(`UPDATE crm_event_photos SET deleted_at = now() WHERE id = 12`);
  await q(`UPDATE crm_event_faces SET vec = NULL, vec_xoa_luc = now() WHERE event_photo_id = 12`);
  /* Nhắm ĐÍCH DANH một mẫu khoanh tay. Bản đầu dùng max(id) và nó trúng luôn mẫu
     900 của AC-8b — hai phép đo giẫm lên nhau, và phép sau đỏ vì một lý do không
     phải lỗi của mã sản phẩm. */
  await q(`UPDATE crm_face_samples SET deleted_at = now(), vec = NULL, vec_xoa_luc = now()
           WHERE nguon = 'cat-tay'
             AND id = (SELECT min(id) FROM crm_face_samples WHERE nguon = 'cat-tay')`);
  const ra3 = chay(['--commit']);
  const matGo = await mot(`SELECT count(*)::int n FROM crm_event_faces
    WHERE deleted_at IS NOT NULL AND vec IS NOT NULL`);
  dat('mặt đã deleted_at KHÔNG được khôi phục', matGo.n === 0);
  const matAnhGo = await mot(`SELECT count(*)::int n FROM crm_event_faces f
    JOIN crm_event_photos e ON e.id = f.event_photo_id
    WHERE e.deleted_at IS NOT NULL AND f.vec IS NOT NULL`);
  dat('mặt có ảnh nguồn đã gỡ KHÔNG được khôi phục', matAnhGo.n === 0);
  const mauGo = await mot(`SELECT count(*)::int n FROM crm_face_samples
    WHERE deleted_at IS NOT NULL AND vec IS NOT NULL`);
  dat('mẫu đã deleted_at KHÔNG được khôi phục', mauGo.n === 0);
  dat('lượt chạy vẫn báo số bỏ qua, không thành công giả',
    /ảnh nguồn đã gỡ [1-9]/.test(ra3) || /mồ côi nguồn [1-9]/.test(ra3)
      || /thiếu mốc \d+/.test(ra3), ra3.split('\n').slice(2, 6).join(' | '));

  muc('AC-8b · KHÔI PHỤC KHÔNG ĐƯỢC NỚI CỬA ẢNH MẪU');
  /* Mẫu 900 lấy từ ảnh chân dung, ảnh nguồn còn sống, thiếu vector ⇒ nó ĐỦ ĐIỀU
     KIỆN để tool thử. Nhưng cửa MAU_DIEM 0,90 của napMau phải được giữ nguyên ở
     đường khôi phục: mặt vẽ tay chỉ đạt ~0,88 nên nó KHÔNG được ghi vector.

     Đây là khẳng định về một cám dỗ có thật. Người viết tool backfill rất dễ nới
     cửa cho "khôi phục được nhiều hơn" — mà một mẫu sai đầu độc MỌI khớp của khách
     đó, nên nới ở đây đắt hơn hẳn ở chỗ tạo. Con số "bỏ qua" là câu trả lời đúng,
     không phải một vector tạm được. */
  const m900 = await mot(`SELECT vec, deleted_at FROM crm_face_samples WHERE id = 900`);
  dat('mẫu chân dung không qua cửa 0,90 KHÔNG được ghi vector tạm bợ',
    m900 && m900.vec === null && m900.deleted_at === null);
  dat('nó được ĐẾM là bỏ/lỗi chứ không biến mất khỏi báo cáo',
    /mẫu: khôi phục \d+ · lỗi\/bỏ [1-9]/.test(ra3), ra3.split('\n').slice(-4).join(' | '));

  muc('AC-11 · audit tổng hợp — chỉ số, không vector');
  const au = await mot(`SELECT meta FROM crm_audit_events
    WHERE event_type = 'face_vec_backfill' ORDER BY id DESC LIMIT 1`);
  dat('có dòng audit face_vec_backfill', !!au);
  if (au){
    const t = JSON.stringify(au.meta);
    dat('audit chỉ chứa số đếm, không vector/khoá kho/tên tệp',
      !/[A-Za-z0-9+/]{60,}/.test(t) && !/object_key|preview_key|\.jpg|orig_name/.test(t), t);
    dat('audit có đủ các nhóm số', au.meta.mat_khoi_phuc !== undefined
      && au.meta.mau_khoi_phuc !== undefined && au.meta.mat_thieu_moc !== undefined);
  }

  muc('AC-9 · tái khớp toàn kho sau khi có MẪU MỚI');
  /* Khách 3 tới giờ chưa có mẫu nào, nên mặt của họ trong khung 11 chưa từng được
     gợi ý. Thêm một ảnh chân dung cho họ rồi chạy batch để có vector mẫu — đó
     đúng là kịch bản nghiệp vụ của vé: CRM có avatar mới. */
  await q(`INSERT INTO crm_face_samples (guest_id,nguon,event_photo_id,box_x,box_y,box_w,box_h,created_by)
           VALUES (3,'cat-tay',11,820,460,440,440,'lab')`);
  execFileSync('node', [path.join(__dirname, 'batch.js'), '--commit'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });

  /* Một quyết định của BTL để bảo vệ: nếu tái khớp hạ cấp nó thì AC-9 đỏ. */
  await q(`UPDATE crm_face_candidates SET trang_thai = 'xac-nhan', decided_by = 'btl@esuhai.com',
           decided_at = now() WHERE id = (SELECT min(id) FROM crm_face_candidates)`);
  const quyetTruoc = await mot(`SELECT id, trang_thai, decided_by FROM crm_face_candidates
    WHERE trang_thai = 'xac-nhan' ORDER BY id LIMIT 1`);

  const uvTruoc = await mot(`SELECT count(*)::int n FROM crm_face_candidates`);
  const kl1 = chayBatch(['--chi-khop-lai', '--commit']);
  const uvSau = await mot(`SELECT count(*)::int n FROM crm_face_candidates`);
  dat('tái khớp chạy được KHÔNG cần MinIO/model (chỉ đọc vector)',
    /TÁI KHỚP · GHI THẬT/.test(kl1), kl1.split('\n')[0]);
  const chuaXacNhan = await mot(`SELECT count(*)::int n FROM crm_face_candidates
    WHERE trang_thai <> 'cho'  AND nguon = 'may' AND run_id = 'run-khop-lai'`);
  dat('mọi dòng tái khớp sinh ra đều ở trạng thái cho', chuaXacNhan.n === 0);

  const quyetSau = await mot(`SELECT trang_thai, decided_by FROM crm_face_candidates WHERE id = $1`,
    [quyetTruoc.id]);
  dat('quyết định xac-nhan của BTL KHÔNG bị hạ cấp',
    quyetSau.trang_thai === 'xac-nhan' && quyetSau.decided_by === quyetTruoc.decided_by,
    JSON.stringify(quyetSau));

  const kl2 = chayBatch(['--chi-khop-lai', '--commit']);
  const uvSau2 = await mot(`SELECT count(*)::int n FROM crm_face_candidates`);
  dat('chạy lại tái khớp KHÔNG đẻ thêm dòng nào', uvSau2.n === uvSau.n,
    uvSau.n + ' → ' + uvSau2.n);
  dat('lần hai tự khai thêm 0 gợi ý', /thêm 0 gợi ý/.test(kl2) || uvSau2.n === uvSau.n);

  const trung = await mot(`SELECT count(*)::int n FROM (
      SELECT face_id, guest_id FROM crm_face_candidates
       WHERE deleted_at IS NULL AND face_id IS NOT NULL
       GROUP BY face_id, guest_id HAVING count(*) > 1) t`);
  dat('không cặp (face_id, guest_id) nào bị nhân đôi', trung.n === 0);

  muc('AC-9b · KHÔNG hồi sinh candidate đã xoá mềm');
  const nan = await mot(`SELECT id, face_id, guest_id FROM crm_face_candidates
    WHERE deleted_at IS NULL AND face_id IS NOT NULL AND trang_thai = 'cho' ORDER BY id LIMIT 1`);
  if (nan){
    await q(`UPDATE crm_face_candidates SET deleted_at = now() WHERE id = $1`, [nan.id]);
    chayBatch(['--chi-khop-lai', '--commit']);
    const song = await mot(`SELECT count(*)::int n FROM crm_face_candidates
      WHERE deleted_at IS NULL AND face_id = $1 AND guest_id = $2`, [nan.face_id, nan.guest_id]);
    dat('cặp đã xoá mềm KHÔNG được tái khớp dựng lại', song.n === 0,
      'thấy ' + song.n + ' dòng sống cho cặp vừa xoá');
  } else dat('có dòng cho để thử hồi sinh', false, 'không dựng được ca đo');

  muc('KẾT QUẢ');
  console.log('  ' + (SO - HONG) + '/' + SO + ' khẳng định đạt');
  if (HONG){ console.log('  HỎNG:\n    - ' + chi.join('\n    - ')); process.exitCode = 1; }
}

function chay(co){
  return execFileSync('node', [path.join(__dirname, 'khoi-phuc-vector.js')].concat(co),
    { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/* Tái khớp cố ý chạy KHÔNG có biến MinIO: nếu nó lỡ đụng tới kho thì lượt này
   ném, và đó chính là điều cần biết. */
function chayBatch(co){
  const e = Object.assign({}, process.env);
  delete e.MINIO_ENDPOINT; delete e.MINIO_ACCESS_KEY;
  delete e.MINIO_SECRET_KEY; delete e.MINIO_BUCKET;
  return execFileSync('node', [path.join(__dirname, 'batch.js')].concat(co),
    { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function chuKy(){
  const r = await mot(`SELECT
     coalesce(md5(string_agg(md5(vec), ',' ORDER BY id)),'-') a FROM crm_event_faces WHERE vec IS NOT NULL`);
  const s = await mot(`SELECT
     coalesce(md5(string_agg(md5(vec), ',' ORDER BY id)),'-') a FROM crm_face_samples WHERE vec IS NOT NULL`);
  return r.a + '/' + s.a;
}
async function anhChup(){
  const r = await mot(`SELECT
     (SELECT coalesce(md5(string_agg(coalesce(soi_luc::text,'-') || ':' || coalesce(soi_so_mat::text,'-'), ',' ORDER BY id)),'-')
        FROM crm_event_photos) soi,
     (SELECT count(*)::int FROM crm_event_faces) mat,
     (SELECT count(*)::int FROM crm_face_candidates) uv,
     (SELECT coalesce(string_agg(trang_thai || '=' || n, ',' ORDER BY trang_thai),'-') FROM
        (SELECT trang_thai, count(*)::text n FROM crm_face_candidates GROUP BY trang_thai) x) tt,
     (SELECT count(*)::int FROM crm_nhan_dien_runs) run`);
  return r;
}

main().then(() => pool.end()).catch((e) => {
  console.error('LOI ' + (e.stack || e.message));
  if (e.stdout) console.error('--- stdout ---\n' + e.stdout);
  if (e.stderr) console.error('--- stderr ---\n' + String(e.stderr).split('\n').filter(l => !/onnxruntime/.test(l)).join('\n'));
  process.exitCode = 1; pool.end();
});
