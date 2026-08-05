# Gate 1 — E08-D032 xuất Excel «để cập nhật» → nhập ngược

05/08/2026 · nền tip **`3bc24e8`** (D030 LIVE) · **kế hoạch, chưa code**
Spec: `specs/2026-08-05-crm-xuat-nhap-cap-nhat.md` · Phiếu: `dispatch/2026-08-05-prompt-pm-con-xuat-nhap-cap-nhat.md`

---

## 0. Bốn quả mìn — em tự kiểm chứng, **cả bốn đều đúng**

| | anh nêu | em đo được |
|---|---|---|
| **M1** | API không trả `guest_ext_id` | ✅ `/crm/guests` trả **21 field**, không có `guest_ext_id`. `updRows()` rơi về `g.id` |
| **M2** | «Đơn vị» bị hiểu thành «phụ trách» | ✅ `norm("Đơn vị")` = `"đonvi"` — **không** chứa `donvi` (mất cột Đơn vị) nhưng **chứa `nv`**, mà `assigned` có khoá `'nv'` (`import.js:65`) ⇒ tên công ty chui vào `crm_assignments.staff_email` |
| **M3** | cột Trạng thái sai nguồn | ✅ classic có **0** chỗ dùng `att_status`; `updRows` dùng `g.from_rsvp?"Tham dự":"Chờ xác nhận"` → chỉ 2 nhóm, **mất nhóm «không tham dự»** |
| **M4** | nút chỉ có ở classic | ✅ `exp_update`: classic **3** · v2 **0**; prod chạy `CRM_UI=new` |

Ba điểm nhỏ cũng đúng: `import.js:83` tra `guest_ext_id` **thiếu `deleted_at IS NULL`** · `:78` `if (!name) continue` **bỏ cả dòng** (mất luôn bàn/ghế đã điền) · không có chống chạy-lại cho khách mới.

## 1. Câu 5 trước — vì nó quyết định vé này gấp tới đâu

**Ly bấm xuất ngay bây giờ rồi nhập lại y nguyên, không sửa một ô nào:**

```
khách active                     344
cột «Mã khách» xuất ra           = g.id (số nội bộ), vì API thiếu guest_ext_id
→ khớp guest_ext_id              0
→ KHÔNG khớp                     344
→ có SĐT để cứu                  42   (file cập nhật KHÔNG có cột SĐT ⇒ không cứu được)
⇒ INSERT khách trùng             344
```

**Toàn bộ danh sách nhân đôi.** Không phải "một vài dòng lệch" — là 344/344.

Vì sao không có đường lùi tự nhiên: `guest_ext_id` phủ **344/344**, **0 trùng**, và **0** cái nào thuần số — nên `g.id` không thể vô tình khớp. Khoá thì hoàn hảo, chỉ là **chưa bao giờ lộ ra API**.

Cộng thêm M2: cùng lượt nhập đó, cột «Đơn vị» đi vào `crm_assignments`. Bảng này đang **0 dòng**, nên đây đúng là lượt đầu tiên giẫm phải.

> **Kết luận độ gấp:** tính năng này hiện **không dùng được** — dùng là hỏng dữ liệu. Nhưng nó cũng **chưa hại ai** vì nút chỉ có ở classic mà prod chạy v2 (M4). M4 vô tình là cái nắp an toàn. **Đừng port nút sang v2 trước khi M1+M2 xong** — port trước là mở nắp.

## 2. Câu 1 (M1) — trả `guest_ext_id`, **chỉ cho `btl`**

Đề xuất: thêm `g.guest_ext_id` vào SELECT của `/crm/guests`, nhưng **chỉ đưa vào phản hồi khi `req.actor.role === 'btl'`** — cùng khuôn em đã dùng cho `phone` ở diện `door`.

Ảnh hưởng các màn dùng chung API:
- **2 cửa** — PG là role `staff` ⇒ không nhận field, không đổi gì. Cửa cũng chẳng dùng.
- **v2 / classic** — chỉ 5 người `btl` nhận; đây đúng là người bấm xuất.
- **Contract additive** — không bỏ/đổi field nào, smoke không đụng tới.

Không dựng đường xuất riêng phía máy chủ: sẽ thành **nguồn thứ hai** cho cùng một danh sách, và đó là lớp lỗi «tab một đằng KPI một nẻo» của D016.

## 3. Câu 2 (M2) — **route mới, tự dò theo tiêu đề chính xác**. Không sửa `norm()`

`norm()` được **mọi** đường import đang chạy dùng chung. Sửa nó ba ngày trước lễ là đổi hành vi của `/crm/import`, `/crm/import-seats`, `/admin/api/import-tables` cùng lúc — trong đó có đường Ly sắp dùng để nạp ghế. **Em đồng ý với anh, và lý do em không sửa `norm()` là phạm vi nổ, không phải vì nó đúng.**

`POST /crm/import-update` tự dò cột bằng **so khớp chính xác sau khi chuẩn hoá riêng**, có xử lý `Đ`:

```js
const key = (s) => String(s||'').normalize('NFC')
  .replace(/Đ/g,'D').replace(/đ/g,'d')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
  .replace(/[^a-z0-9]/g,'');
// "Đơn vị" → "donvi"  ·  "Mã khách (KHÓA - KHÔNG sửa)" → "makhachkhoakhongsua"
```

Và **khớp bằng bảng tiêu đề đầy đủ**, không phải `indexOf` mờ — chính `indexOf` là thứ làm `nv` ăn `đonvi`. Không tìm thấy cột bắt buộc → **400, không đoán**.

