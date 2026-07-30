# GATE 1 PLAN — Đối soát data TGĐ + nạp ảnh CRM (E08-D018)

> Worker: PM-con-Kha (R1) · Gate **FULL** · **CHƯA code/chạy production tới khi PASS.**
> Nguồn dispatch: `dispatch/2026-07-30-crm-data-anh-ly.md`. Đích: CRM production (đã live UI mới E08-D017).

## 0. Việc đã điều tra (bằng chứng, không đoán)

Đọc thẳng 3 nguồn có trong workspace:

| Nguồn | Là gì | Số khách | Khoá định danh |
|---|---|---|---|
| Excel `data/inbox/2026-07-28-DS-khach-TGD-Gia-dinh.xlsx` (importer chính thức đọc) | file Ly gửi 28/07, header dòng 3 | **114 dòng có tên** (127 dòng, 13 trống tên) | cột **STT** (1..115) |
| Production `crm_guests` (PMt xác minh) | DB thật | **114** nhóm `ly-tgd-20260728-*` | `guest_ext_id = ly-tgd-20260728-{STT}` |
| Mock `crm.html` `var SEED` | bản vẽ R0 của Ly | **116** (K001..K116) | cột **Mã khách** (K-code), **KHÔNG có STT** |

**Kết luận đối soát STT 25 & 116 (AC-1):**
- STT 25 và 116 **vắng ngay trong file Excel nguồn** (không phải rớt khi import). Production 114 = **trung thành tuyệt đối với Excel**. Import idempotent.
- Mock có 116 dòng nhưng đánh **K-code, không có STT** → **không map 1:1** sang STT được. Mock ≠ SoT (đúng chỉ đạo). Nên "116" của mock **không chứng minh** có 2 khách thật bị thiếu; có thể chỉ là đánh số khác.
- ⇒ **Không thể tự chốt 114 hay 116.** Cần Ly xác nhận (mục Hỏi chốt §5).

## 1. Ảnh — trạng thái thật (AC-3/4/5)

- ⛔ **BLOCKER: 0 file ảnh gốc trong workspace/repo.** `find` ảnh binary → trống. Mock chỉ có **tên file**, không có ảnh. **Không nạp được gì tới khi Ly đưa bộ ảnh** (path local hoặc .zip).
- Cột "Tên file ảnh" trong mock **không đáng tin làm mapping tự động**:
  - Chỉ **47/116** dòng có tên file (42 file duy nhất). **69 khách không có ảnh.**
  - **34** file trùng khớp tên khách (match sạch).
  - **13** file lệch tên, gồm 2 loại:
    - **Ảnh chung (hợp lệ, cần gộp):** 5 file dùng cho ≥2 khách — vd `Vợ chồng chú Tư Viễn.jpg` (Chú+Cô Tư Viễn), `Chị Ruby và Anh Kiên.jpg`, `Ông Phạm Anh Thắng và cô Thủy.jpg`, `Ông Phan Hoàng Ân và cô Kiều Hương.jpg`, `Kha - May.jpg`.
    - **Nghi hoán đổi/sai (cấm auto):** K002 "Bà Trần Thị Anh Vũ" → file `Bà Đồng Thị Bạch Tuyết.jpg`; K003 ngược lại. → **phải Ly xác nhận**, không tự upload.
- **Khoá nối mock→production là vấn đề:** production key theo **STT** (`ly-tgd-...-{STT}`), mock theo **K-code + tên**. Không có STT trong mock ⇒ chỉ nối được qua **so tên** (tiếng Việt, có kính ngữ Bà/Ông/Chú + nhóm "Gia đình …") — **lossy, rủi ro nối nhầm**. Đây là rủi ro lớn nhất của việc nạp ảnh.

## 2. Mô hình lưu ảnh hiện có — đủ dùng, KHÔNG cần đổi schema (AC-6)

`crm_photos(guest_id, object_key, content_type, size, uploaded_by, created_at)` + `photos.js` view bằng **presignGet(object_key)** (bucket private, URL ngắn hạn). UI v2 đã render ảnh + **placeholder khi thiếu** (không vỡ). ⇒ AC-6 sẵn sàng, không đụng schema/API.

