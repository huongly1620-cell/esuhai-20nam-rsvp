'use strict';
/* E08-D077 · Batch nhận diện — MẶC ĐỊNH DRY-RUN, chỉ ghi khi có --commit.
   Chạy TÁCH khỏi esuhai-web (FR-1). Không tự gán cho ai: mọi thứ nó sinh ra đều
   ở trạng thái 'cho' (chờ người xác nhận) — CR-127.

   E08-D126 · thêm chế độ TRỰC: thay vì nhận một cửa sổ ảnh tính sẵn, tiến trình
   đứng trực, XIN việc theo tấm từ sổ luồng, đọc cờ điều khiển sau mỗi tấm, và ghi
   nhịp thở để trang web biết nó còn sống. Xem khối «MÁY QUÉT TRỰC» ở cuối tệp.

   Dùng:
     node batch.js                      # thử, không ghi gì
     node batch.js --commit             # ghi thật, một lượt, cả hàng đợi
     node batch.js --gioi-han 100       # chỉ 100 ảnh đầu
     node batch.js --nguong 0.55        # ngưỡng gợi ý
     node batch.js --truc               # ĐỨNG TRỰC: nhận luồng từ trang web (D126)
     node batch.js --truc --mot-luot    # trực đúng một đợt rồi thoát (máy chủ dùng)
     node batch.js --chi-khop-lai            # D134: thử tái khớp toàn kho, không ghi
     node batch.js --chi-khop-lai --commit   # D134: tái khớp thật (không cần MinIO/model)

   Chạy nhiều luồng trên một máy — mỗi luồng một tiến trình, không cần tính offset:
     for i in 1 2 3; do node batch.js --truc & done
*/
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { Pool } = require('pg');
const Minio = require('minio');
const E = require('./engine');

const CO = process.argv.slice(2);
const co  = k => CO.includes(k);
const so  = (k, m) => { const i = CO.indexOf(k); return i < 0 ? m : Number(CO[i + 1]); };
/* D126 · TRỰC bao hàm GHI. Một máy quét đứng trực mà không ghi thì nó chỉ đốt
   CPU và làm bảng điều khiển nói dối — không có nghĩa nào khác cho «trực thử». */
const TRUC     = co('--truc');
const MOT_LUOT = co('--mot-luot');
const GHI     = co('--commit') || TRUC;
const GIOI_HAN = so('--gioi-han', 0);
const BO_QUA   = so('--bo-qua', 0);
/* Ngưỡng gợi ý — khoá 0,45 ngày 10/08 theo Bước 0 (soi tay), KHÔNG phải AC-5.
   locked 2026-08-10 step-0 hand review; not AC-5.

   Đường đi tới con số này, để người sau không phải dựng lại:
   0,55 ban đầu lấy từ thí nghiệm chân dung↔chân dung — KHÔNG chuyển sang được,
   vì bài thật là chân dung→ảnh tiệc và thang điểm chéo miền thấp hẳn: mặt sự
   kiện khớp mẫu ở p50≈0,28 trong khi khớp NHAU ở ~0,95.
   Soi tay 13 cặp trên phóng sự Máy 1: từ 0,45 trở lên không thấy ca sai rõ nào;
   ngay dưới đó thì có, gồm một cặp 0,370 khớp một người đàn ông với một phụ nữ.
   Ở 0,45 kho Máy 1 cho ~880 gợi ý — dư sàn 300 của AC-5, nên không phải hạ
   ngưỡng để lấy cho đủ số.

   Đây VẪN chưa phải precision đo được: 13 cặp là quá ít cho khoảng tin cậy, và
   ba trong số đó tôi không kết luận chắc. Con số của AC-5 do BTL chấm sinh ra,
   và ngưỡng có thể đổi lại sau khi có nó. */
const NGUONG  = so('--nguong', 0.45);
const TOP     = so('--top', 5);
/* Khớp lại TOÀN BỘ mẫu với các mặt đã lưu. Bản đầu chỉ khớp những mẫu vừa được
   tính trong chính lượt chạy đó — nghe thì hợp lý, nhưng nghĩa là bấm chạy lại
   lần thứ hai sẽ không làm gì cả, và người dùng không có cách nào bảo hệ thống
   "tìm lại đi". ON CONFLICT DO NOTHING khiến chạy bao nhiêu lần cũng vô hại. */
const KHOP_LAI = co('--khop-lai');
/* E08-D134 · TÁI KHỚP MỘT MÌNH, không kéo theo gì khác.
   Đường tái khớp duy nhất trước vé này là `--commit --khop-lai`, mà lượt ấy còn
   chạy napMau() (INSERT mẫu mới từ ảnh chân dung) và quét cả hàng đợi ảnh. Hai hệ
   quả, cả hai đều xấu:
     · KHÔNG ĐO ĐƯỢC. AC-9 đòi chứng minh tái khớp không nhân đôi và không hạ cấp
       quyết định BTL — mà nếu cùng lượt ấy còn đẻ mẫu mới thì không tách được cái
       gì gây ra cái gì.
     · KHÔNG DÙNG ĐƯỢC TRÊN PROD. Người vận hành muốn "tìm lại ảnh cho khách vừa
       có avatar mới" phải chạy cả một lượt batch — hàng giờ CPU cho một việc chỉ
       đọc vector và nhân hai mảng số.
   Chế độ này KHÔNG cần MinIO và KHÔNG cần model: nó chỉ so vector đã lưu. Nhờ vậy
   chạy được từ bất kỳ máy nào có đường tới CSDL. Mẫu chưa có vector không thuộc
   phạm vi ở đây — chúng cần engine, tức cần một lượt batch bình thường. */
const CHI_KHOP_LAI = co('--chi-khop-lai');

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
/* D134 · `canKho` = lượt chạy này có phải tải ảnh không. Tái khớp (--chi-khop-lai)
   chỉ đọc vector đã lưu và nhân hai mảng số — không MinIO, không ONNX. Bắt nó khai
   bốn biến MinIO là bắt người vận hành dựng một thứ họ không dùng, rồi bỏ cuộc. */
