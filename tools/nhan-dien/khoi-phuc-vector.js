#!/usr/bin/env node
'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   E08-D134 · KHÔI PHỤC VECTOR ĐANG THIẾU
   ══════════════════════════════════════════════════════════════════════════════
   Vì sao tệp này tồn tại: bỏ hạn 7 ngày chỉ ngăn vector MỚI biến mất. Phần đã bị
   quét sạch từ 10/08 tới nay thì không tự quay lại — tắt máy bơm không làm đầy lại
   cái bể. Mà đúng những hàng ấy mới là thứ vé này hứa: đội vận hành phải tái tìm
   được ảnh của khách trên TOÀN BỘ kho, không phải trên phần còn sót lại.

   Dựng lại được vì hai thứ vẫn nằm nguyên: ẢNH NGUỒN trong kho, và HÌNH HỌC (hộp
   + năm mốc) trong chính hàng mặt. Nên đây không phải "quét lại kho": không dò
   lại, không đẻ hàng mặt mới, không đụng dấu đã soi. Chỉ tải ảnh, căn theo mốc đã
   lưu, nhúng, rồi ghi vector vào ĐÚNG HÀNG ĐANG CÓ.

   MẶC ĐỊNH THỬ. Chỉ ghi khi có --commit — cùng khuôn với mọi lệnh khác ở đây.

   Dùng:
     node khoi-phuc-vector.js                     # THỬ: chỉ đếm, không ghi gì
     node khoi-phuc-vector.js --commit            # ghi thật
     node khoi-phuc-vector.js --commit --chi mat  # chỉ crm_event_faces
     node khoi-phuc-vector.js --commit --chi mau  # chỉ crm_face_samples
     node khoi-phuc-vector.js --commit --gioi-han 200 --nghi-ms 50
     node khoi-phuc-vector.js --mau-thu 20        # THỬ có tính thật 20 hàng để đo
     node khoi-phuc-vector.js --hoan-tac ten.jsonl --commit   # CHỈ khi Sponsor lệnh

   ─────────────────────────────────────────────────────────────────────────────
   THANG TOẠ ĐỘ — ĐỌC TRƯỚC KHI SỬA BẤT KỲ DÒNG NÀO Ở ĐÂY
   ─────────────────────────────────────────────────────────────────────────────
   Đây là chỗ duy nhất trong tệp có thể hỏng mà KHÔNG báo gì: sai thang thì
   E.catCan() vẫn chạy, vẫn trả về một ảnh 112×112, E.nhung() vẫn trả về 128 số
   hợp lệ, câu UPDATE vẫn thành công. Chỉ có điều vector ấy tả một vùng ảnh khác —
   và mọi khớp về sau lệch, không ai biết cho tới lúc có người hỏi vì sao máy đoán
   kém đi. Vé D077 đã dẫm đúng bẫy này một lần (xem chú thích Q1 ở batch.js).

   HAI BẢNG DÙNG HAI QUY ƯỚC NGƯỢC NHAU. Kiểm bằng cách đọc chỗ GHI, không đoán:

     crm_event_faces.moc  → THANG 2048 (thang của crm_event_photos.width/height).
        Chỗ ghi: batch.js dùng JSON.stringify(mGhi.moc), mà mGhi = quyThang(...).
        Nên ở đây PHẢI đổi ngược về thang buffer trước khi đưa vào catCan.

     crm_face_samples.moc → THANG BUFFER (thang của chính tấm ảnh đã tải về).
        Chỗ ghi: napMau dùng mat[0].moc thô từ phatHien; tinhMauKhoanhTay đổi
        ngược về thang buffer trước khi lưu. Nên ở đây dùng THẲNG, không đổi.

   Và một ca thứ ba, tệ hơn cả hai: mẫu nguon='crm-photos'. Bảng crm_photos KHÔNG
   có cột width/height, còn bản preview của nó được backfill SAU (xem
   server/crm/backfill-thumbs.js). Nghĩa là một mẫu tạo trước lượt backfill ấy đã
   được dò trên ẢNH GỐC, còn hôm nay coalesce(preview_key, object_key) trả về bản
   1024 — hai buffer khác cỡ, và KHÔNG có dữ liệu nào để suy ra hệ số. Nên với
   nhánh này tệp KHÔNG dùng moc đã lưu: nó chạy lại đúng đường dò của napMau trên
   buffer vừa tải, tự nhất quán với bất kể ta tải được cỡ nào.

   Hệ quả: moc/box của mẫu crm-photos có thể lệch nhẹ so với vector mới. KHÔNG sửa
   chúng, vì (a) vé chỉ cho ghi hai cột vec/vec_xoa_luc, và (b) hình học của MẪU
   không được vẽ ở đâu cả — giao diện duyệt vẽ hộp từ crm_event_faces — còn
   tinhMauKhoanhTay chỉ đọc moc của mẫu khi vec IS NULL, tức sau lượt này không
   bao giờ đọc nữa. Một cột chết thì lệch cũng vô hại; sửa nó mới là vượt phạm vi.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const Minio = require('minio');
