# Gate 2 §B7 — Cửa OTP tự đăng ký + `/crm` đúng 5 người

| Hạng mục | Giá trị |
|---|---|
| Phạm vi | Hai trang cửa `/checkin-toadam.html` · `/checkin-gala.html` (đăng nhập bằng mã gửi email) và bảng `/crm` |
| Tip kiểm | `c6b24cb` — "Cửa: ai có link, nhập email là nhận OTP vào được (anh Kha chốt 05/08)" |
| Prod | https://esuhai-web-production.up.railway.app |
| Người chấm | QC độc lập §B7 (4 lăng kính: leo-quyen · luong-otp · crm-5-nguoi · pass-gia), **không phải R1** |
| Cửa sổ kiểm | 05/08/2026, 09:35 → 10:30 giờ VN (02:35 → 03:30 UTC) |
| Chốt trạng thái cuối | 05/08/2026 **10:24 giờ VN** (03:24 UTC) |
| Còn tới lễ | **3 ngày** (08/08) |

---

## 1. Verdict

> ## ✅ PASS CÓ ĐIỀU KIỆN
> **Không có `blocker`.** Cả **hai điều Sponsor yêu cầu đều ĐẠT và đã được đo trực tiếp trên prod**:
> ai có link nhập email là nhận mã và vào được cửa; bảng `/crm` đúng **5 người role `btl`**.
> Không tìm được đường leo quyền nào từ tài khoản tự đăng ký lên `btl`.

**Hai điều kiện đi kèm (vận hành, không phải sửa mã):**

1. **Từ nay tới hết 08/08, mọi deploy chạm `server/crm/auth.js`, `server/crm/index.js` hoặc `server/crm/views/crm-login.html` phải kiểm tay end-to-end đường cửa trước khi coi là xong.** Lý do: `npm run smoke:crm` có **0/43 phép kiểm** chạm đường xin-mã/OTP — 43/43 xanh **không** bảo chứng cửa còn sống (mục B7-03).
2. **Có ít nhất một máy đã đăng nhập sẵn bằng tài khoản `btl` tại mỗi cửa từ sáng 08/08**, làm đường lui khi PG gặp trục trặc email (mục 5).

Hai lỗi còn lại đều là **minor / quy trình**, không cần sửa mã trước lễ.

---

## 2. Bảng chấm

### 2.1 Hai điều Sponsor chốt (đây là thước đo)

| # | Yêu cầu Sponsor | Kết quả | Bằng chứng tự chạy | Mốc giờ (VN) |
|---|---|---|---|---|
| **S1** | Hai trang cửa: **ai có link** nhập email → nhận mã qua mail → vào được. **Không** duy trì danh sách email PG | **ĐẠT** | Chạy trọn chuỗi trên prod với địa chỉ `@example.com` mới toanh: `POST /auth/request-code` → **202**; DB sinh 1 dòng `staff_users` role=`staff`, active=true; `crm_auth_codes` có mã, TTL 10 phút; mã **sai** → **401**; mã **đúng** → **200** + `Set-Cookie` phiên; hai trang cửa → **200/200**. `CRM_DOOR_SIGNUP=1`, `OTP_DELIVERY=smtp` xác nhận từ env prod | 09:55 – 10:10 |
| **S2** | Bảng `/crm`: **đúng 5 người** — `trucly@esuhai.com` + 4 tài khoản cũ, đều role `btl` | **ĐẠT** | Truy vấn read-only lúc chốt: `staff_users` gom nhóm cho **đúng một dòng kết quả** `{role: btl, active: true, n: 5}`; miền thư: `esuhai.com` = 5, không có miền nào khác. Ngày tạo: 4 dòng 27/07 (23:17 và 23:40) + 1 dòng **05/08 09:38** (chính là `trucly`). `/crm` chỉ nhận `btl` ⇒ bảng đúng 5 người | **10:24** |

### 2.2 Chống leo quyền

