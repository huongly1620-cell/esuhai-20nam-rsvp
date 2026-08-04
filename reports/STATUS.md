# STATUS — RSVP Railway MVP (E08-D004)

> Product: `LandingPage_KhachMoi_0808` · Spec: `Projects_S2-coord/.../specs/2026-07-24-rsvp-railway-mvp.md`
> Nhánh deploy: `main` · Gate: **FULL** · Worker: PM-con-Kha (R1)

## Deploy log — mới nhất

**2026-08-04 · E08-D022 Pha 2 — nạp SoT 331 khách + 166 ảnh — ✅ ĐÃ GHI PROD**
SoT: **chỉ** sheet visible `Khách Việt Nam+Nhat Ban` (7 sheet còn lại ẩn; importer tự dừng nếu sheet SoT bị ẩn).
Kết quả: **173 → 401 khách active** · **44 → 210 ảnh** (186 khách active có ảnh) · smoke **PASS 43/43**.

| | |
|---|---|
| Cập nhật (nối theo tên 1-1) | 72 |
| Tạo mới | 259 — trong đó **31** gắn `trung-ten-can-ra` |
| Soft-delete khách thừa | 31 (**không** có form) |
| Giữ lại vì có form | **10** — chốt Sponsor, xem ⚠ dưới |
| Ảnh tải lên MinIO | 166 |

- **Mã idempotent:** `vnjb-<sha1(tên|đơn vị|chức vụ)[0..9]>`. **Không** dùng STT — Ly chèn/xoá một dòng là STT đổi hết, lần chạy sau nhân đôi toàn bộ. Chạy lại đã kiểm: **0 tạo mới, 0 xoá, 401 ổn định**.
- **SĐT:** sheet SoT không có cột nào; importer **không có câu lệnh ghi nào chạm `phone`**. 43 số trước import còn nguyên (42 active + 1 nằm trên khách thừa đã ẩn, khôi phục được).
- **Buổi:** `o`=dự, `x`=không. 13 khách `x` cả hai → tag `khong-du`; 11 khách trống cả hai → `chua-ro-buoi`. **Hai nhóm này khác nhau** — một bên đã trả lời không dự, một bên chưa trả lời.
- **Ảnh trùng thư mục:** ưu tiên TGĐ → TTLK → KOKATEAM.

**Smoke bắt 2 lỗi sau import, đã sửa:**

1. **12 khách vừa có tag buổi vừa có form** → phá giả định "hai nguồn rời nhau" của D016, KPI phải hạ dòng "Dự Gala". Đã kiểm cả 12 hai nguồn nói **cùng một buổi** → gỡ tag danh sách (lossless, buổi vẫn đọc từ form). **Không** sửa `/crm/stats`.
2. **2 ảnh HEIC + 1 CR2** trình duyệt không hiện được → chuyển JPEG bằng `sips`, tải lại, xoá bản ghi cũ.


### Gate 2 §B7 — **FAIL vòng 1**, 4 lỗi do import đã vá (04/08)

QC độc lập xác nhận **mọi con số báo cáo đều đúng** (đếm lại 331/331 thẻ, 0 lệch tag, 0 lệch `table_no`), nhưng bắt 4 lỗi **chưa khai báo** do chính import gây ra — đã vá, smoke lại **PASS 43/43**:

| Lỗi | Hậu quả | Đã vá |
|---|---|---|
| `tags = $7` **ghi đè** thay vì merge | ~58 thẻ mất `tgd116` + `kcode:Kxxx` — `kcode` là đường **duy nhất** truy về cách đánh số K của Ly. Ô "trong đó N từ DS Sếp" trên `/crm` tụt **114 → 30** | dùng merge; phục hồi **89** thẻ `tgd116`+`kcode`, **85** thẻ `ly-tgd` |
| Chạy lại `--commit` **phá lại D016** | bản vá "gỡ tag buổi khỏi 12 khách có form" chỉ có trên prod, không có trong git → chạy lại là giao ≠ 0, KPI vỡ | `tagsOf(r, hasForm)` — code tái tạo đúng prod |
| 1 nhóm trùng tên **không có tag** `trung-ten-can-ra` | BTL lọc theo tag để rà sẽ **bỏ sót nguyên nhóm**. Con số thật là **30 người / 93 thẻ**, không phải 29/91 | tag đủ **93** thẻ |
| Tag `pl:` **mất dấu** | `pl:ptg-` 117 + `pl:ptgd` 28 cùng là PTGĐ; `pl:-i-t-c-kh-ch-h-ng` = Đối tác/Khách hàng — rác hiện nguyên xi trên `/crm` | bỏ dấu trước slug; sửa **268** tag → `pl:ptgd` 145 · `pl:tgd` 102 · `pl:doi-tac-khach-hang` 23 |
| 1 ảnh gắn cho **2 người khác tên** | một khách đang hiện mặt người khác ở cửa | giữ cho người khớp tên file, **gỡ 8** thẻ còn lại → initials |
| Import không để lại **dòng audit nào** | 72 update + 259 insert + 31 ẩn + 166 ảnh, không truy được | `logAudit` `import_vnjb` + `repair_gate2` |