**Idempotency (AC-5) ở tầng script (không đổi schema):** object_key **tất định** = `crm/tgd/{guest_ext_id}/{sha1(tên-file-gốc)}.jpg` (AC-4: không phụ thuộc tên Unicode thô). Trước khi upload/insert → `SELECT 1 FROM crm_photos WHERE guest_id=$1 AND object_key=$2`; có rồi thì **skip**. Rerun không đẻ trùng ở cả MinIO lẫn DB.

## 3. Kế hoạch triển khai (sau khi Ly gỡ blocker + chốt SoT)

**Pha A — data (nếu Ly chốt 116):** thêm đúng 2 khách thiếu bằng cách bổ sung vào **Excel SoT** (hoặc CSV phụ) → chạy lại `import-ly-tgd.js` (idempotent theo STT). **Không** viết thẳng SQL tay, **không** lấy mock làm nguồn. Nếu Ly chốt **114** → không làm gì (đã đúng).

**Pha B — ảnh (2 bước, chặn ghi tới khi dry-run sạch):**
1. **Dry-run (AC-3, KHÔNG ghi DB/MinIO):** nhận bộ ảnh của Ly → script chỉ **đếm & phân loại**: tổng file · match chắc (tên file == tên khách production) · shared/couple (1 file→N khách, theo danh sách Ly duyệt) · **unmatched** · **ambiguous** (nối tên mờ) · **duplicate**. Xuất bảng cho anh/Ly soi. **Không** đụng production.
2. **Load thật (AC-4/5, chỉ sau khi anh duyệt bảng dry-run):** chỉ upload **match chắc + shared đã Ly duyệt**. Bỏ qua unmatched/ambiguous/nghi-swap (báo danh sách để Ly xử tay). Ghi `crm_photos` đúng `guest_id`, object_key tất định, uploaded_by=`import:tgd`. Rerun idempotent.

**Không đụng:** OTP/RBAC/check-in/interaction/import CSV/`/crm/classic` (AC-7). Gate 2 QC khác actor kiểm số DB/MinIO trước–sau + smoke prod (AC-8).

## 4. Rủi ro
| Rủi ro | Giảm thiểu |
|---|---|
| Nối nhầm ảnh↔khách (mock K-code vs prod STT, chỉ so tên) | Dry-run bắt buộc + anh/Ly duyệt bảng; chỉ auto match chắc; ambiguous để tay |
| Ảnh swap/sai (K002/K003…) | Đưa vào nhóm "nghi sai" — cấm auto, Ly xác nhận |
| Rerun đẻ ảnh trùng | object_key tất định + check tồn tại trước insert |
| Lấy mock làm SoT | Cấm; SoT = Excel/Ly; mock chỉ tham chiếu tên file |
| Nạp lên production sát lễ | Dry-run trước; load sau khi duyệt; không đụng đường vận hành |

## 5. Hỏi chốt Gate 1 (cần Ly/anh trả lời để đi tiếp)

1. **SoT & tổng số TGĐ (AC-1):** danh sách thật là **114** (đúng Excel 28/07) hay **116**? Nếu 116 → xin **STT 25 & 116** (tên + thông tin) để bổ sung vào Excel SoT; mock không đủ tin.
2. **Bộ ảnh gốc (BLOCKER):** Ly đang giữ ở đâu? Xin **path local hoặc gói .zip** ảnh. (Workspace/git hiện **không có** ảnh; chỉ có tên file trong mock.)
3. **Ảnh chung & nghi-sai:** xác nhận 5 ảnh couple/family gán cho những khách nào; và cặp nghi hoán đổi (Trần Thị Anh Vũ ↔ Đồng Thị Bạch Tuyết) đúng là ảnh của ai?
4. Xác nhận **cách nối ảnh↔khách**: theo **tên khách** (production) là chấp nhận được chứ? (mock không có STT để nối chắc)

**PASS Gate 1 = trả lời (1)(2)(3)(4) + Ly đưa bộ ảnh ⇒ em chạy dry-run (không ghi), trình bảng, rồi mới xin phép load.**