| Mục | Kết quả | Bằng chứng | Mốc giờ |
|---|---|---|---|
| Tự đăng ký **luôn** ra role `staff`, không bao giờ `btl` | ĐẠT | `POST /auth/request-code` với email lạ → DB đúng 1 dòng role=`staff`. Câu `INSERT` ở `auth.js:180` hardcode `'staff'`; không route web nào set `role='btl'` (chỉ `seed.js` CLI) | 09:52 |
| `ON CONFLICT (email) DO UPDATE` **không hạ quyền** 5 tài khoản `btl` | ĐẠT | Hai lớp: (1) `allowOrSelfSignup()` gọi `lookupAllowed()` **trước**, email đã có → return sớm, không chạm `INSERT`; (2) mệnh đề chỉ `SET email = EXCLUDED.email`, không đụng cột `role`. Gọi request-code **lần 2** cùng email test → role vẫn `staff`. DB còn `CHECK staff_users_role_check (role IN ('staff','btl'))` | 09:52 – 10:05 |
| Bước `/auth/verify` **không** tự đăng ký | ĐẠT | Verify bằng email **chưa từng xin mã** + mã `123456` → **401**, và DB **không** có dòng `staff_users` nào cho email đó. Gõ bừa mã không đẻ tài khoản | 09:58 |
| `requireRole('btl')` chặn đúng ở mọi đường ghi/PII | ĐẠT | Bằng phiên role `staff` thật: `DELETE /crm/guests/:id` · `POST /crm/import` · `GET /crm/audit` · `GET /crm/audit/export.csv` · `POST /crm/guests` → **403** toàn bộ | 10:02 |
| Giả mạo cookie đổi `role→btl` | ĐẠT (chặn) | Cookie payload `{role:btl, exp:tương lai}` + chữ ký giả → `GET /crm` trả **trang đăng nhập** (6.738 byte, byte-identical với chưa đăng nhập), không phải app shell; `DELETE`/`import` với cookie đó → **401**. `verifyToken()` dùng HMAC-SHA256 `timingSafeEqual` | 10:06 |
| Miễn trừ làn smoke **không rộng hơn 2 route HTML** | ĐẠT | grep toàn repo: `SMOKE_EMAIL` chỉ xuất hiện ở `server/crm/index.js:43` và trong chính `auth.js`. Bearer smoke vào mọi route `btl` đều **403** | 10:08 |
| `/crm` shell chỉ mở cho `btl` (+ ngoại lệ smoke) | ĐẠT | Đọc mã `index.js:43` (`a.role !== 'btl' && a.email !== auth.SMOKE_EMAIL`) tôi tự mở lại lúc 10:26; phiên `staff` → **403** kèm màn chỉ đường 1.030 byte, sạch PII (chỉ 2 thẻ `<a>` về hai cửa) | 10:12 |

### 2.3 Luồng OTP