Chạy lại importer sau vá: **0 tạo mới, 0 xoá, 401 ổn định, 163 ảnh** (bớt 3 HEIC/CR2 vì trình duyệt không mở được — nay bỏ ở khâu chọn thay vì up rồi sửa tay).

### 🔴 Hai lỗi CHƯA vá — cần quyết định

**1. Mỗi khách SoT đăng ký form từ giờ tới 08/08 đều sinh thẻ trùng.** `rsvp.js:136` gọi `syncFromRsvp` trên **đường ghi live**, không chỉ backfill. 259 thẻ `vnjb-*` mới đều `phone = NULL` → sync tra SĐT trượt, tra ext-id trượt → **INSERT thẻ mới** không ảnh, không số bàn, không tag buổi. Nhịp thật ~5 submission/ngày ≈ **20 thẻ trùng nữa trước lễ**. STATUS cũ chỉ cấm `backfill-rsvp.js` — **đường live chưa được chặn**. Sửa: thêm nhánh tra theo tên chuẩn hoá trong `upsertOne` — **đụng backend LIVE, cần vé + Gate riêng**.

**2. Màn `/crm` kéo 293 MB ảnh gốc, tải nóng.** `crm-app-v2.html` render avatar danh sách **không có `loading="lazy"`** (thumb màn chi tiết thì có), UI gọi `limit=1000` lấy cả 401 thẻ một lượt, `photos.js:49` redirect thẳng tới **object gốc** không có bản thu nhỏ. 37 ảnh > 2 MB, 17 ảnh > 5 MB, lớn nhất 20 MB. Wifi hội trường ngày 08/08.

### ⛔ Cấm sau import này

**KHÔNG chạy `server/crm/backfill-rsvp.js`** cho tới khi có vé sửa `sync-from-rsvp.js`.
Lý do: `sync-from-rsvp.js:26` tra khách theo `phone_norm ... AND deleted_at IS NULL`, nên khách đã soft-delete **không được tìm thấy** → rơi xuống nhánh `INSERT` tạo bản ghi mới không mang tag. Backfill sẽ hồi sinh 31 khách thừa vừa ẩn.

### Nợ vé

- **Vé sync-rsvp:** cho `sync-from-rsvp.js` tôn trọng cờ ngoài-SoT → mới deactivate được 10 khách form ngoài danh sách (Pha 2 cố ý **không** làm).
- **Vé D016 KPI:** thêm nhóm `khong-du` vào `/crm/stats`. Hiện 13 khách đã báo **không dự** đang bị đếm chung ô "Thật sự chưa rõ buổi" — nhãn đó sai với họ.
- **Ảnh quá nặng:** lớn nhất **19.9 MB**, 41 ảnh > 2 MB, trung bình 1.5 MB. Màn `/crm` là mobile, Lễ tân dùng wifi hội trường ngày 08/08 → nên có bản thu nhỏ.


**2026-08-04 · E08-D025 `npm run smoke:crm` — bộ smoke một lệnh cho /crm**
Gói chuỗi smoke Bearer (D024) thành một lệnh chạy trước/sau mọi deploy CRM. **43 phép kiểm**, một dòng cuối `PASS`/`FAIL` + exit 0/1.
```bash
export CRM_SMOKE_BEARER=$(railway variables --service esuhai-web --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).CRM_SMOKE_BEARER')
export DATABASE_URL=$(railway variables --service Postgres --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).DATABASE_PUBLIC_URL')  # tuỳ chọn: bật đối chiếu SQL
npm run smoke:crm     # → PASS — 43/43 phép kiểm · <url>
```