function kiemMoiTruong(canKho){
  const thieu = (canKho === false ? []
    : ['MINIO_ENDPOINT','MINIO_ACCESS_KEY','MINIO_SECRET_KEY','MINIO_BUCKET'])
    .filter(k => !process.env[k]);
  if (!process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) thieu.push('DATABASE_URL');
  if (thieu.length) throw new Error('thiếu biến môi trường: ' + thieu.join(', ')
    + '\n  Chạy qua `railway run --service esuhai-web -- node batch.js` để nó tự bơm vào,'
    + '\n  và ĐỪNG dán chuỗi kết nối thẳng lên dòng lệnh.');
}
/* D126 · pool.on('error') — MỘT DÒNG NÀY LÀ CẢ MỘT LỚP HỎNG.
   Tối 11/08, luồng 3 và 5 chết vì `read EADDRNOTAVAIL` nổi lên thành *Unhandled
   'error' event* trên pg-pool và làm SẬP cả tiến trình sau 7 phút chạy. Kết nối
   nhàn rỗi trong pool bị mạng cắt thì pg phát sự kiện 'error' trên chính đối
   tượng pool; không ai nghe thì Node coi đó là lỗi chết người.
   Nghe nó, ghi lại, và ĐI TIẾP: pool tự dựng kết nối mới ở lần truy vấn sau. Một
   đợt chạy ba tiếng lúc nửa đêm không được phép mất trắng vì mạng chớp 2 giây. */
let LOI_KET_NOI = null;
function db(){
  if (_pool) return _pool;
  _pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    /* Prod đi qua proxy công khai nên TLS là bắt buộc — mặc định giữ nguyên.
       PGSSL=disable là lối cho một Postgres LAB chạy trên máy (kiểm giao thức
       hàng đợi, thử --truc bằng engine giả): Postgres mặc định không bật SSL, và
       không có lối này thì mọi lượt kiểm đều chết ở dòng đầu với một câu lỗi nói
       về SSL chứ không nói về thứ đang kiểm. Cùng lối viết PGSSL của server/db.js. */
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  _pool.on('error', e => {
    LOI_KET_NOI = 'Mạng tới cơ sở dữ liệu chập: ' + e.message;
    console.error('  [kết nối] ' + LOI_KET_NOI);
  });
  return _pool;
}
function kho(){ return _mc || (_mc = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT || 443),
  useSSL: String(process.env.MINIO_USE_SSL) === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY, secretKey: process.env.MINIO_SECRET_KEY })); }

/* D126 · «tương đương pool.on('error') cho MinIO» là ba thứ, không phải một:
   (1) bắt lỗi của cú gọi VÀ của luồng dữ liệu — bản cũ đã có;
   (2) CHỈ trả lời một lần: một luồng đã 'end' rồi vẫn có thể phát 'error' lúc
       ổ cắm đóng, và gọi rej sau res thì Promise im lặng nuốt mất, nhưng nếu
       không gỡ ống thì bộ nhớ giữ lại cả tấm ảnh;
   (3) CÓ HẠN GIỜ. Đây là chỗ tối qua treo: một cú tải nằm im vô hạn thì luồng
       không chết, không lỗi, chỉ đứng — và bảng điều khiển hiện «đang chạy» cho
       một thứ không chạy. Quá hạn thì cắt ống và ném, để tầng thử-lại lo. */
const HAN_TAI_MS = 60 * 1000;
const layObj = (k, hanMs) => new Promise((res, rej) => {
  const c = []; let xong = false, hen = null;
  const dong = (loi, buf) => {
    if (xong) return; xong = true;
    if (hen) clearTimeout(hen);
    loi ? rej(loi) : res(buf);
  };
  hen = setTimeout(() => dong(new Error('quá hạn ' + ((hanMs || HAN_TAI_MS) / 1000)
    + 's khi tải ảnh từ kho')), hanMs || HAN_TAI_MS);
  kho().getObject(BUCKET, k, (e, s) => {
    if (e) return dong(e);
    s.on('data', d => c.push(d));
    s.on('end', () => dong(null, Buffer.concat(c)));
    s.on('error', err => { try { s.destroy(); } catch (_){} dong(err); });
  });
});