| Mục | Kết quả | Bằng chứng | Mốc giờ |
|---|---|---|---|
| Cửa chưa đăng nhập → đẩy về đăng nhập, giữ đúng cửa | ĐẠT | Chromium sạch mở `/checkin-gala.html`: gate gọi `/crm/me` → **401** → chuyển `/crm?next=%2Fcheckin-gala.html`; tiêu đề đổi thành «Đăng nhập để vào cửa đón tiếp»; `window.NEXT=/checkin-gala.html` | 10:14 |
| Câu thông báo đúng ngữ cảnh | ĐẠT | `next` = cửa → «Đã gửi mã tới email của anh/chị. Kiểm tra hộp thư và cả mục Spam.» (bỏ vế «nếu email nằm trong danh sách»). `next=/crm` → giữ nguyên câu mập mờ — đúng thiết kế | 10:15 |
| Đăng nhập xong quay lại **đúng** cửa | ĐẠT | `next=/checkin-toadam.html` → điều hướng tới đúng cửa đó | 10:16 |
| `next` không mở đường redirect tuỳ ý | ĐẠT | Client: `crm-login.html:59-61` chỉ nhận đúng mảng `DOOR` gồm 2 đường (tôi tự đọc lại lúc 10:28). Server: `index.js:30,36` so khớp **chính xác chuỗi**. 4 payload bịa (`https://evil.example`, `//evil.example`, `/crm/audit`, `javascript:alert(1)`) đều hạ về `/crm`, không phát `Location` ra ngoài miền | 10:16 |
| Khoá theo số lần gõ sai | ĐẠT | 5 lần sai đầu → **401** «Mã không đúng.»; lần thứ 6 → **429** «Nhập sai quá nhiều lần, xin mã mới.» `MAX_ATTEMPTS=5` (`auth.js:18`, tôi đọc lại 10:26); DB cho thấy `attempts` kẹt ở 5 | 10:18 |
| Hạn mã 10 phút | ĐẠT | Đọc `crm_auth_codes` read-only: `expires_at − created_at` = **599,99 s** ≈ 600 s | 10:18 |
| Phiên 48 giờ | ĐẠT | `Set-Cookie esuhai_crm`: `HttpOnly` + `Secure` + `SameSite=Lax` + `Path=/` + `Max-Age=172800`. Giải payload base64url: `exp = now + 48,000 h`. Env prod `CRM_SESSION_TTL_H=48` (tôi đọc lại 10:25) | 10:19 |
| Một phiên dùng được **cả hai** cửa | ĐẠT | Cookie lấy ở cửa Gala mở được cả `/checkin-gala.html` lẫn `/checkin-toadam.html` mà không bị đá về đăng nhập (`Path=/`) | 10:20 |
| Trần tần suất xin mã không khoá nhầm PG dùng chung wifi | ĐẠT | Key khoá là `email + '|' + ip` (`auth.js:198`) ⇒ 10 PG khác email chung 1 IP NAT = 10 xô riêng | 10:21 |

### 2.4 Hồi quy & cấu hình

| Mục | Kết quả | Bằng chứng | Mốc giờ |
|---|---|---|---|
| Byte prod ↔ HEAD khớp tuyệt đối | ĐẠT | `cmp -s` **0 byte lệch** trên cả 5 màn: 2 trang cửa, `/crm` (crm-app-v2), `/crm/classic` (crm-app), trang đăng nhập | 10:22 |
| Nhánh "mở công khai không cần đăng nhập" đúng là đã revert | ĐẠT | grep toàn repo tại `c6b24cb`: `CRM_DOOR_OPEN` / `doorOpen` / `allowDoor` / `DOOR_EMAIL` → **0 kết quả** (`0f11d65` đã bị `9d6aeca` gỡ). Prod đang chạy `c6b24cb`, xác nhận bằng 3 dấu hiệu hành vi: phiên `staff` bị 403 · bearer mở được shell · request-code đẻ dòng `staff_users` | 10:22 |
| Env prod khớp lời R1 | ĐẠT | Tôi tự đọc lúc **10:25**: `CRM_DOOR_SIGNUP=1` · `CRM_SESSION_TTL_H=48` · `CRM_DOOR_OPEN=0` · `OTP_DELIVERY=smtp` · `NODE_ENV=production` · `MINIO_PRESIGN_TTL=300` | 10:25 |
| Chưa đăng nhập không lộ dữ liệu khách | ĐẠT | Tôi tự chạy lúc **10:27**: `/checkin-toadam.html` 200 (53.924 B tĩnh) · `/checkin-gala.html` 200 (53.978 B) · `/crm` 200 (6.738 B = trang đăng nhập, có 2 lần chuỗi «Gửi mã») · `/crm/classic` 200 (6.738 B) · `/crm/guests` **401** · `/crm/me` **401**. Quét HTML: 0 lần khớp tên khách / SĐT / thư khách | 10:27 |
| **16/16** route khách & quản trị đều 401 khi chưa đăng nhập | ĐẠT | GET `/crm/guests` · `/guests/:id` · `/stats` · `/me` · `/photos/:id` · `/thumb` · `/preview` · `/audit` · `/audit/export.csv`; POST `/guests` · `/check-in` · `/interactions` · `/photos` · `/import`; PATCH & DELETE `/guests/:id` | 10:10 |
| Shell `btl` nguyên vẹn | ĐẠT | `GET /crm` 200 (82.075 B), render 344 thẻ khách, KPI đủ (ĐÃ ĐẾN 1/344), 4 nút `btl` hiện, có nút Đăng xuất | 10:13 |
| Màn 403 của `staff` **bấm được thật** | ĐẠT | Chromium + cookie `staff`, click «Cửa Gala» → tới `/checkin-gala.html`, trang cửa nạp dữ liệu bình thường (ĐÃ ĐẾN 1 · CHƯA ĐẾN 317/318 · chip VIP 44 · Khách Nhật 63) | 10:13 |
| Không rò kết nối DB | ĐẠT | Mọi route mở transaction riêng đều `release` trong `finally` hoặc trên cả nhánh lỗi: `guests.js:301` · `photos.js:124` · `stats.js:179` · `import.js:111/114` · `admin.js:261/262` | 10:23 |
| Hồi quy FE lịch sử không tái phát | ĐẠT | `counter()` đóng đủ `}` (gala:198) · check-in tôn trọng `!r.ok`, không báo xanh giả (gala:513) · `window.imgFit` đã phơi global (gala:286) · toast `z-index` 100001 > `.pf` 100000 · `jpost` trả `{ok,status}` và được kiểm | 10:23 |
| `smoke:crm` | 43/43 PASS | Dòng cuối «PASS — 43/43 phép kiểm». AC-4 có đối chiếu SQL độc lập (SQL 344/276/44/24 == API) nên không phải PASS trần — **nhưng xem B7-03** | 10:21 |

