# Gate 2 §B7 — E08-D028 **gói còn lại** (E-1 · CỬA-4 · F · G)

**QC độc lập, không phải R1.** Read-only toàn phiên: không sửa file, không commit, không deploy, không ghi DB.
Mọi SQL bọc `BEGIN TRANSACTION READ ONLY … ROLLBACK`. Không tạo interaction, không upload ảnh lên thẻ khách thật.

| | |
|---|---|
| Vé | E08-D028 — gói còn lại (E-1 · CỬA-4 · AC-F · AC-G) |
| Tip được giao | `0eebe09` (mã ở `2a429ab`) |
| **Tip thật lúc chấm** | `6c55c19` — prod đã trôi qua `63ca5a8` · `8c0c870` · `c494c75` · `059c54a` · `6c55c19` **giữa phiên QC** |
| Cửa sổ đo | 2026-08-04 **23:33Z** → 2026-08-05 **00:33Z** (06:33 → 07:33 giờ VN) |
| Nền dữ liệu | khách active **348** (Ly xoá mềm 30 thẻ lúc 15:56Z 04/08, 378 → 348) — đã trừ hao ở mọi phép đo |
| Prod | `esuhai-web-production.up.railway.app` · `CRM_UI=new` (`/crm` phục vụ `crm-app-v2.html`) |

---

## 1. Verdict

# ⚠️ PASS CÓ ĐIỀU KIỆN

**Không có `blocker`** ⇒ không FAIL. Toàn bộ 6 mục bắt buộc của phiếu (CR-25 · E-1 · CỬA-4 · AC-F · AC-G0…G3 · AC-G4 · Regress) đều **ĐẠT**, và **E-1 đã lật được FAIL cũ** (千葉/鶴雅/取締役 từ 0 → có kết quả, `Chiba` không regress).

Điều kiện để chuyển sang PASS trọn:

1. **Vá `L4-02` trước 08/08** (2 dòng, `crm-app-v2.html:577` + `crm-app.html:425`). Đây là **PASS giả kinh điển**: mọi phép kiểm hôm nay xanh chỉ vì tính năng ảnh quà **chưa được dùng lần nào** (`crm_photos` có `interaction_id` = **0**). Chiều 08/08 PG bấm «Chụp ảnh quà» lần đầu là **ảnh hộp quà thế chỗ mặt khách** trên hồ sơ `/crm` — đúng màn BTL mở ra để đối chiếu người thật.
2. **Chốt cách xử lý `L4-03` + `L4-04`** (ghi từng phần / dòng mồ côi). Không có route xoá interaction ⇒ mọi dòng rác đọng vĩnh viễn trên thẻ khách VIP. Nếu không kịp vá mã thì **phải** vào runbook cửa.
3. **Phát lại phiếu QC với tiền đề đúng** — xem `QC-01`: phiếu tiêm cho QC còn ghi «tag chưa `--commit` ⇒ ba nút phải ra 0», trong khi backfill đã chạy thật lúc **23:41:02Z 04/08** và ba nút đang ra **16/17/5**.

> **Đính chính quan trọng cho PM:** phiếu QC tiêm cho tôi ghi *«Tag Nội/Ngoại/Gia đình TGĐ CHƯA `--commit` ⇒ ba nút lọc đó phải ra 0»*. **Điều này không còn đúng.** Tôi tự đo lúc **00:33:33Z 05/08**: `?session=gala` → Nội **16** · Ngoại **17** · GĐ TGĐ **5** (322 thẻ); `?session=toa-dam` → **0** · **0** · **2** (148 thẻ). File dispatch gốc trên đĩa đã được PM tự sửa (dòng 34: «F6: sau `--commit` → Nội16 · Ngoại17 · TGĐ5»), chỉ bản prompt tiêm là còn cũ.

---

## 2. Bảng chấm theo phiếu

### 0 · CR-25 — byte prod ↔ tip repo

| Vòng | Mốc giờ | Kết quả | Bằng chứng (sha256, 16 ký tự đầu) |
|---|---|---|---|
| Vòng 1 (tip `0eebe09`/`2a429ab`) | **23:33–23:34Z** | ✅ **4/4 KHỚP** | `checkin-gala` `446eb14b…` (47 749 B) · `checkin-toadam` `ea99bd99…` (47 702 B) · `crm-app-v2` `1190ea57…` (78 896 B) · `crm-app` `a20fd323…` (65 801 B) |
| Vòng 2 (prod bị deploy lại giữa phiên, tip `c494c75`) | **23:57Z** | ✅ 2/2 cửa | `e74cdcb9…` / `6e24fbfc…` |
| Vòng 3 (tip `6c55c19`) | **00:15Z** | ✅ **4/4 KHỚP** | hai cửa `ea5ff779…` / `84f5ae62…`; hai màn `/crm` không đổi byte |
| **Vòng 4 — tôi tự chạy lại lúc chốt báo cáo** | **00:33:13Z** | ✅ 2/2 cửa | `checkin-gala` prod `ea5ff779ab878351` = local `ea5ff779ab878351` · `checkin-toadam` prod `84f5ae62e48cc564` = local `84f5ae62e48cc564` |

`git status` **sạch** ở cả 4 lần. **Kết luận: mọi phép đo dưới đây chạy trên đúng byte đang phục vụ khách.**

> ⚠️ Ghi vào nhật ký vé: **prod bị deploy lại 2 lần trong lúc QC đang chấm.** Tôi đã chạy lại toàn bộ bảng E-1 và CỬA-4 trên byte mới; số không đổi một đơn vị. Nhưng đây là rủi ro quy trình cần siết trước 08/08.

---

### 1 · E-1 — ô tìm kanji (**bắt buộc — lật FAIL cũ**) ✅ ĐẠT

Mốc đo: **23:36Z–23:50Z**, đo lại trên byte `059c54a` lúc **00:05Z**.

| Khoá | Kỳ vọng | Cửa Gala | Cửa Tọa đàm | |
|---|---|---|---|---|
| 千葉 | >0 (trước = **0**) | **2** | **2** | ✅ lật FAIL |
| 鶴雅 | >0 (trước = **0**) | **1** | **1** | ✅ lật FAIL |
| 取締役 | >0 (trước = **0**) | **13** | **9** | ✅ lật FAIL |
| Chiba | không regress | **2** | **2** | ✅ giữ nguyên |

**4 khoá tôi tự rút thêm** từ `name_jp`/`title_jp`/`org_jp` (không dùng khoá của R1): 株式会社 **22/17** · 代表 **15/10** · 社長 **5/4** · 部長 **28/21** (Gala/Tọa đàm).
**Cả 8 khoá khớp TỪNG SỐ** với phép tính lại độc lập của tôi trên JSON thô `/crm/guests?session=` — không phải đọc lại số của R1.

**Ở chế độ 日本語:** bấm `#langBtn` sang `jp` rồi gõ lại cả 8 khoá — kết quả **y hệt** bản `vn` trên cả hai cửa (hint đổi sang 「22件」). **0 lỗi JS.**

---

### 2 · CỬA-4 — làm mới số ✅ ĐẠT (đo bằng `page.on('request')`, không chỉ runbook)

Mốc đo: **23:44Z–00:02Z**, chạy lại trên byte mới lúc **00:18Z**.

| Điều kiện | Kết quả | Bằng chứng |
|---|---|---|
| Đứng yên ≥25 s | ✅ | Sau boot 1 request `/crm/guests?session=`; đứng yên 35 s → **+1 request**, `lastSync` đổi, `POLL_MS=25000`. Đúng trên **cả hai cửa**. |
| Bấm ↻ | ✅ | +1 request, `lastSync` đổi sau **0,55 s**, dòng «Cập nhật HH:MM» nhảy, toast «Đã cập nhật số ✓» hiện **thật** (`display:block`, `z-index 100001`). Lặp 4 lần × 2 cửa. |
| Máy khác vừa điểm danh | ✅ | 2 browser context riêng, cùng khởi đầu 1/321. A điểm danh (POST bị chặn ở trình duyệt, trả 201 giả — **không ghi DB**) → **B tự đổi 1→2 sau 15,2 s và 17,2 s** (2 lượt), thẻ lên class `gc done`. Trên máy chủ giả: **24,1 s** đúng chu kỳ. |
| Tab ẩn không đốt request | ✅ | Ép `document.hidden=true` + dispatch `visibilitychange` → **0 request** trong 40 s. Sáng lại → bù 1 request trong <3 s. |
| Hồ sơ đang mở thì dừng poll | ✅ | Đứng 32 s với `.pf.show=true` → **0 request**. Đóng hồ sơ → bù 1 request sau **0,28 s**. |
| Không cướp chữ đang gõ | ✅ | Gõ «Ng» vào `#q` rồi ép poll trả về có thay đổi → chữ nguyên, focus nguyên, caret `[2,2]`, kết quả 287→287. |
| Không lật ngược dấu «đã đến» | ✅ | Ép `/crm/guests` chậm 8 s rồi điểm danh giữa chừng (`pollBusy=true`) → `mutSeq` chặn đúng, cDone giữ, `.cidone` còn, sau 12 s poll THẬT thẻ vẫn `gc done`. |
| Thẻ không trượt dưới ngón tay | ✅ | 3 ca điểm danh từ máy khác đổ về khi **không** bật lọc → thẻ mốc dịch **0 px**. |

⚠️ **Khoảng trống đã ghi thành `L-05`:** đường **hỏng** của vòng poll im lặng tuyệt đối (401 hoặc rớt mạng → 0 toast, số đông cứng, `#upd` đóng băng).

---

### 3 · AC-F ✅ ĐẠT (F0 · F2 · F3 · F3b · F4 · F5 · F6 · F7 · F8)

