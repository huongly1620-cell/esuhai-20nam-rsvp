# Gate 1 — E08-D024 `CRM_SMOKE_BEARER`

> PM con gửi PMt. **Chưa code.** Hai điểm cần anh chốt (§4).
> Vé thêm **đường xác thực thứ hai** vào hệ thống chứa PII khách thật → em trình rủi ro trước, không code trước.

## 1. Hiện trạng auth (đo được)

- Session = cookie `esuhai_crm`, HMAC-SHA256 ký bằng `SECRET`, có `exp` ([`auth.js:56-68`](../server/crm/auth.js)). `verifyToken` **đã** dùng `timingSafeEqual` + so length — em sẽ tái dùng đúng khuôn đó.
- `requireCrmAuth` đọc **chỉ** cookie qua `currentActor(req)` ([`auth.js:75`](../server/crm/auth.js)).
- `/crm` chọn shell hay trang login cũng bằng `currentActor(req)` ([`index.js:24`](../server/crm/index.js)) → **muốn Playwright mở được UI thì `currentActor` phải hiểu Bearer**, không chỉ middleware API.

## 2. 🔴 Ranh giới quyền — lý do em đề nghị KHÔNG dùng `btl`

`requireRole('btl')` đang khoá 5 đường:

| Đường | Hậu quả nếu token rò |
|---|---|
| `DELETE /crm/guests/:id` | **xoá khách** khỏi danh sách, 4 ngày trước lễ |
| `POST /crm/import` | **ghi đè hàng loạt** danh sách |
| `GET /crm/audit/export.csv` | **xuất toàn bộ PII** khách ra CSV |
| `GET /crm/audit` | đọc nhật ký |
| `POST /crm/guests` | tạo khách |

Việc smoke **không cần đường nào trong số đó**. Check-in (`POST /crm/guests/:id/check-in`) **không** đòi `btl` ([`guests.js:158`](../server/crm/guests.js)) — mọi actor đã auth đều làm được.

`staff` đủ cho toàn bộ smoke: `/crm/me` · `/crm/guests` (có `photo_url`) · `/crm/stats` · check-in · HTML shell có `#kpiCard`.

### ⚠️ Rủi ro tồn dư của `staff` — phải ghi ra, không được để trống

Chọn `staff` **thu hẹp** rủi ro chứ không xoá. Token rò vẫn:

| Còn làm được | Đường |
|---|---|
| **Sửa** họ tên / SĐT / email / đơn vị / chức danh / note / tags của **mọi khách** | `PATCH /crm/guests/:id` |
| Tạo **check-in giả** | `POST /crm/guests/:id/check-in` |
| Ghi tương tác | `POST /crm/guests/:id/interactions` |
| **Tải ảnh lên** MinIO | `POST /crm/photos` |
| **Đọc** toàn bộ 173 tên + đơn vị + chức danh + note + số bàn, và **43 SĐT thô chưa mask** | `GET /crm/guests` |

Không làm được: xoá khách · import đè · xuất CSV toàn bộ PII · đọc nhật ký.

**Kết luận:** `staff` là mức đúng cho vé này, nhưng đây **vẫn là quyền ghi**. Muốn triệt để thì cần role thứ ba `smoke` chỉ-đọc — ngoài phạm vi vé, ghi vào mục theo dõi.

**Thêm một lợi ích thật:** với `staff`, smoke có thể **khẳng định RBAC còn nguyên** — `DELETE` phải trả **403**. Với `btl` thì không kiểm được điều đó, vì nó xoá thật.

## 3. Thiết kế đề xuất

1. `auth.js` thêm `bearerActor(req)`: chỉ chạy khi `process.env.CRM_SMOKE_BEARER` **có giá trị**; đọc `Authorization: Bearer …`; so bằng `crypto.timingSafeEqual` trên Buffer **cùng length** (khác length → fail ngay, không so).
2. `currentActor(req)` = cookie **trước**, Bearer **sau**. Cookie OTP không đổi một dòng.
   → `/crm` shell, `requireCrmAuth`, `requireRole` đều tự hiểu Bearer mà **không cần đúc cookie**.
3. **Không mint cookie session** (khác gợi ý §8 của phiếu). Lý do: Playwright `extraHTTPHeaders` gắn Bearer cho **cả** request HTML lẫn XHR, nên đủ mở UI; đúc thêm cookie chỉ mở rộng bề mặt (thêm một token sống trong trình duyệt) mà không thêm năng lực.
4. Actor: `{ email: 'crm-smoke-agent@esuhai.local', role: <chốt ở §4> }` — email riêng để **audit phân biệt được** người thật vs agent.
5. Env trống → nhánh Bearer **không tồn tại** (kill-switch: `railway variables --service esuhai-web set CRM_SMOKE_BEARER=`).

