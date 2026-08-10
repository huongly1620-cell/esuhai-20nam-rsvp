'use strict';
/* E08-D077 · Batch nhận diện — MẶC ĐỊNH DRY-RUN, chỉ ghi khi có --commit.
   Chạy TÁCH khỏi esuhai-web (FR-1). Không tự gán cho ai: mọi thứ nó sinh ra đều
   ở trạng thái 'cho' (chờ người xác nhận) — CR-127.

   Dùng:
     node batch.js                      # thử, không ghi gì
     node batch.js --commit             # ghi thật
     node batch.js --gioi-han 100       # chỉ 100 ảnh đầu
     node batch.js --nguong 0.55        # ngưỡng gợi ý
*/
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Pool } = require('pg');
const Minio = require('minio');
const E = require('./engine');

const CO = process.argv.slice(2);
const co  = k => CO.includes(k);
const so  = (k, m) => { const i = CO.indexOf(k); return i < 0 ? m : Number(CO[i + 1]); };
const GHI     = co('--commit');
const GIOI_HAN = so('--gioi-han', 0);
const BO_QUA   = so('--bo-qua', 0);
/* NGƯỠNG TẠM, chưa phải ngưỡng vận hành. 0,55 lấy từ thí nghiệm chân dung↔chân
   dung KHÔNG chuyển sang được: đo trên kho thật, mặt sự kiện khớp mẫu ở p50≈0,28
   trong khi mặt sự kiện khớp NHAU ở ~0,95. Cặp chéo miền điểm cao nhất (0,619)
   soi mắt thì đúng người, nên engine bắc được cầu — chỉ là thang điểm khác hẳn.
   Precision ở 0,35 CHƯA ĐO. Chính hàng đợi duyệt của BTL mới sinh ra số cho
   AC-5, và ngưỡng chốt sau khi có số đó. */
const NGUONG  = so('--nguong', 0.35);
const TOP     = so('--top', 5);

/* Cửa ảnh MẪU — chặt hơn cửa dò ảnh sự kiện. Đo thật trên crm_photos: có ảnh
   lẵng hoa nằm dưới một guest_id và YuNet vẫn trả về "một mặt" ở ngưỡng 0,5.
   Một mẫu sai đầu độc MỌI khớp của khách đó, nên chỗ này không được rộng rãi. */
const MAU_DIEM   = 0.9;
const MAU_TI_LE  = 0.10;
const MAU_TRO_AT = 0.5;

/* Dựng LƯỜI. Bản đầu tạo client MinIO ngay ở tầng module, nên chạy mà thiếu biến
   môi trường thì nó ném `endPoint: undefined` trước khi kịp kiểm gì — người chạy
   nhận một vết ngăn xếp thay vì câu nói rõ mình thiếu cái gì. Mỗi hỏng phải nói
   đúng tên của nó. */
let _pool = null, _mc = null;
const BUCKET = process.env.MINIO_BUCKET;
function kiemMoiTruong(){
  const thieu = ['MINIO_ENDPOINT','MINIO_ACCESS_KEY','MINIO_SECRET_KEY','MINIO_BUCKET']
    .filter(k => !process.env[k]);
  if (!process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) thieu.push('DATABASE_URL');
  if (thieu.length) throw new Error('thiếu biến môi trường: ' + thieu.join(', ')
    + '\n  Chạy qua `railway run --service esuhai-web -- node batch.js` để nó tự bơm vào,'
    + '\n  và ĐỪNG dán chuỗi kết nối thẳng lên dòng lệnh.');
}
function db(){ return _pool || (_pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } })); }
function kho(){ return _mc || (_mc = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT || 443),
  useSSL: String(process.env.MINIO_USE_SSL) === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY, secretKey: process.env.MINIO_SECRET_KEY })); }

const layObj = k => new Promise((res, rej) => { const c = []; kho().getObject(BUCKET, k, (e, s) => e ? rej(e)
  : (s.on('data', d => c.push(d)), s.on('end', () => res(Buffer.concat(c))), s.on('error', rej))); });