| Mục | Kết quả | Bằng chứng · mốc giờ |
|---|---|---|
| **F0** ★VIP theo buổi | ✅ | Tôi **tự đếm lại từ DB** lúc **23:36:56Z**: Gala 322 thẻ / ★VIP **44** · Tọa đàm 148 / ★VIP **30**. Đo trên trình duyệt **23:46Z**: 44 / 30 — trùng khít. Con số «~53» của phiếu cũ là **trước** lần Ly xoá mềm; tổng VIP toàn DB hiện **49**. Không còn ca «~5». |
| **F6** Nội/Ngoại/TGĐ | ✅ | **Tự đo 00:33:33Z:** Gala **16 · 17 · 5** · Tọa đàm **0 · 0 · 2**. Gốc: `crm_audit_events` id 122 `backfill_tags_vnjb` lúc **23:41:02Z**, meta `{"theSua":42,"themTheoTag":{"vip":1,"Nội":16,"pl:ob":3,"Ngoại":17,"Gia đình TGĐ":5}}`. |
| **F6** backfill là MERGE, không gán đè | ✅ | 42 thẻ đổi, **min 5 / max 10** tag mỗi thẻ; 41/42 giữ `vnjb`, 41/42 giữ `pl:*`, 38/42 giữ tag buổi, 37/42 giữ `kcode:`, 37/42 giữ `tgd116`; **0** thẻ mất `full_name`, **0** thẻ mất `name_jp`; **0** thẻ `deleted_at` bị chạm. Chạy lại dry-run lúc **23:42:04Z** → «thẻ SẼ SỬA: **0**», 108/108 tag «đã có sẵn» ⇒ **idempotent, bằng chứng thực nghiệm chứ không phải suy luận**. |
| **F8** stick đếm trên nút lọc | ✅ | Ship giữa phiên (`c494c75`). Số trên nút **khớp 5/5** với số thẻ nút đó lọc ra: Gala 44·63·16·17·5 · Tọa đàm 30·44·**0**·**0**·2. Hai số **0** mang class `qn zero`, **vẫn hiện** (18 px, không ẩn, không cắt mép). Không tràn ngang ở 320/360/390 px. `quickOk()` dùng chung cho `match()` và `quickCounts()` ⇒ **không thể** lệch giữa số và danh sách. |
| **F2/F7** nhãn `VIP` viết HOA đủ 4 màn + CSV | ✅ | list cửa `.bg-vip` = {VIP 43, «VIP2 - HÀNG 3» 1} Gala / {VIP 30} Tọa đàm; pill hồ sơ «HẠNG \| VIP»; `/crm` + `/crm/classic` = {VIP 48, «VIP2 - HÀNG 3» 1}; **CSV tải thật**: 348 dòng, cột «Hạng VIP» = {VIP 48, «VIP2 - HÀNG 3» 1}. Quét regex chữ thường `vip` trên innerText 4 màn + CSV → **0 chỗ**. |
| **F3** `hangTags()` map đúng | ✅ | 7 giá trị thật của cột 4 map đúng; **«Gia đình TGĐ» KHÔNG lọt vào «Nội»**: 0/332 dòng SoT. 38 biến thể bẩn tự nghĩ (kể cả `Gia đình TGĐ - Nội`, gạch dài U+2013, thừa dấu cách, không dấu, viết HOA) đều đúng. |
| **F3b** OB đủ 22 | ✅ | Cột 4: VIP 48 · Thường 187 · OB Esuhai 22 · trống 37 · GĐ TGĐ 5 · Nội 16 · Ngoại 17 (tổng 332). Prod: `pl:ob` 19 → **22**. |
| **F4** giữ `isKanji(full_name)` | ✅ | `checkin-gala.html:238` / `checkin-toadam.html:238` còn nguyên vế `isKanji(g.name)||isKanji(g.name_jp)`. Hiện `full_name` chứa kanji = 0 thẻ ⇒ đang là **lưới an toàn thuần** cho form JP tới 08/08 — đúng ý AC-F4. Badge 🎌: Gala 63 · Tọa đàm 44. |
| **F5** badge không phá layout | ✅ | Đo **trước và sau** khi 38 badge họ hàng xuất hiện, ở 320/360/390 px × 2 cửa: `scrollWidth == clientWidth` (không tràn ngang), `.bgs` không tràn, **0** thẻ badge đè tên, `.pv-sub` cao 0 px = **0/238** (Gala) và **0/151** (Tọa đàm), thấp nhất 14,11 px. Kiểm chéo `/crm` + `/crm/classic` ở 320/390/1280: 243 hàng, 0 hàng 0 px. |
| **Rủi ro tách module `vnjb-keys.js`** | ✅ **KHÔNG lệch** | So `codeOfParts()` mới với bản chép nguyên từ `import-vnjb.js@28c53ce` trên **toàn bộ 332 dòng SoT**: **0 dòng lệch**. Sinh lại mã từ workbook → khớp **259/259** `guest_ext_id` `vnjb-*` đang có trên prod ⇒ lượt import sau **không** tạo 259 thẻ trùng. |

---

### 4 · AC-G0…G3 ✅ ĐẠT

Mốc đo: **23:52Z–00:10Z**.

| Mục | Kết quả | Bằng chứng |
|---|---|---|
| **G0** hai buổi hai màu | ✅ | `getComputedStyle` trên prod: Tọa đàm `--acc:#0F955A` (xanh lá) · Gala `--acc:#2E7FCC` (xanh dương). Nền cũng tách thật: `--bg1/--bg3` = `#0a2018/#07140E` vs `#0b1a30/#08111F`. Lớp `.pf`, ô ảnh trống, viền header, tiêu đề «GHI NHẬN TẠI QUẦY» đều đổi theo buổi. |
| **G0** tương phản chữ trên nền lá mới | ✅ | Tên khách **13,3:1** · hàng VN/JP phụ **7,7:1** · chức vụ **7,0:1** · dòng «Cập nhật» **4,8:1** — không tệ hơn cửa xanh dương. |
| **G1** thứ tự khối hồ sơ khớp mock | ✅ | `.pf-bar` («HỒ SƠ KHÁCH» + nút ←) → `pf-av` → `pf-nm` → `pf-rl` (chức vụ + đơn vị, cặp VN/JP) → `th` (BÀN) → `hangp` (HẠNG VIP) → `badges` → `facts` → `info` (Người phụ trách · Vai trò · SĐT ẩn · Mã khách) → CTA → `quay`. Đo trên thẻ có bàn + VIP. Khách đã điểm danh: `.cidone` thay đúng chỗ CTA, khối quầy vẫn còn. |
| **G1** bỏ ô GHẾ không ai mất số bàn | ✅ | SQL **23:38Z**: active 348 · có `table_no` **119** · note chứa «Số bàn» **6** · có **đồng thời** hai nguồn **0**. Trên màn: 118 badge Bàn ở list Gala, 36 ở Tọa đàm. ⚠️ 6 thẻ hiện «BÀN N/A» — xem `L-06`. |
| **G2** CTA POST thật, trạng thái khớp DB | ✅ | Bắt được `POST /crm/guests/:id/check-in` body `{}` (chặn lại, không tới DB). Thẻ đã điểm danh hiện «Đã check-in lúc 18:50», DB `checked_in_at=2026-08-04T11:50:53Z` = 18:50 giờ VN. Bộ đếm ĐÃ ĐẾN = 1 ở cả hai cửa, DB cũng 1. |
| **G2** không báo xanh giả (CỬA-2) | ✅ | Ép **500 / 401 / 404 / mất mạng** → **4/4** toast ĐỎ đúng câu, `.cidone` **không** dựng, bộ đếm giữ 1, thẻ không chuyển `done`, nút bật lại. |
| **G3** hai nút ảnh đúng chỗ | ✅ | Cả hai nằm **trong** khối «Ghi nhận tại quầy», ô đầu tiên nhãn «Ảnh khách». `data-cam` → `input#cam` có `capture="environment"`; `data-pick` → `input#pick` **không** có `capture`; cả hai `accept=image/*`. |
| **E4** spot chồng VN/JP | ✅ | 2 cửa × 320/360/390 × vn/jp, cả list lẫn hồ sơ: UI vn → VN trên/JP dưới; UI jp → JP trên/VN dưới (kiểm cả bằng toạ độ Y). Không tràn ngang lần nào, kể cả khi lớp hồ sơ đang mở. Thiếu một phía → chỉ hiện phía có dữ liệu, không có hàng trống. |

---

### 5 · AC-G4 ✅ ĐẠT (đã wire thật, **shell + payload + đường lỗi** đo trọn; **đường thành công thật CHƯA đo được — xem câu hỏi (b) cho Sponsor**)

Mốc đo: **23:52Z–00:20Z**.

| Mục | Kết quả | Bằng chứng |
|---|---|---|
| Khối đủ phần tử | ✅ | h4 «GHI NHẬN TẠI QUẦY» · Ảnh khách + 2 nút · 🎁 Quà khách tặng + nút «Chụp ảnh quà» · 🎀 Quà đáp lễ (placeholder có 引き出物) + dòng «⌛ Danh sách quà đáp lễ đang chờ chị Thúy Hà xác nhận» · 📝 Ghi chú · nút «Lưu ghi nhận» · khối lịch sử. |
| `saveQuay()` **có** kiểm `r.ok` — không lặp CỬA-2 | ✅ | Ép **500 / 401 / 404 / mất mạng** → **4/4 toast ĐỎ**, **0** toast xanh, nút bật lại, chữ trong ô giữ nguyên. |
| Toast nổi trên lớp hồ sơ (nợ m2) | ✅ **chứng minh bằng pixel** | Vùng cắt 350×144 ở đáy màn, hồ sơ đang mở: check-in 500 → **26 713 px đổi** · ảnh 500 → **39 683 px** · lưu 500 → **48 494 px** · lưu rỗng → **48 105 px**. Cả 4 lần `elementFromPoint` tại tâm toast trả về **chính `#ciToast`**; `z-index 100001 > .pf 100000`. |
| Payload đúng endpoint + đúng `kind` | ✅ | 3 POST `/crm/guests/:id/interactions` với `qua-tang` / `qua-dap-le` / `ghi-chu-quay`; ảnh quà gửi kèm `interaction_id` trong form-data. |
| Xoá ô sau khi lưu (vá `63ca5a8`) | ✅ | Lưu thành công (201 giả) → 3 ô xoá sạch, `g._q={}`, bấm lại ra «Chưa có gì để lưu». |
| Bản nháp sống qua 3 đường phiếu nêu | ✅ | Đổi ngôn ngữ · `enrich()` trả về · điểm danh thành công — cả 3 ô giữ nguyên chữ. ⚠️ Vỡ ở **đường thứ tư** (đóng/mở hồ sơ) — `L-07`. |
| `photos.js` chặn `interaction_id` của khách khác | ✅ | 4 đường thất bại tự chạy: id bịa → 400 «Ghi nhận không thuộc khách này.» · id thuộc khách khác → 400 · `'1abc'` → 400 · khách không tồn tại → 404. Đếm lại `crm_photos` sau 4 lần: vẫn **202/0**. |
| Ràng buộc DB không chặn đường thành công | ✅ | `crm_interactions.kind` là `text NOT NULL default 'khác'`, **không** CHECK/enum; FK `crm_photos.interaction_id → crm_interactions(id) ON DELETE SET NULL` đã tồn tại ⇒ 4 `kind` mới chèn được, **không cần migration**. |
| Lịch sử render đúng khi có dữ liệu | ✅ | Mô phỏng 1 interaction `anh-qua` → cửa hiện «Chụp ảnh quà: … · \<actor rút gọn\> · 18:00». ⚠️ Nhưng biến mất khi mở lại thẻ — `L-04`. |
| **Đường THÀNH CÔNG thật trên prod** | ⛔ **N/A — không đo được** | Sponsor cấm ghi vào thẻ khách thật. `crm_interactions` đúng **1 dòng** từ 27/07, `crm_photos` **202 dòng / 0 có `interaction_id`**, `kind='anh-qua'` = **0**. Tôi dừng ở đây, giống R1. **Xem câu hỏi (b).** |

---

### 6 · Regress ✅ ĐẠT

Mốc đo: **23:50Z–00:20Z**.

| Mục | Kết quả | Bằng chứng |
|---|---|---|
| `npm run smoke:crm` | ✅ | «**PASS — 43/43 phép kiểm**» · AC-5 ảnh UI khớp API **165 vs 165**. ⚠️ Nhưng **0/43** phép kiểm chạm hai trang cửa — `L-13`. |
| AC-A sau khi tag bị backfill | ✅ **0 lệch** | tab `du_gala` **322** = `?session=gala` **322** · `du_toa_dam` **148** = `?session=toa-dam` **148**; KPI invited 348 = số thẻ list 348; integrity `{partitionOk, disjoint, bucketsOk, overlapTagAndForm:0}`. Tag buổi nguyên vẹn (`khong-du` 13 · `chua-ro-buoi` 11). |
| AC-B2 — 0 nút điểm danh trên `/crm` | ✅ | `/crm` và `/crm/classic`, ép role **staff VÀ btl**: `#ciBtn` không tồn tại, **0** nút/liên kết chứa «điểm danh/check-in», vẫn hiện khối «Điểm danh tại cửa — mở …». 0 lỗi JS. |
| `/crm` + `/crm/classic` không vỡ | ✅ | 348 thẻ, **0** lỗi JS, không tràn ngang ở 320/390/1280. |
| AC-D0 avatar list vuông một cỡ | ✅ | `/crm` + `/crm/classic`: **348/348** ô `.av` đúng 48×48, `object-fit:cover`; hai cửa 46×46 đồng nhất. |
| AC-D2 ảnh ngang trong hồ sơ | ✅ | Ảnh gốc 1280×854 → `.pf-av img` `object-fit:contain`, khung 250×190 (nới ngang, không crop). Quét 60 ảnh thật: 23 ngang / 37 dọc / **0 lỗi tải**. |
| **Không khách nào mất ảnh** vì `AND ph.interaction_id IS NULL` | ✅ | 3 nguồn độc lập: SQL 202 ảnh / 188 guest_id / **0** ảnh có `interaction_id`; khách active có ảnh = **165 TRƯỚC và SAU** điều kiện mới; API 348 rows / 165 `photo_url`; DOM `/crm` + `/crm/classic` đếm **165** `<img>`; cửa Gala 322/162, Tọa đàm 148/91. Chênh 188→165 giải thích trọn bằng 23 thẻ Ly xoá mềm. |
| `imgFit is not defined` — không tái tạo | ✅ | `window.imgFit === 'function'` ở cả 4 màn; 6 phiên trình duyệt × 320/390/1280 → **0 pageerror, 0 console error**. |
| `tags = $7` — không tái tạo | ✅ | `PATCH /crm/guests/:id` dựng chỉ số động `$${params.length}`, không đếm tay. |
| Đường thất bại | ✅ | `?session=xxx` → 400 · không auth → 401 mọi route · Bearer sai → 401 · POST check-in không auth → 401. |
| **Không ghi gì lên prod** | ✅ | Đếm lại **23:56Z**: `crm_interactions` **1** · `crm_photos` **202** · `crm_check_ins` **2** · khách active **348** — **đúng bằng lúc bắt đầu**. |

