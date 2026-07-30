# GATE 1 PLAN — Wire check-in → /crm API (E08-D020, Wave A)

> Worker: PM-con-Kha (R1) · Gate **FULL** · **CHƯA code tới khi PASS.**
> Nối 2 page check-in + tab Tọa đàm/Gala trên `/crm` vào **SoT Postgres** bằng **tags** (`toa-dam`/`gala` đã có từ D018), auth bắt buộc. KHÔNG ALTER schema (đó là Wave B).

## 0. Đã xác minh
- `GET /crm/guests` (guests.js) SELECT: `id, full_name, phone, org, title, table_no, from_rsvp, checked_in, checked_in_at, checked_in_by` — **chưa trả `tags`**, chưa có filter buổi. `limit` cap hiện = **200** (active ~154 < 200).
- D018 importer ghi tag **`toa-dam`** (khi Buổi chứa "Tọa đàm") + **`gala`** vào `crm_guests.tags` (chuỗi CSV, vd `ly-tgd,TGĐ,VIP,toa-dam,gala,tgd116,kcode:K001`).
- `checkin-toadam/gala.html` sau D019 = shell + `var G=[]` + banner đỏ, **0 fetch**. `crm-app-v2.html` tab Tọa đàm/Gala hiện in copy cứng "chưa có dữ liệu buổi".

## 1. Quyết định thiết kế (đề xuất)

### (a) Auth-gate check-in pages (AC-1/AC-2/AC-14) → **client-side qua `/crm/me`**
Trang tĩnh (đã rỗng PII từ D019) load shell → JS gọi **`GET /crm/me`**:
- **401** → render màn "Cần đăng nhập CRM" + nút `→ /crm` (OTP). **Không** fetch guests → 0 PII trong response.
- **200** → fetch `GET /crm/guests?session=…` rồi render.
PII **chỉ** đến qua authed fetch, **không** nhúng HTML. Cookie `esuhai_crm` Path=/ nên login ở `/crm` xong vào check-in là chạy. *Ưu tiên hơn server-redirect* (khỏi return-URL, tận dụng 401-handling sẵn có).

### (b) Filter buổi bằng tag (AC-3/AC-7/AC-8) → **`?session=toa-dam|gala`**, khớp CSV tag chính xác
- `GET /crm/guests` thêm **`tags`** vào SELECT + response row (AC-7; document STATUS).
- Query **`session=toa-dam|gala`** → server lọc **tag chính xác** (không substring): `(',' || tags || ',') ILIKE '%,toa-dam,%'`. Whitelist 2 giá trị; giá trị khác → 400.
- `checkin-toadam` gọi `?session=toa-dam`, `checkin-gala` `?session=gala`. Khách có **cả 2 tag** → hiện ở **cả 2** page (thoả AC-3).

### (c) Counter thật (AC-5) → tính từ rows
"ĐÃ ĐẾN x/y" = `rows.filter(checked_in).length` / `rows.length` (sau filter session). **Bỏ** hardcode `/16`, `/99`.

### (d) `limit` (AC-8/§5) → nâng cap có kiểm soát
Nâng cap `limit` **200 → 1000** (vẫn bounded; ~154 khách, subset buổi nhỏ hơn). Check-in gọi `limit=1000`. Không cần paginate ở Wave A.

### (e) `/crm` tab Tọa đàm/Gala (AC-10) → refetch `session=`
Bấm tab → `load()` với `session=toa-dam|gala` (server filter), render như tab Tất cả. **Bỏ** copy cứng "chưa có dữ liệu buổi". 0 khách có tag → empty state trung thực "Chưa có khách gắn buổi này". Tab Tất cả giữ nguyên; khách thiếu tag **không** bị nhét vào buổi (AC-6/AC-11).

### (f) Banner (AC-6) → thay banner nhẹ
Gỡ «BẢN THIẾT KẾ — không điểm danh», thay **banner nhẹ**: «✔ Đã nối /crm · dữ liệu SoT · điểm danh ghi thật». Nav `/crm`→check-in giữ href (giờ có đích sống).

### (g) Trường hiển thị check-in (chốt phạm vi)
List API trả: name, title, org, table_no, checked_in(+by/at), tags. Check-in page hiện **tên · chức danh/đơn vị · số bàn · trạng thái đến · nút điểm danh**; ảnh/tương tác lấy khi **tap → dùng `GET /crm/guests/:id`** (đã có). **Không** thêm seat/vip/diet/photo vào list API (giữ contract gọn). → *Hỏi chốt (3)*.

## 2. File đụng + contract
- `server/crm/guests.js`: `+tags` SELECT · `session=` filter · nâng cap limit. (POST check-in **không đổi** — 1 lần/khách.)
- `checkin-toadam.html` / `checkin-gala.html`: auth-gate + fetch(session) + render + POST check-in + counter thật + thay banner. `var G` = chỉ biến render, **không** nguồn.
- `server/crm/views/crm-app-v2.html`: tab buổi refetch `session=` + bỏ copy cứng.
- **Contract:** `GET /crm/guests` thêm field `tags` + param `session=` (additive, document STATUS). `POST check-in` giữ nguyên.
- **KHÔNG đụng** (AC-13): `/admin`, `/api/rsvp`, `dang-ky`, importer D018 (chỉ đọc tag), MinIO, **không ALTER `sessions`**.

## 3. Rollback
Revert 1 commit wire → check-in về shell rỗng + banner (D019), `/crm` tab buổi về copy cũ. `/crm` tab **Tất cả** + điểm danh **luôn chạy** (không phụ thuộc vé này) = fallback cho PG mai.

## 4. Rủi ro
| Rủi ro | Giảm thiểu |
|---|---|
| Lộ PII không-auth ở check-in | Client-gate `/crm/me`; Gate 2 sweep tên mẫu = 0 (như D019) |
| Đoán buổi cho khách thiếu tag | Cấm — chỉ lọc tag chính xác; thiếu tag → nhóm "Chưa gán buổi", không nhét |
| `session` substring match nhầm | Match CSV có phân tách `,tag,`, whitelist 2 value |
| Khách > cap limit về sau | Cap 1000 bounded + ghi STATUS; >1000 = paginate wave sau |
| check-in ghi localStorage như cũ | Bỏ hẳn; điểm danh chỉ qua `POST /check-in` (AC-4) |

## 5. Hỏi chốt Gate 1
1. **Token buổi**: chốt `session=toa-dam|gala` (khớp tag D018) — OK?
2. **Nâng cap `limit` 200→1000** (thay vì paginate) — OK?
3. **Trường check-in list gọn** (name/title/org/table_no/checked_in; ảnh khi tap→detail), **không** thêm seat/vip/diet/photo vào list API — OK? (mock trước có, nhưng là cosmetic)
4. **Banner nhẹ** «Đã nối /crm · dữ liệu SoT» (thay vì bỏ hẳn) — OK?
5. Auth-gate **client-side `/crm/me`** (không server-redirect) — OK?

**PASS = trả lời (1)-(5) ⇒ em code → self-QC (auth/không-auth sweep + 2 role) → Gate 2 (actor khác) → deploy + smoke.**