- **401 trên TỪNG route bảo vệ** — `/crm/me`, `/crm/guests`, `/crm/guests/:id`, `/crm/stats`, `/crm/photos/:id`, `/crm/audit`, mỗi route × 3 kiểu header sai. Auth gắn **per-route** (không có guard bao trùm), bỏ sót một route là rò tên + SĐT toàn bộ khách. Cộng `/crm` và `/crm/classic` phải **đúng là trang login**.
- **200** dương tính (`/crm/me` role=staff · guests · stats) · **số thẻ khớp `invited`** · `stats` còn tươi (`asOf` < 2 phút).
- **403** RBAC 5 đường btl-only.
- **Phân hoạch buổi:** bất biến nội tại + **sàn/trần ghim** (`SMOKE_INVITED_FLOOR` 170 · `SMOKE_UNKNOWN_CEILING` 30) + **đối chiếu SQL độc lập** khi có `DATABASE_URL`.
- **UI thật** qua Playwright: `#kpiCard` hiện · số thẻ khớp `invited` · **số trên ô KPI** khớp `invited` · số ảnh khớp API · 0 lỗi JS.
- Biến: `CRM_BASE_URL` (mặc định prod) · `SMOKE_EXPECT_INVITED` ghim số khách · `SMOKE_INVITED_FLOOR` / `SMOKE_UNKNOWN_CEILING` chỉnh mỏ neo · `SMOKE_SKIP_UI=1` bỏ phần trình duyệt (**dòng cuối ghi rõ là đã bỏ**).
- Token **chỉ** từ env, không in ra đâu, không commit. Script **chỉ đọc**, không tạo/xoá khách. Trình duyệt **chặn mọi origin ngoài** (`fonts.googleapis.com`) để token không rời hạ tầng mình.
- Chạy **không** `DATABASE_URL` vẫn được, nhưng dòng cuối ghi **MỨC GIẢM: chưa đối chiếu nguồn độc lập** — đừng đọc chữ PASS đó thành "dữ liệu đã xác minh".
- **Không thêm dependency npm** — dùng `python3` + playwright có sẵn, tránh kéo browser vào build prod sát ngày lễ.
- Đã tự phá để chắc nó biết FAIL, tái hiện đúng kịch bản QC: mất auth ở `/crm/guests` → **6 phép kiểm đỏ** · mất 172/173 khách → đỏ ở sàn · phân hoạch D016 lệch (tổng không đổi) → đỏ ở trần · không token / sai URL / ghim sai số → exit 1.


**2026-07-31 · E08-D021 Avatar ảnh khách ở danh sách — ✅ LIVE trên production (SHA `6b50bf1`)**
Đưa ảnh MinIO đã có lên avatar list `/crm` (3 tab + detail header) + 2 check-in. Gate 1 PASS (4 chốt) · **Gate 2 §B7 PASS 14/15** (QC độc lập, no-N+1 chứng minh bằng log query, null-not-empty đúng) · deploy trước 9h (đúng nhịp) · AC-15 smoke prod xanh.
- `GET /crm/guests`: **+field `photo_url`** qua `LEFT JOIN LATERAL` (ảnh mới nhất) — **1 query, không N+1**. Không ảnh → `null`. Additive (D020 giữ nguyên).
- `crm-app-v2.html` + 2 check-in: avatar render `<img loading=lazy onerror=remove>` → fallback initials; CSS `.av img`/`.dav img` object-fit cover, kích thước cố định.
- Bảo mật giữ: ảnh vẫn `/crm/photos/:id` `requireCrmAuth` (no-cookie 401), không route public, không lộ object key. Không ALTER schema.
- **Prod verify:** 154 khách active · **41 có `photo_url`** (27%) · phần còn lại initials tới khi bổ sung ảnh (Wave C).
- Rollback: `git revert 6b50bf1` → avatar về initials, không đụng điểm danh.