const veBytes = v => { const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
const tuBytes = b => { const v = new Array(b.length / 4);
  for (let i = 0; i < v.length; i++) v[i] = b.readFloatLE(i * 4); return v; };

function batBuoc(){
  /* AC-4 · thiếu model thì DỪNG, không tự tải. Batch tự tải nghĩa là "0 egress
     lúc chạy" không còn kiểm được, và một lần chạy có thể lặng lẽ kéo về file
     khác với file đã duyệt. */
  for (const f of ['yunet.onnx', 'sface.onnx']){
    if (!fs.existsSync(path.join(__dirname, 'model', f)))
      throw new Error('thiếu model/' + f + ' — chạy `npm run tai-model` trước. '
        + 'Batch KHÔNG tự tải (AC-4).');
  }
}

async function napMau(phien, log){
  /* Mẫu = ảnh chân dung đã gắn khách sẵn trong crm_photos (FR-2). Ảnh nào đã có
     mẫu rồi thì bỏ qua — chạy lại đợt không nhúng lại từ đầu. */
  /* Ở chế độ THỬ, không đụng bảng mới: lệnh thử phải chạy được TRƯỚC khi lược đồ
     lên prod, không thì nó vô dụng đúng lúc người ta cần nó nhất — lúc chưa dám
     đổi gì. Mẫu giữ trong bộ nhớ và trả về. */
  const r = (await db().query(GHI ? `
    SELECT p.id, p.guest_id, coalesce(p.preview_key, p.object_key) k
    FROM crm_photos p
    WHERE NOT EXISTS (SELECT 1 FROM crm_face_samples s
                      WHERE s.photo_id = p.id AND s.deleted_at IS NULL)
    ORDER BY p.guest_id, p.id` : `
    SELECT p.id, p.guest_id, coalesce(p.preview_key, p.object_key) k
    FROM crm_photos p ORDER BY p.guest_id, p.id`)).rows;
  const trongBoNho = [];
  const loai = { khongMat: 0, diem: 0, nho: 0, dongNguoi: 0, loi: 0 };
  let them = 0;
  for (const x of r){
    try {
      const buf = await layObj(x.k);
      const mat = await E.phatHien(phien, buf, { nguongDiem: 0.5 });
      if (!mat.length){ loai.khongMat++; continue; }
      mat.sort((a, b) => (b.w * b.h) - (a.w * a.h));
      if (mat[0].diem < MAU_DIEM){ loai.diem++; continue; }
      const g = await E.anhGoc(buf);
      if (Math.max(mat[0].w, mat[0].h) / Math.max(g.w, g.h) < MAU_TI_LE){ loai.nho++; continue; }
      if (mat.length > 1 && (mat[1].w * mat[1].h) > MAU_TRO_AT * (mat[0].w * mat[0].h)){ loai.dongNguoi++; continue; }
      const vec = await E.nhung(phien, E.catCan(g.raw, g.w, g.h, mat[0].moc));
      them++;
      if (!GHI) trongBoNho.push({ id: null, guest: String(x.guest_id), v: vec });
      if (GHI) await db().query(`INSERT INTO crm_face_samples
        (guest_id,nguon,photo_id,box_x,box_y,box_w,box_h,moc,vec,diem_do,created_by)
        VALUES ($1,'crm-photos',$2,$3,$4,$5,$6,$7,$8,$9,'batch-d077')`,
        [x.guest_id, x.id, mat[0].x, mat[0].y, mat[0].w, mat[0].h,
         JSON.stringify(mat[0].moc), veBytes(vec), mat[0].diem]);
    } catch (e){ loai.loi++; }
  }
  log('  mẫu: xét ' + r.length + ' ảnh chân dung · nhận ' + them
    + ' · loại: không thấy mặt ' + loai.khongMat + ', điểm thấp ' + loai.diem
    + ', mặt quá nhỏ ' + loai.nho + ', nhiều người ' + loai.dongNguoi + ', lỗi ' + loai.loi);
  return trongBoNho;
}

async function docMau(){
  const r = (await db().query(`SELECT id, guest_id, vec FROM crm_face_samples
    WHERE deleted_at IS NULL AND vec IS NOT NULL`)).rows;
  return r.map(x => ({ id: x.id, guest: String(x.guest_id), v: tuBytes(x.vec) }));
}

(async () => {
  batBuoc();
  kiemMoiTruong();
  const runId = 'run-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
              + '-' + crypto.randomBytes(3).toString('hex');
  const log = s => console.log(s);
  log((GHI ? '── GHI THẬT ──' : '── THỬ (không ghi gì) ──') + '  đợt ' + runId
    + '  ngưỡng ' + NGUONG + '  top ' + TOP);

  const phien = await E.moPhien();
  const mauTam = await napMau(phien, log);
  const mau = GHI ? await docMau() : mauTam;
  log('  mẫu dùng để so: ' + mau.length + ' vector · ' + new Set(mau.map(m => m.guest)).size + ' khách');
  if (!mau.length) throw new Error('không có mẫu nào dùng được — kiểm lại cửa ảnh mẫu');

  const anh = (await db().query(`SELECT id, orig_name, coalesce(preview_key, object_key) k
    FROM crm_event_photos WHERE deleted_at IS NULL
      ${GHI ? `AND NOT EXISTS (SELECT 1 FROM crm_event_faces f
               WHERE f.event_photo_id = crm_event_photos.id AND f.deleted_at IS NULL)` : ''}
    ORDER BY id ${GIOI_HAN ? 'LIMIT ' + GIOI_HAN : ''} ${BO_QUA ? 'OFFSET ' + BO_QUA : ''}`)).rows;
  log('  ảnh sự kiện cần xử lý: ' + anh.length);

  let soMat = 0, soGoi = 0, khongMat = 0, loiAnh = 0;
  const phanBo = [], diemTot = [], kho2 = [];
  const t0 = Date.now();
  for (const a of anh){
    try {
      const buf = await layObj(a.k);
      const mat = await E.phatHien(phien, buf, { nguongDiem: 0.6 });
      if (!mat.length){ khongMat++; continue; }
      const g = await E.anhGoc(buf);
      for (const m of mat){
        const crop = E.catCan(g.raw, g.w, g.h, m.moc);
        const vec = await E.nhung(phien, crop);
        const canh = Math.max(m.w, m.h), net = E.doNet(crop);
        phanBo.push([canh, net]);
        soMat++;
        let faceId = null;
        if (GHI){
          faceId = (await db().query(`INSERT INTO crm_event_faces
            (event_photo_id,box_x,box_y,box_w,box_h,canh_px,do_net,diem_do,moc,vec,run_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [a.id, m.x, m.y, m.w, m.h, canh, net, m.diem, JSON.stringify(m.moc), veBytes(vec), runId])).rows[0].id;
        }
        /* Một khách chỉ giữ điểm CAO NHẤT trong số các mẫu của họ: nhiều mẫu cùng
           người không được biến thành nhiều gợi ý trùng nhau. */
        const theoKhach = new Map();
        let totNhat = -1;
        for (const s of mau){
          const d = E.giongNhau(vec, s.v);
          if (d > totNhat) totNhat = d;
          if (d < NGUONG) continue;
          const cu = theoKhach.get(s.guest);
          if (!cu || d > cu.d) theoKhach.set(s.guest, { d, sample: s.id });
        }
        diemTot.push([totNhat, canh, net]);
        if (!GHI) kho2.push({ anh: a.id, canh, v: vec });
        const top = [...theoKhach.entries()].map(([g2, o]) => ({ guest: g2, ...o }))
          .sort((x, y) => y.d - x.d).slice(0, TOP);
        soGoi += top.length;
        if (GHI){
          for (const t of top)
            await db().query(`INSERT INTO crm_face_candidates
              (event_photo_id,face_id,guest_id,sample_id,score,nguon,trang_thai,run_id)
              VALUES ($1,$2,$3,$4,$5,'may','cho',$6)
              ON CONFLICT DO NOTHING`, [a.id, faceId, t.guest, t.sample, t.d, runId]);
        }
      }
    } catch (e){ loiAnh++; }
  }
  const giay = (Date.now() - t0) / 1000;
  log('  xử lý ' + anh.length + ' ảnh trong ' + giay.toFixed(1) + 's ('
    + (anh.length ? (giay * 1000 / anh.length).toFixed(0) : 0) + 'ms/ảnh)');
  log('  mặt tìm được: ' + soMat + ' · ảnh không thấy mặt nào: ' + khongMat + ' · ảnh lỗi: ' + loiAnh);
  log('  gợi ý ≥ ' + NGUONG + ': ' + soGoi + (soMat ? ' (' + (soGoi / soMat).toFixed(2) + '/mặt)' : ''));

  /* Phân bố cạnh × độ nét — dữ liệu để CHỐT ngưỡng FR-8, không phải để tự chốt. */
  if (phanBo.length){
    const canh = phanBo.map(x => x[0]).sort((a, b) => a - b);
    const net  = phanBo.map(x => x[1]).sort((a, b) => a - b);
    const pct = (a, p) => a[Math.floor(a.length * p)].toFixed(a === net ? 3 : 0);
    log('  phân bố cạnh(px): p10 ' + pct(canh, .1) + ' · p50 ' + pct(canh, .5) + ' · p90 ' + pct(canh, .9));
    log('  phân bố độ nét  : p10 ' + pct(net, .1) + ' · p50 ' + pct(net, .5) + ' · p90 ' + pct(net, .9));
  }
  /* Điểm KHỚP TỐT NHẤT của mỗi mặt — biết ngưỡng đang đứng ở đâu so với thực tế.
     Không có bảng này thì "4 gợi ý" không phân biệt được "ngưỡng quá cao" với
     "khớp hỏng", mà hai chuyện đó cần hai cách chữa khác hẳn nhau. */
  if (diemTot.length){
    const d = diemTot.map(x => x[0]).sort((a, b) => a - b);
    const q = p2 => d[Math.floor(d.length * p2)].toFixed(3);
    log('  điểm khớp tốt nhất mỗi mặt: p50 ' + q(.5) + ' · p90 ' + q(.9)
      + ' · p99 ' + q(.99) + ' · cao nhất ' + d[d.length - 1].toFixed(3));
    for (const t of [0.30, 0.35, 0.40, 0.45, 0.50, 0.55]){
      const n = d.filter(x => x >= t).length;
      log('    ngưỡng ' + t.toFixed(2) + ' → ' + n + '/' + d.length + ' mặt có gợi ý ('
        + (n / d.length * 100).toFixed(1) + '%)');
    }
    /* Mặt to có khớp tốt hơn không — nếu có thì vấn đề là cỡ mặt, không phải model. */
    const to = diemTot.filter(x => x[1] >= 100).map(x => x[0]).sort((a, b) => a - b);
    if (to.length) log('  riêng mặt ≥100px (' + to.length + ' mặt): p50 '
      + to[Math.floor(to.length * .5)].toFixed(3) + ' · cao nhất ' + to[to.length - 1].toFixed(3));
  }
  /* Chẩn: khớp mặt sự kiện với mặt sự kiện KHÁC ẢNH. Cùng một khách chắc chắn
     xuất hiện nhiều lần trong 120 khung. Nếu điểm ở đây cũng thấp thì vấn đề nằm
     ở chất lượng mặt sự kiện; nếu cao thì vấn đề là khoảng cách giữa ảnh studio
     và ảnh tiệc — hai chuyện cần hai cách chữa khác hẳn. */
  if (!GHI && kho2.length){
    let n55 = 0, n45 = 0, tong = 0; const dinh = [];
    for (let i = 0; i < kho2.length; i++) for (let j = i + 1; j < kho2.length; j++){
      if (kho2[i].anh === kho2[j].anh) continue;
      const d = E.giongNhau(kho2[i].v, kho2[j].v); tong++;
      if (d >= 0.55) n55++; if (d >= 0.45) n45++;
      if (dinh.length < 5 || d > dinh[dinh.length - 1]){ dinh.push(d); dinh.sort((a, b) => b - a); dinh.length = Math.min(5, dinh.length); }
    }
    log('  CHẨN · mặt sự kiện ↔ mặt sự kiện (khác ảnh): ' + tong + ' cặp');
    log('    ≥0.55: ' + n55 + '  ·  ≥0.45: ' + n45 + '  ·  cao nhất: ' + dinh.map(x=>x.toFixed(3)).join(', '));
  }
  if (!GHI) log('  (THỬ — không ghi dòng nào. Thêm --commit để ghi thật.)');
  await db().end();
})().catch(e => { console.error('LOI ' + e.message); process.exit(1); });