const E = require('./engine');

const CO = process.argv.slice(2);
const co = k => CO.includes(k);
const so = (k, m) => { const i = CO.indexOf(k); return i < 0 ? m : Number(CO[i + 1]); };
const chuoi = (k, m) => { const i = CO.indexOf(k); return i < 0 ? m : String(CO[i + 1] || ''); };

const GHI      = co('--commit');
const CHI      = chuoi('--chi', 'tat-ca');          // tat-ca | mat | mau
const GIOI_HAN = so('--gioi-han', 0);
const NGHI_MS  = so('--nghi-ms', 0);
const MAU_THU  = so('--mau-thu', 0);
const HOAN_TAC = chuoi('--hoan-tac', '');
/* Dò lại mốc cho hàng mặt KHÔNG có moc. Mặc định TẮT, và đó là một quyết định:
   dò lại nghĩa là dựng vector từ một hình học KHÁC cái đã đẻ ra hàng đó, tức một
   thay đổi chất lượng lặng lẽ trên dữ liệu cũ. Đếm riêng, báo là không khôi phục
   được, và chỉ bật khi có người quyết định bật. */
const DO_LAI_MOC = co('--do-lai-moc');

if (['tat-ca', 'mat', 'mau'].indexOf(CHI) < 0){
  console.error('LOI --chi phải là tat-ca | mat | mau'); process.exit(2);
}
const LAM_MAT = CHI === 'tat-ca' || CHI === 'mat';
const LAM_MAU = CHI === 'tat-ca' || CHI === 'mau';

/* Cùng cửa ảnh mẫu với napMau() của batch.js. Chép giá trị chứ không require:
   batch.js chạy một IIFE ở tầng module, nạp nó vào đây là chạy luôn cả một lượt
   batch. Ba số này là hợp đồng với napMau — đổi một bên phải đổi cả hai. */
const MAU_DIEM   = 0.9;
const MAU_TI_LE  = 0.10;
const MAU_TRO_AT = 0.5;

const MA_LUOT = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
              + '-' + crypto.randomBytes(3).toString('hex');
const NHAT_KY = chuoi('--nhat-ky', path.join(process.cwd(), 'khoi-phuc-' + MA_LUOT + '.jsonl'));

// ── Lưới ──────────────────────────────────────────────────────────────────────
let _pool = null, _mc = null;
const BUCKET = process.env.MINIO_BUCKET;

function kiemMoiTruong(canKho){
  const thieu = (canKho === false ? []
    : ['MINIO_ENDPOINT','MINIO_ACCESS_KEY','MINIO_SECRET_KEY','MINIO_BUCKET'])
    .filter(k => !process.env[k]);
  if (!process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) thieu.push('DATABASE_URL');
  if (thieu.length) throw new Error('thiếu biến môi trường: ' + thieu.join(', ')
    + '\n  Chạy qua `railway run --service esuhai-web -- node khoi-phuc-vector.js`'
    + '\n  và ĐỪNG dán chuỗi kết nối thẳng lên dòng lệnh.');
}

