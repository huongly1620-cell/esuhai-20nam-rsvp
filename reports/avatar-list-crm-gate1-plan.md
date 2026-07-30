# GATE 1 PLAN — Avatar ảnh khách ở danh sách (E08-D021)

> Worker: PM-con-Kha (R1) · Gate **FULL** · **CHƯA code tới khi PASS.**
> Đưa ảnh đã có trong MinIO (41/154 khách) lên avatar list `/crm` (3 tab) + 2 page check-in. Additive, không N+1, không phá auth. Không tăng độ phủ ảnh (việc dữ liệu = Wave C).

## 0. Đã xác minh (code)
- `guests.js` list SELECT chưa có field ảnh → `crm-app-v2.html:236` + `:269` luôn `initials()`.
- check-in `.av` (dòng 40) **đã có** `overflow:hidden` + `.av img{width:100%;height:100%;object-fit:cover}` + `av()` (dòng ~118) render `<img onerror="this.remove()">` — **chỉ thiếu dữ liệu** (`mapRow` gán `photo:""`).
- crm-app-v2 `.av`(62)/`.dav`(70): grid initials, **chưa** có rule `img`.
- `GET /crm/photos/:id` (photos.js) `requireCrmAuth` → presigned; **giữ nguyên**.

## 1. API (Nhóm A) — 1 truy vấn, cấm N+1
Thêm vào SELECT của `GET /crm/guests`:
```
LEFT JOIN LATERAL (
  SELECT ph.id FROM crm_photos ph
  WHERE ph.guest_id = g.id ORDER BY ph.created_at DESC LIMIT 1
) p ON TRUE
```
→ trả **`photo_url`** = `p.id ? '/crm/photos/'+p.id : null`. (AC-1/2/3/4)
- **1 query** cho cả 154 khách (LATERAL, không vòng lặp) — đo bằng 1 dòng log query.
- Ảnh **mới nhất** (`created_at DESC`) — khớp thứ tự `photos[]` của detail.
- Không ảnh → **`null`** (không `""` → tránh `<img src="">`).
- **Additive**: `q/mine/limit/session=` giữ nguyên hành vi D020 (AC-5/14).

## 2. UI danh sách (Nhóm B)
- **crm-app-v2 (3 tab)** dòng 236 avatar row:
  `'<div class="av">'+(g.photo_url?'<img src="'+esc(g.photo_url)+'" loading="lazy" onerror="this.remove()">':'')+esc(initials(g.full_name))+'</div>'`
  + CSS thêm: `.av{overflow:hidden;position:relative}` · `.av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}` (img phủ lên initials; lỗi → `remove()` → initials hiện lại). (AC-6/8/9)
- **Detail header (AC-10)** dòng 269 `.dav`: làm **tương tự** (đề xuất **CÓ** — Lễ tân mở hồ sơ thấy mặt ngay) + `.dav{overflow:hidden;position:relative}` · `.dav img{...inset:0...}`.
- **2 check-in** (AC-7): chỉ **truyền dữ liệu** — `mapRow` gán `photo: r.photo_url||""` (thay `""`). `av()` + `.av img` + `onerror` **đã có sẵn** → ảnh lưới hiện ngay từ list, không chờ `enrich()`. `enrich()` giữ nguyên cho ảnh chi tiết/note.
- **loading="lazy"** + `.av`/`.dav` kích thước cố định (36/56px) → không nhảy layout (AC-9).

## 3. Bảo mật / regress (Nhóm C)
- Ảnh vẫn qua `/crm/photos/:id` **`requireCrmAuth`** → chỉ người đã đăng nhập tải được; bucket private; **không** route public, **không** lộ object key/URL MinIO thô (chỉ trả `/crm/photos/:id`). (AC-11/12)
- Không-auth: list 401, static check-in 0 ảnh/0 tên (fail-closed D020 giữ). (AC-11)
- **Không** ALTER schema, không đụng `/admin`/RSVP/importer/`POST check-in`. (AC-13)
- Regress D020: `session=` exact-token (bẫy `gala-vip`), counter thật, cap 1000, staff→btl 403. (AC-14)

## 4. File đụng + rollback
- `server/crm/guests.js` (LATERAL + photo_url) · `crm-app-v2.html` (2 avatar + CSS) · `checkin-toadam/gala.html` (mapRow 1 dòng). **KHÔNG** đụng photos.js/auth/schema.
- **Rollback**: `git revert 1 commit` → avatar về initials; **không ảnh hưởng điểm danh** (D020 độc lập). `/crm` tab Tất cả luôn sống.

## 5. Hỏi chốt Gate 1
1. **Field `photo_url`** (string `/crm/photos/:id` | `null`) — OK? (đúng đề xuất spec)
2. **Detail header** (`/crm`) cũng hiện ảnh (AC-10) — em đề xuất **CÓ**. OK?
3. Ảnh hỏng/thiếu → **fallback initials** (onerror remove → initials), **không** placeholder/ảnh mượn — OK?
4. Lazy-load + kích thước cố định (đã có) — OK?

## 6. Nhịp deploy (buổi PG 9h)
Vé **không chặn** buổi 9h (D020 chạy với initials). Ảnh avatar **giúp PG nhận mặt** → nếu Gate 2 xong **trước 9h** thì deploy sớm (có lợi cho buổi tập); nếu **sát/đang 9h** thì **hoãn `railway up` tới sau buổi** (tránh restart API PG đang dùng). Deploy là additive/thấp rủi ro nhưng không cần restart giữa buổi cho việc cosmetic.

**PASS = trả lời (1)-(4) + chốt nhịp deploy ⇒ code → self-QC (đếm query=1, auth/no-auth, ảnh render/hỏng) → Gate 2 (actor khác) → deploy.**