---

## 3. Lỗi còn lại — sắp theo mức nặng

> **ĐỪNG tự sửa từ báo cáo này.** Mỗi mục ghi rõ file:line, vì sao quan trọng, cách sửa để R1 quyết.
> Cột «Mức» là mức **sau phản biện** của tôi; nơi nào tôi hạ/nâng so với người báo đầu tiên đều ghi rõ.

### 🔴 MAJOR — nên vá trước 08/08

#### `L-01` · Ảnh quà sẽ thế chỗ mặt khách trên `/crm` và `/crm/classic` — **PASS giả kinh điển**

* **Vị trí:** `server/crm/views/crm-app-v2.html:577` và `server/crm/views/crm-app.html:425`
  `var pu=(j.photos&&j.photos[0])?j.photos[0].url:"";`
  *(Tôi xác minh lại lúc 00:33Z: **hai số dòng vẫn đúng nguyên văn** ở HEAD `6c55c19`.)*
* **AC:** AC-G4 · AC-D1 (spec nêu đích danh «hồ sơ chi tiết (/crm detail)»)
* **Vì sao quan trọng:** đường ghi có thật và một chiều — `checkin-gala.html:339-350` khi `asGift` thì POST `/interactions` kind=`anh-qua` lấy id **rồi** `fd.append("interaction_id", interId)`; `photos.js:37-49` xác thực rồi INSERT. **Không có route DELETE ảnh** ⇒ không lùi lại được. Chiều 08/08 PG bấm «Chụp ảnh quà» lần đầu là ảnh hộp quà trở thành avatar hồ sơ trên màn BTL dùng để **đối chiếu người thật**.
* **Vì sao mọi phép kiểm vẫn xanh:** `crm_photos` có `interaction_id` = **0**, `kind='anh-qua'` = **0** — tính năng **chưa dùng lần nào**. `npm run smoke:crm` PASS 43/43 và «AC-5 ảnh UI khớp API 165 vs 165» chỉ đếm `photo_url` của **LIST**, không đụng ảnh trên tấm hồ sơ (`tools/smoke-crm.js:139, 256`).
* **Tái hiện (tôi tự chạy, 17:15–17:25Z 04/08):** chặn `GET /crm/guests/<id>`, `route.fetch()` lấy phản hồi **thật** rồi chèn 1 ảnh đúng hình dạng server trả sau khi chụp ảnh quà (`{id:900001, url:"/crm/photos/900001", interaction_id:777}` đặt đầu mảng — đúng vì `ORDER BY created_at DESC`, `guests.js:129`). Kết quả `.pf-av img@src`:
  * `/crm` (v2 live) → `/crm/photos/900001` = **ẢNH QUÀ ❌**
  * `/crm/classic` → `/crm/photos/900001` = **ẢNH QUÀ ❌**
  * Cửa Gala → `/crm/photos/46` = chân dung thật ✅
  * Cửa Tọa đàm → `/crm/photos/46` = chân dung thật ✅
  * `.thumbs` trên `/crm`: `["/crm/photos/900001","/crm/photos/46","/crm/photos/9"]` — **trộn lẫn, không nhãn phân biệt**.
* **Vá 2/3 nơi — xác nhận:** `guests.js:92-93` lọc `AND ph.interaction_id IS NULL` cho avatar LIST; `checkin-gala.html:452` / `checkin-toadam.html:452` lọc `!p.interaction_id` cho hồ sơ ở cửa. **Hai shell `/crm` không lọc.** Chính báo cáo R1 (dòng 109-112) tuyên bố «avatar khách ở CẢ 4 MÀN…» ⇒ **ý định của R1 chưa đạt ở 2 màn**.
* **Cách sửa (2 dòng):** trong `renderGuest()` của cả hai shell:
  `var ph=(j.photos||[]).filter(function(p){return !p.interaction_id;}); var pu=ph[0]?ph[0].url:"";`
  và đánh dấu ảnh quà trong `.thumbs` (viền/nhãn 🎁) thay vì trộn chung. **Cùng luật với cửa và với SQL list.**

#### `L-02` · «Lưu ghi nhận» ghi **từng phần**: hỏng giữa chừng → dòng đã vào DB nhưng báo ĐỎ «CHƯA lưu được» → bấm lại là **ghi trùng**

* **Vị trí:** `checkin-gala.html:379-399` @`0eebe09` (= **411-436** ở tip hiện tại), nhánh báo lỗi `:395-396` (= **427-428**) · `checkin-toadam.html` **giống hệt** (`diff` vùng này = rỗng) · `server/crm/guests.js:247-263`
* **AC:** AC-G4 · AC-C2 — **mặt trái của chính lỗi CỬA-2 mà gói này tự hào đã chặn**: CỬA-2 là «báo xanh giả», đây là **«báo đỏ giả» cho một ghi ĐÃ thành công**.
* **Vì sao quan trọng:** 3 job POST **tuần tự**, mỗi job là một INSERT **độc lập tự commit**, **không transaction chung**, **không idempotency**, **không upsert**. Job trước đã vào DB; `if(!r.ok){btn.disabled=false; toast(…,1); return;}` thoát sớm **mà không đụng ô** (việc xoá ô ở `63ca5a8` nằm SAU vòng lặp, chỉ trên đường thành công). PG đọc «CHƯA lưu được» → bấm lại → dòng `qua-tang` **thứ hai**. **Không có route xoá interaction** ⇒ dòng trùng nằm lại trên thẻ khách VIP; chị Thúy Hà đối soát quà sau lễ sẽ **đếm sai**.
* **Tái hiện (tôi tự chạy, 00:05–00:11Z, chặn route ở trình duyệt nên 0 byte tới DB):**
  * Ép job 2 trả **500**: toast «Máy chủ từ chối — CHƯA lưu được (500)» (`class="ci-toast bad"`, ĐỎ); máy chủ **đã có** 1 dòng `[qua-tang, «Gio hoa»]`; ô còn nguyên `['Gio hoa','Hop tra','Khach di cung 2 nguoi']`; nút Lưu `disabled=false`.
  * Bấm lại **đúng như PG thật** → posts = `[qua-tang, qua-dap-le, qua-tang]`, máy chủ 4 dòng, **đếm trùng `('qua-tang','Gio hoa') = 2`**; «Lịch sử tại quầy» hiện «🎁 Quà khách tặng: Gio hoa» **HAI LẦN**.
  * Biến thể **rớt mạng** giữa hai job: toast ĐỎ «Mất mạng — CHƯA lưu được», ô nguyên chữ, bấm lại vẫn gửi lại `qua-tang`.
  * **Cửa sổ lỗi không hề vài mili-giây:** 6 lượt POST `/crm/guests/999999999/interactions` trên prod (404, không ghi gì) mất **0,30 / 0,30 / 0,36 / 1,65 / 1,19 / 0,73 giây** ⇒ một lượt Lưu đủ 3 ô trải **~1–5 GIÂY**.
* **Tình tiết nặng thêm (tôi tự tìm):** `openPf()` (`:449`) chỉ gọi `enrich()` khi `!g._enriched` ⇒ sau lần lưu hỏng, PG đóng-mở lại hồ sơ **cũng không** nạp lại lịch sử ⇒ **dòng đã commit vô hình** cho tới khi tải lại cả trang.
* **Cách sửa (chọn một):** (a) gửi cả 3 ô trong **MỘT** request (thêm endpoint nhận mảng); (b) xoá riêng ô nào đã 2xx + đổi câu báo thành «Đã lưu 1/3 — phần còn lại CHƯA lưu», không xoá `g._q` toàn bộ. Tối thiểu: đánh dấu job đã ok để lần bấm sau không gửi lại.
* **Sắc thái tôi ghi trung thực:** biến thể «đứt socket» **không** tái hiện (Chromium tự thử lại POST trên kết nối mới) ⇒ kích hoạt thực tế là **5xx/4xx từ máy chủ** (redeploy giữa lễ, PG hụt hơi), không phải mọi kiểu mạng chập. «Vĩnh viễn» hơi mạnh: không có route HTTP nào xoá, nhưng người có `DATABASE_URL` vẫn DELETE được. **Ở quầy thì đúng là không lùi được.**

#### `L-03` · «Chụp ảnh quà» tạo dòng ghi nhận **TRƯỚC** khi ảnh lên kệ — ảnh hỏng để lại dòng mồ côi; và **ngay cả khi thành công** cũng đẻ 2 dòng cho 1 món quà

* **Vị trí:** `checkin-gala.html:306-318` @`0eebe09` (= **338-357** ở tip) nhánh `if(asGift)` trong `sendPhoto()` · `checkin-toadam.html:338-357` **giống hệt** · `server/crm/photos.js:22, 54`
* **AC:** AC-G4 · AC-C1b · AC-C2
* **Vì sao quan trọng:** dòng `anh-qua` đã nằm trên thẻ khách **dù không có ảnh nào**, và **không có route xoá interaction**. `photos.js:22` trả 503 «Kho ảnh (MinIO) chưa cấu hình.» **ngay đầu handler**, trước cả kiểm tra file ⇒ trong sự cố MinIO, dòng ghi nhận **đã vào DB rồi ảnh mới chết**. Prod vừa có đúng sự cố đó **8 phút** (commit `d23b0a0`) ⇒ **không phải giả định**.
* **Tái hiện (tôi tự chạy, 17:05–17:10Z và 00:15Z, khách GIẢ id 999001/9001, chặn toàn bộ `/crm/**`, KHÔNG chạm prod):**
  * Ép `/photos` **500**: thứ tự đúng là 1) POST `interactions {kind:anh-qua}` 2) POST `photos`; bấm **3 lần** → **3 interaction** `anh-qua` (id 5000/5001/5002), **0 ảnh**, ô «Quà khách tặng» vẫn còn chữ.
  * **Chi tiết làm lỗi NẶNG hơn:** nhánh hỏng `return` **trước** khi gọi `enrich()` ⇒ 3 dòng rác **không hiện lên màn ngay** — PG không thấy gì tích tụ nên **càng dễ bấm lại**; rác chỉ lộ ở vòng nạp sau.
  * **Đường THÀNH CÔNG cũng hỏng:** cho `/photos` trả 201 → 3 dòng «Chụp ảnh quà» hiện ngay; bấm tiếp «Lưu ghi nhận» → thêm dòng `qua-tang` cùng body ⇒ **4 dòng cho 1 món quà**. `sendPhoto` **không** xoá ô như `saveQuay` đã được vá ở `63ca5a8` — R1 vá nút Lưu, **bỏ sót nút Chụp ảnh quà**.
  * Ô quà để **trống** + 503 → body rơi về nhãn mặc định ⇒ dòng «Chụp ảnh quà: Chụp ảnh quà», không ảnh, không xoá được.
  * `histHtml()` chỉ hiện **12 dòng** (`L.slice(0,12)`) ⇒ rác đẩy ghi nhận thật ra khỏi màn.