**2026-07-30 · E08-D020 Wire check-in + tab buổi → /crm API — ✅ LIVE trên production (SHA `ee82bbc`)**
Wave A: 2 page check-in + tab Tọa đàm/Gala đọc SoT Postgres qua `/crm/*`, filter buổi bằng **tag** (`toa-dam`/`gala`, không ALTER schema). Gate 1 PASS (5 chốt + fail-closed) · **Gate 2 §B7 PASS 15/15** (QC độc lập, 0 PII, không substring-bleed, fail-closed) · `railway up` · AC-15 smoke prod xanh.
- `GET /crm/guests`: **+field `tags`** · **+param `session=toa-dam|gala`** (match CSV chính xác, invalid→400) · cap limit 200→1000. POST check-in **không đổi**.
- `checkin-toadam/gala.html`: auth-gate client `/crm/me` **fail-closed** (401/network→màn đăng nhập, 0 render khách) · fetch `?session=` · điểm danh POST check-in (bỏ localStorage) · counter thật (bỏ /16,/99) · bỏ nút Huỷ (API 1 chiều) · banner nhẹ "Đã nối /crm" · `var G=[]`.
- `crm-app-v2.html`: tab buổi refetch `session=`; bỏ copy cứng; thiếu tag → không đoán.
- **Contract additive** (`tags`+`session=`); **không ALTER schema** (cột `sessions` = Wave B).
- Rollback: `git revert ee82bbc`; `/crm` tab Tất cả luôn là fallback.
⏳ Xác nhận người thật: đăng nhập `/crm` → mở 2 page check-in thấy khách theo buổi + điểm danh (authed không probe được ngoài). Khách chưa gắn tag buổi **không** tự hiện ở Tọa đàm/Gala (đúng — BTL/nạp file có cột Buổi).

**2026-07-30 · E08-D019 Một SoT: cắt 3 page mock — ✅ LIVE trên production (SHA `2ade14e`)**
SoT = `/crm` + Postgres. Gate 1 PASS (rỗng data · redirect 302 · banner) · **Gate 2 §B7 PASS 7/7** (QC độc lập ≠ worker, 0 tên khách còn nhúng) · `railway up` · smoke prod xanh.
- `crm.html` → **302 → /crm** (route trước static); `var SEED=[]`.
- `checkin-toadam/gala.html` → **banner đỏ** «BẢN THIẾT KẾ — điểm danh thật /crm» + nút /crm; `var G=[]` (trước đây serve DS VIP **không-auth** → nay hết lộ PII).
- Không đụng `/crm`,`/admin`,`/api/rsvp`,`dang-ky`,`xep-ban`; `/crm/classic` vẫn đường lùi.
Smoke prod: crm.html 302 (0 guest-data) · 2 checkin 200+banner+0 tên · /crm//crm/classic/dang-ky/xep-ban/admin/health 200 · /admin/api & /crm/me 401.
🔎 Follow-up (Gate 2 nêu, không chặn): `crm-app-v2.html` nav vẫn link ra 2 page check-in mock — dọn ở vé sau để dứt điểm "một SoT".

**2026-07-30 · E08-D018 data 116 + ảnh TGĐ — ✅ LIVE trên production (SHA `1d4229d` + UI deploy)**
anh xác nhận UI D017 OK + lệnh chạy (Ly chưa chốt, chấp nhận vì script idempotent). Đã chạy prod:
- **Merge importer** `--commit`: 104 update · 10 insert · 2 ambiguous(→BTL). Guests **144 → 154** (+10, KHÔNG nhân đôi 260); **114 kcode-tagged**. Dry prod khớp Gate 2.
- **Loader ảnh** `--commit`: **42 ảnh / 40 khách** lên MinIO prod; rerun idempotent (0 new / 42 already); K103 loại, Kha-May bỏ.
- **UI** deploy: BTL thêm ô sửa Họ tên/Chức danh (khử ~13 ca fuzzy + 2 ambiguous).
- Smoke prod: presigned GET ảnh **200/1.2MB**; regress AC-18 xanh; staff-only gates 401/403 giữ.
🔁 **Re-run khi Ly gửi bản mới:** chạy lại 2 script `--commit` — an toàn (match kcode-tag, object_key tất định).
Còn lại: BTL rà tay ~10 dòng insert nghi-trùng + 2 ambiguous ngay trên UI.