## 4. Xin anh chốt

**(a) Role của smoke actor** — em đề nghị **`staff`** (§2). Chọn `btl` thì token rò = xoá khách + xuất toàn bộ PII.

**(b) Ai đặt secret trên Railway.** Đây là **đổi cấu hình production**, em không tự làm khi chưa được ủy quyền rõ. Hai cách:
- Anh tự chạy `railway variables --service esuhai-web set CRM_SMOKE_BEARER='…'` (token anh tự sinh).
- Anh ủy quyền em: em sinh token 32 byte ngẫu nhiên, set thẳng lên Railway, **không in ra chat, không commit**. Anh xem giá trị trong Railway dashboard.

## 5. Test sẽ chạy

Local: không header → 401 · Bearer sai → 401 · sai length → 401 · env trống + Bearer đúng → 401 · Bearer đúng → 200.
Prod sau deploy: 4 ca trên + `/crm/me` `/crm/guests` `/crm/stats` 200 + `/crm` trả shell (có `#kpiCard`) + `DELETE` → **403** (nếu chốt `staff`) + audit ghi `crm-smoke-agent@esuhai.local`.

## 6. Cấm (theo phiếu, em giữ)

Không `OTP_DELIVERY=console` trên prod · không hard-code token · không in token ra STATUS/chat/Signal · STATUS chỉ ghi "đã cấu hình".

---

# KẾT QUẢ — LIVE

`14e959a` (lane Bearer) + `887c8eb` (audit + trim) · deploy `108eab43` SUCCESS 04/08 11:11 · `railway up --service esuhai-web` (CR-25, service ID `2f54e6bc` đối chiếu trước khi đẩy).

**Secret:** `CRM_SMOKE_BEARER` **đã cấu hình** trên service `esuhai-web` (32 byte ngẫu nhiên, 43 ký tự base64url). Giá trị **không** nằm trong repo, commit, report, hay chat — anh xem trong Railway dashboard. Tắt lane: đặt biến rỗng.

## Verify prod

| | |
|---|---|
| Không header · Bearer sai · scheme `Basic` | **401** |
| `/crm/me` · `/crm/guests` · `/crm/stats` | **200** |
| `DELETE /crm/guests/:id` · `GET /crm/audit` · `POST /crm/import` · `POST /crm/guests` | **403** — RBAC còn nguyên |
| `/crm` không auth | trang login, **0 tên khách** |
| Actor | `crm-smoke-agent@esuhai.local` / `staff` |

**UI thật trên prod qua Playwright + header Bearer** (thứ trước đây phải chờ người): `#kpiCard` hiện · **173 thẻ khách · 41 ảnh** · pill `Dự Tọa đàm 24 / Dự Gala 155` · khối buổi `107 + 48 + 18` · nút 日本語 còn · **0 lỗi JS**. Đây cũng là smoke BTL còn thiếu của **D022 Pha 1** — nay đã đóng.

## Gate 2 — QC độc lập PASS, 2 việc đã xử lý

1. **Lane Bearer mù với audit khi chỉ đọc.** QC kéo trọn 173 khách (tên, đơn vị, SĐT thô) mà `crm_audit_events` tăng **0 dòng** — vì chỉ endpoint **ghi** mới gọi `logAudit`. Yêu cầu số 3 của phiếu vì thế chưa từng chứng minh được. **Đã sửa:** ghi event `smoke_auth` khi Bearer xác thực thành công, throttle 10 phút. Verify prod: 1 request → 1 dòng; thêm 5 request → vẫn **1 dòng** (không spam).
2. **Rủi ro tồn dư của `staff` chưa ghi ra giấy.** QC đúng — bảng rủi ro cũ chỉ liệt kê hậu quả của `btl`. Đã bổ sung §2 ở trên.

QC còn báo 5 mục thông tin, em **không** sửa trong vé này: `.trim()` làm `Bearer  <tok>` thừa space vẫn nhận (RFC 7235 cho phép OWS, token vẫn phải đúng từng byte) · `SMOKE_MIN_LEN` đếm độ dài chứ không phải entropy · `smokeWarned` là latch (restart là reset) · token không có TTL/rotate/rate-limit · `CRM_ALLOWLIST` là **biến chết**, không file .js nào tham chiếu (allowlist thật nằm ở bảng `staff_users`) — cái cuối đáng dọn, ngoài vé.

## Theo dõi

- Muốn triệt để thì cần role thứ ba **`smoke` chỉ-đọc** — `staff` vẫn cho sửa khách, tạo check-in giả, tải ảnh, đọc 43 SĐT thô.
- Chưa có quy trình **xoay token**. Sau lễ nên đặt lịch, hoặc xoá biến khi hết mùa sự kiện.
