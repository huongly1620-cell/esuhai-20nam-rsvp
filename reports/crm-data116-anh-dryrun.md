# DRY-RUN REPORT — Data 116 (K-code) + Ảnh TGĐ (E08-D018)

> Worker: PM-con-Kha (R1) · Gate **FULL** · **DRY-RUN — 0 ghi Postgres/MinIO.**
> Không có PII trong report này (tên khách ở file `data/*.txt` gitignored, không commit).
> Tiền đề còn treo: **Ly xác nhận file 116 là bản cuối** trước khi ghi.

## Nguồn (đã xác minh)
- **SoT mới:** `data/inbox/20260729_v1_TGD_IMPORT_DS_KHACH_GALA_20NAM.xlsx` · sheet `DS Khách` · **116 khách**, mã **K001→K116 liền mạch** (0 thiếu). File 38 MB là format phồng, **0 ảnh nhúng**.
- **Production hiện tại:** 114 khách nhóm `ly-tgd-20260728-*` (khóa STT, import 28/07). `crm_photos`: 0 ảnh nhóm TGĐ.
- **Ảnh:** `…/ALESU - HÌNH KHÁCH MỜI/KHÁCH VIỆT - TGĐ` = **40 file** (35 jpg + 5 png, 0 rỗng). `KHÁCH VIỆT NAM - TTLK` (108) **ngoài phạm vi**.
- Script: [dryrun-data116.js](../server/crm/dryrun-data116.js) (phần A) · [dryrun-tgd-photos.js](../server/crm/dryrun-tgd-photos.js) (phần B). Chi tiết tên: `data/dryrun-data116.txt`, `data/dryrun-tgd-photos.txt` (gitignored).

---

## PHẦN A — Data 116 vs 114 (⚠️ nguy cơ NHÂN ĐÔI)

Đối chiếu theo **tên chuẩn hóa** (bỏ kính ngữ, bỏ dấu, hạ chữ). 116-K so với 114-STT:

| Nhóm | Số | Ý nghĩa |
|---|---|---|
| **OVERLAP** (116-K trùng tên 1 khách STT cũ) | **106** | Nếu INSERT theo K → **nhân đôi 106 người**. Phải **UPDATE bản cũ**, không tạo mới. |
| **AMBIGUOUS** (trùng tên ≥2 khách cũ) | 4 | Do bỏ kính ngữ làm **chú/cô, ba/mẹ trùng khóa** (cặp Tư Viễn; Ba/Mẹ ông Trung/Dũng/Hiếu). Cần khớp kèm **giới tính**. |
| **FRESH** (mới hoàn toàn) | 6 | Gồm khách thật mới (vd phu nhân) **và** vài ca **nghi trùng do khác chính tả** (xem dưới). |
| **OLD-STT không khớp K nào** | 5 | Có thể là chính tả khác của "fresh", hoặc khách **bị bỏ khỏi 116** (có 1 VIP đáng chú ý). |

**Kết luận A:** **KHÔNG** được nạp 116 kiểu INSERT thẳng — sẽ nhân đôi ~106 khách. Chỉ 6 "fresh" nhưng trong đó lẫn ca nghi-trùng-khác-chính-tả (STT 45 "Chị Trang" ↔ K046 "…Thùy Trang"; STT 22 "…Bình (con trai bác Hòa)" ↔ K021 "…Bình"; STT 70 "Tít & Chị Hoa" ↔ K071 "Tít & Chị Hằng"). ⇒ Số **mới thật ~2–4**, không phải 6.

### Đề xuất đường nạp idempotent (trình duyệt, CHƯA chạy)
1. **Match K→bản ghi cũ theo tên chuẩn hóa CÓ giữ giới tính/kính ngữ** (tránh gộp nhầm chú/cô).
2. Trùng (≈106) → **UPDATE** bản cũ: enrich `org/title/buổi/tags/số bàn` từ SoT + gắn tag `kcode:Kxxx` (giữ liên kết, **không đổi `guest_ext_id`** để không mất idempotency & không mồ côi check-in/table_no đã có).
3. Mới thật → **INSERT** `guest_ext_id = tgd-kcode-Kxxx`.
4. **Nhóm nghi-trùng/ambiguous/old-orphan (~13 ca)** → **treo, Ly quyết tay** — không auto.
5. Rerun idempotent: match theo tên (update lại, không thêm dòng); bản mới theo ext_id.