const veBytes = v => { const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
const tuBytes = b => { const v = new Array(b.length / 4);
  for (let i = 0; i < v.length; i++) v[i] = b.readFloatLE(i * 4); return v; };

/* Q1 · THANG TOẠ ĐỘ — một chỗ duy nhất quy đổi, và nói rõ vì sao.
   `crm_event_photos.width/height` là của bản WEB 2048 (do trang nạp ghi lên).
   Batch lại đọc `preview_key` = bản 1024 cho nhẹ, nên mọi toạ độ engine trả về
   nằm trong thang 1024. Giao diện chia cho `width` (2048) ⇒ khung vẽ đúng một
   nửa vị trí và một nửa kích thước, mà KHÔNG có lỗi nào báo: một màn duyệt trông
   vẫn bình thường trong khi ô vàng nằm trên mặt người khác.
   `width/height` đã là hợp đồng công khai với UI, nên thang chuẩn là bản 2048 và
   batch quy về đó ngay khi rời engine — không để mỗi chỗ đọc tự đoán. */
function heSoThang(banGhi, buffer){
  const kx = (banGhi.width  && buffer.w) ? banGhi.width  / buffer.w : 1;
  const ky = (banGhi.height && buffer.h) ? banGhi.height / buffer.h : 1;
  return { kx, ky };
}
function quyThang(m, k, khung){
  let x = m.x * k.kx, y = m.y * k.ky, w = m.w * k.kx, h = m.h * k.ky;
  /* Kẹp vào trong mép ảnh. Phép lồng khung 640 làm tròn nên khung có thể thò ra
     vài pixel; giao diện vẽ theo % nên một khung tràn mép sẽ lệch khỏi ô ảnh, và
     canh_px sẽ tính cả phần không tồn tại. */
  if (khung && khung.w && khung.h){
    x = Math.max(0, Math.min(x, khung.w));
    y = Math.max(0, Math.min(y, khung.h));
    w = Math.max(1, Math.min(w, khung.w - x));
    h = Math.max(1, Math.min(h, khung.h - y));
  }
  return { x, y, w, h, diem: m.diem, moc: m.moc.map(p => [p[0] * k.kx, p[1] * k.ky]) };
}

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

/* E08-D134 · MẪU CỦA KHÁCH ĐÃ GỠ KHÔNG ĐƯỢC DÙNG ĐỂ ĐOÁN.
   Bản trước chỉ lọc crm_face_samples.deleted_at, không hỏi gì về khách. Xoá khách
   ở CRM là xoá MỀM (crm_guests.deleted_at), nên mẫu của họ vẫn sống và vẫn sinh
   gợi ý — hàng đợi duyệt mọc lại tên một người đã được gỡ khỏi sổ.

   Chuyện này hầu như không lộ ra ở D077 vì tái khớp toàn kho là một cờ hiếm dùng.
   D134 biến tái khớp thành thao tác thường (đó là cả điểm của vé), nên khe hở ấy
   sẽ đi từ hiếm sang thường xuyên. Gate 1 chốt vá ngay trong vé này.

   Lọc ở đây — chỗ ĐỌC mẫu để so — chứ không ở chỗ tạo mẫu: mọi đường đoán mặt đều
   đi qua hàm này (lượt chạy tay, máy quét trực, tái khớp), nên một lần lọc là phủ
   cả ba. Chặn ở chỗ tạo thì mẫu cũ đã nằm sẵn trong bảng vẫn lọt. */
async function docMau(){
  const r = (await db().query(`SELECT s.id, s.guest_id, s.vec
    FROM crm_face_samples s
    JOIN crm_guests g ON g.id = s.guest_id AND g.deleted_at IS NULL
    WHERE s.deleted_at IS NULL AND s.vec IS NOT NULL`)).rows;
  return r.map(x => ({ id: x.id, guest: String(x.guest_id), v: tuBytes(x.vec) }));
}

/* Mẫu BTL khoanh tay (FR-10) chỉ có khung, chưa có vector — trang web không tính
   được vì engine không nằm trong esuhai-web. Batch tính nốt ở đây. */
async function tinhMauKhoanhTay(phien, log){
  /* Q2 · guest_id PHẢI có mặt. Thiếu nó thì `String(x.guest_id)` ra chuỗi
     "undefined", Postgres ném 22P02 và cả lượt chạy chết — mà nhánh --khop-lai
     lại đi qua docMau() (có guest_id) nên chính cái cờ đó che mất lỗi ở đường
     chạy mặc định. */
  const r = (await db().query(`SELECT s.id, s.guest_id, s.event_photo_id,
      s.box_x, s.box_y, s.box_w, s.box_h, s.moc,
      e.width AS anh_w, e.height AS anh_h,
      coalesce(e.preview_key, e.object_key) k
    FROM crm_face_samples s JOIN crm_event_photos e ON e.id = s.event_photo_id
    WHERE s.deleted_at IS NULL AND s.vec IS NULL AND s.vec_xoa_luc IS NULL
      AND s.nguon = 'cat-tay'`)).rows;
  if (!r.length) return [];
  let xong = 0; const moi = [];
  for (const x of r){
    try {
      const buf = await layObj(x.k);
      const g = await E.anhGoc(buf);
      /* Có mốc thì căn theo mốc; không có (BTL kéo khung tay) thì dò lại TRONG
         khung đã khoanh để lấy mốc — căn bằng mốc mới cho vector dùng được. */
      let moc = x.moc;
      if (!moc){
        /* Khung do BTL kéo nằm trong thang 2048 (UI quy theo width/height của bản
           ghi). Mặt dò được nằm trong thang của buffer đang đọc. So thẳng hai
           thang khác nhau thì KHÔNG mặt nào lọt vào khung — và hỏng im lặng: mẫu
           nằm lại ở trạng thái "chờ tính" đúng như thiết kế, không ai biết. */
        const k = heSoThang({ width: x.anh_w, height: x.anh_h }, g);
        const mat = (await E.phatHien(phien, buf, { nguongDiem: 0.3 }))
          .map(m => quyThang(m, k, { w: x.anh_w, h: x.anh_h }));
        const noi = 12;
        const trong = mat.filter(m => m.x >= x.box_x - noi && m.y >= x.box_y - noi
          && m.x + m.w <= x.box_x + x.box_w + noi && m.y + m.h <= x.box_y + x.box_h + noi);
        if (!trong.length) continue;                 // không thấy mặt trong khung: để nguyên, báo sau
        trong.sort((a, b) => (b.w * b.h) - (a.w * a.h));
        /* Căn mặt cần mốc trong thang BUFFER, nên đổi ngược lại. */
        moc = trong[0].moc.map(p => [p[0] / k.kx, p[1] / k.ky]);
      }
      const vec = await E.nhung(phien, E.catCan(g.raw, g.w, g.h, moc));
      if (GHI) await db().query(`UPDATE crm_face_samples SET vec = $1, moc = $2 WHERE id = $3`,
        [veBytes(vec), JSON.stringify(moc), x.id]);
      moi.push({ id: x.id, guest: String(x.guest_id), v: vec });
      xong++;
    } catch (e){ /* để lại cho lượt sau, không xoá mẫu của người ta */ }
  }
  log('  mẫu khoanh tay chờ tính: ' + r.length + ' · tính xong ' + xong);
  return moi;
}

/* Khớp MẪU MỚI với những mặt ĐÃ nằm sẵn trong CSDL.
   Không có bước này thì lời hứa của FR-10 không thành: batch bỏ qua ảnh đã xử lý
   (đúng, để chạy lại không tốn công), nên một mẫu vừa thêm sẽ chẳng bao giờ gặp
   những khuôn mặt đã dò từ lượt trước — BTL khoanh xong, chạy lại, và không có
   gì mới xuất hiện.

   E08-D134 · ĐÂY LÀ LÝ DO GIỮ VECTOR VĨNH VIỄN. Bản D077 viết ở chỗ này rằng
   "vector lưu 7 ngày trả công" — nhưng nó chỉ trả công trong 7 ngày ấy. Qua hạn
   thì câu SELECT dưới đây trả về ít dần rồi rỗng, và một mẫu mới sẽ chỉ gặp được
   những khuôn mặt vừa dò trong tuần. Sponsor 16/08/2026 chốt giữ vĩnh viễn để
   câu này luôn nhìn thấy TOÀN BỘ kho, không phải một cửa sổ trượt bảy ngày. */
async function khopMauMoiVoiMatCu(mauMoi, log, ghi){
  if (ghi === undefined) ghi = GHI;
  if (!mauMoi.length) return 0;
  const mat = (await db().query(`SELECT id, event_photo_id, vec FROM crm_event_faces
    WHERE deleted_at IS NULL AND vec IS NOT NULL`)).rows;
  if (!mat.length) return 0;
  let them = 0;
  for (const f of mat){
    const v = tuBytes(f.vec);
    const theo = new Map();
    for (const s of mauMoi){
      const d = E.giongNhau(v, s.v);
      if (d < NGUONG) continue;
      const cu = theo.get(s.guest);
      if (!cu || d > cu.d) theo.set(s.guest, { d, sample: s.id });
    }
    for (const [gid, o] of theo){
      /* D134 · KHÔNG HỒI SINH DÒNG ĐÃ XOÁ.
         ON CONFLICT DO NOTHING một mình là chưa đủ, và lý do nằm ở chữ MỘT PHẦN:
         uq_face_candidates_mat_khach chỉ phủ WHERE deleted_at IS NULL, nên một
         dòng đã xoá MỀM nằm NGOÀI chỉ mục và không gây xung đột nào — câu INSERT
         đi lọt và đẻ lại đúng dòng mà D115 vừa gộp bỏ, hoặc đúng dòng mà cascade
         gỡ ảnh vừa dọn. Người duyệt thấy một gợi ý họ đã xử lý quay lại.
         Bản D077 sống chung được với chuyện này vì --khop-lai là cờ hiếm dùng;
         D134 biến tái khớp toàn kho thành thao tác thường, nên phơi nhiễm tăng
         theo cả kho lẫn tần suất.

         Vế NOT EXISTS chặn đúng chuyện đó và không hơn: chỉ nhìn cặp
         (face_id, guest_id) đã từng bị xoá. Không mở rộng sang "khách này từng bị
         từ chối trên tấm này" — một khuôn mặt KHÁC của cùng người trong cùng
         khung hình là một phỏng đoán khác, và chặn nó là tự quyết thay BTL.

         Ba tính chất giữ nguyên, cả ba đều là điều kiện của FR-5:
           · chỉ INSERT, không câu UPDATE nào ⇒ xac-nhan / tu-choi / bo-qua không
             thể bị hạ cấp bởi một lượt chạy lại;
           · ON CONFLICT DO NOTHING lo dòng SỐNG trùng ⇒ chạy lại không nhân đôi;
           · trang_thai viết cứng 'cho' ⇒ máy không tự xác nhận (CR-127). */
      if (!ghi){
        /* D134 · lượt THỬ đếm ĐÚNG con số lượt ghi sẽ tạo ra, không ước lượng.
           Hai cái chặn ở nhánh ghi — vế NOT EXISTS (dòng đã xoá) và ON CONFLICT
           (dòng sống trùng) — gộp lại đúng bằng một câu hỏi: cặp (mặt, khách) này
           đã có dòng nào chưa, sống hay đã xoá. Hai chỉ mục một phần còn lại
           không đụng tới vì dòng sinh ra ở đây luôn mang face_id và luôn 'cho'.
           Đếm bằng ước lượng thì con số của lượt thử không dùng để quyết định
           được, mà đó là toàn bộ lý do lượt thử tồn tại. */
        const co = await db().query(`SELECT 1 FROM crm_face_candidates
           WHERE face_id = $1 AND guest_id = $2 LIMIT 1`, [f.id, gid]);
        if (!co.rowCount) them++;
        continue;
      }
      const r = await db().query(`INSERT INTO crm_face_candidates
        (event_photo_id, face_id, guest_id, sample_id, score, nguon, trang_thai, run_id)
        SELECT $1,$2,$3,$4,$5,'may','cho',$6
         WHERE NOT EXISTS (SELECT 1 FROM crm_face_candidates x
                            WHERE x.face_id = $2 AND x.guest_id = $3
                              AND x.deleted_at IS NOT NULL)
        ON CONFLICT DO NOTHING RETURNING id`,
        [f.event_photo_id, f.id, gid, o.sample, o.d, 'run-khop-lai']);
      if (r.rowCount) them++;
    }
  }
  log('  khớp lại mặt cũ với ' + mauMoi.length + ' mẫu mới: thêm ' + them + ' gợi ý');
  return them;
}

/* E08-D134 · SỔ AUDIT CHO MỘT LƯỢT TÁI KHỚP (FR-6).
   Chỉ SỐ ĐẾM. Không vector, không object key, không tên tệp, không id khách —
   cùng luật với mọi thứ khác chạm vào bảng này. Ghi từ công cụ chứ không từ app
   vì chính công cụ mới biết mình vừa làm gì; actor là he-thong, đúng khuôn mà
   khối gộp của D115 trong crm-db.js đã dùng cho một lượt ghi không có người bấm. */
async function ghiSoTaiKhop(d){
  await db().query(
    `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta)
     VALUES ('he-thong','face_khop_lai','he-thong','0',$1::jsonb)`,
    [JSON.stringify(Object.assign({ ve: 'E08-D134' }, d))]);
}

/* ═════════════════════════════════════════════════════════════════════════════
   MÁY QUÉT TRỰC — E08-D126
   ═════════════════════════════════════════════════════════════════════════════
   Vì sao chế độ này tồn tại, nói bằng chuyện tối 11/08: em chia 5 luồng bằng
   `--bo-qua 0/1800/3600/5400/7200 --gioi-han 1750` rồi khởi động lệch 60 giây để
   hai luồng không đụng cùng một tấm. Sau 11 phút cả 5 tắt. Ba chỗ hỏng, và cả ba
   đều được chữa ở đây chứ không ở giao diện:

     · CHIA VIỆC BẰNG PHÉP TÍNH TAY LÀ MỎNG. Hàng đợi CO LẠI trong lúc chạy, nên
       tính đúng hay sai phải chứng minh bằng lập luận thứ tự khởi động — mà
       crm_event_faces không có ràng buộc nào chặn một tấm bị hai luồng ghi. Nay
       việc được GIỮ: một luồng đóng dấu tên mình lên 25 tấm bằng FOR UPDATE SKIP
       LOCKED. Hai luồng không thể cầm cùng một tấm, kể cả khởi động cùng giây,
       kể cả thêm luồng thứ 6 giữa lúc đang chạy.

     · DỪNG ĐƯỢC ĐÚNG MỘT CÁCH: `kill`. Nay web đổi một chữ trong sổ, máy quét
       đọc chữ ấy SAU MỖI TẤM. Tấm đang cầm vẫn soi xong; tấm còn giữ mà chưa soi
       thì nhả về hàng đợi. «Tiếp tục» không cần nhớ mình đang ở đâu — việc giao
       theo tấm, không theo cửa sổ.

     · MỘT LỖI MẠNG LÀM SẬP CẢ LƯỢT, VÀ KHÔNG AI BIẾT CHO TỚI LÚC KẾT THÚC. Nay
       lỗi kết nối bị bắt ở tầng pool, tấm lỗi được thử lại ba lần giãn dần, và
       mọi con số đi vào sổ theo nhịp — bảng thấy tỉ lệ lỗi ngay ở nhịp đọc sau.

   Điều KHÔNG đổi: máy vẫn chỉ GỢI Ý. Mọi dòng sinh ra ở trạng thái 'cho'; không
   có đường nào ở đây tự đưa ảnh vào album của khách. */

/* Giao thức hàng đợi nằm ở tệp riêng vì nó là phần DUY NHẤT của máy quét kiểm
   được mà không cần engine — xem đầu hang-doi.js. Ở đây chỉ còn phần cần ONNX. */
const HD = require('./hang-doi');
const xinLuong = may => HD.xinLuong(db(), may);
const xinAnh = (luongId, n) => HD.xinAnh(db(), luongId, n);
const nhaAnh = luongId => HD.nhaAnh(db(), luongId);
const nhaMotAnh = (luongId, anhId) => HD.nhaMotAnh(db(), luongId, anhId);
const nhip = (luongId, d) => HD.nhip(db(), luongId, d);
const chotLuong = (luongId, tt, d, cau) => HD.chotLuong(db(), luongId, tt, d, cau);

const GIU_MOI_LUOT = HD.GIU_MOI_LUOT;
const NHIP_MS = 10 * 1000;    // nhịp thở, kể cả khi đang kẹt giữa một tấm nặng
const CHO_MS = 3000;          // đứng trực thì hỏi lại mỗi 3 giây
const GIAN_THU_LAI = [1000, 4000, 15000];
const CUA_SO_LOI = HD.CUA_SO_LOI;       // tự hãm nhìn 100 tấm gần nhất
const CHO_LUONG_MS = 60 * 1000;         // --mot-luot chờ luồng tối đa 1 phút
const CHO_MAU_MS = 15 * 60 * 1000;      // chờ luồng 1 tính xong mẫu

const ngu = ms => new Promise(r => setTimeout(r, ms));
const cauNgan = e => String((e && e.message) || e || '').replace(/[a-z+]+:\/\/[^\s]*@[^\s]*/gi, '«đã ẩn»').slice(0, 300);

/* Soi MỘT tấm: tải · dò · nhúng · so mẫu · ghi. Ném khi hỏng — tầng thử lại ở
   trên quyết định thử tiếp hay bỏ. Không bắt lỗi ở đây, vì «đếm lỗi rồi đi tiếp»
   chính là cái làm luồng 1 tối qua cày 1.601 tấm rỗng mà không ai biết.

   Mọi tính toán nặng (tải · dò · nhúng · so mẫu) làm XONG HẾT trước khi mở giao
   dịch: giữ một giao dịch mở suốt 1,3 giây xử lý ảnh là giữ khoá trên hàng ảnh
   và bắt mọi luồng khác đợi. Giao dịch ở đây chỉ dài bằng mấy cú INSERT. */
async function soiMotTam(phien, mau, a, luongId, nguong){
  const buf = await layObj(a.k);
  const matThuc = await E.phatHien(phien, buf, { nguongDiem: 0.6 });
  const runIdTam = 'luong-' + luongId;
  const ghiRa = [];
  if (matThuc.length){
    const g = await E.anhGoc(buf);
    const k = heSoThang(a, g);
    for (const m of matThuc){
      const mGhi = quyThang(m, k, { w: a.width, h: a.height });
      const crop = E.catCan(g.raw, g.w, g.h, m.moc);
      const vec = await E.nhung(phien, crop);
      const theoKhach = new Map();
      for (const s of mau){
        const d = E.giongNhau(vec, s.v);
        if (d < nguong) continue;
        const cu = theoKhach.get(s.guest);
        if (!cu || d > cu.d) theoKhach.set(s.guest, { d, sample: s.id });
      }
      const top = [...theoKhach.entries()].map(([g2, o]) => ({ guest: g2, d: o.d, sample: o.sample }))
        .sort((x, y) => y.d - x.d).slice(0, TOP);
      ghiRa.push({ mGhi, canh: Math.max(mGhi.w, mGhi.h), net: E.doNet(crop), vec, top });
    }
  }

  const cli = await db().connect();
  try {
    await cli.query('BEGIN');
    if (!await HD.danhDauDaSoi(cli, a.id, luongId, ghiRa.length)){
      await cli.query('ROLLBACK');
      return null;                      // mất quyền giữ — bỏ, không ghi gì
    }
    let soGoi = 0;
    for (const x of ghiRa){
      const faceId = (await cli.query(`INSERT INTO crm_event_faces
        (event_photo_id,box_x,box_y,box_w,box_h,canh_px,do_net,diem_do,moc,vec,run_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [a.id, x.mGhi.x, x.mGhi.y, x.mGhi.w, x.mGhi.h, x.canh, x.net, x.mGhi.diem,
          JSON.stringify(x.mGhi.moc), veBytes(x.vec), runIdTam])).rows[0].id;
      for (const t of x.top){
        const r = await cli.query(`INSERT INTO crm_face_candidates
          (event_photo_id,face_id,guest_id,sample_id,score,nguon,trang_thai,run_id)
          VALUES ($1,$2,$3,$4,$5,'may','cho',$6) ON CONFLICT DO NOTHING RETURNING id`,
          [a.id, faceId, t.guest, t.sample, t.d, runIdTam]);
        if (r.rowCount) soGoi++;
      }
    }
    await cli.query('COMMIT');
    return { so_mat: ghiRa.length, goi_y: soGoi };
  } catch (e){
    await cli.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cli.release(); }
}

/* Chuẩn bị MẪU — đúng một luồng làm, những luồng khác đợi.
   Việc này (tính vector cho mẫu BTL vừa khoanh tay, rồi khớp chúng với mặt đã
   lưu) là việc của CẢ ĐỢT, không của một luồng. Năm luồng cùng làm thì năm lần
   tải cùng một ảnh mẫu và năm lần khớp lại toàn bộ mặt cũ. Luồng số 1 làm, ghi
   so_mau vào sổ đợt như một lá cờ «xong rồi»; luồng khác đợi lá cờ ấy trước khi
   đọc mẫu — đọc sớm là bỏ sót đúng những mẫu mới mà BTL vừa khoanh. */
async function chuanBiMau(phien, luong, log){
  if (luong.so === 1){
    const mauMoi = await tinhMauKhoanhTay(phien, log);
    await napMau(phien, log);
    const them = await khopMauMoiVoiMatCu(await docMau(), log);
    await db().query('UPDATE crm_nhan_dien_runs SET so_mau = $2 WHERE id = $1',
      [luong.runId, mauMoi.length]);
    if (them) await db().query(
      'UPDATE crm_nhan_dien_luong SET goi_y = goi_y + $2 WHERE id = $1', [luong.id, them]);
    return them;
  }
  const het = Date.now() + CHO_MAU_MS;
  for (;;){
    const r = (await db().query('SELECT so_mau FROM crm_nhan_dien_runs WHERE id = $1',
      [luong.runId])).rows[0];
    if (r && r.so_mau != null) return 0;
    if (Date.now() > het){ log('  luồng ' + luong.so + ': chờ mẫu quá lâu, chạy tiếp với mẫu hiện có'); return 0; }
    await ngu(CHO_MS);
  }
}

/* Một luồng, từ lúc nhận tới lúc buông. */
async function chayMotLuong(phien, luong, log){
  const d = { da_soi: 0, so_mat: 0, goi_y: 0, so_loi: 0 };
  /* Cửa sổ trượt 100 tấm gần nhất — true là lỗi. Đếm dồn từ đầu đợt thì một luồng
     hỏng nửa sau vẫn nằm dưới ngưỡng nhờ nửa đầu chạy tốt. */
  const cuaSo = [];
  let tuHam = null;

  log('  luồng ' + luong.so + ' (id ' + luong.id + ') nhận việc trên máy ' + os.hostname());
  await chuanBiMau(phien, luong, log);
  const mau = await docMau();
  log('  luồng ' + luong.so + ': mẫu dùng để so ' + mau.length + ' vector · '
    + new Set(mau.map(m => m.guest)).size + ' khách');
  if (!mau.length){
    await nhaAnh(luong.id);
    await chotLuong(luong.id, 'loi', d, 'Không có mẫu nào dùng được — kiểm lại cửa ảnh mẫu.');
    return;
  }

  for (;;){
    const co = await nhip(luong.id, d);

    if (co.dot === 'huy' || co.luong === 'huy'){
      await nhaAnh(luong.id);
      await chotLuong(luong.id, 'huy', d, null);
      log('  luồng ' + luong.so + ': đợt bị dừng hẳn — đã nhả tấm đang giữ');
      return;
    }
    if (co.luong === 'mat-lien-lac'){
      /* Nhịp dọn đã coi tôi là chết và nhả ảnh của tôi cho luồng khác. Buông
         ngay: chạy tiếp là ghi lên những tấm không còn thuộc về mình. */
      await nhaAnh(luong.id);
      log('  luồng ' + luong.so + ': máy chủ coi luồng này đã mất liên lạc — buông');
      return;
    }
    if (co.luong === 'tam-dung' || co.dot === 'tam-dung'){
      const nha = await nhaAnh(luong.id);
      if (co.luong !== 'tam-dung'){
        await db().query(
          `UPDATE crm_nhan_dien_luong SET trang_thai = 'tam-dung' WHERE id = $1 AND trang_thai = 'chay'`,
          [luong.id]);
      }
      if (nha) log('  luồng ' + luong.so + ': tạm dừng — nhả ' + nha + ' tấm về hàng đợi');
      await ngu(2000);
      continue;                          // ngủ nhưng VẪN thở: vòng sau lại ghi nhịp
    }
    if (co.luong !== 'chay'){            // xong / loi — ai đó đã chốt sổ hộ
      await nhaAnh(luong.id);
      return;
    }

    const tam = await xinAnh(luong.id, GIU_MOI_LUOT);
    if (!tam.length){
      await chotLuong(luong.id, 'xong', d, null);
      log('  luồng ' + luong.so + ': hàng đợi cạn · ' + d.da_soi + ' tấm · '
        + d.so_mat + ' mặt · ' + d.goi_y + ' gợi ý · ' + d.so_loi + ' tấm lỗi');
      return;
    }

    for (const a of tam){
      let ket = null, loiCuoi = null;
      for (let lan = 0; lan <= GIAN_THU_LAI.length; lan++){
        try {
          ket = await soiMotTam(phien, mau, a, luong.id, luong.nguong);
          loiCuoi = null;                 // lượt này thành công — xoá dấu vết lượt hỏng trước
          break;
        }
        catch (e){
          loiCuoi = cauNgan(e);
          /* Giãn dần 1s · 4s · 15s. Không thử lại ngay: cái hỏng tối qua là mạng
             cạn cổng, và đâm lại lập tức chỉ làm nó cạn nhanh hơn. */
          if (lan < GIAN_THU_LAI.length) await ngu(GIAN_THU_LAI[lan]);
        }
      }

      if (ket === null && loiCuoi === null){
        /* Mất quyền giữ tấm — không phải lỗi, không đếm vào tỉ lệ lỗi. */
        continue;
      }
      if (ket){
        d.da_soi++; d.so_mat += ket.so_mat; d.goi_y += ket.goi_y;
        cuaSo.push(false);
      } else {
        d.so_loi++;
        d.loi = 'Tấm ' + a.orig_name + ': ' + loiCuoi;
        cuaSo.push(true);
        /* Nhả ĐÚNG tấm hỏng, không nhả cả nắm đang cầm — 24 tấm kia đã trả tiền
           tải và dò rồi. */
        await nhaMotAnh(luong.id, a.id).catch(() => {});
      }
      if (cuaSo.length > CUA_SO_LOI) cuaSo.shift();

      /* TỰ HÃM. Thà dừng một luồng còn hơn cày 1.601 tấm rỗng như tối qua. Phép
         quyết định nằm ở hang-doi.js để kiểm được không cần engine. */
      const ham = HD.nenTuHam(cuaSo);
      if (!tuHam && ham){
        tuHam = 'Tự tạm dừng: ' + ham.loi + '/' + ham.xet + ' tấm gần đây bị lỗi. '
          + 'Lỗi cuối — ' + (loiCuoi || d.loi || 'không rõ') + '.';
        break;
      }

      const co2 = await nhip(luong.id, Object.assign({ anh_hien_tai: a.orig_name }, d));
      if (co2.luong !== 'chay' || co2.dot !== 'chay') break;   // đọc cờ SAU MỖI TẤM
    }

    if (tuHam){
      const nha = await nhaAnh(luong.id);
      await db().query(
        `UPDATE crm_nhan_dien_luong SET trang_thai = 'tam-dung', nhip_cuoi = now(),
                anh_hien_tai = NULL, da_soi = $2, so_mat = $3, goi_y = $4, so_loi = $5, loi = $6
          WHERE id = $1 AND trang_thai = 'chay'`,
        [luong.id, d.da_soi, d.so_mat, d.goi_y, d.so_loi, tuHam]);
      log('  luồng ' + luong.so + ': ' + tuHam + ' Đã nhả ' + nha + ' tấm.');
      /* Câu lý do phải SỐNG SÓT qua những nhịp thở kế tiếp. Không có dòng này thì
         `nhip()` ở đầu vòng lặp sau ghi đè `loi` bằng câu lỗi của tấm cuối cùng —
         và hai giây sau, bảng hiện «Tấm anh-20.jpg: khoá MinIO sai» thay vì
         «tự tạm dừng vì 20/20 tấm gần đây bị lỗi». Câu thứ nhất nói tấm nào hỏng;
         chỉ câu thứ hai trả lời được câu người vận hành thật sự đang hỏi: vì sao
         luồng này đứng. Đo được ở lab. */
      d.loi = tuHam;
      tuHam = null;
      cuaSo.length = 0;                  // tiếp tục là bắt đầu đếm lại, không hãm ngay
    }
  }
}

async function chayTruc(){
  batBuoc();
  kiemMoiTruong();
  const log = s => console.log(s);
  const may = os.hostname();
  log('── TRỰC ──  máy ' + may + '  ngưỡng ' + NGUONG + (MOT_LUOT ? '  (một lượt)' : ''));

  /* D127 · FR-1 — khai tên vào sổ máy TRƯỚC cả khi mở phiên engine, và trước vòng
     lặp xin luồng. Máy quét mất vài giây để nạp model 37 MB; trong mấy giây ấy nó
     ĐÃ là một máy quét đang lên, và người đang nhìn trang phải thấy nó. */
  await HD.thoMay(db(), may, process.pid).catch(e => log('  [sổ máy] ' + cauNgan(e)));

  /* …và vì tên đã khai TRƯỚC khi engine mở, mọi đường ra sau dòng này đều phải đi
     qua chỗ xoá tên. Bản vòng 2 chỉ xoá ở hai lối: Ctrl-C và thoát êm. Lối thứ ba
     — `E.moPhien()` ném vì model hỏng, hoặc bất kỳ lỗi nào giữa chừng — bỏ lại
     một hàng sống 3 phút, và bảng đếm một MÁY QUÉT MA: người vận hành thấy «Đang
     có 1 máy quét», chọn 1 luồng, rồi ngồi đợi một tiến trình đã chết từ lúc nào.
     `finally` là chỗ duy nhất che được cả ba lối cùng lúc. */
  try {
  const phien = await E.moPhien();
  let dangGiu = null;
  /* Ctrl-C giữa chừng phải NHẢ ẢNH, không để lại 25 tấm bị khoá cho tới khi nhịp
     dọn của web nhận ra sau 3 phút. Và phải XOÁ TÊN khỏi sổ máy: một máy quét vừa
     tắt mà bảng còn đếm nó là bảng mời người ta chọn 3 luồng cho 2 máy. */
  const buong = async () => {
    if (dangGiu){ try { await nhaAnh(dangGiu); } catch (_){} }
    try { await HD.quenMay(db(), may, process.pid); } catch (_){}
    try { await db().end(); } catch (_){}
    process.exit(0);
  };
  process.on('SIGINT', buong);
  process.on('SIGTERM', buong);

  /* NHỊP THỞ RIÊNG, không đi kèm việc. `nhip()` chạy sau mỗi tấm là đủ ở nhịp
     bình thường (1,3 giây/tấm), nhưng một tấm gặp mạng xấu có thể ngốn tới ba
     phút: 60 giây hạn tải × ba lượt, cộng 1+4+15 giây giãn. Không có cái đồng hồ
     này thì đúng lúc luồng đang KIÊN NHẪN thử lại, web lại kết luận nó đã chết,
     nhả ảnh nó đang cầm cho luồng khác — và hai luồng cùng ghi một tấm.
     Điều kiện trạng thái trong câu UPDATE là quan trọng: một luồng đã bị chốt sổ
     thì cái đồng hồ này KHÔNG được phép hồi sinh nó. */
  const timTho = setInterval(() => {
    if (!dangGiu) return;
    HD.tho(db(), dangGiu).catch(() => { /* mạng chớp — nhịp sau lại thở */ });
  }, NHIP_MS);
  if (timTho.unref) timTho.unref();

  /* D127 · nhịp thứ HAI, và nó không có điều kiện nào cả. Cái đồng hồ ngay trên
     chỉ thở khi đang cầm một luồng — đúng cho câu hỏi «luồng này còn sống không»,
     nhưng câu hỏi của người đứng trước trang lúc 6h sáng là «có máy nào để mà bấm
     không». Máy quét rỗi việc vẫn phải trả lời được câu ấy, nên nhịp này chạy kể
     cả khi vòng lặp đang ngủ giữa hai lượt xin luồng. */
  const timMay = setInterval(() => {
    HD.thoMay(db(), may, process.pid).catch(() => { /* mạng chớp — nhịp sau lại thở */ });
  }, NHIP_MS);
  if (timMay.unref) timMay.unref();

  const het = Date.now() + CHO_LUONG_MS;
  for (;;){
    let luong = null;
    try { luong = await xinLuong(may); }
    catch (e){ log('  [kết nối] không xin được luồng: ' + cauNgan(e)); }

    if (!luong){
      if (MOT_LUOT && Date.now() > het){ log('  không còn luồng nào để nhận — thoát'); break; }
      await ngu(CHO_MS);
      continue;
    }

    /* Ngưỡng ghi trong sổ đợt PHẢI khớp ngưỡng biên dịch vào máy quét. Lệch nghĩa
       là hai nơi đang nói hai con số khác nhau về cùng một đợt, và sổ sẽ ghi một
       ngưỡng không đúng thứ đã dùng — đúng thứ AC-10 kiểm. Từ chối, nói rõ. */
    if (luong.nguong != null && Math.abs(Number(luong.nguong) - NGUONG) > 1e-6){
      await chotLuong(luong.id, 'loi', { da_soi: 0, so_mat: 0, goi_y: 0, so_loi: 0 },
        'Ngưỡng của đợt (' + luong.nguong + ') khác ngưỡng của máy quét (' + NGUONG + ').');
      log('  luồng ' + luong.so + ': từ chối vì lệch ngưỡng');
      if (MOT_LUOT) break;
      await ngu(CHO_MS);
      continue;
    }

    dangGiu = luong.id;
    try { await chayMotLuong(phien, luong, log); }
    catch (e){
      const cau = cauNgan(e);
      log('  luồng ' + luong.so + ' hỏng: ' + cau);
      await nhaAnh(luong.id).catch(() => {});
      await db().query(
        `UPDATE crm_nhan_dien_luong SET trang_thai = 'loi', xong_luc = now(), nhip_cuoi = now(),
                anh_hien_tai = NULL, loi = $2 WHERE id = $1`, [luong.id, cau]).catch(() => {});
    }
    dangGiu = null;
    if (MOT_LUOT) break;
  }
  } finally {
    /* Thoát êm (--mot-luot hết việc) HAY thoát vì lỗi — cả hai đều là một máy quét
       rời khỏi bàn. Cùng lý do với `buong()`: đừng để bảng đếm một cái đã đi. */
    await HD.quenMay(db(), may, process.pid).catch(() => {});
  }
  await db().end();
}

/* E08-D134 · một lượt TÁI KHỚP TOÀN KHO và không gì khác (FR-5).
   Mặc định THỬ; chỉ ghi khi có --commit, cùng khuôn với mọi lệnh khác ở thư mục
   này. Không mở đợt trong crm_nhan_dien_runs, không đụng hàng đợi ảnh, không
   chạm soi_luc — nó chỉ đọc hai bảng vector rồi có thể thêm dòng gợi ý 'cho'. */
async function chayChiKhopLai(){
  kiemMoiTruong(false);
  const log = s => console.log(s);
  const t0 = new Date();
  log((GHI ? '── TÁI KHỚP · GHI THẬT ──' : '── TÁI KHỚP · THỬ (không ghi gì) ──')
    + '  ngưỡng ' + NGUONG);
  const mau = await docMau();
  const soKhach = new Set(mau.map(m => m.guest)).size;
  log('  mẫu dùng để so: ' + mau.length + ' vector · ' + soKhach + ' khách');
  if (!mau.length){
    log('  không có mẫu nào dùng được — không có gì để khớp.');
    await db().end();
    return;
  }
  const soMat = (await db().query(`SELECT count(*)::int n FROM crm_event_faces
    WHERE deleted_at IS NULL AND vec IS NOT NULL`)).rows[0].n;
  log('  mặt sự kiện sống có vector: ' + soMat);
  const them = await khopMauMoiVoiMatCu(mau, log, GHI);
  if (GHI){
    await ghiSoTaiKhop({ so_mau: mau.length, so_khach: soKhach, so_mat_xet: soMat,
      goi_y_cho_moi: them, nguong: NGUONG,
      bat_dau: t0.toISOString(), xong_luc: new Date().toISOString() });
    log('  đã ghi sổ audit face_khop_lai.');
  } else {
    log('  (THỬ — không ghi dòng nào. Thêm --commit để ghi thật.)');
  }
  await db().end();
}

(async () => {
  if (TRUC) return chayTruc();
  if (CHI_KHOP_LAI) return chayChiKhopLai();
  batBuoc();
  kiemMoiTruong();
  const runId = 'run-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
              + '-' + crypto.randomBytes(3).toString('hex');
  const log = s => console.log(s);
  log((GHI ? '── GHI THẬT ──' : '── THỬ (không ghi gì) ──') + '  đợt ' + runId
    + '  ngưỡng ' + NGUONG + '  top ' + TOP);

  /* E08-D134 · BƯỚC DỌN HẠN TRƯỚC MỖI LƯỢT GHI ĐÃ BỎ.
     Chỗ này từng chạy một câu UPDATE đặt vec = NULL cho mọi mặt quá het_han_luc,
     và lập luận đặt nó ở đây rất chắc: đây là chỗ CHẮC CHẮN được chạy, khác một
     lệnh dọn riêng mà không ai nhớ gọi. Lập luận ấy vẫn đúng — nhưng nó là lập
     luận về CHỖ ĐẶT một việc, còn vé này bỏ chính cái việc đó.
     Sponsor 16/08/2026: giữ vector vĩnh viễn chừng nào bản ghi nguồn còn sống.
     Mọi đường xoá có chủ ý vẫn nguyên (gỡ ảnh, gỡ đợt, gỡ mẫu, xoá cứng, xoá
     khách) — cái bị bỏ là đồng hồ. Xem khối D134 ở server/crm-db.js. */

  const phien = await E.moPhien();
  let mauVuaTinh = [];
  if (GHI) mauVuaTinh = await tinhMauKhoanhTay(phien, log);
  const mauTam = await napMau(phien, log);
  const mau = GHI ? await docMau() : mauTam;
  if (GHI){
    const canKhop = KHOP_LAI ? await docMau() : mauVuaTinh;
    if (KHOP_LAI) log('  --khop-lai: đối chiếu TẤT CẢ ' + canKhop.length + ' mẫu với mặt đã lưu');
    await khopMauMoiVoiMatCu(canKhop, log);
  }
  log('  mẫu dùng để so: ' + mau.length + ' vector · ' + new Set(mau.map(m => m.guest)).size + ' khách');
  if (!mau.length) throw new Error('không có mẫu nào dùng được — kiểm lại cửa ảnh mẫu');

  /* D126 · hàng đợi của lượt chạy tay cũng đổi sang `soi_luc IS NULL`, cùng định
     nghĩa với chế độ trực. Hai định nghĩa hàng đợi song song thì lượt chạy tay sẽ
     soi lại những tấm máy quét vừa soi xong — mỗi bên tự thấy mình đúng.
     Thêm `soi_luong_id IS NULL` để lượt chạy tay không giẫm lên tấm một luồng
     đang cầm. Cờ --gioi-han / --bo-qua giữ nguyên cho lượt chạy tay, nhưng chúng
     KHÔNG còn là cách chia việc giữa nhiều luồng nữa. */
  const anh = (await db().query(`SELECT id, orig_name, width, height, coalesce(preview_key, object_key) k
    FROM crm_event_photos WHERE deleted_at IS NULL
      ${GHI ? 'AND soi_luc IS NULL AND soi_luong_id IS NULL' : ''}
    ORDER BY id ${GIOI_HAN ? 'LIMIT ' + GIOI_HAN : ''} ${BO_QUA ? 'OFFSET ' + BO_QUA : ''}`)).rows;
  log('  ảnh sự kiện cần xử lý: ' + anh.length);

  let soMat = 0, soGoi = 0, khongMat = 0, loiAnh = 0;
  const phanBo = [], diemTot = [], kho2 = [];
  const t0 = Date.now();
  for (const a of anh){
    try {
      const buf = await layObj(a.k);
      const matThuc = await E.phatHien(phien, buf, { nguongDiem: 0.6 });
      /* D126 · đánh dấu ĐÃ SOI kể cả khi không thấy mặt nào. Không có dòng này
         thì 1.217 tấm đã biết không có mặt người vẫn nằm đầu hàng đợi và ăn 26
         phút mỗi lượt chạy — con số ấy tăng theo kho. */
      if (!matThuc.length){
        khongMat++;
        if (GHI) await db().query(
          'UPDATE crm_event_photos SET soi_luc = now(), soi_so_mat = 0 WHERE id = $1 AND soi_luc IS NULL',
          [a.id]);
        continue;
      }
      const g = await E.anhGoc(buf);
      /* Cắt mặt vẫn dùng toạ độ của CHÍNH buffer đang cầm; chỉ những gì GHI RA
         hoặc so với dữ liệu bên ngoài mới quy về thang 2048. */
      const k = heSoThang(a, g);
      const mat = matThuc.map(m => ({ goc: m, ghi: quyThang(m, k, { w: a.width, h: a.height }) }));
      for (const mm of mat){
        const m = mm.goc, mGhi = mm.ghi;
        const crop = E.catCan(g.raw, g.w, g.h, m.moc);
        const vec = await E.nhung(phien, crop);
        const canh = Math.max(mGhi.w, mGhi.h), net = E.doNet(crop);
        phanBo.push([canh, net]);
        soMat++;
        let faceId = null;
        if (GHI){
          faceId = (await db().query(`INSERT INTO crm_event_faces
            (event_photo_id,box_x,box_y,box_w,box_h,canh_px,do_net,diem_do,moc,vec,run_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [a.id, mGhi.x, mGhi.y, mGhi.w, mGhi.h, canh, net, mGhi.diem,
             JSON.stringify(mGhi.moc), veBytes(vec), runId])).rows[0].id;
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
      if (GHI) await db().query(
        'UPDATE crm_event_photos SET soi_luc = now(), soi_so_mat = $2 WHERE id = $1 AND soi_luc IS NULL',
        [a.id, mat.length]);
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