/* Cùng lý do với batch.js: một kết nối nhàn rỗi bị mạng cắt phát sự kiện 'error'
   trên chính pool, không ai nghe thì Node coi là lỗi chết người và cả lượt chạy
   dài chết theo. Nghe, ghi lại, đi tiếp. */
function db(){
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  _pool.on('error', e => console.error('  [kết nối] ' + cauNgan(e)));
  return _pool;
}
function kho(){ return _mc || (_mc = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT || 443),
  useSSL: String(process.env.MINIO_USE_SSL) === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY, secretKey: process.env.MINIO_SECRET_KEY })); }

const HAN_TAI_MS = 60 * 1000;
const layObj = (k) => new Promise((res, rej) => {
  const c = []; let xong = false, hen = null;
  const dong = (loi, buf) => {
    if (xong) return; xong = true;
    if (hen) clearTimeout(hen);
    loi ? rej(loi) : res(buf);
  };
  hen = setTimeout(() => dong(new Error('quá hạn ' + (HAN_TAI_MS / 1000) + 's khi tải ảnh')), HAN_TAI_MS);
  kho().getObject(BUCKET, k, (e, s) => {
    if (e) return dong(e);
    s.on('data', d => c.push(d));
    s.on('end', () => dong(null, Buffer.concat(c)));
    s.on('error', err => { try { s.destroy(); } catch (_){} dong(err); });
  });
});

const veBytes = v => { const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };

/* Che chuỗi kết nối trong câu lỗi. Cùng bộ lọc với batch.js. */
const cauNgan = e => String((e && e.message) || e || '')
  .replace(/[a-z+]+:\/\/[^\s]*@[^\s]*/gi, '«đã ẩn»').slice(0, 300);
const ngu = ms => new Promise(r => setTimeout(r, ms));

/* ── ĐẾM ──────────────────────────────────────────────────────────────────────
   Ba nhóm của mặt sự kiện CỘNG LẠI ĐÚNG BẰNG thiếu_vec, không chồng nhau. Đó là
   chủ ý: một bảng số mà các ngăn chồng lên nhau thì người đọc không cộng được, và
   con số dùng để xin lệnh Sponsor phải cộng được. */
async function demMat(){
  return (await db().query(`
    SELECT count(*)::int AS song,
           count(*) FILTER (WHERE f.vec IS NOT NULL)::int AS co_vec,
           count(*) FILTER (WHERE f.vec IS NULL)::int     AS thieu_vec,
           count(*) FILTER (WHERE f.vec IS NULL AND e.id IS NOT NULL AND f.moc IS NOT NULL)::int AS khoi_phuc_duoc,
           count(*) FILTER (WHERE f.vec IS NULL AND e.id IS NOT NULL AND f.moc IS NULL)::int     AS thieu_moc,
           count(*) FILTER (WHERE f.vec IS NULL AND e.id IS NULL)::int                           AS thieu_anh
      FROM crm_event_faces f
      LEFT JOIN crm_event_photos e ON e.id = f.event_photo_id AND e.deleted_at IS NULL
     WHERE f.deleted_at IS NULL`)).rows[0];
}

async function demMau(){
  return (await db().query(`
    SELECT count(*)::int AS song,
           count(*) FILTER (WHERE s.vec IS NOT NULL)::int AS co_vec,
           count(*) FILTER (WHERE s.vec IS NULL)::int     AS thieu_vec,
           count(*) FILTER (WHERE s.vec IS NULL
                              AND ((s.nguon = 'cat-tay'    AND e.id IS NOT NULL)
                                OR (s.nguon = 'crm-photos' AND p.id IS NOT NULL)))::int AS khoi_phuc_duoc,
           count(*) FILTER (WHERE s.vec IS NULL
                              AND NOT ((s.nguon = 'cat-tay'    AND e.id IS NOT NULL)
                                    OR (s.nguon = 'crm-photos' AND p.id IS NOT NULL)))::int AS mo_coi
      FROM crm_face_samples s
      LEFT JOIN crm_event_photos e ON e.id = s.event_photo_id AND e.deleted_at IS NULL
      LEFT JOIN crm_photos       p ON p.id = s.photo_id
     WHERE s.deleted_at IS NULL`)).rows[0];
}

