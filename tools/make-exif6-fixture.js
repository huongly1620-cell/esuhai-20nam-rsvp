'use strict';

/* E08-D082 · sinh ẢNH MẪU EXIF Orientation 6 cho phép dò năng lực + AC-9.
 *
 * Vì sao có file này thay vì một chuỗi base64 chép tay vào HTML: AC-9 bắt buộc
 * chứng minh «ảnh dọc ra dọc» bằng một dòng assert chạy lại được mãi. Một khối
 * base64 vô danh trong HTML thì sáu tháng nữa không ai biết nó là ảnh gì, chụp
 * cỡ bao nhiêu, cờ xoay mấy — và không sửa lại được khi cần ca thử khác.
 *
 * Ảnh sinh ra: 64x32 (NGANG trong pixel thật), nửa trái đỏ / nửa phải lam, kèm
 * thẻ EXIF Orientation = 6 (nghĩa là "xoay 90° theo chiều kim đồng hồ khi hiện").
 * Trình duyệt ÁP cờ  → giải mã ra 32x64, tức DỌC  → width < height  → AC-9 đạt.
 * Trình duyệt BỎ cờ  → giải mã ra 64x32, tức NGANG → width > height → AC-9 trượt,
 * và đó chính là mìn M3: mặt người vào kho nằm ngang, D077 nhận diện hỏng theo.
 *
 * Chạy:  node tools/make-exif6-fixture.js
 * Ra:    server/crm/views/exif6.fixture.js  (data URI, nạp bằng <script>)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const os = require('os');

const W = 64, H = 32;                       // NGANG trong pixel thật

// ─────────── PNG tối giản (không phụ thuộc thư viện ngoài) ───────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function makePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type 2 = truecolour RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Nửa trái ĐỎ, nửa phải LAM — bất đối xứng để mắt người cũng thấy được xoay.
  const raw = Buffer.alloc(H * (1 + W * 3));
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;                             // filter type 0
    for (let x = 0; x < W; x++) {
      const left = x < W / 2;
      raw[o++] = left ? 0xD1 : 0x1E;
      raw[o++] = left ? 0x2B : 0x63;
      raw[o++] = left ? 0x2B : 0xC7;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────── Khối EXIF APP1 chỉ chứa đúng một thẻ Orientation ───────────
// Viết tay thay vì kéo thư viện EXIF về: cần đúng MỘT thẻ, và ai đọc lại cũng
// phải kiểm được từng byte — thư viện ở đây chỉ làm khó việc soi.
function exifApp1(orientation) {
  const tiff = Buffer.alloc(14);
  tiff.write('MM', 0, 'ascii');            // big-endian
  tiff.writeUInt16BE(42, 2);               // magic
  tiff.writeUInt32BE(8, 4);                // offset tới IFD0
  tiff.writeUInt16BE(1, 8);                // IFD0 có 1 thẻ
  const entry = Buffer.alloc(12);
  entry.writeUInt16BE(0x0112, 0);          // tag = Orientation
  entry.writeUInt16BE(3, 2);               // type = SHORT
  entry.writeUInt32BE(1, 4);               // count = 1
  entry.writeUInt16BE(orientation, 8);     // giá trị nằm ngay trong ô 4 byte
  entry.writeUInt16BE(0, 10);
  const next = Buffer.alloc(4);            // không có IFD kế
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff.subarray(0, 10), entry, next]);
  const seg = Buffer.alloc(2);
  seg.writeUInt16BE(body.length + 2, 0);   // độ dài segment tính cả 2 byte này
  return Buffer.concat([Buffer.from([0xFF, 0xE1]), seg, body]);
}

// Chèn APP1 ngay sau SOI. Nếu sips đã sinh sẵn APP1/APP0 thì chèn TRƯỚC chúng —
// đầu đọc lấy IFD0 đầu tiên, nên thẻ của mình thắng.
function spliceExif(jpeg, app1) {
  if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) throw new Error('không phải JPEG (thiếu SOI)');
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exif6-'));
const pngPath = path.join(tmp, 'src.png');
const jpgPath = path.join(tmp, 'src.jpg');
fs.writeFileSync(pngPath, makePng());
execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85',
  pngPath, '--out', jpgPath], { stdio: 'ignore' });

const withExif = spliceExif(fs.readFileSync(jpgPath), exifApp1(6));
const dataUri = 'data:image/jpeg;base64,' + withExif.toString('base64');

const out = path.join(__dirname, '..', 'server', 'crm', 'views', 'exif6.fixture.js');
fs.writeFileSync(out,
  '/* SINH TỰ ĐỘNG bởi tools/make-exif6-fixture.js — ĐỪNG sửa tay.\n'
  + '   Ảnh JPEG ' + W + 'x' + H + ' (NGANG trong pixel) + EXIF Orientation 6.\n'
  + '   Áp đúng cờ xoay ⇒ giải mã ra ' + H + 'x' + W + ' (DỌC). Xem D082 AC-9 / mìn M3. */\n'
  + 'window.EXIF6_FIXTURE = ' + JSON.stringify(dataUri) + ';\n'
  + 'window.EXIF6_RAW = ' + JSON.stringify({ w: W, h: H }) + ';\n');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('đã ghi ' + path.relative(path.join(__dirname, '..'), out)
  + '  (' + withExif.length + ' byte JPEG, ' + W + 'x' + H + ' + Orientation 6)');
