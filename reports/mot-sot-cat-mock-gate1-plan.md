# GATE 1 PLAN — Một SoT: cắt page mock (E08-D019)

> Worker: PM-con-Kha (R1) · Gate **FULL** · **CHƯA đụng production tới khi PASS.**
> Mục tiêu: SoT = `/crm` + Postgres. Cắt 3 page mock khỏi vận hành, **giữ mã R0**.

## 0. Đã xác minh bằng code
- `crm.html` (84KB): nhúng `var SEED` **116 khách** + localStorage. Served tại `/crm.html` qua `express.static` (`server/index.js`).
- `checkin-toadam.html` / `checkin-gala.html`: nhúng `var G=[…]` = **DS VIP thật** (tên, chức danh, VIP, **bàn/ghế**, tên file ảnh) + localStorage.
- Cả 3 là **static, KHÔNG auth** → ai mở URL cũng thấy. `/crm` (route) mount trước static nên không bị crm.html chiếm.

## 1. Cách chặn từng page (đề xuất)

| AC | Page | Cách làm |
|---|---|---|
| **AC-1** | `crm.html` | **Redirect 302 server-side**: thêm route `app.get('/crm.html', → res.redirect(302,'/crm'))` **trước** `express.static` trong `server/index.js`. File **không đụng** (giữ mã R0), SEED **không bao giờ được serve**. → *ưu tiên hơn* trang tĩnh thay thế (khỏi sửa file R0). |
| **AC-2** | 2 page check-in | Chèn **banner đỏ cố định** ngay sau `<body>`: «⚠ BẢN THIẾT KẾ — KHÔNG dùng điểm danh thật. Điểm danh tại /crm» + nút `→ Mở /crm`. Thêm `padding-top` để không che nội dung. Giữ UI tham khảo. |
| **AC-3** | mock nav | `crm.html` redirect ⇒ nav moot. Nav "Check-in" cũ trỏ `/check-in.html` cũng chết theo. Trong 2 page check-in: nếu có link trỏ như-live → trỏ về `/crm` hoặc bỏ. |

## 2. ⚠️ Rủi ro PII phát hiện thêm (cần anh quyết) — ngoài AC gốc

**2 page check-in vẫn SERVE `var G` (DS VIP thật) cho trình duyệt KHÔNG đăng nhập.** Banner chỉ *cảnh báo*, không *che dữ liệu* → tên/chức danh/bàn/ghế VIP vẫn lộ cho bất kỳ ai biết URL. `crm.html` SEED 116 cũng vậy (dù redirect chặn serve, dữ liệu vẫn nằm trong file repo).

- **Đề xuất (khuyến nghị):** ngoài banner/redirect, **làm rỗng mảng dữ liệu nhúng** — `var G=[]` / `var SEED=[]` — trong cả 3 file. **Giữ nguyên layout + logic R0** (vẫn tra cứu được thiết kế), chỉ bỏ **dữ liệu khách thật**. Đây đúng tinh thần AC-6 ("không nhúng DS khách") + bịt lỗ lộ PII không-auth.
- Nếu anh muốn **đúng literal ràng buộc "chỉ redirect/banner"** → giữ data, chấp nhận PII vẫn served ở 2 page check-in (kém an toàn). **Em nghiêng phương án làm rỗng data.**

→ **Hỏi chốt (1):** có làm rỗng `var G`/`var SEED` (giữ layout) không? Em đề xuất **CÓ**.

## 3. Không đụng (AC-4/5/6)
- **Không** sửa `/crm`, `/admin`, `/api/rsvp`, `dang-ky.html`, `xep-ban.html` (luồng CSV `table_no` giữ).
- `/crm/classic` vẫn là đường lùi app thật (không liên quan mock).
- **Không** nhúng thêm DS khách nào.

## 4. Phạm vi + rollback
- **File đụng:** `server/index.js` (1 route redirect) · `checkin-toadam.html` + `checkin-gala.html` (banner [+ rỗng data nếu duyệt]) · (nếu duyệt) `crm.html` (rỗng SEED). **KHÔNG** đụng server CRM/admin/schema.
- **Rollback:** gỡ route redirect + revert banner = về như cũ (1 commit revert). Không ảnh hưởng DB.

## 5. Hỏi chốt Gate 1
1. **Làm rỗng `var G`/`var SEED`** (giữ layout, bỏ PII khách) hay chỉ redirect/banner? — em đề xuất **làm rỗng**.
2. Xác nhận **redirect 302 server-side** cho `crm.html` (thay vì trang tĩnh) — giữ file R0 nguyên.
3. Mẫu chữ banner đỏ ở §1 (AC-2) OK chứ, hay anh muốn câu khác?

**PASS Gate 1 = trả lời (1)(2)(3) ⇒ em code redirect + banner [+ rỗng data], self-QC, Gate 2 (actor khác), rồi deploy.**