/* Checksum vector — bằng chứng của AC-5 (lượt thử không đổi gì) và AC-7 (lượt
   commit thứ hai không đổi gì). md5 của từng vector rồi md5 của cả chuỗi đã sắp
   theo id: đổi một byte ở một hàng là đổi cả con số này. */
async function chuKy(){
  const q = async (bang) => (await db().query(
    `SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(vec), ',' ORDER BY id)), '-') AS ck
       FROM ${bang} WHERE vec IS NOT NULL`)).rows[0];
  return { mat: await q('crm_event_faces'), mau: await q('crm_face_samples') };
}

/* ── LẤY HÀNG ĐỦ ĐIỀU KIỆN ────────────────────────────────────────────────────
   Bốn vế WHERE của mặt, mỗi vế đóng một lớp lỗi khác nhau:
     f.deleted_at IS NULL  · hàng đã gỡ không được hồi sinh (AC-8)
     f.vec IS NULL         · chỉ tái tạo cái đang thiếu; cũng là chốt chạy-lại (AC-7)
     f.moc IS NOT NULL     · dùng lại chính hình học đã lưu, không dò lại
     e.deleted_at IS NULL  · nguồn chết thì dẫn xuất không sống lại (FR-3)

   f.vec_xoa_luc KHÔNG loại hàng, và đó là điểm mấu chốt: dấu ấy chính là dấu của
   nạn nhân TTL — đúng nhóm spec đòi khôi phục. Ranh giới thật là NGUỒN CÒN SỐNG,
   không phải dấu đã xoá. Khi ảnh bị gỡ, event-photos.js đặt deleted_at VÀ
   vec_xoa_luc trong cùng một câu, nên hàng cascade đã bị vế thứ nhất chặn rồi. */
async function layMat(){
  const gh = GIOI_HAN ? ' LIMIT ' + Number(GIOI_HAN) : '';
  return (await db().query(`
    SELECT f.id, f.event_photo_id, f.moc,
           e.width AS anh_w, e.height AS anh_h,
           coalesce(e.preview_key, e.object_key) AS k
      FROM crm_event_faces f
      JOIN crm_event_photos e ON e.id = f.event_photo_id AND e.deleted_at IS NULL
     WHERE f.deleted_at IS NULL AND f.vec IS NULL
       AND ${DO_LAI_MOC ? 'true' : 'f.moc IS NOT NULL'}
     ORDER BY f.id${gh}`)).rows;
}

async function layMau(){
  const gh = GIOI_HAN ? ' LIMIT ' + Number(GIOI_HAN) : '';
  return (await db().query(`
    SELECT s.id, s.nguon, s.moc, s.box_x, s.box_y, s.box_w, s.box_h,
           e.width AS anh_w, e.height AS anh_h,
           coalesce(e.preview_key, e.object_key) AS k_su_kien,
           coalesce(p.preview_key, p.object_key) AS k_chan_dung
      FROM crm_face_samples s
      LEFT JOIN crm_event_photos e ON e.id = s.event_photo_id AND e.deleted_at IS NULL
      LEFT JOIN crm_photos       p ON p.id = s.photo_id
     WHERE s.deleted_at IS NULL AND s.vec IS NULL
       AND ((s.nguon = 'cat-tay'    AND e.id IS NOT NULL)
         OR (s.nguon = 'crm-photos' AND p.id IS NOT NULL))
     ORDER BY s.id${gh}`)).rows;
}

// ── Tính vector cho một hàng ──────────────────────────────────────────────────