> `norm()` vẫn là mìn cho các đường cũ. Em **ghi sổ, không vá trong vé này** — vá nó phải là vé riêng có Gate 2 của chính nó.

## 4. Câu 3 (M3) — bản đồ chữ ↔ `att_status`, chữ lạ thì **báo lỗi cả dòng**

| chữ trong file | ghi vào `att_override` |
|---|---|
| Tham dự | `du` |
| Không tham dự | `khong` |
| Chờ xác nhận / Chưa xác nhận | `cho` |
| **ô rỗng** | **không đổi** (COALESCE) |
| chữ khác | **lỗi, dừng cả dòng** |

Chọn **báo lỗi** chứ không «bỏ qua ô», vì hai lý do:
1. Ô trạng thái là thứ Ly **cố ý sửa** — bỏ qua im lặng nghĩa là Ly gõ "Ko tham dự", thấy báo "cập nhật 344 dòng", và tin rằng đã đổi. Đó là **báo xanh giả**, đúng lớp lỗi CỬA-2.
2. Ô rỗng đã có nghĩa riêng rồi ("không đổi"), nên "chữ lạ" phải khác nghĩa với "để trống".

Dry-run liệt kê **từng dòng lỗi kèm mã khách + chữ gõ sai** để Ly sửa file, không phải mò.

## 5. Câu 4 — khách mới: chạy hai lần thì **1**

Trả lời thẳng: **1 khách, không phải 2.**

Cách bảo đảm: dòng không có mã khách → sinh khoá **tất định từ nội dung**, không phải ngẫu nhiên:

```
guest_ext_id = 'upd-' + sha1(nameKey(Họ tên) | nameKey(Đơn vị) | nameKey(Chức danh))[0..9]
```

Cùng công thức `vnjb-<sha1>` của D022 (dùng lại `codeOfParts` trong `vnjb-keys.js`, không chép). Chạy lại cùng file → cùng khoá → khớp dòng cũ → **UPDATE**, không INSERT. Đây là idempotent **bằng cấu trúc**, không bằng cờ.

Hai người thật cùng tên + cùng đơn vị + cùng chức danh sẽ gộp làm một — em sẽ cho dry-run **nêu riêng** các dòng như vậy để Ly quyết, thay vì im lặng gộp.

## 6. Câu 6 — kế hoạch kiểm, theo CR-35

**Không** boot trỏ `DATABASE_URL` prod. **Không** ghi vào thẻ khách thật.

| kiểm | cách |
|---|---|
| dò cột | test thuần hàm: đưa đúng 8 tiêu đề của `UPD_HDR` + biến thể bẩn (thừa dấu cách, chữ hoa, thiếu dấu) → khẳng định `Đơn vị`→`donvi`, **không** rơi vào `assigned` |
| dry-run | dựng DB cục bộ (`postgres:dev@localhost`) nạp **bản sao cấu trúc + vài chục dòng giả**; chạy pha 1 → đối chiếu M/N/K |
| ghi thật | **trên DB cục bộ**, không prod. Chạy **hai lần** cùng file → khách mới vẫn 1 |
| không chạm | sau lượt ghi cục bộ, so `crm_photos` · `phone` · `response_id` · `checked_in*` · `deleted_at` **trước/sau** — phải giống hệt từng byte |
| trên prod | chỉ **dry-run** với file thật của Ly (không ghi), báo số M/N/K để anh duyệt trước khi cho ghi |

## 7. Rủi ro

| # | rủi ro | chặn |
|---|---|---|
| R1 | port nút sang v2 trước khi M1+M2 xong | **Không port**. M4 đang là nắp an toàn — mở sau cùng |
| R2 | 344 khách trùng nếu ai đó dùng đường `/crm/import` cũ với file này | route mới **riêng**; và dry-run bắt buộc trước khi ghi |
| R3 | tên công ty chui vào `crm_assignments` | route mới không dùng `detectCol` mờ |
| R4 | ghi hàng loạt sai → không lùi được | một transaction; dry-run bắt buộc; mọi cột COALESCE |
| R5 | ⏰ còn 3 ngày, vé ghi hàng loạt vào bảng khách | **đề xuất: chỉ làm tới dry-run trước lễ**, phần GHI mở sau 08/08 — trừ khi anh cần Ly cập nhật hàng loạt ngay |

## 8. Một đề xuất về phạm vi

Vé này **ghi hàng loạt vào bảng khách 3 ngày trước lễ**. Em đề xuất cắt đôi:

- **D032a (trước lễ):** M1 + M2 + xuất đúng ở v2 + **dry-run**. Ly xuất được file đúng, thấy trước điều gì sẽ xảy ra, nhưng **chưa ghi**.
- **D032b (sau lễ):** bật đường ghi.

Nếu Ly **cần** cập nhật hàng loạt trước lễ thì bỏ đề xuất này — nhưng lúc đó em xin một cửa sổ deploy không sát buổi PG, và anh duyệt số M/N/K của dry-run trước khi em cho ghi.

---

## Chờ anh

1. **Gate 1 PASS** để em code.
2. Chốt **§8**: làm trọn (a+b) trước lễ, hay chỉ **dry-run** trước lễ?
3. Xác nhận **không port nút sang v2** cho tới khi M1+M2 xong (§7 R1).

§B7: Gate 1 plan do R1 viết. Gate 2 phải do người ≠ R1 chạy.
