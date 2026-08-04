# Checklist rà lễ 08/08 — `/crm` đón tiếp

> PM con gửi anh + chị Ly · đo trên prod 04/08 · **0 PII trong file này**, chỉ số đếm.
> Trạng thái mã nguồn: **FREEZE** — chỉ nhận hotfix chặn cửa.

---

## 1. Số đứng ngày hôm nay

| | |
|---|---|
| **Khách trong danh sách** | **376** |
| **Dự Gala** | **350** |
| **Dự Tọa đàm** | **156** |
| Đã đăng ký qua form | 47 (44 lượt · 49 người khai) |
| Báo **không dự** | 13 |
| **Chưa rõ buổi** | 11 |
| Đã điểm danh | 0 (chưa bắt đầu) |

Hai nguồn buổi **rời nhau tuyệt đối** (giao = 0) nên hai số "Dự Gala / Dự Tọa đàm" ở trên là **cộng gộp hợp lệ**, không đếm trùng.

## 2. Bốn khoảng trống — ai cũng nên biết trước sáng 08/08

| Khoảng trống | Số | Nghĩa là ở cửa |
|---|---|---|
| **Không có SĐT** | **334 / 376** | Lễ tân **không tra được bằng số điện thoại** cho phần lớn khách. Phải tra bằng **tên**. Sheet SoT của chị Ly không có cột SĐT nên đây là giới hạn dữ liệu, không phải lỗi phần mềm |
| **Không có số bàn** | **256 / 376** | Chỉ 120 khách có bàn. Còn lại phải hỏi tại cửa hoặc tra sơ đồ giấy |
| **Không có ảnh** | **197 / 376** | Hiện chữ cái viết tắt. 179 khách có ảnh (48%) |
| **Thẻ trùng tên** | **68 thẻ / 28 người** | Một người có 2–3 thẻ. Xem mục 3 |

## 3. 68 thẻ trùng tên — việc BTL rà tay

Đây là **cố ý**: khi một tên khớp nhiều thẻ, hệ thống **không tự gộp** vì ghép nhầm thì gán ảnh và buổi sai người — ngày lễ sẽ chào nhầm mặt khách.

**Cách rà trên `/crm`:**

1. Đăng nhập `/crm` (OTP gửi về email trong allowlist).
2. Gõ **`trung-ten-can-ra`** vào ô tìm — hoặc bấm nút lọc **⚠ Trùng**.
3. Với mỗi nhóm: mở từng thẻ, so **đơn vị** và **chức vụ**.
   - **Cùng một người** → giữ thẻ **có ảnh và số bàn**, xoá thẻ kia.
   - **Hai người khác nhau** → giữ cả hai, gỡ nhãn ⚠ để khỏi rà lại.

Ưu tiên rà nhóm nào trước: nhóm mà **một thẻ có ảnh, thẻ kia không** — đó là nhóm dễ chào nhầm nhất.

## 4. Năm khách có số điện thoại nằm ở thẻ khác

Có **5 người** mà **đăng ký nằm ở thẻ này, số điện thoại nằm ở thẻ kia**. Máy không tự chuyển vì số đó đang thuộc về một thẻ khác — tự chuyển là có nguy cơ gán số của người này cho người kia. BTL rà tay theo mục 3 là xử lý được luôn.

## 5. Trước giờ mở cửa — 6 việc

- [ ] **Đăng nhập thử `/crm`** bằng đúng tài khoản Lễ tân sẽ dùng (hiện có **4 tài khoản** hoạt động). Đủ chưa cho số cửa dự kiến?
- [ ] **Điểm danh thử 1 khách** rồi kiểm số "đã đến" nhảy đúng.
- [ ] **Mở 2 trang check-in** (`/checkin-toadam.html`, `/checkin-gala.html`) trên đúng máy/điện thoại sẽ dùng.
- [ ] **Thử wifi hội trường**: mở `/crm` tại chỗ, cuộn danh sách. Ảnh nay **tải dần** (lazy) nên mở màn chỉ kéo ~5% số ảnh — nhưng kho ảnh là **284 MB** ảnh gốc, cuộn nhanh trên wifi yếu vẫn chậm.
- [ ] **Rà 28 nhóm trùng tên** (mục 3).
- [ ] **Chốt danh sách 13 khách báo không dự** — có mời lại hay bỏ.

## 6. Nếu có sự cố ngày lễ

| Triệu chứng | Xử lý tại chỗ |
|---|---|
| Không tìm thấy khách | Tra bằng **một phần tên** (bỏ Ông/Bà). Vẫn không ra → **+ Thêm** khách mới, điểm danh sau |
| Thấy 2 thẻ cùng người | Điểm danh **thẻ có ảnh/số bàn**; báo BTL gộp sau lễ |
| Ảnh không hiện | Bình thường với 197 khách chưa có ảnh — dùng tên + đơn vị để xác nhận |
| Màn chậm | Dùng ô tìm thay vì cuộn; tìm theo tên là truy vấn phía máy chủ, không phụ thuộc ảnh |
| `/crm` không mở được | Đường lùi **`/crm/classic`** — cùng dữ liệu, giao diện cũ |

## 7. Đang đóng băng (không sửa tới sau lễ, trừ hotfix chặn cửa)

- **3 nợ QC của D026** — nhánh 3a chưa có phanh · khách trùng tên trong cùng một lượt đăng ký bị nuốt · audit lần dọn chỉ ghi số tổng.
- **D025** — `PROTECTED` trong bộ smoke mới phủ 6/14 route; bốn đường **ghi** chưa được thử 401.
- **Import / sync**: **cấm** chạy `import-vnjb.js --commit` và `backfill-rsvp.js` trừ khi có lệnh và có người ngồi cạnh.