/* MẶT SỰ KIỆN. moc ở thang 2048 ⇒ đổi ngược về thang buffer. Xem khối THANG
   TOẠ ĐỘ ở đầu tệp — dòng chia cho kx/ky dưới đây là cả cái bẫy. */
async function vectorChoMat(phien, x){
  const buf = await layObj(x.k);
  const g = await E.anhGoc(buf);
  const kx = (x.anh_w && g.w) ? x.anh_w / g.w : 1;
  const ky = (x.anh_h && g.h) ? x.anh_h / g.h : 1;
  let moc = x.moc;
  if (!moc){
    if (!DO_LAI_MOC) return null;
    /* Chỉ tới đây khi người chạy đã bật --do-lai-moc một cách có ý thức. */
    const mat = await E.phatHien(phien, buf, { nguongDiem: 0.3 });
    if (!mat.length) return null;
    mat.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    moc = mat[0].moc;                       // đã ở thang buffer, dùng thẳng
  } else {
    moc = moc.map(p => [p[0] / kx, p[1] / ky]);
  }
  return E.nhung(phien, E.catCan(g.raw, g.w, g.h, moc));
}

/* MẪU CẮT TAY. moc ở thang BUFFER ⇒ dùng thẳng. Không có moc thì dò trong khung
   BTL đã khoanh — khung ấy ở thang 2048 nên phép so phải quy về cùng thang, đúng
   như tinhMauKhoanhTay() của batch.js làm. */
async function vectorChoMauCatTay(phien, x){
  const buf = await layObj(x.k_su_kien);
  const g = await E.anhGoc(buf);
  let moc = x.moc;
  if (!moc){
    const kx = (x.anh_w && g.w) ? x.anh_w / g.w : 1;
    const ky = (x.anh_h && g.h) ? x.anh_h / g.h : 1;
    const mat = (await E.phatHien(phien, buf, { nguongDiem: 0.3 }))
      .map(m => ({ x: m.x * kx, y: m.y * ky, w: m.w * kx, h: m.h * ky, moc: m.moc }));
    const noi = 12;
    const trong = mat.filter(m => m.x >= x.box_x - noi && m.y >= x.box_y - noi
      && m.x + m.w <= x.box_x + x.box_w + noi && m.y + m.h <= x.box_y + x.box_h + noi);
    if (!trong.length) return null;
    trong.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    moc = trong[0].moc;                     // moc gốc vẫn ở thang buffer
  }
  return E.nhung(phien, E.catCan(g.raw, g.w, g.h, moc));
}

/* MẪU TỪ ẢNH CHÂN DUNG. KHÔNG dùng moc đã lưu — thang của nó không suy ra được
   (crm_photos không có width/height, preview backfill sau). Chạy lại đúng đường
   của napMau() trên buffer vừa tải, kèm nguyên ba cửa lọc: một mẫu sai đầu độc
   MỌI khớp của khách đó, nên chỗ này không được rộng rãi hơn chỗ tạo. */
async function vectorChoMauChanDung(phien, x){
  const buf = await layObj(x.k_chan_dung);
  const mat = await E.phatHien(phien, buf, { nguongDiem: 0.5 });
  if (!mat.length) return null;
  mat.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  if (mat[0].diem < MAU_DIEM) return null;
  const g = await E.anhGoc(buf);
  if (Math.max(mat[0].w, mat[0].h) / Math.max(g.w, g.h) < MAU_TI_LE) return null;
  if (mat.length > 1 && (mat[1].w * mat[1].h) > MAU_TRO_AT * (mat[0].w * mat[0].h)) return null;
  return E.nhung(phien, E.catCan(g.raw, g.w, g.h, mat[0].moc));
}

