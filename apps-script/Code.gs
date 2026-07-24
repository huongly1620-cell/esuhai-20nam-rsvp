/**************************************************************************
 * ESUHAI Group · 20 Năm · Form Xác nhận tham dự — BACKEND (Apps Script)
 * ------------------------------------------------------------------------
 * Vai trò: LƯU dữ liệu. Trang đẹp do GitHub Pages hiển thị; file này chỉ
 * nhận thông tin khách gửi lên (qua doPost) và ghi 1 dòng vào Google Sheet.
 *
 * Cách dùng: dán toàn bộ file này vào Apps Script GẮN VỚI 1 Google Sheet
 * (Sheet → Tiện ích mở rộng → Apps Script), rồi Triển khai thành "Ứng dụng
 * web" để lấy link kết thúc bằng /exec. Xem HUONG_DAN_DEPLOY.md.
 *
 * Xuất bản lúc: 2026-07-24 17:32  ·  CL1 – Hương Ly
 **************************************************************************/

/* Tên tab (sheet) chứa dữ liệu đăng ký. Đổi nếu muốn. */
var SHEET_NAME = 'DangKy';

/* Hàng tiêu đề cột trong Google Sheet */
var HEADERS = [
  'Thời gian nhận', 'Trạng thái', 'Phần tham dự',
  'SĐT đại diện', 'Email đại diện', 'Số khách',
  'Khách 1 – Họ tên', 'Khách 1 – Đơn vị', 'Khách 1 – Chức danh', 'Khách 1 – Giới tính',
  'Khách 2 – Họ tên', 'Khách 2 – Đơn vị', 'Khách 2 – Chức danh', 'Khách 2 – Giới tính',
  'Ẩm thực (Gala)', 'Lời chúc', 'Ghi chú'
];

/**
 * Trang GitHub Pages gửi dữ liệu về đây bằng POST (fetch).
 * e.postData.contents = chuỗi JSON thông tin khách.
 */
function doPost(e) {
  var res = { ok: false };
  try {
    var data = (e && e.postData && e.postData.contents)
      ? JSON.parse(e.postData.contents) : {};
    saveRSVP(data);
    res.ok = true;
  } catch (err) {
    res.error = String(err);
  }
  // Client dùng mode:"no-cors" nên không đọc nội dung trả về; vẫn trả JSON cho gọn.
  return ContentService
    .createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Mở link /exec bằng trình duyệt sẽ thấy dòng này (kiểm tra "còn sống").
 */
function doGet(e) {
  return ContentService
    .createTextOutput('ESUHAI 20 · RSVP endpoint OK · ' +
      Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd HH:mm:ss'))
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Ghi 1 dòng dữ liệu khách vào Google Sheet.
 * data = đối tượng thông tin khách (đã gom sẵn ở phía trang web).
 */
function saveRSVP(data) {
  var lock = LockService.getScriptLock();      // tránh 2 người gửi cùng lúc ghi đè nhau
  try { lock.waitLock(20000); } catch (err) { /* vẫn cố ghi */ }

  try {
    var sh = ensureSheet_();
    var tz = 'Asia/Ho_Chi_Minh';
    var now = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
    var row;

    if (data && data.status === 'no') {
      // KHÁCH KHÔNG THAM DỰ — lưu quý danh + lời nhắn
      var rep = data.rep || {};
      row = [
        now, 'Không tham dự', '',
        '', '', '',
        rep.name || '', rep.org || '', '', '',
        '', '', '', '',
        '', data.wish || '', ''
      ];
    } else {
      // KHÁCH THAM DỰ
      var g  = (data && data.guests) || [];
      var g1 = g[0] || {}, g2 = g[1] || {};
      var r  = (data && data.rep) || {};
      row = [
        now, 'Tham dự',
        ((data && data.sessions) || []).join(' · '),
        r.phone || '', r.email || '',
        g.length,
        g1.name || '', g1.org || '', g1.title || '', g1.gender || '',
        g2.name || '', g2.org || '', g2.title || '', g2.gender || '',
        (data && data.dietary) || '', (data && data.wish) || '', (data && data.note) || ''
      ];
    }

    sh.appendRow(row);

    // (TÙY CHỌN) Gửi email báo BTC mỗi khi có đăng ký mới:
    // bỏ dấu // ở 2 dòng dưới và điền email nhận thông báo.
    // var NOTIFY = 'hanhchanh@esuhai.com';
    // MailApp.sendEmail(NOTIFY, 'RSVP mới · Gala 20 năm ESUHAI', row.join('\n'));

    return { ok: true };
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

/**
 * Tìm (hoặc tạo mới) tab dữ liệu + kẻ hàng tiêu đề đẹp. Chạy tự động.
 */
function ensureSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    var head = sh.getRange(1, 1, 1, HEADERS.length);
    head.setFontWeight('bold')
        .setBackground('#0b1e38')
        .setFontColor('#f5efe1')
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle')
        .setWrap(true);
    sh.setFrozenRows(1);
    sh.setRowHeight(1, 40);
  }
  return sh;
}

/**
 * Thêm menu tiện ích trong Google Sheet để chị thao tác không cần code.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📋 ESUHAI RSVP')
    .addItem('① Tạo/kiểm tra tab dữ liệu', 'ensureSheet_')
    .addItem('② Gửi 1 dòng thử để kiểm tra', 'testInsert_')
    .addToUi();
}

/** Chèn 1 dòng dữ liệu giả để chị kiểm tra Sheet nhận đúng chưa. */
function testInsert_() {
  saveRSVP({
    status: 'yes', sessions: ['Tọa đàm', 'Gala'],
    rep: { name: 'Nguyễn Văn Thử', phone: '0900000000', email: 'thu@example.com' },
    guests: [{ name: 'Nguyễn Văn Thử', org: 'ESUHAI', title: 'Khách mời', gender: 'Nam' }],
    dietary: 'Món mặn', wish: '(dòng thử — có thể xóa)', note: ''
  });
  SpreadsheetApp.getUi().alert('Đã chèn 1 dòng thử vào tab "' + SHEET_NAME + '". Kiểm tra rồi xóa dòng đó đi nhé.');
}