* **Ràng buộc thiết kế:** `photos.js:37-42` **bắt buộc** `interaction_id` phải tồn tại và thuộc đúng khách trước khi nhận ảnh ⇒ client **không thể** tự đảo thứ tự. Đây là lỗ hổng thiết kế, cần endpoint gộp hoặc đường dọn, **không phải sửa vặt**.
* **Cách sửa:** đảo thứ tự — upload ảnh trước (không `interaction_id`), chỉ khi 2xx mới tạo interaction rồi gắn id; **hoặc** thêm endpoint upload nhận cả `kind`+`body` để làm một transaction. Nếu giữ thứ tự hiện tại thì phải xoá interaction vừa tạo khi upload lỗi (**cần route xoá — xem `L-10`**). Tối thiểu: khi ảnh lỗi thì báo rõ «đã ghi dòng quà nhưng ảnh chưa lên» **và xoá chữ ở ô** để tránh ghi trùng.

#### `QC-01` · **Tiền đề của phiếu QC sai** — backfill `--commit` đã chạy, ba nút lọc **KHÔNG** ra 0 *(lỗi giấy tờ, KHÔNG phải lỗi mã)*

* **Vị trí:** prod DB (`crm_guests` · `crm_audit_events`) · `reports/2026-08-05-d028-goi-con-lai-r1.md` · **prompt tiêm cho agent QC**
* **Vì sao quan trọng:** nếu chấm theo đúng phiếu, QC phải báo **FAIL** cho ba nút «ra 16/17/5 thay vì 0» — tức **báo lỗi cho một việc làm ĐÚNG**. Ngược lại, một QC ít cẩn thận sẽ ghi «PASS: ra 0 như kỳ vọng» **mà không mở màn hình**. **Cả hai đường đều cho PM bức tranh sai.**
* **Bằng chứng tôi tự chạy:**
  * `crm_audit_events` id **122**: `event_type=backfill_tags_vnjb`, `actor_email=backfill-tags-vnjb`, `created_at=2026-08-04T23:41:02Z`. Meta: `{"theSua":42,"themTheoTag":{"vip":1,"Nội":16,"pl:ob":3,"Ngoại":17,"Gia đình TGĐ":5}}` — **`--commit` đã chạy thật**, đúng y bảng dry-run.
  * Đếm tag trên thẻ active: Gia đình TGĐ **5** · Ngoại **17** · Nội **16** · pl:ob **22** · vip **48**. 42 thẻ có `updated_at` trong cửa sổ 23:40–23:45Z.
  * **Trình duyệt thật** (390 px, 0 lỗi JS): Gala (322) **16 · 17 · 5**; Tọa đàm (148) **0 · 0 · 2**. **Tôi đo lại lần cuối lúc 00:33:33Z qua API — y hệt.**
  * `git show 0eebe09:reports/…-r1.md` dòng 58 «F6 dry-run — CHƯA `--commit`», dòng 76 «ba nút lọc … hiện danh sách RỖNG». Phụ lục đính chính chỉ có ở `8c0c870` (06:47:53+07), **sau** `0eebe09` (06:31:15+07).
* **R1 KHÔNG khai gian:** lúc viết `0eebe09` (06:31+07) backfill thật sự chưa chạy (23:41:02Z = 06:41:02+07), và R1 **tự đính chính 6 phút sau**. Gốc lỗi là **phiếu neo tip cũ**.
* **Giảm nhẹ:** file dispatch **gốc trên đĩa đã được PM tự sửa** (dòng 34 nay ghi «F6: sau `--commit` → Nội16 · Ngoại17 · TGĐ5»; dòng 6 ghi «Chạy khi tip prod ≥ `059c54a`»). Chỉ **prompt tiêm** vào agent QC là còn bản cũ.
* **Dữ liệu KHÔNG cần sửa** — tôi đã kiểm toàn vẹn backfill và nó **sạch** (xem bảng AC-F6). Việc phải làm là **thủ tục**: đồng bộ prompt tiêm với tip prod, và ghi mốc `--commit` **23:41:02Z** vào **nhật ký vé** thay vì chỉ nằm trong phụ lục báo cáo của chính người code.

---

### 🟡 MINOR

#### `L-04` · «Lịch sử tại quầy» biến mất khi PG mở lại thẻ — và client **không bao giờ** tự hỏi lại máy chủ

* **Vị trí:** `checkin-gala.html:198-211` @`0eebe09` (= **213-226**) `merge()` · `:412` (= **:449**) `if(!g._enriched)enrich(g,id)` · `:417` (= **:454**) `g._inter=j.interactions` — `checkin-toadam.html` giống hệt (`diff` khối merge = **rỗng**)
* **Cơ chế (tôi xác minh dòng 220 ở tip):** `merge()` chép `_enriched, seat, diet, handler, role, photo, _came, _by` — **bỏ `_inter`**; vì `_enriched` **vẫn true** nên `openPf()` không gọi lại `enrich()`.
* **Tái hiện:** mở thẻ → `_inter=2`, `.qh` hiện → bấm ← chờ `pollBusy===false` → `_inter=undefined`, `_enriched` **vẫn true** → mở lại **đúng thẻ đó** → `.qh = null`, **0 request** tới `/crm/guests/:id`. Mở lần 3: vẫn null, vẫn 0 request. Cả hai cửa.
* **Tôi HẠ major → minor và bác bỏ 2 luận điểm hệ quả của người báo đầu:**
  * ✗ «PG chỉ thấy lịch sử của thẻ ĐẦU TIÊN mở sau mỗi lần tải trang» — **SAI**. Thẻ chưa từng mở có `_enriched=false` và merge chép lại chính false đó; đo: sau 2 vòng merge, mở thẻ mới lần đầu → `_inter=1`, `.qh` hiện, đúng 1 request. **Chỉ thẻ mở LẠI mới mất.**
  * ✗ «PG B không thấy PG A ghi quà → ghi trùng» — **SAI với lỗi này**. PG B là máy khác, mọi thẻ `_enriched=false` → thấy đủ.
  * ✗ «vĩnh viễn» — có 2 đường hồi phục ngoài tải lại trang: `saveQuay()` đặt `_enriched=false` rồi `enrich()` (`:435`) và nhánh tải ảnh (`:360`).
* **Vẫn real:** khối lịch sử hiện rồi **biến mất** khi mở lại thẻ, 0 request đo được; «điểm danh trước, khách đưa quà sau» là thao tác thường ở quầy. Là **mục 5 mock Ly** ⇒ G4 có khiếm khuyết thật, nhưng là **giữ-trạng-thái phía client**, **không mất dữ liệu DB**.
* **Cách sửa (1 dòng × 2 file):** thêm `n._inter=o._inter; n._q=o._q;` vào `merge()`. Nếu không muốn giữ cache thì phải hạ `n._enriched=false`.

#### `L-05` · Poll hỏng thì hỏng **IM LẶNG** — hết phiên hoặc rớt mạng giữa buổi, số đông cứng, không một lời báo

* **Vị trí:** `checkin-gala.html:245` `}catch(e){if(manual)toast(t("rf_fail"),1);}` · `:498-499` `gate()` **chỉ** gọi trong `boot()` · `checkin-toadam.html` cùng dòng · `server/crm/auth.js:12, 133-138, 215`
* **Vì sao quan trọng:** hai máy cùng cửa hiện hai con số khác nhau và **không máy nào biết mình sai** — chính là lời than đã đẻ ra CỬA-4, chỉ đổi nguyên nhân. Tín hiệu duy nhất là dòng **11,2 px màu `rgb(143,136,111)`** ghi **giờ tuyệt đối** — liếc qua «Cập nhật 06:52» trông y hệt số vừa mới.
* **Tái hiện (tôi tự chạy, 00:22:59Z–00:29:29Z, cả 2 cửa, chỉ GET):**
  * Ép `/crm/guests?session=` trả **401**: trong 65 s có **3** vòng poll đều 401 (t+17,3 / 42,3 / 65,1 s), `#upd` **đứng nguyên**, `lastSync` **đóng băng**, cDone/cLeft/cTot không đổi, list vẫn 322 dòng, **0 toast**, `DEAD=false`, **0 lỗi JS**. Bấm ↻ tay MỚI ra 1 toast đỏ.
  * **Đối chứng:** vòng poll LÀNH trước khi chặn đã nhích `lastSync` **+24,8 s** ⇒ chứng minh poll đang sống.
  * Biến thể **RỚT MẠNG** (`route.abort internetdisconnected`): 2 vòng poll rớt, `#upd` đứng, **0 toast**. ⇒ **wifi hội trường chập chờn là đủ, không cần đợi hết 12 h TTL.**
  * `auth.js:12` `SESSION_TTL_MS = 12h`, cấp cứng ở `:215`, `requireCrmAuth` (`:133-138`) chỉ verify, **không gia hạn theo lần dùng** ⇒ PG login 08:00 sáng dựng cửa thì phiên chết ~20:00 **giữa Gala**.
* **Giảm nhẹ (giữ MINOR):** rớt mạng tạm **tự lành** (nối lại 30 s là `lastSync` nhích, `#upd` 07:27 → 07:29); đường **ĐIỂM DANH** vẫn được cứu (`:471-480` có toast 401 «Phiên hết hạn») — chỉ máy dùng để **NGẮM SỐ** mới im. Chữ của AC-CỬA-4 (spec dòng 63) chỉ đòi «poll 20–30 s + visibilitychange + nút ↻» ⇒ bản vá **đạt chữ**; nhưng đúng **mục đích** AC thì đường hỏng đưa trang về đúng trạng thái AC sinh ra để diệt.
* **Cách sửa (không thêm request nào):** trong `catch` của `refresh()` — nếu `e.status===401` → gọi thẳng `gate()` (fail-closed như boot); nếu lỗi mạng → đếm vòng hỏng liên tiếp, từ vòng thứ 2 đổi dòng «Cập nhật …» sang **đỏ** + **giờ TƯƠNG ĐỐI** («cũ 3 phút»), để số cũ **tự tố cáo mình**.

#### `L-06` · 6 khách active hiện «**BÀN N/A**» — chuỗi vô nghĩa chiếm ô to nhất khối nhận diện

* **Vị trí:** `checkin-gala.html:171` (`parseNote` → `o.seat`) · `:338` (`thBox`: `ban=g.table||g.seat`). Hai hàm **y hệt** ở tip hiện tại (diff `0eebe09..059c54a` = 0 dòng đụng).
* **Bằng chứng (SQL read-only 00:08Z + trình duyệt 00:11Z):** active **348** · có `table_no` **119** · note chứa «Số bàn» **6** · có **đồng thời** hai nguồn **0**. Tách giá trị sau «Số bàn (SoT):» → **6/6 đều là chuỗi `N/A`**. Mở rộng cả thẻ xoá mềm: **56/56 cũng là `N/A`** ⇒ trong note **chưa từng** có số bàn thật. 6 id: 31/49/60/90/148/156. Mở 6 hồ sơ trên prod 390 px: `.th` = «BÀN N/A» ở **6/6**, đồng thời thẻ trên list **không** có badge Bàn ở 6/6 (list dùng riêng `g.table`) ⇒ **hai màn nói ngược nhau**.
* **Tôi chỉnh lại 2 điểm của người báo đầu (nghiêng về nhẹ hơn):**
  * «Số bàn **giả**» là **nói quá** — hiện ra là chuỗi `N/A`, **không phải một con số**; PG không thể bị dẫn tới bàn sai.
  * **Không phải rác do gói này sinh ra.** Trước `2a429ab` (`dbe7f7d:checkin-gala.html:218`) khối `.th` vẽ **vô điều kiện** cả hai ô ⇒ 6 thẻ này vốn đã hiện «GHẾ N/A», còn ~204 thẻ không bàn hiện ô BÀN **rỗng**. Gói này **đã bỏ được ô rỗng cho toàn bộ số đó** — cải thiện ròng.