/* ── GHI ──────────────────────────────────────────────────────────────────────
   Hai cột, hai bảng, không gì khác. Ba vế WHERE là toàn bộ phép chống đua:

     id = $2              · đúng hàng đang có, không INSERT hàng nào
     deleted_at IS NULL   · BTL gỡ ảnh giữa lúc chạy thì cú ghi này rơi vào 0 dòng
     vec IS NULL          · lượt hai đụng 0 dòng (AC-7), và hai tiến trình cùng
                            chạy thì cú thứ hai không ghi đè cú thứ nhất

   Hai thứ tự đua với cascade gỡ ảnh đều an toàn: tool ghi trước thì câu cascade
   (cũng mang AND deleted_at IS NULL) chạy sau và THẮNG, đặt lại vec = NULL; cascade
   chạy trước thì vế deleted_at ở đây không khớp và tool không ghi gì.

   vec_xoa_luc = NULL đi CÙNG CÂU với vec: ràng buộc ck_*_vec_xoa nói không hàng
   nào vừa giữ vector vừa mang dấu đã xoá, và nó ở dạng NOT VALID nên gác đúng mọi
   lượt ghi từ nay — kể cả lượt ghi này. Tách hai câu là có một khoảnh khắc hàng ở
   trạng thái CSDL từ chối. */
async function ghiVec(bang, id, vec){
  const r = await db().query(
    `UPDATE ${bang} SET vec = $1, vec_xoa_luc = NULL
      WHERE id = $2 AND deleted_at IS NULL AND vec IS NULL`, [veBytes(vec), id]);
  return r.rowCount;
}

/* ── SỔ AUDIT ─────────────────────────────────────────────────────────────────
   MỘT dòng cho CẢ LƯỢT, và chỉ SỐ ĐẾM. Không vector, không object key, không tên
   tệp, không id khách, không id hàng. Vector là dữ liệu sinh trắc dù được giữ
   vĩnh viễn; một dòng audit tả nó là một bản sao của nó ở chỗ không ai gác. */
async function ghiSo(d){
  await db().query(
    `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta)
     VALUES ('he-thong','face_vec_backfill','he-thong','0',$1::jsonb)`,
    [JSON.stringify(Object.assign({ ve: 'E08-D134', ma_luot: MA_LUOT }, d))]);
}

/* Nhật ký hoàn tác: CHỈ bảng + id. Đủ để đảo ngược đúng tập hàng vé này đã chạm,
   không đủ để dựng lại bất kỳ dữ liệu cá nhân nào. Tệp nằm ngoài repo và ngoài
   coord — nó là công cụ vận hành, không phải artifact. */
function moNhatKy(){
  if (!GHI) return null;
  const f = fs.openSync(NHAT_KY, 'a');
  fs.writeSync(f, JSON.stringify({ ma_luot: MA_LUOT, bat_dau: new Date().toISOString() }) + '\n');
  return f;
}