**Không đo được (ghi nhận trung thực):** cửa Gala mở màn ≤ 0,2 MB — chỉ đo được phần HTML tĩnh (53.978 B ≈ 0,05 MB) và xác nhận file byte-identical với bản D029 từng báo 0,16 MB; **không tái đo phần ảnh thumb** vì cần phiên và tổng byte ảnh.

---

## 3. Lỗi còn lại (sắp theo mức nặng)

Không có `blocker`. Không có mục nào cần sửa mã trước 08/08.

### B7-03 · `major` (đề nghị hạ **minor / quy trình**) — `smoke:crm` mù hoàn toàn đường xin-mã/OTP

* **Ở đâu:** `tools/smoke-crm.js` (AC-1..AC-5) — không phép kiểm nào chạm `/auth/request-code`, `/auth/verify`, hay đường gửi SMTP. Phụ: `tools/smoke-crm-ui.py:42`.
* **Bằng chứng tự chạy:** `grep -c "request-code\|/auth/verify\|checkin-toadam\|checkin-gala"` trên hai file smoke → **0 và 0**. Đọc trọn 298 dòng `smoke-crm.js`: 25 call-site `record()` bung qua vòng lặp thành đúng **43** phép kiểm (AC-1 20 · AC-2 5 · AC-3 5 · AC-4 7 · AC-5 6) — khớp con số «PASS 43/43» được trích trong mọi báo cáo Gate 2. Không có `.github/`, không CI; `package.json` chỉ 2 script (`start`, `smoke:crm`) ⇒ đây là **cổng tự động duy nhất**. Làn UI cũng cố ý đi vòng: bơm header `Authorization: Bearer …` rồi `goto(/crm)`, không bao giờ qua màn đăng nhập.
* **Vì sao quan trọng:** Gate deploy dựa vào 43/43. Con số đó **không** bảo chứng rằng một PG nhận được mã và vào được cửa — đúng thứ Sponsor #1 yêu cầu. Deploy tiếp theo có thể làm hỏng đường mã mà smoke vẫn xanh.
* **Vì sao KHÔNG phải major đang gây hại:** tôi đã chạy trọn chuỗi cửa trên prod và **cửa đang sống** (mục 2.1/S1). Đây là lỗ hổng **bảo vệ hồi quy**, không phải lỗi đang xảy ra. Món này cũng đã nằm sẵn trong sổ: `reports/2026-08-04-d028-goi-con-lai-gate2.md:146` ghi «**0/43** phép kiểm chạm hai trang cửa — `L-13`». B7-03 là nêu lại **L-13**.
* **Cách sửa (ĐỪNG tự sửa trước lễ):** thêm 1 phép kiểm end-to-end đường cửa ở môi trường test, dùng địa chỉ `@example.com` với `OTP_DELIVERY=console` (đọc mã từ log). Hoặc tối thiểu: một smoke prod chỉ đếm tỉ lệ lỗi `EENVELOPE` gần đây = 0 sau mỗi deploy. **Tuyệt đối không** để smoke tự động gửi mail tới email thật.
* **Bù đắp trước lễ:** thay bằng **điều kiện 1** ở mục Verdict — kiểm tay đường cửa sau bất kỳ deploy nào chạm auth.