* **Phạm vi hẹp:** 6/348 thẻ, và cả 6 mang tag `trung-ten-can-ra` (bản trùng Ly sẽ gộp) ⇒ **có khả năng về 0 trước lễ**.
* **Cách sửa (1 dòng):** lọc giá trị rỗng nghĩa ngay ở `parseNote`: bỏ qua khi `/^(n\/a|na|-|—|\s*)$/i.test(v)`; hoặc trong `thBox` chỉ nhận `seat` khi khớp `/^\d+/`.

#### `L-07` · Chữ đang gõ mất trắng khi PG **đóng hồ sơ rồi mở lại** thẻ đó

* **Vị trí:** `checkin-gala.html:198-211` (`merge` bỏ `_q`) · `:357-359` (`grabDraft`) · handler `#pfBack` (`:459` ở tip) · `checkin-toadam.html` cùng dòng
* **Tái hiện (00:14:49Z, prod, mọi method ≠ GET bị chặn ⇒ 0 request ghi):**
  * A) gõ 3 ô → ← → mở lại đúng thẻ: `{tang:'', dap:'', note:''}` — **MẤT TRẮNG**.
  * B) gõ → jp → vn → ←: trước ← `_q` đủ 3 ô; sau ← `_q = null`; mở lại **RỖNG**.
  * C) **đối chứng** — gõ → mở **thẳng thẻ khác** (không bấm ←) → quay lại: **GIỮ NGUYÊN** (vì `openPf()` mở đầu bằng `grabDraft()`).
  * D) **cô lập** — gõ → `DEAD=true` (vô hiệu `refresh`/`merge`) → ← → mở lại: **GIỮ NGUYÊN** ⇒ chứng minh **`merge()` đúng là thứ xoá `_q`**.
* **Bổ sung của tôi (làm nặng thêm):** thực tế có **HAI** nguyên nhân chồng nhau. (1) handler `#pfBack` gán `curId=null; refresh();` mà **không** gọi `grabDraft()` trước ⇒ chữ trên DOM chưa bao giờ được cất vào `_q` (đo: lúc đang gõ `_q` vẫn `{"tang":"","dap":"","note":""}`). (2) `merge()` không mang theo `_q` ⇒ bản nháp đã cất bị chính vòng `refresh()` mà nút ← tự kích **xoá sạch**.
* **Vì sao quan trọng:** «mở nhầm thẻ → ← → mở lại» là thao tác **rất thường** ở cửa khi hàng người đang dồn. Chữ mất **im lặng**. Chỉ mất bản nháp tại quầy; **cờ điểm danh và dữ liệu DB không hề hấn**.
* **Cách sửa (2 dòng):** gọi `grabDraft()` trong handler `#pfBack` **trước** khi gán `curId=null`; và thêm `n._q=o._q` (nên kèm `n._inter=o._inter`) vào `merge()`.

#### `L-08` · Khối «đã điểm danh» in **nguyên địa chỉ email** tài khoản nội bộ; và ngay sau khi bấm thì **không hiện ai** điểm danh

* **Vị trí:** `checkin-gala.html:401` @`0eebe09` (= **:438**) `+(g._by?' · '+esc(g._by):'')` — đối chiếu `who()` `:354` (= **:386**) `return String(e||"").split("@")[0];` **đã có sẵn** và đang được dùng ở `histHtml()` cho **đúng loại dữ liệu này**.
* **Tái hiện (00:13–00:16Z, mọi lời gọi `/crm` bị chặn và trả giả, 0 request chạm DB):**
  * API thật `GET /crm/guests?limit=500` (200): 348 dòng, đúng **1** thẻ `checked_in`, `checked_in_by` dài 28 ký tự và **có `@`**.
  * `openPf('248')` → `.cidone .t` = «◯ Đã check-in lúc 18:50 · \<địa chỉ email đầy đủ\>», chuỗi chứa `@` = **True**. ⇒ **VẾ 1 ĐÚNG.**
  * Thẻ chưa check-in: bấm CTA, POST trả **201 giả đúng shape thật** `{ok,already:false,at}` → `.cidone .t` = «◯ Đã check-in lúc 07:20», `_by.length = 0`. ⇒ **VẾ 2 ĐÚNG.**
  * **Nặng hơn mô tả gốc:** `refresh()` có chốt `if(!manual&&(curId||document.hidden))return;` ⇒ đang mở hồ sơ thì poll **tắt hẳn**; ô người điểm danh trống **cho tới khi PG ĐÓNG rồi MỞ LẠI** hồ sơ, không phải «tới vòng làm mới kế tiếp».
* **Tôi PHẢI đính chính phần AC (hạ trọng số):** cụm «kèm tên người điểm danh» **không tồn tại** — grep toàn bộ `specs/` + `briefing/` + `dispatch/` của event-08-08: **không có**. AC-G2 chỉ đòi «nút chính kiểu «Check-in — Khách đã đến» · trạng thái đã đến phản ánh đúng DB». Mock Ly mục 5 «dòng lịch sử actor + timestamp» thuộc **AC-G4**, và chỗ đó R1 làm **ĐÚNG** (`histHtml` dùng `who()`). ⇒ **vế 2 không vi phạm AC nào**, gần như vô hại.
* **Vẫn real vì vế 1 đứng độc lập:** `_by` là thứ R1 **tự thêm ngoài spec**, đang phơi nguyên địa chỉ email nội bộ trên màn **đặt trước mặt khách**, trong khi hàm chuẩn hoá `who()` nằm cách vài dòng trong cùng file.
* **Cách sửa (1 dòng × 2 file):** dùng `esc(who(g._by))` cho hiển thị. (Tuỳ chọn: sau POST 2xx gán `g._by = r.body.by || actor từ /crm/me`.)

#### `L-09` · «Lưu ghi nhận» gặp **401** lại báo chuyện **điểm danh**

* **Vị trí:** `checkin-gala.html:396` @`0eebe09` (= **:428**, tôi xác minh lúc 00:33Z):
  `toast(r.status===401?t("ci_auth"):t("q_fail")+" ("+r.status+")",1);return;}`
  `t("ci_auth")` = «Phiên hết hạn — đăng nhập lại rồi **điểm danh**». `checkin-toadam.html:428` **y hệt**.
* **Tái hiện (prod thật, chặn toàn bộ `/crm/*` ở trình duyệt, khách GIẢ id 999999):** ép `/interactions` trả 401, gõ chữ rồi bấm «💾 Lưu ghi nhận» → toast đỏ = «Phiên hết hạn — đăng nhập lại rồi **điểm danh**». **Đo thêm cái chưa ai đo:** trong cùng phiên ép 401 cho **cả `/check-in`** → **hai thao tác khác hẳn nhau ra hai chuỗi giống hệt nhau từng ký tự** ⇒ PG **không có manh mối** phân biệt.
* **Đây là NGOẠI LỆ duy nhất trong vốn từ của file:** nhánh check-in dùng `ci_fail`/`ci_net` («CHƯA **điểm danh** được»), nhánh lưu dùng `q_fail`/`q_net` («CHƯA **lưu** được»), nhánh ảnh **có** `cam_auth` («…đăng nhập lại **để gửi ảnh**»). Tác giả đã làm đúng cho ảnh, **chỉ sót nhánh lưu ghi nhận**.
* **Tôi đính chính lý do (nhẹ hơn báo cáo gốc):** «thứ vừa mất» là **SAI** — đo `#qTang` sau 401: **vẫn còn nguyên chữ** (`63ca5a8` chỉ xoá ô khi lưu **thành công**). Hậu quả thực = PG đi dò lại điểm danh (thứ đang đúng) mất mấy chục giây ở hàng chờ, **không** phải gõ lại từ đầu.
* **Cách sửa (1 dòng × 2 file):** thêm khoá i18n `q_auth` = «Phiên hết hạn — đăng nhập lại rồi **lưu ghi nhận**» (+ bản JP) cho nhánh 401 của `saveQuay`.

#### `L-10` · **Không có route xoá/sửa** ghi nhận hay ảnh — mọi cú gõ nhầm ở quầy là vĩnh viễn

* **Vị trí:** `server/crm/guests.js` · `server/crm/photos.js` — route xoá **duy nhất** là `guests.js:205 app.delete('/crm/guests/:id', …requireRole('btl'))`
* **Bằng chứng tôi tự chạy:** `grep -rn "app.delete" server/ tools/ *.html` → **đúng 1** kết quả. `grep -rniE "DELETE +FROM +crm_(interactions|photos)|UPDATE +crm_(photos|interactions)"` → **RỖNG**. 9 mũi thăm prod (đường thất bại, an toàn): `DELETE|PATCH|PUT /crm/guests/1/interactions/1`, `DELETE|PATCH /crm/interactions/1`, `DELETE|PATCH /crm/photos/1`, `DELETE /crm/guests/1/photos/1`, `DELETE /crm/guests/1/check-in` → **404 cả 9**; đối chứng `GET /crm/me` → 200. `.undo` (`:112`) và chuỗi «Huỷ check-in» là **mã chết** — không nút nào render.
* **Bằng chứng mạnh hơn báo cáo gốc:** `crm_interactions` còn **1** dòng nhưng `crm_interactions_id_seq.last_value = 7`; `crm_audit_events` có `interaction_create` = **7** và **0** sự kiện xoá/sửa ⇒ 6 dòng tạo qua ứng dụng (có audit) rồi biến mất **không để lại một dòng audit nào** — chỉ có thể gỡ bằng **SQL tay trên prod, ngoài mọi vết kiểm toán**.
* **Vì sao quan trọng:** gói này vừa mở một **đường GHI mới cho vai `staff`** (`POST /interactions` chỉ có `requireCrmAuth`, **không** `requireRole`; `auth.js:136` mặc định role `staff`) trên thẻ khách thật, **3 ngày trước sự kiện**, mà **không mở đường lùi nào**.
* **Tôi trừ điểm quy chiếu AC (giữ minor):** ngưỡng PASS của AC-G4 là «persist thật» — ngưỡng đó **ĐẠT**; spec **chưa bao giờ** đòi route xoá/sửa, lại dặn «cấm invent schema im lặng» ⇒ R1 dừng-và-báo là **đúng quy trình** (R1 tự nêu ở `reports/2026-08-05-…-r1.md:111, :126`). Đây là **rủi ro vận hành ĐÃ KHAI BÁO**, không phải AC fail.
* **Cách sửa:** trước 08/08 tối thiểu thêm `DELETE /crm/guests/:id/interactions/:iid` (role `btl`, ghi audit) để BTL dọn được từ `/crm`; **hoặc** chấp nhận rủi ro nhưng **ghi vào runbook cửa**: «gõ xong đọc lại rồi mới bấm Lưu; **không bấm lại khi báo lỗi**».

#### `L-11` · Toast lỗi ảnh in **nguyên văn tiếng Anh** của máy chủ («upload error») thay vì câu tiếng Việt đã soạn

