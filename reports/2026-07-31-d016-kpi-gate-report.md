# Báo cáo Gate — E08-D016 pha 1 (KPI mời ↔ đăng ký ↔ buổi trên `/crm`)

> Báo cáo của PM con gửi PM tổng. Spec + review-logs bên repo coord do PM tổng viết (§B7 / SESSION-REPO-BOUNDARY).
> **Ngày:** 2026-07-31 · **SHA:** `4b71b19` · **Trạng thái:** LIVE prod, smoke xanh

---

## 1. Kết quả

**LIVE trên prod lúc 07:23**, trước buổi hướng dẫn PG 9h. Gate 1 PASS có điều kiện → Gate 2 PASS vòng 3 (QC độc lập, actor ≠ người code).

`GET /crm/stats` (mới, `requireCrmAuth`, chỉ số đếm, 0 PII) + khối KPI toàn cục trên dashboard `/crm`.

### Số hiện trên màn hình

| | |
|---|---|
| Tổng khách mời | **154** (114 từ DS Sếp) |
| Lượt đăng ký (form) | **26** — 29 người xác nhận |
| Mời đã nối form | **29** |
| Mời chưa nối form | **125** |

Buổi — **ba nhóm rời nhau, cộng đúng 154**:

```
Buổi theo danh sách   107   (chỉ Gala 90 · cả hai buổi 17)
Buổi theo bản đăng ký  29   (Gala 24 · Tọa đàm·Gala 5)
Thật sự chưa rõ        18
                      ─────
                       154
```

Dòng tổng có điều kiện: **Dự Gala 136** = 107 danh sách + 29 đăng ký · **Dự Tọa đàm 22** = 17 + 5.

## 2. Phát hiện Gate 1 — spec sai một con số cốt lõi

`tiec-toi` **không phải tên buổi**. Nó là `source` của form: `tiec-toi.html:1037` đặt `RSVP_SOURCE`, `rsvp.js:44` lưu, sync gắn thành tag `rsvp,tiec-toi`. Đó là **kênh mời**.

Hệ quả: 29 thẻ khách từ form không mang tag buổi → bị dồn vào "chưa rõ". Nhóm chưa rõ thật là **18**, không phải 47. Hiện "Chưa rõ 47" là nói với Sponsor rằng 29 khách chưa khai buổi, trong khi họ **đã khai rõ ràng**.

Kèm phát hiện phụ: hai nguồn **rời nhau tuyệt đối** (`overlap = 0`) → dựng được phân hoạch cộng đúng 154 mà vẫn tách nguồn, thoả cả luật 2 lẫn luật 4.

## 3. Gate 2 — ba vòng, QC độc lập bắt 11 lỗi

| Vòng | Verdict | Lỗi chặn |
|---|---|---|
| 1 | FAIL | **B1** tổng Tọa đàm bỏ sót nhóm chọn riêng Tọa đàm trên form → đếm thiếu âm thầm, không cảnh báo |
| 2 | FAIL | **B10** `pool.connect()` ngoài `try` → unhandled rejection **giết process**, kéo sập màn điểm danh. *Do chính bản sửa vòng 1 sinh ra* |
| 3 | **PASS** | — |

Đã đóng: B1 · B2 (`checkedIn` đếm cả thẻ xoá mềm) · B3 (`INNER JOIN` làm thẻ mồ côi biến mất) · B5 (5 query khác snapshot) · B6/B11 (payload thiếu → in `undefined` / báo động giả) · B9 · B10 · B14 (XSS qua `invitedTgd`).

**Giữ nguyên có chủ ý:** `partitionOk` / `bucketsOk` là **guard hồi quy code**, KHÔNG phải canh bất biến runtime — hai cờ này không thể false trên dữ liệu, chỉ bắt được khi ai đó sửa code sai (đổi `LEFT JOIN` về `INNER JOIN`, thêm bucket không vét cạn). Đừng ghi chúng là "đã canh bất biến ở runtime".