### B7-01 · `minor` — Chú thích trần tần suất lệch code

* **Ở đâu:** `server/crm/auth.js:20-23`.
* **Bằng chứng tự chạy (tôi mở lại lúc 10:26):**
  ```
  auth.js:20    // request-code rate limit: max 5 / 10min per email+ip (in-memory, one web service).
  auth.js:23    const RL_MAX = 10;
  ```
  Chú thích ghi **5**, hằng thực là **10** — lệch đúng 2 lần.
* **Nguồn gốc (git, không suy đoán):** `git log -L20,23:server/crm/auth.js` cho thấy commit gốc `ca76a68` có `RL_MAX = 5` **khớp** chú thích; commit `d437563` ("CRM OTP via SMTP (E08-D012)") đổi `-const RL_MAX = 5; +const RL_MAX = 10;` nhưng **không** sửa dòng chú thích ngay trên. Chính thân `d437563` viết "Rate-limit 5 -> 10 / 10min" ⇒ việc nâng trần là **cố ý**, chỉ chú thích bị bỏ quên.
* **Đo lại ngưỡng (harness cục bộ, KHÔNG đụng prod):** mount `auth.mount(app)` từ chính file `server/crm/auth.js`, trỏ `DATABASE_URL` vào cổng đóng `127.0.0.1:1`. Chốt chặn rate-limit nằm ở `auth.js:197-202`, chạy **trước** mọi truy vấn DB nên ngưỡng vẫn quan sát được. 13 lượt liên tiếp cùng email+ip: req #1..#10 → 500 (qua được cửa rate-limit, chỉ lỗi vì DB cố ý chết); req #11, #12, #13 → **429** `{note:"rate"}`. ⇒ đúng **10 lượt lọt, lượt 11 mới khoá**, khớp `if (arr.length >= RL_MAX)`.
* **Phần còn lại của chú thích thì đúng:** key = `email + '|' + ip` (dòng 198) ⇒ "per email+ip" chính xác; `RL_WINDOW` = 10 phút ⇒ "10min" chính xác. Chỉ mỗi con số 5 sai.
* **Vì sao quan trọng:** ai chỉnh trần dựa theo chú thích sẽ hiểu sai mức bảo vệ thực. Drift tài liệu ngay ở lớp chống lạm dụng.
* **Cách sửa (việc SAU lễ):** sửa chú thích cho khớp `RL_MAX = 10`, hoặc hạ `RL_MAX` về 5 nếu ý định ban đầu là 5. **Không cần sửa trước 08/08** — hành vi thực 10/10 phút chính là hành vi chủ đích.
* **Vệ sinh:** hạng mục này **không** gọi đường ghi prod — cố tình tránh, vì mỗi lượt xin mã hợp lệ sẽ (i) đẻ một dòng `staff_users` do `CRM_DOOR_SIGNUP=1` và (ii) bắn 10 mail bounce tới `@example.com` qua SMTP prod, làm bẩn uy tín người gửi đúng 3 ngày trước lễ.

---

## 4. Đã thử phá mà không phá được

