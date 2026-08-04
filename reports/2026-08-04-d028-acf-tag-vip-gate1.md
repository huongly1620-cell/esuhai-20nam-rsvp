# Gate 1 — E08-D028 AC-F: tag VIP · Nội/Ngoại · lọc Khách Nhật

Ngày 04/08/2026 · tip `811fba3` · PM-con-Kha (R1) · **kế hoạch, chưa code**
Đo trên prod (SELECT read-only, 378 khách active) + workbook SoT `Khách Việt Nam+Nhat Ban`.

---

## 0. Xác nhận briefing của PMt — đúng, và có một chỗ nặng hơn mô tả

| Điểm briefing | Đo được | Kết luận |
|---|---|---|
| Cột 4 đã vào `C.vip = 4` | `import-vnjb.js:45` | ✅ đúng — không viết importer mới |
| `tagsOf` chỉ `if (/vip/i.test(vip))` | `import-vnjb.js:96` | ✅ đúng |
| Đếm cột 4 trên 332 dòng | 187/48/37/22/17/16/5 | ✅ khớp từng số |
| Tag `Nội`/`Ngoại` không tồn tại | **0 / 0** trên 378 thẻ | ✅ hai nút lọc trả rỗng |
| `VIP` vs `vip` = "lệch chữ hiển thị" | ❌ **nặng hơn** — xem §1 | 🔴 |

Một chi tiết phụ: sheet có **một dòng tiêu đề lặp lại giữa vùng dữ liệu**
(`KHÁCH VIP/THƯỜNG VIP/一般` ⟂ `Phân loại khách 顧客分類`) → nên đếm là 333 dòng có
chữ ở cột tên, 332 dòng khách thật. Đã kiểm: **không có thẻ ma** nào sinh ra từ dòng
đó trên prod ✅.

---

## 1. 🔴 Nút ★ VIP ở cửa đang giấu 48/53 khách VIP

Không phải lỗi hiển thị. Lỗi **lọc**, hai trang cửa như nhau
(`checkin-gala.html:142`, `checkin-toadam.html:142`):

```js
if(st.quick==="vip" && String(g.vip||"").indexOf("VIP")===-1
                    && String(g.vip||"").indexOf("VVIP")===-1) return false;
```

`vipOf()` (dòng 120) dùng regex `/^V?VIP/i` nên **bắt được** tag chữ thường → `g.vip = "vip"`.
Nhưng bộ lọc dùng `indexOf` — **phân biệt hoa thường**. `"vip".indexOf("VIP") === -1` → loại.

| tag trong DB | số thẻ | bấm ★ VIP |
|---|---|---|
| `vip` (do `import-vnjb` ghi) | **48** | ❌ bị ẩn |
| `VIP` (di sản `tgd116`) | 5 | ✅ hiện |

**Tại cửa ngày 08/08:** bấm ★ VIP ra **5 thẻ**, trong đó **4 thẻ mang `trung-ten-can-ra`**
(thẻ trùng chờ gộp) và **1 thẻ mang đồng thời `VIP` + `Khách thường`**. Nghĩa là nút VIP
hiện gần như đúng tập sai. Lễ tân dùng nút này để ưu tiên đón VIP → 48 VIP thật đi qua
như khách thường.

Sửa: so khớp **không phân biệt hoa thường** ở bộ lọc (`/v?vip/i.test(g.vip)`), độc lập với
việc backfill tag. Đây là **một dòng ở mỗi trang cửa và không cần đụng DB** — em đề xuất
tách ra vá trước.

---

## 2. Nội / Ngoại — hai nút lọc chưa bao giờ có dữ liệu

`mapRow` (dòng 126) đọc `phanloai` từ tag **đúng chữ** `Nội` / `Ngoại`.
`import-vnjb` không ghi hai tag đó (cột 2 → `pl:<slug bỏ dấu>`; cột 4 chỉ xét `/vip/i`).
Đo prod: **0 và 0**. Hai nút bấm ra danh sách rỗng, không có thông báo lý do.

SoT có sẵn dữ liệu: **Nội 16 · Ngoại 17 · Gia đình TGĐ 5**.

## 3. `OB Esuhai` — briefing nói "không map", thực tế map **thiếu 3**

Cột 2 sinh `pl:ob` = **19 thẻ** trên prod. Cột 4 có **22** dòng `OB Esuhai`.
Bắt chéo hai cột trên sheet:

```
19  OB Esuhai  ⟂  OB       → có pl:ob   ✅
 3  OB Esuhai  ⟂  TGĐ      → chỉ pl:tgd ❌ thiếu
```

Nên gộp cột 4 vào lane OB thì được đúng 22.

## 4. Lọc «Khách Nhật» — em xin **không** bỏ `isKanji(full_name)`

Đo prod sau E3:

| | số thẻ |
|---|---|
| `full_name` có chữ Nhật | **0** |
| `name_jp` có chữ Nhật | **63** |
| chỉ `full_name` (mất nếu bỏ vế đó) | **0** |
| hợp — bộ lọc hiện tại | **63** |

