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
