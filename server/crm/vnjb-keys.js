'use strict';

// Khoá định danh + luật gắn tag của sheet SoT «Khách Việt Nam+Nhat Ban».
//
// TÁCH RA MODULE RIÊNG có lý do: `import-vnjb.js` là script CLI chạy ngay khi
// nạp — nó là một IIFE async ở cuối file, nên `require('./import-vnjb')` sẽ
// KHỞI ĐỘNG một lượt import thật. Script dry-run / backfill vì thế không thể
// mượn hàm của nó, và lần trước (D026) hậu quả của việc chép lại luật chuẩn hoá
// sang chỗ khác là hai bản không khớp nhau ở 12/23 ca — 4 thẻ khách thật không
// ai tìm ra. Một định nghĩa, nhiều nơi dùng.

const crypto = require('crypto');

const norm = (s) => String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim();

const HONOR = /^(anh|chị|chi|ông|ong|bà|ba|cô|co|chú|chu|thầy|thay|em|mr|mrs|ms|dr|gs|ts)\.?\s+/i;
function nameKey(s) {
  let x = norm(s).toLowerCase();
  for (let i = 0; i < 3; i++) x = x.replace(HONOR, '');
  return x.trim();
}

// Khoá idempotent của thẻ SoT. CỐ Ý không dùng STT: STT đổi mỗi lần Ly chèn dòng.
function codeOfParts(ten, donvi, chucvu) {
  return 'vnjb-' + crypto.createHash('sha1')
    .update(nameKey(ten) + '|' + nameKey(donvi) + '|' + nameKey(chucvu))
    .digest('hex').slice(0, 10);
}

// AC-F1/F3/F3b — cột 4 «KHÁCH VIP/THƯỜNG · VIP/一般» KIÊM cả hạng VIP lẫn một
// phần phân loại gia đình. Đếm trên SoT (332 dòng khách):
//   Thường 187 · VIP 48 · trống 37 · OB Esuhai 22 · Gia đình-Ngoại 17 ·
//   Gia đình-Nội 16 · Gia đình TGĐ 5
// Bản cũ chỉ bắt /vip/i, nên hai nút lọc «Gia đình-Nội»/«Gia đình-Ngoại» ở cửa
// đọc tag `Nội`/`Ngoại` mà chưa thẻ nào mang — bấm ra danh sách rỗng (đo prod
// 04/08: 0 và 0 trên 378 thẻ).
//
// `Thường` cố ý KHÔNG gắn tag: 187 thẻ, không nút lọc nào dùng. Không có tag
// hạng = khách thường.
function hangTags(v) {
  const s = norm(v); if (!s) return [];
  const k = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const out = [];
  // OB Esuhai (22 dòng) dùng CHUNG chuẩn với cột 2 «Phân loại khách» đã sinh
  // `pl:ob` cho 19 thẻ — 3 dòng còn lại là OB ở cột 4 nhưng TGĐ ở cột 2.
  if (/\bob\b/.test(k)) out.push('pl:ob');
  // Sponsor chốt 04/08: «Gia đình TGĐ» là tag RIÊNG, KHÔNG gộp vào `Nội`. Cả 38
  // người nhóm gia đình đều là TGĐ ở cột 2; sheet cố ý viết nhóm 5 người khác
  // hai nhóm kia. Gộp là suy đoán quan hệ họ hàng mà dữ liệu không nói — lễ tân
  // chào sai bên trước mặt gia đình TGĐ là sai không cứu được tại chỗ.
  if (/gia dinh\s*tgd/.test(k)) out.push('Gia đình TGĐ');
  else if (/ngoai/.test(k)) out.push('Ngoại');   // xét TRƯỚC `noi` cho chắc
  else if (/\bnoi\b/.test(k)) out.push('Nội');
  if (/vip/.test(k)) out.push('vip');
  return out;
}

module.exports = { norm, nameKey, codeOfParts, hangTags };
