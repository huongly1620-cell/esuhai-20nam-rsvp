# GATE 1 PLAN — CRM UI theo mockup Ly (E08-D017)

> Worker: PM-con-Kha (R1) · Gate **FULL** · **CHƯA code tới khi PASS.**
> Nguồn: `crm.html` (mockup R0, localStorage thuần) · Đích: `/crm` production (đang LIVE).
> Ràng buộc: giữ nguyên app (OTP/RBAC/check-in/interactions/photos/import/audit) · 0 localStorage cho dữ liệu khách · không đổi schema/contract.

## 1. Ánh xạ từng khối mockup → API đang có (spec §3)

| Khối mockup `crm.html` | Nguồn dữ liệu MỚI (thay localStorage) |
|---|---|
| Top nav | Sửa href: `/admin` · `/checkin-toadam.html` · `/checkin-gala.html` · `/xep-ban.html` (mock đang trỏ `/check-in.html` cũ — AC-4) |
| Đếm ngược (`cd`,`tickCd`) | Client timer tới 08/08 (Tọa đàm ~14:30 / Gala ~17:00) — **hằng số, không phải dữ liệu** ✅ |
| Ô tìm kiếm (`q`) | `GET /crm/guests?q=` (AC-5) |
| Quick filter (`qb`): đã đến / chưa · của tôi · VIP · trùng SĐT | client-filter trên rows trả về; **"của tôi" → `mine=1`**; "đã đến" = `checked_in`; VIP/trùng từ tags/`computeDup` client (AC-5/AC-10) |
| Danh sách thẻ (`list`,`renderList`) | `GET /crm/guests` → name, org, `table_no`, `checked_in` (chấm), tags. **Không localStorage** (AC-5) |
| Chi tiết (`detail`,`renderDetail`) | `GET /crm/guests/:id` → liên hệ, `table_no`, điểm danh **ai+lúc nào**, interactions, ảnh (AC-6) |
| Nút điểm danh | `POST /crm/guests/:id/check-in` → đã điểm danh báo rõ ai/lúc (AC-7) |
| Thêm khách (`addBtn`) | `POST /crm/guests` — **chỉ hiện + chỉ chạy với `btl`** (AC-8/AC-15) |
| Lưu (`saveBtn`) | `PATCH /crm/guests/:id` (field whitelist server) |
| Xoá (`delBtn`) | `DELETE /crm/guests/:id` — **btl** (server chặn staff — AC-15) |
| Tương tác / ảnh / import / audit | `POST …/interactions` · `…/photos`+`/crm/photos/:id` · `/crm/import`(btl) · `/crm/audit`(+export, btl) — **giữ nguyên** (AC-9) |
| Export (`expBtn`) | **Không có endpoint export khách** → xuất **client-CSV** từ rows đã tải (không PII ngoài màn), HOẶC bỏ. Audit export dùng `/crm/audit/export.csv`. *(chốt ở Gate 1)* |
| Stats (`renderStats`) | Tính từ rows thật: tổng · đã đến · chưa · của tôi. **Không hard-code** (AC-11) |
| Theme sáng/tối (`theme`,`crm_theme`) | **Giữ localStorage** — chỉ tuỳ chọn hiển thị (AC-2) ✅ |

## 2. AC-12 — tab Tọa đàm/Gala (điểm nhạy, cấm đoán) → **cần anh/PMt chốt**
`crm_guests` **không có cột buổi**. Data thực: ~114 khách TGĐ (import, **0 nguồn buổi**) + ~16 khách RSVP (có `response_id` → buổi nằm ở `rsvp_submissions.sessions`, **API `/crm/guests` hiện KHÔNG trả**).

- **Phương án A (đề xuất — an toàn, 0 đụng contract):** Tab "Tất cả" chạy đầy đủ. Tab **Tọa đàm/Gala hiển thị trung thực**: *"Chưa có dữ liệu buổi cho danh sách này — cần vé schema riêng (thêm cột buổi)."* → **báo PMt mở vé schema**. Không bịa, không chia đôi.
- **Phương án B (khớp ý AC-12, nhưng chạm contract nhẹ):** thêm field **read-only** `sessions` vào response `/crm/guests` (LEFT JOIN `rsvp_submissions` theo `response_id`). Khách RSVP → lọc đúng buổi; khách TGĐ → nhóm **"chưa rõ"**. Chỉ đúng cho ~16/130 khách; **là thêm field (additive), không đổi schema/endpoint** nhưng spec ghi "không đổi contract" → **cần anh duyệt mới làm**.

→ **Em nghiêng A** cho wave này (đúng "1 lát mỏng" của AC-12) + mở vé schema để có tab buổi thật. Anh chọn A hay B.

## 3. AC-13 — checklist "việc cần chuẩn bị"
Giữ checklist tĩnh + `localStorage` (`CHK`) **nhưng gắn nhãn rõ**: *"☑ Ghi nhớ trên máy này — không đồng bộ cả đội."* Đây KHÔNG phải dữ liệu khách (được phép theo AC-13). Muốn dùng chung toàn đội = vé riêng (bảng mới).
→ **localStorage sau khi port: chỉ còn `crm_theme` + `CHK` (checklist, có nhãn). XOÁ `GUESTS`/`CI` (dữ liệu khách).**

## 4. AC-17 — cutover an toàn (rollback ≤ 1 phút)
- Build UI mới thành **file riêng** `server/crm/views/crm-app-v2.html`; **giữ `crm-app.html` cũ nguyên** (đang chạy).
- Route `/crm` chọn theo **env `CRM_UI`** (`classic` mặc định | `new`). Thêm `/crm/classic` **luôn** serve shell cũ.
- **`/crm` chỉ trỏ UI mới SAU Gate 2 PASS** (set `CRM_UI=new`). Hỏng → set `CRM_UI=classic` (env, restart ~1') = về ngay. Login/RBAC/API **không đụng** → rollback chỉ là đổi lớp view.

## 5. Phạm vi + rủi ro + ước lượng
- **File đụng:** `server/crm/index.js` (chọn view theo `CRM_UI` + `/crm/classic`) · **MỚI** `crm-app-v2.html` (port UI + wiring API) · (tuỳ) `crm-login.html` đồng bộ nhận diện. **KHÔNG** đụng `auth.js`/`guests.js`/`rbac`/schema/contract *(trừ khi anh chọn AC-12 B → sửa `guests.js` SELECT thêm `sessions`)*.
- **Ước lượng:** ~1 file view mới (~500-650 dòng) + 1 sửa nhỏ route. Code → self-QC 2 role → Gate 2 (actor khác) → flip env.
- **Rủi ro:** (a) mất năng lực khi đổi UI → map từng cái ở §1 + Gate 2 chạy thật 2 role; (b) hỏng sát lễ (9 ngày) → rollback §4; (c) localStorage sót → grep khi QC; (d) bịa buổi → §2 trung thực.

## 6. Hỏi chốt Gate 1 (cần anh/PMt trả lời để code)
1. **AC-12: chọn A (trung thực "chưa có dữ liệu buổi" + mở vé schema) hay B (thêm field `sessions` read-only)?** — em đề xuất **A**.
2. **Export khách** trên `/crm`: làm **client-CSV** từ rows đã tải, hay **bỏ nút export** (chỉ giữ audit export cho btl)? — em đề xuất client-CSV (tiện Trợ lý), che không lộ thêm PII ngoài màn.
3. Xác nhận **cơ chế rollback** `CRM_UI` env + `/crm/classic` ổn.

**PASS Gate 1 = trả lời (1)(2)(3) ⇒ em code `crm-app-v2.html` + route, chưa flip `/crm`.**