| # | Đòn tấn công | Kết quả |
|---|---|---|
| 1 | Giả mạo cookie `role=btl` chữ ký sai | `GET /crm` → trang đăng nhập; `DELETE`/`import` → 401. HMAC `timingSafeEqual` chặn |
| 2 | Lật **1 ký tự** payload cookie phiên hợp lệ | `/crm/me` → 401. Không giả được phiên nếu không có `CRM_SESSION_SECRET` |
| 3 | Ép `ON CONFLICT` hạ 5 tài khoản `btl` xuống `staff` | Không thể: `btl` không bao giờ chạm `INSERT` (return sớm ở `lookupAllowed`), và `SET email = email` không đụng `role`. Sau test 5/5 vẫn `btl` |
| 4 | Tự đăng ký ở bước **verify** (email chưa xin mã) | Không đẻ dòng nào; 401 |
| 5 | Xoá khách / import / audit / export.csv / tạo khách bằng phiên `staff` | **403** toàn bộ |
| 6 | Mở `/crm` shell bằng phiên `staff` | 403 door page. Chỉ `btl` và email smoke vào được shell |
| 7 | Open-redirect qua `?next=` (9 payload: `https://evil.example/x`, `//evil.example/x`, `/admin`, `/crm/audit`, `javascript:alert(1)`, `/checkin-gala.html%3Fx`, next rỗng, …) với cả 3 loại phiên | So khớp **chính xác chuỗi** với 2 đường cửa (`index.js:30,36`) ⇒ mọi giá trị lạ rơi về 403 hoặc màn đăng nhập; **không lần nào** phát `Location` ra ngoài miền; không chạy `javascript:` |
| 8 | Giả `X-Forwarded-For` để né trần theo IP | Sau khi email A đã 429, gửi thêm với `X-Forwarded-For: 203.0.113.51/52` → **vẫn 429**. Railway chèn IP client tin cậy nên spoof header không reset khoá |
| 9 | Brute-force mã 6 số | Xin mã mới có reset `attempts=0`, nhưng trần 10 lượt/10 phút/email+IP × 5 lần gõ ≈ **50 lượt đoán / 10 phút** trên không gian 10⁶ ⇒ xác suất trúng không đáng kể |
| 10 | Leo thang cross-door bằng cookie `staff` | Cookie dùng được ở cả hai cửa nhưng vẫn bị `requireRole('btl')` chặn ở `/crm` (403) và ở `DELETE`/`POST`/`import` |
| 11 | Đưa bearer làn smoke vào các route `btl` | `/crm/audit`, `/crm/audit/export.csv`, `DELETE /crm/guests/:id`, `POST /crm/guests`, `POST /crm/import` → **403**. Miễn trừ `index.js:43` chỉ chạm 2 route HTML |
| 12 | Tìm dữ liệu khách trong HTML trả cho người chưa đăng nhập | Quét `/crm`, `/crm/classic`, màn 403 của `staff`, hai trang cửa tĩnh, và file gốc `crm-app-v2.html` (77.509 B) → **0** lần khớp tên khách / SĐT / thư khách. Toàn bộ dữ liệu chỉ qua API có cổng |
| 13 | Mở ảnh khách không đăng nhập | `/crm/photos/:id`, `/thumb`, `/preview` → **401**. Ảnh chỉ phát URL ký sẵn hạn 300 s sau khi qua cổng |
| 14 | Chứng minh prod còn chạy mã có nhánh "cửa mở công khai" | Không được. 3 dấu hiệu hành vi chỉ khớp `c6b24cb`, không khớp `0f11d65` |
| 15 | Tái tạo rò pool D016 | Không được — mọi nhánh (kể cả nhánh lỗi) đều `release` |

---

## 5. Kịch bản làm PG **không vào được cửa** ngày 08/08 — và cách phòng

Đây là mục quan trọng nhất của báo cáo. Cửa hoạt động đúng hôm nay; các rủi ro dưới đây là **vận hành**, không phải lỗi mã.