**2026-07-30 · E08-D017 CRM UI theo mockup Ly — ✅ LIVE, đã flip `CRM_UI=new` (SHA `f32d795`)**
Port giao diện mockup `crm.html` lên `/crm` thật, **giữ nguyên app** (OTP/RBAC/check-in/interactions/photos/import/audit). Gate 1 PASS · **Gate 2 §B7 PASS** (QC độc lập ≠ worker, smoke 2 role 25/25) · push `f32d795` · `railway up` (deploy behavior-neutral) · set env **`CRM_UI=new`** flip · live regress AC-18 xanh.
Đường lùi 1 phút: xoá/để `CRM_UI` khác `new` (hoặc `=classic`) → `/crm` về shell cũ; `/crm/classic` luôn có sẵn.
⏳ **Chờ 1 xác nhận người thật:** anh/allowlist đăng nhập `/crm` thấy UI mới (marker authed không probe được từ ngoài vì cần OTP).

- **File:** MỚI `server/crm/views/crm-app-v2.html` (UI mockup + nối `/crm/*` API thật) · sửa `server/crm/index.js` (route theo env **`CRM_UI`**, mặc định `classic`; thêm `/crm/classic`). **KHÔNG** đụng `auth.js`/`guests.js`/`audit.js`/`import.js`/schema/contract.
- **Self-QC (worker=PM-con-Kha, Postgres 16 Docker cục bộ, 2 role):**

| Nhóm AC | Kết quả |
|---|---|
| A giao diện + nav | ✅ `/crm` (CRM_UI=new) render v2 · nav → `/admin`,`/xep-ban.html`,`/checkin-toadam.html`,`/checkin-gala.html` (bỏ `/check-in.html` cũ) |
| B nối dữ liệu thật (AC-5..10) | ✅ list `GET /crm/guests` · detail `:id` (table_no+điểm danh ai/lúc+interactions+ảnh) · check-in ghi **actor=staff** · repeat→already · interaction · PATCH · mine=1 · import/audit (btl) |
| C số liệu trung thực (AC-11..13) | ✅ dashboard "đón tiếp" tính từ rows thật (đã đến/chưa) · **AC-12=A**: tab Tọa đàm/Gala báo *"chưa có dữ liệu buổi — cần schema"* (0 bịa) · checklist gắn nhãn *"ghi nhớ trên máy này"* |
| D bảo mật/vận hành (AC-14..18) | ✅ no-cookie→401 · **AC-15 staff gọi thẳng API btl (POST guests/DELETE/import/audit/export) → 403 ở SERVER** · rollback: mặc định `CRM_UI` unset → `/crm`=classic, `/crm/classic` luôn classic · regress /health·/admin API 401·dang-ky·2 check-in·/api/rsvp |

Smoke tự động: **30/31 PASS** (1 "fail" là assertion sai của tôi — probe trang `/admin` (200, đúng là trang login) thay vì API `/admin/api/*`; đã xác nhận thủ công API no-auth → **401**). `grep localStorage crm-app-v2.html` → **chỉ `crm_theme` + `crm_chk`** (0 dữ liệu khách).
- **AC-12:** đã mở vé schema follow-up (draft) `specs/2026-07-30-crm-schema-buoi-followup.md`.
- **CÒN LẠI:** Gate 2 (actor khác) đọc code + chạy thật + thử rollback → PASS mới `railway up` + set env `CRM_UI=new`. **`/crm` production vẫn classic tới lúc đó.**

**2026-07-30 · tip FE Ly (LIGHT `ly-fe-checkin-crm-deploy`) — SHA live `5f13eb4`**
Pull `--ff-only` (behind 6 → tip) + `railway up esuhai-web`. 3 trang FE mới của Ly (không đụng BE).

| AC | Kết quả |
|---|---|
| AC-2 `checkin-toadam.html` | ✅ 200 · title "Check-in Tọa đàm · Gala 20 Năm" |
| AC-3 `checkin-gala.html` | ✅ 200 · title "Check-in Gala · Gala 20 Năm" |
| AC-4 `crm.html` (mock) | ✅ 200 · title "CRM Khách mời · Gala 20 Năm ESUHAI" |
| AC-5 regress BE | ✅ /health ok · dang-ky 200 · /admin login (api 401) · /crm (CRM thật) 200 · /api/rsvp 400 |
| AC-6 STATUS | ✅ (mục này) |
| AC-7 §B7 | Self-QC LIGHT (worker=PM-con-Kha) — QC độc lập tuỳ chọn: mở 3 URL mobile soi theme |

