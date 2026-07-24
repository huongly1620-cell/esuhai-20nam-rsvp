> ⚠️ **DEPRECATED (2026-07-24).** Hệ thống đã chuyển sang **Railway + Postgres** (xem `README.md`).
> Không cần deploy Apps Script, không cần Google Sheet. Tài liệu này chỉ để tham khảo lịch sử.

# Hướng dẫn nối trang với Google Sheet (Apps Script)

**Sự kiện:** Gala Kỷ niệm 20 năm ESUHAI Group · 08/08/2026 · GEM Center
**Xuất bản lúc:** 2026-07-24 17:32 · CL1 – Hương Ly

> Trang đẹp (`dang-ky.html`, `tiec-toi.html`) đã do **GitHub Pages** lo phần hiển thị.
> Việc còn lại ở đây: dựng một "kho chứa" để mỗi lượt khách điền **tự thêm 1 dòng vào Google Sheet**.
> Toàn bộ khoảng **10 phút**, chỉ copy – paste, không cần biết lập trình.

---

## Bước 1 — Tạo Google Sheet mới

1. Vào **drive.google.com** → **Mới (＋)** → **Google Trang tính** (Google Sheets).
2. Đặt tên, ví dụ: **`ĐĂNG KÝ - Gala 20 năm ESUHAI`**.

> Không cần tự tạo cột — hệ thống tự kẻ hàng tiêu đề khi có đăng ký đầu tiên.

---

## Bước 2 — Mở trình soạn mã (Apps Script)

1. Ngay trong Google Sheet vừa tạo, bấm menu **Tiện ích mở rộng** (Extensions) → **Apps Script**.
2. Cửa sổ mới mở ra, có sẵn file `Code.gs` với dòng `function myFunction() {}`.

---

## Bước 3 — Dán "phần lưng" (Code.gs)

1. **Xóa sạch** nội dung mẫu trong ô soạn mã.
2. Mở file **`apps-script/Code.gs`** trong repo này → **Chọn tất cả (Cmd+A)** → **Copy (Cmd+C)**.
3. Quay lại Apps Script → **Dán (Cmd+V)** → bấm **💾 Lưu**.

> ⚠️ Bản này **KHÔNG** cần thêm file Index.html như trước. Trang đẹp đã nằm ở GitHub.

---

## Bước 4 — Triển khai để lấy link `/exec`

1. Góc phải trên, bấm **Triển khai** (Deploy) → **Bản triển khai mới** (New deployment).
2. Bấm bánh răng ⚙️ cạnh "Chọn loại" → chọn **Ứng dụng web** (Web app).
3. Điền:
   - **Mô tả:** `RSVP 20 năm` (tùy ý)
   - **Chạy với tư cách** (Execute as): **Tôi** (Me)
   - **Ai có quyền truy cập** (Who has access): **Bất kỳ ai** (Anyone)
     > ⚠️ Chọn đúng **"Bất kỳ ai"** (không phải "…có Tài khoản Google") để trang gửi được dữ liệu mà khách không phải đăng nhập.
4. Bấm **Triển khai**.

### Lần đầu Google xin cấp quyền — bình thường:

5. **Ủy quyền truy cập** → chọn tài khoản Google của chị.
6. Gặp màn hình **"Google chưa xác minh ứng dụng này"** → **Nâng cao** (Advanced) → **Chuyển đến … (không an toàn)**.
   > Đây là script **của chính chị** nên an toàn; Google chỉ cảnh báo vì script tự viết.
   > (Khách mời **không bao giờ** thấy màn hình này — họ chỉ mở trang GitHub đẹp.)
7. **Cho phép** (Allow) → Google hiện **đường link Ứng dụng web** kết thúc bằng **`/exec`**. **Copy link này.**

> 📌 Mở thử link `/exec` trên trình duyệt: thấy dòng chữ *"ESUHAI 20 · RSVP endpoint OK…"* là đúng.

---

## Bước 5 — Dán link `/exec` vào `config.js` (CHỖ DUY NHẤT cần sửa)

1. Mở file **`config.js`** ở thư mục gốc repo.
2. Dán link vào giữa hai dấu ngoặc kép:
   ```js
   window.RSVP_ENDPOINT = "https://script.google.com/macros/s/AKfy.../exec";
   ```
3. Lưu lại, rồi **đưa file `config.js` đã sửa lên GitHub** (xem `../HUONG_DAN_GITHUB.md`).

→ Từ giờ cả **hai trang** `dang-ky.html` và `tiec-toi.html` đều gửi dữ liệu về đúng Google Sheet này.

---

## Bước 6 — Kiểm tra thật

1. Mở link GitHub Pages `.../dang-ky.html`, điền thử 1 lượt, bấm **Gửi xác nhận**.
2. Mở lại Google Sheet → tab **`DangKy`** phải có 1 dòng mới.
   > Trong Apps Script cũng có menu **📋 ESUHAI RSVP → ② Gửi 1 dòng thử** để kiểm tra nhanh.

---

## Khi cần sửa Code.gs sau này (GIỮ NGUYÊN link `/exec`)

Nếu sửa `Code.gs`, **đừng tạo "Bản triển khai mới"** (sẽ ra link khác). Hãy làm:

1. **Triển khai** → **Quản lý bản triển khai** (Manage deployments).
2. Bấm biểu tượng **✏️ (Chỉnh sửa)**.
3. Mục **Phiên bản** → **Phiên bản mới** (New version) → **Triển khai**.

→ Link `/exec` **giữ nguyên**, không phải sửa lại `config.js`.

---

## (Tùy chọn) Nhận email báo mỗi khi có đăng ký mới

Trong `Code.gs`, tìm đoạn `MailApp.sendEmail` (đang khóa bằng `//`). Bỏ `//` ở 2 dòng đó, điền email nhận thông báo, rồi Lưu + Triển khai phiên bản mới. Lần Lưu tiếp theo Google sẽ xin thêm quyền gửi email — cứ **Cho phép**.

---

## Xử lý sự cố nhanh

| Hiện tượng | Cách xử lý |
|---|---|
| Điền xong không thấy dòng trong Sheet | Kiểm tra `config.js` đã dán đúng link `/exec` và đã đẩy lên GitHub chưa; deploy chọn **"Bất kỳ ai"** chưa |
| Mở link `/exec` báo lỗi quyền | Bước 4 chọn nhầm — sửa "Ai có quyền" thành **Bất kỳ ai**, rồi triển khai phiên bản mới |
| Muốn xem/ lọc danh sách | Mở Google Sheet → **Dữ liệu → Tạo bộ lọc**, lọc theo Trạng thái / Phần tham dự / Ẩm thực |

*Mọi thắc mắc trong lúc làm, chị chụp màn hình gửi em — em hướng dẫn tiếp từng bước.*