| # | Kịch bản | Xác suất | Hậu quả | Cách phòng |
|---|---|---|---|---|
| **K1** | **Mail OTP rơi vào Spam** hoặc chậm vài phút (SMTP prod, không có smoke canh) | **Cao** | PG đứng ở cửa chờ mail | Dặn PG trong hướng dẫn: **kiểm cả mục Spam** (câu này đã có sẵn trên màn hình). **Chạy thử đường mail thật với 2–3 PG vào chiều 07/08**, trước lễ 1 ngày |
| **K2** | **Mã hết hạn**: mã sống đúng **10 phút**; PG mở mail muộn (đang bận đón khách) | **Cao** | Nhập mã cũ → 401, tưởng hỏng | Dặn: mã hết hạn thì **bấm xin mã lại**, đừng nhập lại mã cũ. Đăng nhập **trước giờ đón khách**, đừng đợi tới lúc khách tới |
| **K3** | **Gõ sai 5 lần → 429 khoá**, phải xin mã mới; xin quá **10 lần trong 10 phút** thì bị 429 tầng trần tần suất, **kẹt tối đa 10 phút** | Trung bình | PG kẹt đúng lúc cao điểm | Người trực đứng cạnh **đọc mã hộ**. Nếu đã kẹt: **chờ 10 phút** hoặc dùng **máy dự phòng đã đăng nhập** (K5). Đổi email khác cũng thoát được vì khoá theo `email+ip` |
| **K4** | **Email công ty chặn thư** (SPF/DKIM/quota nhà cung cấp), hoặc uy tín người gửi bị bẩn do bounce | Trung bình | Không PG nào nhận mail | Cửa **nhận mọi email**, nên PG có thể dùng **email cá nhân (Gmail)** làm đường lui. Từ giờ tới lễ **không gửi thêm mã tới địa chỉ ảo** (`@example.com` bounce làm bẩn uy tín người gửi) |
| **K5** | Wifi GEM Center chập chờn / DNS lỗi ngay lúc PG đăng nhập | Trung bình | Cửa không nạp được | **Đăng nhập trước, ở nhà hoặc sáng sớm 08/08** — phiên **48 giờ** (đăng nhập 8h sáng 08/08 → hết hạn 8h sáng 10/08, **phủ trọn Gala tới ~21:00**, không có nguy cơ rớt phiên giữa lễ). Có **4G dự phòng** |
| **K6** | PG dùng **chế độ ẩn danh**, đổi máy, hoặc xoá cookie giữa chừng | Trung bình | Phải đăng nhập lại từ đầu, lại phụ thuộc mail | Dặn PG **không dùng tab ẩn danh**. Đăng nhập trên **đúng thiết bị sẽ dùng ở cửa** |
| **K7** | PG bấm nhầm link `/crm` thay vì link cửa | Trung bình | Thấy màn 403, tưởng bị cấm | **Đã có sẵn đường lui**: màn 403 hiện 2 nút bấm được thật, tôi đã click thử «Cửa Gala» → sang thẳng trang cửa. Ngoài ra `/crm?next=<đường cửa>` sẽ redirect đúng cửa nếu đã có phiên |
| **K8** | **Deploy vá gấp sáng 08/08** làm hỏng đường mã mà `smoke:crm` vẫn xanh 43/43 (**B7-03**) | Thấp nhưng nặng | Cả hai cửa chết, không ai phát hiện | **Đóng băng deploy** từ chiều 07/08. Nếu buộc phải deploy: **kiểm tay end-to-end đường cửa** (xin mã → nhận mail → verify → vào cửa) trước khi coi là xong. 43/43 **không** đủ |
| **K9** | Một PG đăng nhập được cửa Tọa đàm rồi tối chuyển sang Gala | — | (Không phải rủi ro) | **Đã kiểm**: một phiên dùng được **cả hai cửa** (`Path=/`), **không phải đăng nhập lại** |
| **K10** | 10 PG cùng wifi NAT cùng xin mã một lúc | — | (Không phải rủi ro) | **Đã kiểm**: khoá theo `email+ip` ⇒ 10 email khác nhau = 10 xô riêng, **không khoá nhầm** |
| **K11** | MinIO trục trặc (tiền lệ: sự cố 8 phút ở D016) | Thấp | Ảnh khách không hiện | **Không chặn việc vào cửa** — cửa và điểm danh không phụ thuộc MinIO. Chỉ ảnh bị thiếu tạm thời |