⚠️ `crm.html` = **mock** (chưa nối `/crm/*` API) — CRM thật vẫn ở `/crm`. Nối API = việc SAU (OUT phiếu này).
Deploy = CLI `railway up` (push `main` KHÔNG tự lên web). Trước đó: `fd800ab` (CR xếp bàn ↔ check-in, Gate 2 PASS).

| Mốc | Trạng thái | Ghi chú |
|---|---|---|
| DoR | ✅ CLOSED 2026-07-24 | E08-D004 |
| Gate 1 | ✅ PASS 2026-07-24 | anh Kha duyệt |
| Code backend + wiring FE | ✅ DONE | server/ + 2 HTML + config.js + AGENTS.md |
| Smoke AC-2…AC-5 (local + Docker PG) | ✅ PASS | xem bảng dưới |
| **Railway provisioned** | ✅ DONE 2026-07-24 | project + Postgres + web service + env (trừ ADMIN_PASSWORD) |
| **Live smoke trên URL Railway** | ✅ PASS | AC-1/2/3/4-gate/6/7 xanh (xem dưới) |
| **ADMIN_PASSWORD (Railway env)** | ✅ SET | anh Kha đã set → /admin/login gate hoạt động (probe → 401, không còn 503) |
| **Push `main`** | ✅ DONE | commit `1ab50bd` trên `main` (Ly invite Write cho `NicholasChen868`) |
| **Deploy code mới** | ✅ LIVE (CLI) | `railway up` — live = `7d5c88a` + **tối ưu tải trang (PM-con-Kha 27/07)**; smoke PASS |

## Tối ưu tải trang (27/07) — giữ nguyên thiết kế

Nguyên tắc: đo → tối ưu → đo lại → verify (Chromium + WebKit/Safari) → deploy. **Thiết kế giữ nguyên** (verify ảnh 2 engine giống hệt trước).

| Hạng mục | Trước | Sau |
|---|---|---|
| Ảnh tải thật (wax-seal, cover, 2 logo) | 933 KB | **151 KB (−84%)** |
| `wax-seal.png` | 453 KB | 71 KB |
| `screen1-cover.jpg` | 417 KB | 72 KB |
| Asset chết (không tham chiếu) | 737 KB | **xoá (0)** |
| Tổng asset repo | 1.8 MB | 372 KB |
| First-load (ảnh+html gz) | ~960 KB | **~180 KB** |

- Ảnh: nén bằng `sharp` (giữ nguyên định dạng/tên file → không đổi markup), verify chất lượng bằng mắt (đạt/đẹp hơn).
- Animation nhẹ hơn: shimmer chạy **1 lần** thay vì vô hạn; canvas sao **tạm dừng khi ẩn/offscreen/tab nền**; pulseGlow hữu hạn. Giảm repaint desktop (nghi vấn "chữ giật" Safari).
- **Chưa repro được** lỗi "đơn điệu" của Ly (headless Chromium+WebKit đều render đúng) → chờ Ly xác nhận trên M5 thật + quay 10s nếu còn.

⚠️ Thay đổi đang ở **working tree + đã railway up**, **CHƯA push `main`** — cần push để giữ lại + Ly pull không mất.
| **AC-1 auto-deploy khi push** | 🅗 HOLD (chấp nhận) | Wave 1 **chốt deploy bằng CLI `railway up`** (anh Kha 25/07). Auto-deploy = follow-up: cần anh connect Source (Railway) + Ly cài Railway GitHub App (GitHub) — 2 tay |
| **Gate 2 (QC độc lập)** | ✅ PASS-có-điều-kiện 25/07 | QC actor khác (§B7 OK). AC-2…7 PASS · AC-1 HOLD. Log: `review-logs/2026-07-25-rsvp-railway-mvp-gate2.md` |

## Deploy runbook (wave 1 — CLI)

**Publish thay đổi lên live** (PM-con-Kha, từ `~/Projects_S2/LandingPage_KhachMoi_0808/`):
```
railway up --service esuhai-web --detach   # deploy code hiện tại lên Railway
```
> ⚠️ **Push `main` KHÔNG tự lên web.** Ly push FE → phải có PM-con-Kha chạy `railway up` mới publish.
> ADMIN_PASSWORD đổi được ngay trên Railway env (không cần redeploy).

