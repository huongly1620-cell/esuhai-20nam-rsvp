# Gate 1 — E08-D026 sync RSVP nhận thẻ `vnjb-*`

> PM con gửi PMt · 2026-08-04 · **CHƯA CODE** (phiếu: Gate 1 trước code).
> Bậc **FULL** — sửa đường ghi LIVE mà mọi form đăng ký đi qua, 4 ngày trước lễ.

---

## 1. Chỗ hỏng (đo được, không suy đoán)

`sync-from-rsvp.js:19-32` khớp theo **đúng hai** đường: `phone_norm` → `guest_ext_id`. Không có đường nào theo tên.

Sau Pha 2, prod có **401 thẻ** nhưng:

| | |
|---|---|
| Thẻ có `phone_norm` | **42 / 401** |
| Thẻ `vnjb-*` (SoT, đều `phone = NULL`) | **259** |
| Thẻ `rsvp:*` | 48 |

Khách trong SoT điền form → tra SĐT **trượt** (thẻ không có số), tra `ext_id` **trượt** (`vnjb-*` ≠ `rsvp:*`) → rơi xuống `INSERT` (`:48`) tạo **thẻ thứ hai**: không ảnh, không số bàn, không tag buổi, không `vnjb`.

**Đã chảy máu thật:** **25 người** hiện có **cả** thẻ `vnjb` lẫn thẻ `rsvp:*`. Tại cửa họ có 2 thẻ, và thẻ **có ảnh** không phải thẻ gắn với đăng ký của họ. `rsvp.js:136` gọi sync trên **đường ghi live** nên con số này còn tăng tới 08/08.

## 2. Đề xuất: thêm đường khớp theo **tên chuẩn hoá**, có phanh

Thứ tự khớp mới trong `upsertOne`:

```
1. phone_norm            (giữ nguyên)
2. guest_ext_id          (giữ nguyên)
3. TÊN chuẩn hoá  ← MỚI
   3a. đúng 1 thẻ active         → nối
   3b. nhiều thẻ, đúng 1 thẻ có tag `vnjb` → nối vào thẻ SoT đó
   3c. còn lại                   → INSERT như cũ, NHƯNG gắn `trung-ten-can-ra`
```

Chuẩn hoá tên: NFC · hạ chữ · gom khoảng trắng · **bỏ kính ngữ** (Ông/Bà/Anh/Chị/Cô/Thầy/Mr/Ms…) — đúng hàm đã dùng ở `import-vnjb.js`, không phát minh luật mới.

### Vì sao 3b an toàn

Thẻ mang tag `vnjb` là thẻ **có trong danh sách mời chính thức** của Ly. Khi một tên khớp nhiều thẻ mà chỉ **một** thẻ thuộc SoT, thẻ đó là đích đúng — các thẻ kia là bản trùng do chính lỗi này sinh ra.

### Đo trên dữ liệu thật (mô phỏng 44 submission `yes`, 43 người)

| | Hiện tại | Sau sửa |
|---|---|---|
| Nối được vào thẻ đúng | 0 | **19** (3a) + **23** (3b) = **42** |
| Còn mơ hồ → tạo mới + gắn cờ | 43 | **1** |

Tức là luật 3b một mình giải **23/24** ca mơ hồ. Ca cuối cùng để `trung-ten-can-ra`, BTL rà tay — **không đoán**.

## 3. Không được phá thứ đang chạy

| Phải giữ | Cách kiểm ở Gate 2 |
|---|---|
| Đường `phone_norm` (42 thẻ) | submission có SĐT khớp thẻ cũ → vẫn nối thẻ đó, không tạo mới |
| Đường `guest_ext_id` (`rsvp:*`, 48 thẻ) | gửi lại đúng submission cũ → update tại chỗ, `crm_guests` không tăng |
| `COALESCE` giữ phone/email/org/title | submission thiếu SĐT **không** xoá số đang có |
| `mergeTags` | thẻ `vnjb` nối từ form **không mất** `vnjb`/`kcode:`/`tgd116` |
| Không nối nhầm người | 2 khách trùng tên, không ai có `vnjb` → **vẫn tạo mới**, không gộp bừa |
| D016 disjoint | thẻ `vnjb` nhận `response_id` thì **phải gỡ** tag `toa-dam`/`gala` (nếu không giao ≠ 0, KPI vỡ như hôm nay) |

⚠️ **Điểm 6 là điểm dễ sót nhất.** Import Pha 2 đã dính đúng chỗ này một lần.

## 4. Nợ dữ liệu đi kèm — xin PMt chốt riêng

25 người **đang** có thẻ đôi. Sửa code chỉ chặn ca mới, **không** dọn ca cũ. Đề nghị một bước dọn:

- chuyển `response_id` từ thẻ `rsvp:*` sang thẻ `vnjb` (thẻ có ảnh + số bàn),
- gỡ tag buổi trên thẻ `vnjb` đó (giữ D016 disjoint),
- soft-delete thẻ `rsvp:*` rỗng.

**Chưa làm** — ngoài phạm vi câu chữ của phiếu, xin anh gật riêng.

## 5. Phạm vi — theo đúng phiếu

Trong: `server/crm/sync-from-rsvp.js` (`upsertOne`).
Ngoài: deactivate 10 khách form · nhóm `khong-du` trong `/crm/stats` (D016) · lazy avatar (**D027**, đã LIVE riêng).

## 6. Test sẽ chạy ở Gate 2

Local: 6 ca ở §3 + ca "tên khớp 1 thẻ" + ca "khớp nhiều, 1 thẻ vnjb" + ca "khớp nhiều, 0 thẻ vnjb".
Prod sau deploy: `npm run smoke:crm` (43 phép kiểm, gồm bất biến D016 + disjoint) · đếm `crm_guests` trước/sau một submission thử **không** tăng.

## 7. Xin PMt

1. Duyệt thứ tự khớp §2, đặc biệt **luật 3b ưu tiên thẻ `vnjb`**.
2. Chốt riêng bước dọn 25 thẻ đôi (§4) — làm trong vé này hay vé sau.