* **Vị trí:** `checkin-gala.html:322` @`0eebe09` (= **:354**) `toast(e.error||t("cam_fail"),1)` · `server/crm/photos.js:54` `error:'upload error'`
* **Tái hiện (chặn ở trình duyệt, 0 request tới máy chủ, id 999999999):** ép **500** + đúng thân JSON prod → `#ciToast` = **`upload error`**, `class="ci-toast bad"`. Hook `window.toast` cho thấy chuỗi truyền vào là `['upload error', true]`, `cam_fail` **không bao giờ** được gọi. **Đối chứng** 500 thân rỗng → toast = «Không lưu được ảnh» ⇒ chứng minh chính `e.error||` là thứ nuốt chuỗi Việt.
* **Ca thực tế hơn ca 500:** `checkin-toadam.html:354` ép **404** `{"error":"not found"}` → toast = **`not found`**. Thẻ bị xoá mềm giữa ca (Ly xoá 30 thẻ 15:56Z) mà PG còn giữ trong list đã nạp → bấm chụp ảnh → màn ra «not found».
* **Ca 500 không phi thực tế:** `storage.isConfigured()` (`storage.js:28`) chỉ kiểm env var **có mặt** ⇒ MinIO **CHẾT** vẫn qua cửa 503 rồi rơi vào try/catch → 500 «upload error». Prod vừa có đúng sự cố đó (`d23b0a0`).
* **Hai điểm trừ của phát hiện (không đủ để lật):** ca **503** trả «Kho ảnh (MinIO) chưa cấu hình.» — **tiếng Việt, rõ nghĩa** (đó là ca `e.error` làm TỐT); ca **400** («Ghi nhận không thuộc khách này.») cũng tiếng Việt và **tốt hơn** `cam_fail`. Vấn đề hẹp hơn nhưng có thật: **3 chuỗi Anh còn sót** trên máy chủ (`upload error`, `not found`, `bad id`) lọt thẳng ra màn PG.
* **Cách sửa (1 dòng):** `toast((r.status>=500 ? t("cam_fail") : (e.error||t("cam_fail")))+" ("+r.status+")",1)` — hoặc chỉ nhận `e.error` khi có cờ đã Việt hoá.

---

### ⚪ INFO — không chặn Gate 2

#### `L-12` · **13 khoá i18n thiếu ở từ điển JP** — đúng lúc lỗi thì màn tiếng Nhật rơi về tiếng Việt

* **Vị trí:** `checkin-gala.html:156` (`T.jp`) · `checkin-toadam.html:156` · hàm dịch `:168` `var s=(T[LANG]&&T[LANG][k])||T.vn[k]||k;`
* **Bằng chứng (00:06–00:08Z):** `curl` hai trang từ prod rồi `diff -q` với repo → **khớp tuyệt đối** (50 451 B / 50 404 B). Parse biến `T`: `T.vn` **66** khoá, `T.jp` **53**, thiếu đúng **13**: `ci_fail, ci_auth, ci_404, ci_net, cambtn, pickbtn, cam_up, cam_ok, cam_fail, cam_net, cam_auth, cam_notimg, cam_heic`. Giống hệt ở cả hai cửa.
* **Cả 13 đều là mã SỐNG:** hai nút ảnh ở `:399-400` (nằm **ngay trong** `quayHtml()`), toast check-in `:474`/`:480`, toast ảnh `:332-333`/`:361`.
* **Tái hiện trong trình duyệt trên chính bundle prod** (stub toàn bộ `/crm/*` bằng khách GIẢ, abort tuyệt đối mọi đường ghi ⇒ **không đọc và không ghi thẻ khách thật**): bấm 日本語 → `html.lang="ja"`, `.quay h4` = 「受付での記録」, nhãn = 「ゲスト写真」, CTA = 「◯ チェックイン(ご来場)」 — **nhưng ba nút camera trong CÙNG khối** là `["📷 Chụp ảnh khách", "📁 Thêm hình từ thiết bị", "📷 贈り物を撮影"]`. **Hai nút Việt, một nút Nhật, cạnh nhau.** Gọi `t()` với `LANG=jp`: **13/13** trả về tiếng Việt.
* **Không phải lỗi gói này:** `git log -S` → 13 khoá VN-only sinh ra ở `1fa2ead` (AC-C, vé trước); khoá mới của gói này (`q_camqua`…, `2a429ab`) đều **có bản JP đầy đủ**.
* **Điều kiện không phi thực tế:** màn JP là đường đi hạng nhất (nút 日本語 ở header, bộ lọc 🎌, trường `name_jp`/`title_jp`/`org_jp`, spec có riêng AC-E4/G) và ngôn ngữ **nhớ qua `localStorage ci_lang`** ⇒ lễ tân bật một lần là **dính cả buổi**.
* **Cách sửa (~10 phút):** bổ sung 13 khoá vào `T.jp`; nếu không kịp thì ghi runbook «màn JP chỉ dịch phần nhãn».

#### `L-13` · **Smoke mù tuyệt đối với hai trang cửa** — cửa hỏng hoàn toàn mà mọi phép kiểm vẫn xanh

* **Vị trí:** `tools/smoke-crm.js` · `tools/smoke-crm-ui.py`
* **Bằng chứng tôi tự chạy (00:07–00:12Z):** `git log 0eebe09..HEAD -- tools/` **RỖNG** ⇒ phát hiện không hề cũ. `grep -c "checkin\|session="` = **0 và 0**. Mọi path `smoke-crm.js` chạm: `/crm`, `/crm/classic`, `/crm/me`, `/crm/guests`, `/crm/guests/1`, `/crm/guests/999999999`, `?limit=1`, `?limit=1000`, `/crm/stats`, `/crm/photos/1`, `/crm/audit`, `/crm/audit/export.csv`, `/crm/import` — **không có** `checkin-gala.html`, **không có** `checkin-toadam.html`. `smoke-crm-ui.py` chỉ `page.goto(BASE + "/crm")` (`:62`).
* Tôi đọc hết tên **43 phép kiểm**: 20 AC-1 (401/login), 5 AC-2, 5 AC-3, 7 AC-4, 6 AC-5 — **không một phép nào** nói về cửa. Prod đang phục vụ cả hai cửa (200 · 50 451 B và 200 · 50 404 B) ⇒ **bề mặt sống**, không phải file chết.
* **Tôi dựng máy chủ giả riêng** (chỉ ĐỌC file từ repo, không chạm prod) và lái bằng Playwright: `rows:[]` → 0/0/0, «Tổng 0 khách Gala», **0 pageerror**, trang **không** gate; `name_jp` toàn null → tìm 「千葉」 ra **0**, stick 🎌 tụt 40→0, **0 pageerror**. ⇒ mọi phép kiểm kiểu «trang lên · không lỗi JS» đều **XANH trên một cửa rỗng ruột**.
* **Bằng chứng mạnh hơn:** cửa lấy dữ liệu bằng `/crm/guests?session=gala&limit=1000` (`checkin-gala.html:236, 499`), smoke chỉ gọi `?limit=1000` ⇒ **tham số `session=` chưa bao giờ được smoke chạm tới**. Vùng còn hở: lọc theo buổi, stick đếm, tìm kanji, avatar ở cửa, poll 25 s/CỬA-4, khối quầy G4 — **đúng những thứ gói này vừa viết lại gần trọn 2 file 50 KB** rồi chấm mốc bằng «PASS 43/43» vốn không nói một chữ nào về cửa.
* **Tôi trừ hao (không đủ để lật):** kịch bản `rows: []` nếu xảy ra **thật** trên prod thì smoke **SẼ** bắt, vì `/crm` và cửa dùng chung backend (AC-2/AC-4/AC-5 đều sập). Câu «cửa hỏng hoàn toàn mà mọi phép kiểm vẫn xanh» hơi rộng nếu hiểu là **sự cố dữ liệu**; phần lõi (lỗ hổng **vùng phủ**) vẫn đứng.
* **Cách sửa (vé riêng, ~30 s chạy, 5 khẳng định):** `/checkin-gala.html` + `/checkin-toadam.html` lên **200** · `G.length > 0` và khớp `/crm/guests?session=` · số avatar khớp `photo_url` của API · **0 pageerror** · nút ↻ sinh **đúng 1** request.

#### `L-14` · Badge `VIP2 - HÀNG 3` (tag di sản `tgd116`) hiện nguyên chữ Việt ngay cả khi UI là 日本語

* **Vị trí:** `checkin-gala.html:163` (`vipOf`) · `:166` (`hangOf` `.toUpperCase()`) · `:272` (`badges()` đẩy thẳng ra **không qua `t()`**, trong khi `b_noi`/`b_ngoai`/`b_tgd`/`b_jp` **đều** qua `t()`) · `crm-app-v2.html:374` (`vipLbl()` lặp lại y logic)
* **Bằng chứng:** SQL read-only — có **12** thẻ mang tag `VIP2 - Hàng 3`, **11 đã xoá mềm**, **đúng 1 thẻ còn sống** (id 156), có tag `gala` ⇒ nằm trong list cửa Gala **mặc định**. Trình duyệt prod: UI **vn** badge = «VIP2 - HÀNG 3»; bấm 日本語 (header đổi 「受付 · ガラ」, các badge khác đã dịch `{内:16, 外:17, 社長ご家族:5, 🎌 日本:63}`) → badge thẻ 156 **VẪN** = «VIP2 - HÀNG 3». Hồ sơ ở UI jp: pill = 「ランクVIP2 - HÀNG 3」. **CSV xuất thật** ở UI jp: 348 dòng, cột «Hạng VIP» = `{"": 299, "VIP": 48, "VIP2 - HÀNG 3": 1}`.
* **Sắc thái (làm nhẹ «vì sao quan trọng»):** file CSV **vốn đã** đầy tiếng Việt khi UI là 日本語 — toàn bộ header (`Họ tên`, `Đơn vị`, `Chức danh`…) và cột «Trạng thái» (`Chưa đến`/`Đã đến`, đo 347/1) **đều không dịch**; chỉ cột «Buổi» có dịch. Nên «file xuất cho đối tác Nhật có **một** ô tiếng Việt» là **quá lời** — ô đó là một trong rất nhiều chỗ VN. Ngoài ra `VIP2 - Hàng 3` là **nhãn hạng ghế di sản**; AC-F2 chỉ đòi chuẩn hoá `vip` thành HOA, AC-F5 chỉ đòi **CÓ** badge hạng — **không AC nào đòi dịch chuỗi hạng sang JP**.
* **Cách sửa (không cần đụng mã):** sửa tag của thẻ id 156 trên `/crm` thành `vip` và chuyển «Hàng 3» sang trường ghế/bàn. Nếu muốn đụng mã: thêm khoá i18n `VIP2 - Hàng 3` → 「VIP2・3列目」.

#### `L-15` · Trả lời câu hỏi của phiếu: **«để nút lọc rỗng ở cửa có chấp nhận được không»** — câu hỏi đã bị mã trả lời giữa lúc tôi đo

* **Vị trí:** `checkin-gala.html` (`quickCounts`, `.qn`) · `checkin-toadam.html`
* **Ý kiến của tôi với tư cách người đứng ngoài: cách hiện tại ĐÚNG.** Hiển thị «**0**» nói «cửa này **không có ai** thuộc nhóm đó» — khác hẳn nút bấm vào rồi im. **Ẩn nút khi bằng 0 sẽ TỆ HƠN**: hai cửa có bộ nút khác nhau, PG **chuyển ca giữa hai cửa** sẽ đi tìm một nút không tồn tại.
* **Bằng chứng:** ở `0eebe09` grep `quickCounts`/`.qn` = **0** trên cả hai trang ⇒ mô tả «đầu phiên nút ra rỗng mà không có số» khớp lịch sử. `c494c75` gộp luật lọc vào **MỘT** hàm `quickOk()` dùng chung cho `match()` và `quickCounts()` ⇒ số trên nút **không thể** lệch danh sách nút mở ra. Hai số **0** ở Tọa đàm mang class `qn zero`, vẫn hiển thị 18 px, không ẩn, không cắt mép.
* **Sắc thái duy nhất, nên ghi cho PG:** stick đếm **trên tập buổi**, **cố ý không trừ** theo ô tìm/nút ĐÃ ĐẾN — gõ «a» rồi bấm ★VIP ở Gala cho stick **44** vs danh sách **43**. Đây là thiết kế ghi rõ trong commit message.
* **Lưu ý:** phần mã này (`c494c75`, `059c54a`) **chưa từng qua QC độc lập nào** ngoài spot-check của tôi — hệ quả trực tiếp của `QC-01` (prod chạy nhanh hơn giấy tờ).

