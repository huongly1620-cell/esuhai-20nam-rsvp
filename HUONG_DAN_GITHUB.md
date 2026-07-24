# Hướng dẫn đưa Landing page lên GitHub + bật link công khai (Pages)

**Xuất bản lúc:** 2026-07-24 17:32 · CL1 – Hương Ly
**Cách này KHÔNG cần cài phần mềm, KHÔNG cần dùng Terminal — chỉ thao tác trên web, kéo-thả file.**

Sau khi làm xong chị sẽ có **2 đường link công khai**:

- `https://<tên-github>.github.io/esuhai-20nam-rsvp/dang-ky.html` → khách dự **cả Tọa đàm + Gala**
- `https://<tên-github>.github.io/esuhai-20nam-rsvp/tiec-toi.html` → khách **chỉ dự Gala tối**

---

## Bước 1 — Đăng nhập GitHub

- Đã có tài khoản: vào **github.com** → **Sign in**.
- Chưa có: **github.com** → **Sign up** (miễn phí, ~3 phút, chỉ cần email + mật khẩu).

> Ghi nhớ **tên đăng nhập (username)** — nó sẽ nằm trong đường link ở trên.

---

## Bước 2 — Tạo repository (kho chứa) mới

1. Góc phải trên, bấm dấu **＋** → **New repository**.
2. **Repository name:** gõ đúng `esuhai-20nam-rsvp`
3. **Public** (để bật được trang miễn phí). *(Xem lưu ý riêng tư ở cuối trang.)*
4. **KHÔNG** tích "Add a README" (mình đã có sẵn file rồi).
5. Bấm **Create repository**.

---

## Bước 3 — Tải các file lên (kéo-thả)

1. Trang repo vừa tạo → bấm dòng chữ xanh **"uploading an existing file"**
   (hoặc nút **Add file → Upload files**).
2. Mở **Finder**, vào thư mục:
   `~/Developer/esuhai-20nam-rsvp`
   (Trong Finder bấm **Cmd + Shift + G**, dán đường dẫn trên, Enter.)
3. **Chọn hết** các mục sau rồi **kéo thả** vào khung upload của GitHub:
   - `index.html`
   - `dang-ky.html`
   - `tiec-toi.html`
   - `config.js`
   - `README.md`
   - thư mục `apps-script`
   - thư mục `tools`
   > (Các file ẩn bắt đầu bằng dấu chấm như `.nojekyll` không bắt buộc — bỏ qua cũng được.)
4. Kéo lên xong, kéo xuống dưới bấm nút xanh **Commit changes**.

---

## Bước 4 — Bật trang công khai (GitHub Pages)

1. Trong repo, bấm tab **Settings** (bánh răng).
2. Cột trái, bấm **Pages**.
3. Mục **Source** chọn **Deploy from a branch**.
4. **Branch:** chọn **main** → thư mục **/(root)** → bấm **Save**.
5. Chờ khoảng **1–2 phút**, tải lại trang Settings → Pages. Khi hiện dòng
   *"Your site is live at https://…"* là xong.

Thử mở ngay 2 link:

- `https://<tên-github>.github.io/esuhai-20nam-rsvp/dang-ky.html`
- `https://<tên-github>.github.io/esuhai-20nam-rsvp/tiec-toi.html`

> Lúc này trang đã đẹp và điền được, nhưng **chưa lưu về Google Sheet** cho tới khi làm xong `apps-script/HUONG_DAN_DEPLOY.md` (Bước 5 dưới).

---

## Bước 5 — Nối trang với Google Sheet

1. Làm theo **`apps-script/HUONG_DAN_DEPLOY.md`** để lấy link `/exec`.
2. Sửa file **`config.js`** (dán link `/exec` vào giữa hai dấu ngoặc kép).
3. Đưa lại **`config.js`** lên GitHub: trong repo bấm vào `config.js` → biểu tượng **bút chì ✏️** →
   sửa trực tiếp trên web (hoặc **Add file → Upload files** đè lại) → **Commit changes**.
4. Chờ ~1 phút, mở lại `dang-ky.html`, điền thử → kiểm tra Google Sheet có dòng mới.

---

## Bước 6 — Tạo mã QR cho 2 link

Sau khi có link chính thức, tạo QR để in lên thiệp / poster / màn hình:

```
cd ~/Developer/esuhai-20nam-rsvp/tools
python3 make_qr.py "https://<tên-github>.github.io/esuhai-20nam-rsvp/dang-ky.html" QR_ToaDam_Gala
python3 make_qr.py "https://<tên-github>.github.io/esuhai-20nam-rsvp/tiec-toi.html" QR_ChiGala
```

Hoặc gửi 2 link cho em, em tạo QR gửi lại chị ngay.

---

## Khi cần sửa nội dung trang sau này

Vào repo trên GitHub → bấm vào file cần sửa (`dang-ky.html`…) → **bút chì ✏️** → sửa → **Commit changes**.
Trang tự cập nhật sau ~1 phút, **link giữ nguyên**, QR vẫn dùng được.

> Nếu sửa phần chữ chung của trang, nhớ sửa cho **cả 2 file** `dang-ky.html` và `tiec-toi.html`
> (chúng là 2 trang độc lập). Cần đổi nhiều, gửi em làm giúp cho đồng bộ.

---

## Lưu ý về "Public"

Repo Public nghĩa là **mã nguồn** trang ai cũng xem được (trang mời vốn để công khai nên không sao).
Link `/exec` trong `config.js` cũng công khai — đây là điều bình thường với mọi form web (giống như địa chỉ nhận thư).
Nếu về sau thấy có người gửi dữ liệu rác, báo em thêm một lớp chống spam đơn giản.
Muốn giấu mã nguồn hẳn thì cần bản GitHub trả phí — với sự kiện này **không cần thiết**.