// ── Một lượt khôi phục ────────────────────────────────────────────────────────
async function chay(){
  kiemMoiTruong();
  const log = s => console.log(s);
  const t0 = new Date();

  log((GHI ? '── KHÔI PHỤC · GHI THẬT ──' : '── THỬ (không ghi gì) ──')
    + '  lượt ' + MA_LUOT + (GIOI_HAN ? '  giới hạn ' + GIOI_HAN : ''));

  const cMat = await demMat();
  const cMau = await demMau();
  log('  MẶT SỰ KIỆN (sống ' + cMat.song + '): có vector ' + cMat.co_vec
    + ' · thiếu ' + cMat.thieu_vec);
  log('    khôi phục được ' + cMat.khoi_phuc_duoc
    + ' · thiếu mốc ' + cMat.thieu_moc + ' · ảnh nguồn đã gỡ ' + cMat.thieu_anh);
  log('  MẪU KHÁCH (sống ' + cMau.song + '): có vector ' + cMau.co_vec
    + ' · thiếu ' + cMau.thieu_vec);
  log('    khôi phục được ' + cMau.khoi_phuc_duoc + ' · mồ côi nguồn ' + cMau.mo_coi);

  const kyTruoc = await chuKy();

  const d = { mat_du_dieu_kien: 0, mat_khoi_phuc: 0, mat_loi: 0,
              mat_thieu_moc: cMat.thieu_moc, mat_thieu_anh: cMat.thieu_anh,
              mau_du_dieu_kien: 0, mau_khoi_phuc: 0, mau_loi: 0, mau_mo_coi: cMau.mo_coi };

  /* Lượt THỬ không mở phiên engine trừ khi có --mau-thu: nạp 37 MB model để rồi
     không tính gì là bắt người ta đợi vô cớ. Nhưng khi họ XIN đo thật vài hàng
     thì phải đo thật — một lượt thử luôn nói "sẽ ổn thôi" là một lượt thử vô dụng. */
  const canEngine = GHI || MAU_THU > 0;
  let phien = null;
  if (canEngine){
    for (const f of ['yunet.onnx', 'sface.onnx']){
      if (!fs.existsSync(path.join(__dirname, 'model', f)))
        throw new Error('thiếu model/' + f + ' — chạy `npm run tai-model` trước.');
    }
    phien = await E.moPhien();
  }

  const nk = moNhatKy();
  const ghiNhatKy = (bang, id) => { if (nk) fs.writeSync(nk, JSON.stringify({ bang, id: String(id) }) + '\n'); };

  if (LAM_MAT && canEngine){
    const rows = await layMat();
    d.mat_du_dieu_kien = rows.length;
    const tran = GHI ? rows.length : Math.min(MAU_THU, rows.length);
    log('  → mặt sự kiện: ' + rows.length + ' hàng đủ điều kiện'
      + (GHI ? '' : ' · lượt thử chỉ tính ' + tran + ' hàng để đo, KHÔNG ghi'));
    for (let i = 0; i < tran; i++){
      const x = rows[i];
      try {
        const vec = await vectorChoMat(phien, x);
        if (!vec){ d.mat_loi++; continue; }
        if (GHI && await ghiVec('crm_event_faces', x.id, vec)){
          d.mat_khoi_phuc++; ghiNhatKy('crm_event_faces', x.id);
        } else if (!GHI) d.mat_khoi_phuc++;
      } catch (e){
        d.mat_loi++;
        /* Log id, KHÔNG log orig_name: tên tệp trên đĩa phóng viên có thể đã bị
           đổi thành TÊN KHÁCH (xem chú thích D110 ở event-photos.js), nên nó là
           PII. batch.js còn in orig_name trong câu lỗi; tệp này không lặp lại. */
        console.error('  [mặt ' + x.id + '] ' + cauNgan(e));
      }
      if (NGHI_MS) await ngu(NGHI_MS);
      if (GHI && d.mat_khoi_phuc && d.mat_khoi_phuc % 200 === 0)
        log('    … đã khôi phục ' + d.mat_khoi_phuc + '/' + rows.length);
    }
  }

  if (LAM_MAU && canEngine){
    const rows = await layMau();
    d.mau_du_dieu_kien = rows.length;
    const tran = GHI ? rows.length : Math.min(MAU_THU, rows.length);
    log('  → mẫu khách: ' + rows.length + ' hàng đủ điều kiện'
      + (GHI ? '' : ' · lượt thử chỉ tính ' + tran + ' hàng để đo, KHÔNG ghi'));
    for (let i = 0; i < tran; i++){
      const x = rows[i];
      try {
        const vec = x.nguon === 'cat-tay'
          ? await vectorChoMauCatTay(phien, x)
          : await vectorChoMauChanDung(phien, x);
        if (!vec){ d.mau_loi++; continue; }
        if (GHI && await ghiVec('crm_face_samples', x.id, vec)){
          d.mau_khoi_phuc++; ghiNhatKy('crm_face_samples', x.id);
        } else if (!GHI) d.mau_khoi_phuc++;
      } catch (e){
        d.mau_loi++;
        console.error('  [mẫu ' + x.id + '] ' + cauNgan(e));
      }
      if (NGHI_MS) await ngu(NGHI_MS);
    }
  }

  const kySau = await chuKy();
  log('  ── kết quả ──');
  log('  mặt: khôi phục ' + d.mat_khoi_phuc + ' · lỗi/bỏ ' + d.mat_loi
    + '  |  mẫu: khôi phục ' + d.mau_khoi_phuc + ' · lỗi/bỏ ' + d.mau_loi);
  log('  chữ ký vector mặt: ' + kyTruoc.mat.n + '/' + kyTruoc.mat.ck.slice(0, 12)
    + '  →  ' + kySau.mat.n + '/' + kySau.mat.ck.slice(0, 12));
  log('  chữ ký vector mẫu: ' + kyTruoc.mau.n + '/' + kyTruoc.mau.ck.slice(0, 12)
    + '  →  ' + kySau.mau.n + '/' + kySau.mau.ck.slice(0, 12));

  if (GHI){
    d.bat_dau = t0.toISOString();
    d.xong_luc = new Date().toISOString();
    await ghiSo(d);
    if (nk) fs.closeSync(nk);
    log('  đã ghi sổ audit face_vec_backfill · nhật ký hoàn tác: ' + NHAT_KY);
  } else {
    /* Bằng chứng AC-5: lượt thử KHÔNG đổi một byte nào. */
    const yen = kyTruoc.mat.ck === kySau.mat.ck && kyTruoc.mau.ck === kySau.mau.ck
             && kyTruoc.mat.n === kySau.mat.n && kyTruoc.mau.n === kySau.mau.n;
    log(yen ? '  (THỬ — chữ ký trước/sau BẰNG NHAU, không ghi dòng nào.)'
            : '  LOI · lượt THỬ mà chữ ký đã đổi — dừng và điều tra ngay.');
    if (!yen) process.exitCode = 1;
  }
}

