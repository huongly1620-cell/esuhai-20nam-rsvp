'use strict';
/* E08-D077 · Tải trọng số — BƯỚC RIÊNG, không nằm trong lệnh batch (AC-4).
   Batch thiếu model thì DỪNG, tuyệt đối không tự tải giữa chừng: nếu batch tự
   tải thì "0 egress lúc chạy" không còn kiểm được, và một lần chạy có thể lặng
   lẽ kéo về một file khác với file đã kiểm. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

/* LFS: raw.githubusercontent trả về CON TRỎ (vài trăm byte), không phải trọng số.
   Đường media/ mới trả file thật. Checksum dưới đây lấy từ chính dòng
   `oid sha256:` trong con trỏ LFS — tức là do OpenCV Zoo công bố, không phải do
   mình tự tính rồi tự tin. */
const GOC = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models';
const GOC_RAW = 'https://raw.githubusercontent.com/opencv/opencv_zoo/main/models';
const MODEL = [
  { ten: 'yunet.onnx',
    url: GOC + '/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    giay_phep: GOC_RAW + '/face_detection_yunet/LICENSE' },
  { ten: 'sface.onnx',
    url: GOC + '/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    sha: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    giay_phep: GOC_RAW + '/face_recognition_sface/LICENSE' },
];
const THU_MUC = path.join(__dirname, 'model');

async function tai(url){
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' · ' + url);
  return Buffer.from(await r.arrayBuffer());
}
(async () => {
  fs.mkdirSync(THU_MUC, { recursive: true });
  const inSha = process.argv.includes('--in-sha');
  for (const m of MODEL){
    const dich = path.join(THU_MUC, m.ten);
    const buf = await tai(m.url);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (inSha){ console.log(m.ten.padEnd(12) + sha + '  ' + (buf.length/1048576).toFixed(2) + ' MB'); }
    else if (sha !== m.sha){
      throw new Error('checksum lệch cho ' + m.ten + '\n  mong: ' + m.sha + '\n  thật: ' + sha
        + '\n  Chạy lại với --in-sha để xem, và CHỈ cập nhật hằng số sau khi biết vì sao nó đổi.');
    }
    fs.writeFileSync(dich, buf);
    /* Giấy phép nằm cạnh trọng số: vé chốt Apache-2.0, và người sau phải kiểm
       được điều đó mà không cần mở lại lịch sử chat. */
    try { fs.writeFileSync(dich.replace(/\.onnx$/, '.LICENSE.txt'), await tai(m.giay_phep)); }
    catch (e){ console.warn('  (chưa lấy được giấy phép của ' + m.ten + ': ' + e.message + ')'); }
    if (!inSha) console.log('  ✓ ' + m.ten + '  ' + (buf.length/1048576).toFixed(2) + ' MB  ' + sha.slice(0,16));
  }
})().catch(e => { console.error('LOI ' + e.message); process.exit(1); });