> ⚠️ Trước khi chọn *merge* hay *wipe+reload*: cần biết 114 khách cũ **đã có `table_no`/check-in chưa** (xếp bàn có thể đã gán). Nếu có → **bắt buộc merge** (wipe sẽ mất). Em kiểm khi được cấp read-only prod, hoặc anh xác nhận.

---

## PHẦN B — Ảnh TGĐ (40 file) match theo TÊN khách (bỏ cột mock)

Nối **ảnh ↔ tên khách 116** (cột "Tên file ảnh" của mock chỉ khớp 2/42 → **bỏ**). Nhờ khớp theo filename↔tên thật, **cặp nghi-swap** (Anh Vũ ↔ Bạch Tuyết mà mock ghi chéo) **tự đúng** — cả hai khớp `exact`.

| Nhóm | Số | Xử lý |
|---|---|---|
| ✅ **Match chắc** (1 khách, exact) | **34** | Tất cả `exact` → ứng viên upload khi duyệt |
| ⚠️ **Shared/couple** | **5** | Ly xác nhận gán ai — **không auto** |
| ❓ **Unmatched** | **1** | `Kha - May.jpg` (nội bộ, không phải khách TGĐ) → bỏ |
| — Khách chưa có ảnh | 75/116 | Bình thường; UI dùng placeholder |

**5 ảnh shared cần Ly chốt (mô tả theo K-code; tên đầy đủ ở `data/dryrun-tgd-photos.txt`):**
- 3 ảnh "khách + người đi kèm không phải khách" → gán cho **1 khách** (K036 / K049 / K011).
- 1 ảnh đôi **K039 + K040** — ⚠️ script bắt nhầm thêm **K103** (khớp mờ chữ "Minh") → **loại K103**.
- 1 ảnh đôi **K004 + K005** (vợ chồng).

### object_key (khi được phép upload)
Tất định, **không phụ thuộc tên Unicode thô**: `crm/tgd/{guest_ext_id}/{sha1(tên-file-gốc)}.<ext>`; check `SELECT 1 FROM crm_photos WHERE guest_id=$1 AND object_key=$2` trước insert ⇒ rerun không trùng (AC-5). Xem ảnh qua presigned có sẵn (AC-6).

---

## Cần Ly / anh quyết (trước khi được ghi)

1. **[A] Ly xác nhận** file `20260729_v1…` là **bản cuối**? (tiền đề bắt buộc)
2. **[A] Cách hợp nhất:** đồng ý **merge theo tên (update + tag `kcode:`), không INSERT trùng** (tránh nhân đôi 106)? Hay chọn *wipe 114 + reload 116* (chỉ khi chưa có table_no/check-in)?
3. **[A] ~13 ca nghi-trùng/ambiguous/orphan** (couples Tư Viễn & Trung/Dũng/Hiếu; Bình STT22↔K021; Trang STT45↔K046; Hoa STT70↔K071; **VIP STT20 Hà Anh Tuấn không thấy trong 116**) — Ly rà tay: ai là 1 người, ai bị bỏ.
4. **[B] Duyệt 34 ảnh match chắc** + cách gán **5 shared** (đặc biệt **loại K103** khỏi ảnh đôi K039+K040).
5. **[B]** 1 ảnh `Kha - May.jpg` bỏ qua — đúng chứ?

**Chưa được phép** (chờ duyệt bảng): tạo/sửa khách, upload ảnh, insert `crm_photos`, chạy importer ghi DB. Sau khi duyệt → em viết importer merge + script load ảnh → **Gate 2 (actor khác)** → chạy prod.