/* ── HOÀN TÁC ─────────────────────────────────────────────────────────────────
   Đây là một thao tác XOÁ dữ liệu sinh trắc, nên nó không phải "rollback thường".
   Spec nói mọi thao tác xoá vector cần một quyết định Sponsor mới kèm preview số
   lượng — tệp này thi hành đúng câu ấy: mặc định THỬ, in ra sẽ xoá bao nhiêu, và
   chỉ xoá khi có --commit. Đặt vec_xoa_luc = now() chứ không để trống: sự vắng
   mặt phải CHỨNG MINH được, không chỉ quan sát thấy. */
async function hoanTac(){
  kiemMoiTruong(false);
  const dong = fs.readFileSync(HOAN_TAC, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const theoBang = new Map();
  for (const x of dong){
    if (!x.bang || !x.id) continue;
    if (!theoBang.has(x.bang)) theoBang.set(x.bang, []);
    theoBang.get(x.bang).push(x.id);
  }
  console.log((GHI ? '── HOÀN TÁC · GHI THẬT ──' : '── HOÀN TÁC · THỬ ──') + '  ' + HOAN_TAC);
  for (const [bang, ids] of theoBang){
    if (['crm_event_faces', 'crm_face_samples'].indexOf(bang) < 0){
      console.error('  bỏ qua bảng lạ: ' + bang); continue;
    }
    const dem = (await db().query(
      `SELECT count(*)::int n FROM ${bang} WHERE id = ANY($1::bigint[]) AND vec IS NOT NULL`,
      [ids])).rows[0].n;
    console.log('  ' + bang + ': ' + ids.length + ' id trong nhật ký · ' + dem + ' hàng còn vector');
    if (!GHI) continue;
    const r = await db().query(
      `UPDATE ${bang} SET vec = NULL, vec_xoa_luc = now()
        WHERE id = ANY($1::bigint[]) AND vec IS NOT NULL`, [ids]);
    console.log('    đã xoá vector: ' + r.rowCount);
  }
  if (!GHI) console.log('  (thêm --commit để xoá thật — cần lệnh Sponsor)');
}

(async () => {
  if (HOAN_TAC) await hoanTac();
  else await chay();
  await db().end();
})().catch(e => { console.error('LOI ' + cauNgan(e)); process.exit(1); });