Bộ lọc hiện tại **đã cho đúng 63**, y hệt phương án "chỉ `name_jp`". Bỏ vế
`isKanji(full_name)` hôm nay **không sửa được gì** vì nó không kéo vào thẻ nào.

Nhưng nó **có thể mất khách về sau**: `name_jp` chỉ đến từ SoT. Một khách Nhật đăng ký
qua form từ giờ tới 08/08 gõ 田中太郎 vào ô họ tên sẽ có `full_name` chữ Nhật và
`name_jp` NULL — vế `isKanji(full_name)` là thứ duy nhất còn bắt được họ.

Rủi ro ngược lại (kéo nhầm khách Việt) bằng **0**: regex chỉ khớp hiragana/katakana/kanji,
tên Việt viết latin không thể khớp.

**Đề xuất:** giữ hợp `name_jp ∪ full_name ∪ tag khach-nhat`. Nếu anh vẫn muốn bỏ, xin bỏ
kèm điều kiện gắn tag `khach-nhat` cho 63 thẻ để không phụ thuộc một cột duy nhất.

---

## 5. `Gia đình TGĐ` (5 khách) — đề xuất **tag riêng, không gộp vào Nội**

Bắt chéo cột 4 ⟂ cột 2 trên SoT:

```
17  Gia đình - Ngoại  ⟂  TGĐ
16  Gia đình - Nội    ⟂  TGĐ
 5  Gia đình TGĐ      ⟂  TGĐ
```

Cả 38 người đều thuộc nhóm TGĐ; sheet cố ý viết nhóm 5 người **khác** hai nhóm kia.

Lý do em đề xuất tag riêng `gd-tgd` (nhãn cửa **Gia đình TGĐ**):

- Gộp vào `Nội` là **suy đoán quan hệ họ hàng** mà dữ liệu không nói. Nếu trong 5 người
  có người bên ngoại hoặc gia đình trực hệ, lễ tân sẽ chào sai bên trước mặt gia đình
  TGĐ — sai kiểu không cứu được tại chỗ.
- Tag riêng **không mất gì**: vẫn lọc được, vẫn có badge, và nếu Ly xác nhận là Nội thì
  đổi sau bằng một câu UPDATE.
- Hướng ngược lại thì không đối xứng: đã trộn vào `Nội` rồi thì không tách lại được nếu
  không đọc lại sheet.

**Chờ anh/Ly chốt.** Mặc định em ghi trong dry-run là tag riêng.

---

## 6. Kế hoạch AC-F (chờ GO mới code)

| # | Việc | File | Rủi ro |
|---|---|---|---|
| F0 | **Vá lọc ★ VIP hoa/thường** (§1) | 2 trang cửa, 1 dòng/trang | thấp — không đụng DB |
| F1 | `tagsOf` map cột 4: `vip` · `thuong` · `gd-noi` · `gd-ngoai` · `gd-tgd` · `ob` | `import-vnjb.js` | thấp — chỉ thêm |
| F2 | `mapRow.phanloai` đọc tag mới thay vì chữ `Nội`/`Ngoại` | 2 trang cửa | thấp |
| F3 | Badge trên **list** cửa: VIP · Nội · Ngoại · GĐ TGĐ · 🎌 | 2 trang cửa | trung — chật chỗ ở 320px, phải đo |
| F4 | Nhãn hiển thị chuẩn hoá **`VIP`** (mọi nơi show hạng) | 4 màn | thấp |
| F5 | Lọc Khách Nhật theo §4 | 2 trang cửa | thấp |
| F6 | **Dry-run** backfill tag trên thẻ `vnjb-*` → bảng đếm → **dừng** | script mới | — |

**Ràng buộc tự đặt**
- Backfill **merge tag**, tuyệt đối không `tags = $7` — đúng lỗi đã phá 58 thẻ ở Pha 2.
- Chỉ chạm thẻ `guest_ext_id LIKE 'vnjb-%'` và `deleted_at IS NULL`.
- Không đụng E3, không đụng tag buổi (`toa-dam`/`gala`/`khong-du`/`chua-ro-buoi`) — D026
  dựa vào đó để giữ ba nhóm rời nhau.
- `--commit` **chỉ khi anh GO riêng**.

## 7. Va chạm với QC toàn tip đang chạy

QC §B7 đang soi tip `811fba3`. Sửa file cửa ngay bây giờ làm verdict rơi lên tip cũ.
PMt đã cho hướng ("bổ sung AC-F vào vòng sau hoặc wave nhỏ sau commit tag").

Em đề xuất: **code AC-F ngay, deploy sau khi verdict QC về** — trừ **F0** nếu anh muốn
48 VIP hiện lại sớm, vì F0 chỉ là một dòng và độc lập hoàn toàn với phần QC đang soi.

---

§B7: bản này do R1 (người sẽ code) viết — là **Gate 1 plan**, không phải Gate 2.
QC AC-F phải do người ≠ R1 chạy sau khi code xong.