## 4. 🔴 Sự cố production trong lúc deploy — đã khắc phục

**Chuyện gì:** `railway up` (không có `--service`) dùng service đang link trong CLI, và service đó là **`minio`**, không phải `esuhai-web`. App Node bị đẩy đè lên service MinIO.

**Hậu quả:** MinIO **502 khoảng 8 phút** (07:14–07:22). Ảnh khách trên `/crm` và 2 trang check-in không tải được trong khoảng đó. D021 (avatar) vừa LIVE 40 phút trước phụ thuộc đúng service này.

**Không mất dữ liệu:** volume `minio-volume` không bị đụng (1.3 GB). Sau khôi phục đếm lại: **44 object / 67.3 MB** — khớp đúng con số D021 ghi nhận (44 ảnh / 42 khách).

**Khắc phục:** `railway redeploy --service minio --from-source` — cấu hình service vẫn giữ `image: minio/minio:latest` nên phục hồi được. Bản deploy tốt trước đó (27/07) đã bị Railway dọn (REMOVED), nên đây là đường duy nhất.

**Nguyên nhân gốc:** CLI link ở mức *project*, service link trỏ sai. `railway status` in "Project / Environment" nhưng **không in tên service đang link**, nên nhìn qua tưởng đúng.

**Phòng ngừa — bắt buộc từ nay:** mọi `railway up` / `railway redeploy` phải có **`--service esuhai-web`** tường minh. Kiểm trước khi deploy:

```bash
railway variables --service esuhai-web --json | grep -o '"RAILWAY_SERVICE_ID":"[^"]*"'
# so với service ID in ra trong URL build log của railway up
```

## 5. AC-13 smoke prod (sau deploy đúng service)

| | | |
|---|---|---|
| `/health` | 200 | ✅ |
| `/crm` | 200 | ✅ |
| `/crm/stats` no-auth | **401** | ✅ AC-2 |
| `/crm/guests` no-auth | 401 | ✅ |
| `/checkin-toadam.html` · `/checkin-gala.html` | 200 · 200 | ✅ |
| `/admin/api/summary` | 401 | ✅ AC-10 không đụng |
| `/dang-ky.html` · `/tiec-toi.html` | 200 · 200 | ✅ |
| MinIO health | 200 | ✅ đã phục hồi |
| Tên khách nhúng trong page không auth | **0** | ✅ 0 PII |

## 6. Rollback

`git revert 4b71b19` → mất khối KPI, **không ảnh hưởng điểm danh** (`/crm/guests`, check-in, `photo_url` D021 đều không bị đụng). Phạm vi thay đổi đúng 3 file: `server/crm/stats.js` (mới) · `server/crm/index.js` (2 dòng wire) · `server/crm/views/crm-app-v2.html`.

## 7. Việc còn lại — gửi PM tổng

1. **Sửa spec §2:** "Đã điểm danh **1**" → **0**. Hàng check-in đó nằm trên thẻ **đã xoá mềm** nên không cùng mẫu số với `invited` 154. Code mới trả 0 là đúng — đừng sửa ngược code cho khớp spec.
2. Ghi `partitionOk`/`bucketsOk` đúng bản chất (mục 3).
3. Ghi sự cố MinIO + luật `--service` tường minh vào `decisions.md` / runbook deploy.

## 8. Theo dõi (ngoài phạm vi vé)

- **B7** KPI chỉ nạp lúc boot → số cũ sau import/điểm danh tới khi F5. Nên gọi lại `loadStats()` sau import.
- **B8** Nhóm 2 đếm cả thẻ nối tới submission `status ≠ 'yes'` (prod hiện 100% `yes`, chưa lộ).
- **18 khách thật sự chưa rõ buổi** — việc **dữ liệu**, Wave C khi Ly gửi file có cột Buổi. Không backfill tag từ form trong vé này.