## Railway (workspace Backend.4all)

| | |
|---|---|
| Project | `esuhai-20nam-rsvp` · id `03a8e07f-2822-4ab6-88f2-57b25ed8bbb2` |
| Web service | `esuhai-web` · GitHub `huongly1620-cell/esuhai-20nam-rsvp` @ `main` |
| DB | Postgres plugin (region Southeast Asia) · `DATABASE_URL` wired vào web qua `${{Postgres.DATABASE_URL}}` |
| **Public URL** | **https://esuhai-web-production.up.railway.app** |
| Env đã set | `DATABASE_URL`, `ADMIN_USER=admin`, `SESSION_SECRET`, `IP_HASH_SALT`, `NODE_ENV=production` |
| Env **CHỜ anh** | `ADMIN_PASSWORD` (secret của anh — set trên Railway, không commit) |

### Live smoke (trên URL Railway, 2026-07-24)
- `/health` → `{"ok":true}` · `POST /api/rsvp` → **201** ghi Postgres thật
- trùng SĐT → **429** · honeypot → 201 **0 row** · `/admin` no-auth → **401** · `/admin/login` (chưa có pass) → **503**
- `/server/*` chặn → 404 · `dang-ky.html` có `RSVP_SOURCE` · `config.js` trỏ `/api/rsvp`
- **Đã xóa 1 row smoke** → SoT sạch (0 row) cho BTC.

> Lưu ý deploy: bản đang chạy là `railway up` (snapshot code local, KHÔNG đụng git). Khi anh **push `main`**, Railway auto-deploy từ GitHub (cùng code) — đó là đường AC-1 chính thức.

## Kết quả smoke (local, Node 24 + Postgres 16 Docker)

| AC | Kết quả |
|---|---|
| `/health` | ✅ `{ok:true}` |
| AC-2 submit hợp lệ → 1 row | ✅ 201 `{ok,id}`, row ghi Postgres, guest_count đúng |
| AC-3 rate-limit trùng SĐT <5' | ✅ 429 |
| AC-3 honeypot điền | ✅ 201 giả, **0 row** thêm |
| AC-3 SĐT VN sai | ✅ 400 |
| AC-4 `/admin` no-auth | ✅ 401; sai pass 401; đúng pass → cookie + summary + bảng |
| AC-4/UI mask SĐT trên bảng | ✅ `0912*****678` (CSV giữ đầy đủ) |
| AC-5 export.csv | ✅ đủ cột (tên,SĐT,email,nguồn,trạng thái,số khách,phần,ẩm thực,lời chúc,ghi chú,gửi lúc,tạo lúc) + BOM UTF-8, tiếng Việt đúng |
| AC-6 config trỏ `/api/rsvp` | ✅ không còn Apps Script/Sheet SoT |
| AC-7 CNAME | ✅ đã xóa file `CNAME` |

## Thay đổi chính
- `server/**` (Express + pg): `/health`, `POST /api/rsvp`, `/admin` (login/summary/responses/export.csv), migrate on boot.
- `config.js` → `RSVP_ENDPOINT="/api/rsvp"`.
- `dang-ky.html`,`tiec-toi.html`: honeypot ẩn, `RSVP_SOURCE`, fetch JSON same-origin (bỏ `no-cors`), báo success/fail thật.
- `CNAME` xóa; Apps Script + HUONG_DAN_DEPLOY.md gắn nhãn DEPRECATED.
- `AGENTS.md` (SoT phối hợp R0/R1) copy vào root; README viết lại (EN dev+env + mục VN cho Ly).

## Còn lại (ngoài code)
- **Q1:** nối GitHub↔Railway + Postgres plugin; set env `DATABASE_URL`,`ADMIN_USER`,`ADMIN_PASSWORD`,`SESSION_SECRET`,`IP_HASH_SALT` (password chỉ trên Railway).
- Chờ lệnh «push» → deploy → lấy URL `*.up.railway.app` → smoke AC-1/AC-2 trên Railway → Gate 2.

_Cập nhật: 2026-07-24 · PM-con-Kha._