#### `L-16` · **Vận hành/bí mật:** token `CRM_SMOKE_BEARER` bị Playwright in nguyên văn ra log lỗi

* **Vị trí:** **môi trường QC** — *không phải mã trong repo*
* **Cơ chế:** `playwright/_impl/_connection.py:559` `rewrite_error(error, f"{apiName}: {error}")` — call log của `Route.fetch` / `APIRequestContext` gắn kèm **toàn bộ header request đi ra**, **không lọc `Authorization`**.
* **Tái hiện (token **GIẢ** có chuỗi mốc, server HTTP giả trên `127.0.0.1` — **không dùng token thật, không chạm prod**): 3/3 ca lộ nguyên văn — (A) `route.fetch()` đang bay thì `ctx.close()`; (B) `route.fetch(url=…)` tới cổng chết (**chỉ cần một lỗi mạng thường**); (C) `APIRequestContext.dispose()` giữa lúc fetch. Cả ba: `SENT in traceback_text` → **True**.
* **Đối chứng quan trọng — repo KHÔNG có lỗi:** ca (D) chạy **đúng mã repo** (`route.continue_` + `page.goto networkidle timeout`, mẫu của `tools/smoke-crm-ui.py:40-58`) thì call log chỉ có «navigating to "…"», **không có header**, và `str(exc)[:300]` ở `:96` cũng không dính token.
* **Tác động (kiểm lại, không thổi phồng):** `auth.js:123` cấp role `staff`; `guests.js:220 app.post('/crm/guests/:id/check-in', requireCrmAuth, …)` **không** có `requireRole('btl')` ⇒ token thật sự **POST check-in được**, và đọc được danh sách khách kèm PII. **Không** xoá được khách (DELETE là btl-only, `guests.js:205`).
* **Độ mới:** vòng trước đã cảnh báo token nằm **trên đĩa** (`reports/2026-08-04-d028-cum-cua-gate2.md`, mục i6). Vector **transcript** là MỚI và nặng hơn: **file thì xoá được, bản ghi phiên thì không**.
* **Cách sửa:** **xoay `CRM_SMOKE_BEARER`** trên Railway (service `esuhai-web`) — trước 08/08 thì tốt hơn (đặt biến rỗng là kill-switch theo `auth.js:79-81`). Với phiên QC sau: chạy Playwright kèm `2>/dev/null`, hoặc gắn `Authorization` bằng `context.route()` thay vì `extra_http_headers`.

---

## 4. Đã thử phá mà không phá được

> Đây là phần tôi **cố ý đi tìm lỗi và thất bại** — giá trị của nó ngang phần lỗi tìm được.

### CỬA-4 / đồng bộ trạng thái
1. Ép `/crm/guests` **chậm 8 s** rồi bấm check-in giữa chừng (`pollBusy=true` lúc bấm), cố làm vòng poll cũ đắp dữ liệu chụp **TRƯỚC** lên và xoá dấu «đã đến» — **`mutSeq` chặn đúng**: dấu giữ nguyên, cDone giữ nguyên; sau khi đóng hồ sơ chạy tiếp 12 s poll THẬT thẻ vẫn `gc done`.
2. Cố làm thẻ **tự lật ngược** «đã đến» → «chưa đến» bằng cách cho máy chủ trả bản ghi chưa điểm danh sau khi máy đã đánh dấu — `merge()` **chỉ bật lên không hạ xuống**. Đối chiếu server: **không có route huỷ check-in** ⇒ luật một chiều là **đúng**, không phải giấu lỗi.
3. Cố làm PG **mất chữ đang gõ** ở ô tìm: gõ rồi ép một vòng poll trả về có thay đổi thật → chữ, focus, caret `[2,2]` đều nguyên, số kết quả không nhảy.
4. Cố làm **trang chết vẫn gõ máy chủ**: ép `/crm/me` 401 → `gate()` dựng cờ `DEAD`, 40 s sau **0 request**, **0 lỗi JS**. Không tìm được đường nào lách cờ `DEAD`.
5. Cố bắt **poll chạy lén khi hồ sơ đang mở**: 32 s với `.pf.show=true` → **0 request**.
6. Cố bắt **tab nền vẫn poll**: ghi đè `document.hidden` + dispatch event, 40 s → **0 request**; sáng lại bù trong 3 s.
7. Cố bấm nút ↻ và nút 日本語 **trong lúc hồ sơ đang mở** (ép poll chạy dưới tay PG): **không chạm tới được** — lớp `.pf` phủ kín màn, Playwright báo `.pf-bar` chặn con trỏ.
8. Cố bắt **thẻ trượt** khi KHÔNG bật lọc (3 ca điểm danh từ máy khác): dịch **0 px**, điểm chạm cũ vẫn ra đúng thẻ.

### E-1 / tìm kiếm kanji
9. Cố tìm khoá kanji làm ô tìm ở cửa **lệch** so với `/crm`: thử thêm 4 khoá tự chọn (株式会社 · 代表 · 社長 · 部長) ngoài 4 khoá bắt buộc, ở **cả hai ngôn ngữ UI** — **cả 8 khớp từng số** với phép tính lại độc lập trên JSON thô. Không bắt được vế nào của `norm()` (NFD, bỏ U+0300–U+036F) làm hỏng dakuten.

### AC-F / tag
10. Cố bắt backfill 23:41Z **gán đè cả mảng tag** (điều AC-F6 cấm): 42 thẻ đổi, **min 5 / max 10** tag mỗi thẻ, 41/42 giữ `vnjb`, 41/42 giữ `pl:*`, 38/42 giữ tag buổi, 0 thẻ mất `full_name`/`name_jp` — **không tìm được dấu vết gán đè**. Đọc mã: `SET tags = $2` nhưng `$2` = `[...new Set(tagArr(p.tags).concat(p.add))]` lấy từ hàng đã khoá `FOR UPDATE` ⇒ **merge thật**.
11. Cố bắt backfill **chạm thẻ đã xoá mềm** hoặc **phá tag buổi**: **0** thẻ `deleted_at IS NOT NULL` có `updated_at` rơi vào phút 23:41; tổng hai cửa 322/148 **trước và sau** không đổi; `khong-du` 13 và `chua-ro-buoi` 11 nguyên vẹn.
12. Cố bắt backfill làm **lệch số buổi** (AC-A): `du_*` = `?session=` = KPI, **0 lệch** cả hai buổi.
13. Ép **`Gia đình TGĐ` lọt vào `Nội`** (Sponsor cấm gộp): 7 giá trị thật + **38 biến thể bẩn tự nghĩ** — `GIA ĐÌNH TGD`, `gia dinh tgd`, `Gia đình TGD`, thừa dấu cách, và ca hiểm nhất **`Gia đình TGĐ - Nội`** → tất cả chỉ ra `["Gia đình TGĐ"]`. Trên 332 dòng SoT thật: **0 dòng lọt**.
14. Ép **`Ngoại` bị nuốt bởi `Nội`** hoặc ngược lại: gạch dài U+2013, thiếu/thừa dấu cách, viết HOA — đều đúng. Thứ tự xét `ngoai` **trước** `noi` là an toàn vì `\bnoi\b` không khớp trong «ngoai».
15. Ép **chữ thường `vip`** lòi ra màn: quét regex trên innerText list 2 cửa + toàn body `/crm` + `/crm/classic` + cột CSV tải thật — **0 chỗ**. Kiểm mã: **không nơi nào** render mảng tag thô ra DOM.
16. Ép **chênh lệch luật VIP** giữa cửa (`/^V?VIP/i` có neo) và `/crm` (`/vip/i` không neo): đếm ba luật trên cùng tập active — **49 = 49 = 49**, không thẻ nào rơi giữa hai luật.
17. Ép **stick đếm nói khác danh sách nó mở ra**: 5/5 nút × 2 cửa đều khớp — `quickOk()` dùng chung nên **không tách được** hai luật.
18. Ép **`codeOfParts()` lệch sau khi tách module** (đường tạo 259 thẻ trùng): so với bản chép nguyên từ `import-vnjb.js@28c53ce` trên **toàn bộ 332 dòng SoT** → **0 lệch**; sinh lại mã từ workbook khớp **259/259** `guest_ext_id` prod.

### Layout / badge
19. Ép **badge làm hỏng layout list**: 320/360/390 px × 2 cửa, **trước và sau** khi 38 badge họ hàng xuất hiện. Thẻ nhiều badge nhất chỉ 2 badge (**0** thẻ ≥3), `.bgs` không tràn, mép phải badge luôn trong lòng thẻ, `.bgs top ≥ .n1 bottom` ⇒ **0** thẻ badge đè tên.
20. Ép hàng tiếng Nhật **`.pv-sub` co về 0 px** (lỗi đã xảy ra ở `/crm`): 238 + 151 + 243 phần tử ở 320/360/390 và thêm 1280 px — **0 hàng nào dưới 1 px**, thấp nhất **13,92 px**.
21. Ép **tràn ngang**: 2 cửa × 3 bề ngang × 2 ngôn ngữ, cả khi lớp hồ sơ đang mở, cả tên JP dài và chức vụ 3 dòng — `scrollWidth == clientWidth` **mọi lần**.
22. Ép **AC-E4 đảo sai thứ tự**: đổi ngôn ngữ qua lại nhiều lượt, list + hồ sơ, 2 cửa — luôn đúng; thiếu một phía thì chỉ hiện phía có dữ liệu, **không có hàng trống**.

### AC-G / quầy · ảnh
23. Ép **«Lưu ghi nhận» báo xanh giả**: 500 · 401 · 404 · mất mạng → **4/4 toast ĐỎ**, **0** toast xanh, nút bật lại, chữ giữ nguyên. `r.ok` **được kiểm thật**.
24. Ép **CTA điểm danh đánh dấu «đã đến» khi máy chủ từ chối**: 500 · 401 · 404 · mất mạng → `.cidone` **không dựng lần nào**, bộ đếm giữ 1, thẻ không chuyển `done`.
25. Thử **chôn toast dưới lớp hồ sơ** (lỗi R1 nói đã vá): 4 loại toast, mỗi lần đổi **26k–48k pixel**, `elementFromPoint` trả về **chính toast**. Không dựng lại được ca «không đổi một pixel nào».
26. Thử làm **ảnh quà chiếm chỗ avatar khách bằng đường client**: client gửi `interaction_id` kèm form-data (bắt được trong request), và cả list lẫn detail đều lọc `interaction_id IS NULL` (`guests.js:80-88, :128-130`) ⇒ **không dựng được cảnh đó ở cửa**. *(⚠️ Nhưng dựng được ở `/crm` — thành `L-01`.)*
27. Cố **tuồn `interaction_id` của khách khác** vào ảnh: id bịa · id có thật của khách khác · id lai chữ `'1abc'` · id 0 — **cả bốn 400 trước khi chạm MinIO**; đếm lại `crm_photos` vẫn **202/0**.
28. Cố làm **mất ảnh đại diện** vì điều kiện mới `AND ph.interaction_id IS NULL`: so **3 nguồn độc lập** (SQL / API / DOM 4 màn) trước-sau → đều **165**; chênh so với mốc 188 giải thích trọn bằng 23 thẻ Ly xoá mềm. Cũng kiểm **không có `UPDATE crm_photos`** ở đâu ⇒ ảnh chân dung cũ **không thể** bị gắn `interaction_id` về sau.
29. Tìm **ràng buộc DB** có thể làm đường THÀNH CÔNG của G4 gãy: `kind` là text NOT NULL default `'khác'`, **không** CHECK/enum; FK `ON DELETE SET NULL` đã có ⇒ **không cần migration**.
30. Thử làm **bản nháp mất** qua ba đường phiếu nêu (điểm danh · `enrich()` trả về · đổi ngôn ngữ) — **không đường nào** làm mất. *(Chỉ vỡ ở đường thứ tư — `L-07`.)*
31. Tìm khách **bị MẤT số bàn** sau khi gộp seat→bàn: SQL **0** thẻ có đồng thời `table_no` và «Số bàn» trong note; 119 thẻ có số bàn thật vẫn hiện đủ.