**Ba việc gọn nên làm trước lễ:**
1. Chiều **07/08**: gửi thử mã thật cho 2–3 PG, xác nhận mail tới hộp thư (kể cả Spam) — bù cho chỗ smoke mù.
2. Sáng **08/08**: PG đăng nhập sớm trên đúng thiết bị sẽ dùng; phiên 48h phủ trọn cả hai buổi.
3. Mỗi cửa có **một máy dự phòng đã đăng nhập sẵn bằng tài khoản `btl`** + một người trực biết đọc mã hộ.

---

## 6. Xác nhận dọn dẹp

**Trạng thái chốt lúc 10:24 giờ VN (03:24 UTC) 05/08 — tôi tự chạy, `BEGIN TRANSACTION READ ONLY … ROLLBACK`:**

```
byRole        [{"role":"btl","active":true,"n":5}]     ← đúng 1 nhóm, không có role staff nào
exampleRows   0                                        ← 0 dòng @example.com còn sót
authCodes     0                                        ← crm_auth_codes rỗng
domains       [{"dom":"esuhai.com","n":5}]             ← 5/5 đều @esuhai.com
created       27/07 23:17 ×2 · 27/07 23:40 ×2 · 05/08 09:38 ×1   (đúng 4 cũ + trucly)
```

* ✅ **`staff_users` còn đúng 5 dòng, tất cả role `btl`, active = true, tất cả `@esuhai.com`** — khớp đúng danh sách Sponsor chốt.
* ✅ **0 dòng `@example.com`** còn sót trong `staff_users`; **0 dòng** trong `crm_auth_codes`.
* ✅ Bốn lăng kính đều **đã khai và đã dọn** phần của mình: các dòng `qcb7signup-*`, `qcb7l2-*` (5 dòng), `qc-b7-lens3-probe`, `e2e-qc-b7`, `qc-b7-door` và các dòng `crm_auth_codes` tương ứng — **tất cả đã DELETE**, và truy vấn chốt ở trên xác nhận độc lập rằng **không còn dòng nào**.
* ✅ **Không gửi mã tới bất kỳ email người thật nào.** Chỉ dùng miền thử `@example.com`.
* ✅ **Không ghi gì vào thẻ khách**: không điểm danh, không ảnh, không ghi nhận. Mọi phép thử đường ghi đều nhắm id giả `99999999` (404/400 trước khi chạm dữ liệu) hoặc bị 401/403 chặn ở cổng.
* ✅ **Không sửa file, không commit, không deploy.** `git status` sạch (`--porcelain` không ra dòng nào), tip vẫn **`c6b24cb`**. Báo cáo này là **file duy nhất** được tạo.
* ✅ **Không in token, không in email/SĐT khách** ở bất kỳ đâu trong quá trình kiểm hay trong báo cáo này.
* ✅ Mọi file tạm chứa bí mật đã xoá: `env.sh`, `webvars.json`, `pgvars.json`, `.dburl`, `.bearer`, `dburl.txt`, `cookieval.txt`, `ck_*.txt`, các script `q*.js` / `mint.js` / `cleanup.js`, các ảnh chụp màn hình có tên khách và các bản HTML tải về.
* ℹ️ **Dấu vết duy nhất cố ý giữ lại:** vài dòng nhật ký `smoke_auth` do `auth.js` tự ghi khi dùng bearer làn smoke (giới hạn 1 dòng / 10 phút) — đây là hành vi vốn có của làn smoke mà nhiệm vụ yêu cầu dùng; **không xoá nhật ký** là đúng nguyên tắc.

---

## 7. Một câu §B7

> Cửa đã thật sự mở đúng cách Sponsor muốn — ai có link, nhập email, nhận mã, vào được, và bảng `/crm` vẫn khoá chặt ở đúng 5 người `btl` mà không một đường tự đăng ký nào leo lên được; thứ còn thiếu không nằm trong mã mà nằm ở lưới chắn: `smoke:crm` xanh 43/43 hoàn toàn mù trước chính luồng OTP này, nên từ giờ tới 08/08 hãy đóng băng deploy và, nếu buộc phải đụng vào `auth.js`, đừng tin con số 43/43 — hãy tự tay xin một mã và bước qua cửa.