### Regress / hồi quy cũ
32. Cố tìm **nút điểm danh còn sót** trên `/crm` / `/crm/classic` bằng cách giả role `btl`: **0 nút, 0 `#ciBtn`**; chỉ còn `var ciBtn=$("#ciBtn")` là **mã chết vô hại**.
33. Cố tìm **`imgFit is not defined`**: cả 4 màn đều phơi `window.imgFit`; 6 phiên trình duyệt trên prod ở 320/390/1280 → **0 pageerror, 0 console error**.
34. Cố làm **avatar list so le**: `/crm` **348/348** ô đúng 48×48; hai cửa 46×46. Class `.landscape` có bị gắn lên vài ảnh list nhưng **CSS chỉ có luật cho `.pf-av`/`.thumbs`/`.dav`** ⇒ vô hại.
35. Cố tái tạo lỗi chỉ số tham số kiểu **`tags = $7`**: `PATCH` dựng `$${params.length}` **động**, không có chỗ nào đếm tay.
36. Cố tìm phép kiểm **«in ok mà không kiểm gì»** trong smoke: **27 lời gọi `record()` đều có biểu thức so sánh thật**, không có `record(..., true)`. ⇒ vấn đề của smoke **không phải** khẳng định rỗng mà là **PHẠM VI** (`L-13`).

---

## 5. Ba câu cho Sponsor

### (a) Có nên GO `--commit` tag không?

**Câu hỏi đã hết hiệu lực — việc đã xong và tôi xác nhận nó SẠCH.**

Backfill `--commit` **đã chạy lúc 23:41:02Z 04/08** (audit id 122, actor `backfill-tags-vnjb`, meta `{"theSua":42,…}`). Ba nút lọc ở cửa **đang ra số thật**: Gala **Nội 16 · Ngoại 17 · GĐ TGĐ 5** · Tọa đàm **0 · 0 · 2** (tôi tự đo lại lần cuối **00:33:33Z 05/08**).

Tôi đã kiểm **toàn vẹn** của lượt ghi đó và **không tìm được vết bẩn nào**: merge thật chứ không gán đè (min 5 / max 10 tag mỗi thẻ), 41/42 giữ `vnjb`, 41/42 giữ `pl:*`, 38/42 giữ tag buổi, **0** thẻ mất `full_name`, **0** thẻ mất `name_jp`, **0** thẻ xoá mềm bị chạm, AC-A vẫn **0 lệch**, và chạy lại dry-run cho **«thẻ SẼ SỬA: 0»** ⇒ **idempotent**.

> **Việc anh cần làm không phải quyết GO nữa, mà là quyết một câu THỦ TỤC:** ghi mốc `--commit` **23:41:02Z** vào **nhật ký vé** thay vì để nó nằm trong phụ lục báo cáo của chính người code, và **đồng bộ prompt tiêm cho QC với tip prod**. Nếu không, vòng QC sau lại chấm bằng tiền đề cũ và sẽ **báo FAIL cho một việc làm đúng** (`QC-01`).

**Riêng câu «để nút lọc rỗng ở cửa có chấp nhận được không»:** ý kiến của tôi với tư cách người đứng ngoài — **cách hiện tại đúng, đừng đổi**. Hiển thị «0» nói «cửa này không có ai thuộc nhóm đó»; **ẩn nút khi bằng 0 sẽ tệ hơn** vì hai cửa sẽ có bộ nút khác nhau và PG chuyển ca sẽ đi tìm một nút không tồn tại. Hai số 0 ở Tọa đàm đang hiện đúng (class `qn zero`, 18 px, không ẩn, không cắt mép).

### (b) Đường THÀNH CÔNG của «Lưu ghi nhận» chưa đo được — cần anh chỉ định một thẻ?

**Có. Đây là khoảng trống lớn nhất còn lại của Gate 2 này, và tôi đề nghị anh chỉ định.**

Hiện trạng đo được: `crm_interactions` đúng **1 dòng** (từ 27/07), `crm_photos` **202 dòng / 0 có `interaction_id`**, `kind='anh-qua'` = **0** ⇒ **đường AC-G4 chưa ai đi trên prod**. Tôi đã đo trọn **shell + payload + toàn bộ đường LỖI** (500/401/404/mất mạng → 4/4 dừng đúng), và đã chứng minh **DB không chặn** (`kind` là text tự do, FK đã có, không cần migration). Nhưng **đường thành công thật, đầu-tới-cuối, chưa ai chạy** — và ba lỗi nặng nhất của báo cáo này (`L-01` · `L-02` · `L-03`) đều nằm **đúng trên đường đó**.

**Đề nghị cụ thể — nếu anh cho phép, xin theo đúng thứ tự này:**
1. Anh chỉ định **1 thẻ khách nội bộ** (ví dụ một thẻ nhân viên Esuhai, **không phải khách VIP/đối tác**), hoặc cho phép tạo **1 thẻ giả** rồi xoá mềm sau.
2. Người được uỷ quyền chạy đúng **4 bước**: lưu ghi nhận đủ 3 ô → chụp 1 ảnh quà → **mở `/crm` xem avatar có bị thế chỗ không** (đây là bằng chứng quyết định cho `L-01`) → đóng/mở lại hồ sơ ở cửa xem lịch sử còn không (`L-04`).
3. **Dọn bằng SQL tay** ngay sau đó và **ghi lại vào nhật ký vé** (vì `L-10`: không có route xoá, và tôi đã đo được **6 dòng interaction từng bị gỡ mà không để lại một dòng audit nào**).

Nếu anh **không** cho phép: tôi tôn trọng, nhưng xin ghi vào GO rằng **đường thành công của AC-G4 sẽ được chạy lần đầu tiên bởi PG thật, giữa buổi lễ, trên thẻ khách VIP thật** — và ba lỗi `L-01`/`L-02`/`L-03` nằm đúng ở đó.

### (c) Nợ nào chặn cửa ngày 08/08, nợ nào hoãn được?

| | Nợ | Chi phí | Vì sao |
|---|---|---|---|
| 🔴 **PHẢI vá trước 08/08** | **`L-01`** — ảnh quà thế chỗ mặt khách trên `/crm` + `/crm/classic` | **2 dòng**, cùng luật đã có ở cửa và ở SQL list | Nổ **ngay lần đầu** PG bấm «Chụp ảnh quà»; không có route xoá ảnh để lùi; hỏng đúng màn BTL dùng đối chiếu người thật. **Không phép kiểm nào hiện tại bắt được.** |
| 🔴 **PHẢI xử trước 08/08** *(vá mã **hoặc** vào runbook)* | **`L-02`** báo đỏ giả → ghi trùng · **`L-03`** dòng mồ côi + 2 dòng cho 1 quà | Vá mã: 1 endpoint gộp hoặc ~10 dòng. Runbook: 2 câu | Không có đường lùi (`L-10`); hậu quả đọng **vĩnh viễn** trên thẻ VIP; chị Thúy Hà đối soát quà sau lễ sẽ **đếm sai**. Nếu không kịp vá, runbook **bắt buộc** phải ghi: «gõ xong đọc lại rồi mới bấm Lưu; **KHÔNG bấm lại khi báo lỗi** — báo BTL kiểm DB». |
| 🟠 **Nên làm trước 08/08 nếu còn giờ** | `L-05` poll hỏng im lặng (đổi dòng «Cập nhật» sang đỏ + giờ tương đối, và 401 → `gate()`) · `L-09` câu 401 sai (thêm khoá `q_auth`) · `L-12` 13 khoá JP | mỗi mục **1–2 dòng × 2 file**, ~10 phút cả cụm | Rẻ, độc lập nhau, không đụng đường dữ liệu. `L-05` là thứ khiến hai máy cùng cửa nói hai con số khác nhau — đúng lời than đã đẻ ra CỬA-4. |
| 🟠 **Vận hành, trước 08/08** | **`L-16`** xoay `CRM_SMOKE_BEARER` | 1 lệnh Railway | Token mở toàn bộ `/crm` vai `staff`, **POST check-in được**, đọc được PII; đã lộ vào transcript phiên QC — **file thì xoá được, bản ghi phiên thì không**. Hai vòng QC liên tiếp cùng chỉ về một hành động. |
| 🟡 **Hoãn được sau lễ** | `L-04` `_inter` · `L-07` `_q` (nên vá **chung một lần** với `L-04`, cùng gốc `merge()`) · `L-06` «BÀN N/A» · `L-08` in email · `L-11` chuỗi Anh · `L-14` badge VIP2 | | Đều **không mất dữ liệu DB**, không sai số điểm danh/KPI. `L-06` còn **có khả năng tự về 0** trước lễ (cả 6 thẻ mang tag `trung-ten-can-ra`, bản trùng Ly sẽ gộp). `L-08` sửa 1 dòng thì nên gộp vào cụm 🟠. |
| 🟡 **Vé riêng, sau lễ** | `L-10` route xoá interaction (role `btl` + audit) · `L-13` smoke cửa (5 khẳng định, ~30 s) | | `L-10` là **rủi ro vận hành đã khai báo**, không phải AC fail — R1 dừng-và-báo là đúng quy trình. `L-13` là lỗ hổng **vùng phủ**, đáng làm nhưng không chặn lễ. |

---

## 6. Một câu §B7

> Gói này **đạt** — E-1 lật được FAIL cũ, CỬA-4 chứng minh bằng request thật chứ không bằng runbook, tag backfill sạch không một vết gán đè, và mọi đường **LỖI** đều dừng đúng; nhưng **mọi con số xanh hôm nay đều đo trên một đường THÀNH CÔNG chưa ai từng đi**, nên trước 08/08 xin vá `L-01` (2 dòng — nếu không, ảnh hộp quà sẽ thành mặt khách trên màn BTL ngay lần bấm đầu tiên) và chốt cách xử `L-02`/`L-03`, vì ở cửa **không có đường lùi**.

---

### Vệ sinh phiên

* **Read-only tuyệt đối:** không sửa file, không commit, không deploy, không ghi DB. `git status` **sạch**, HEAD vẫn `6c55c19`.
* Mọi SQL bọc `BEGIN TRANSACTION READ ONLY … ROLLBACK`. Đếm lại lúc **23:56Z**: `crm_interactions` **1** · `crm_photos` **202** · `crm_check_ins` **2** · khách active **348** — **đúng bằng lúc bắt đầu**.
* **Không ghi vào thẻ khách thật:** mọi POST/DELETE/PATCH bị chặn **tại trình duyệt** (`route.fulfill`/`route.abort`) hoặc dùng **khách GIẢ** / id không tồn tại. Không tạo interaction, không upload ảnh.
* Đường thất bại thăm dò trên prod (404/400/401) — an toàn theo cho phép của phiếu.
* **Không in token, không in tên/SĐT/email khách.** File tạm chứa secret/PII/ảnh đã xoá.
