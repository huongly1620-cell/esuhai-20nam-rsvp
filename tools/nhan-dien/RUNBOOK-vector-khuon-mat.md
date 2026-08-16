# Runbook — vector khuôn mặt (E08-D134, thay runbook hạn 7 ngày của D077)

**Chốt của Sponsor 16/08/2026:** giữ **cả hai** loại vector, **giữ vĩnh viễn**.

Vé D134 thay hẳn `RUNBOOK-han-vector.md`. Nếu bạn đang tìm cách "dọn hạn" thì không
còn đường nào — và đó là chủ ý, không phải thiếu sót.

## 1. "Vĩnh viễn" nghĩa là gì, và KHÔNG nghĩa là gì

| Nghĩa là | KHÔNG nghĩa là |
|---|---|
| Không TTL theo đồng hồ | Không phải bất khả xoá |
| Không quét xoá khi đóng/tạm dừng/dừng đợt | Không phải giữ bản sao ẩn ở đâu đó |
| Vector sống chừng nào **bản ghi nguồn** còn sống | Không phải giữ vector của hàng đã `deleted_at` |

Lý do nghiệp vụ: khi CRM có avatar hoặc mẫu **mới**, đội vận hành phải tái tìm được
ảnh của khách trên **toàn bộ** kho đã lưu. Việc đó cần vector của những khuôn mặt đã
dò. Với hạn 7 ngày, một mẫu thêm vào hôm nay chỉ gặp được những mặt dò trong tuần.

## 2. Đường xoá thật — vẫn nguyên, gắn với vòng đời dữ liệu

| Hành động | Hệ quả |
|---|---|
| Gỡ mềm ảnh sự kiện (`DELETE /crm/event-photos/:id`) | mặt: `deleted_at` + `vec=NULL` + `vec_xoa_luc`; mẫu cắt trên tấm đó: như trên; khớp sinh từ mẫu quay về `cho` |
| Gỡ mềm cả đợt (`DELETE /crm/event-photos/batch/:id`) | như trên, cho cả đợt |
| Xoá cứng ảnh (`DELETE /crm/event-photos/:id/vinh-vien`) | `DELETE` Postgres (FK cascade) + xoá object MinIO |
| **Gỡ mẫu** (`DELETE /crm/face-match/sample/:id`) | **D134:** `deleted_at` + `vec=NULL` + `vec_xoa_luc`; khớp sinh từ mẫu quay về `cho` |
| Xoá cứng khách | `crm_face_samples` + `crm_face_candidates` biến mất qua `ON DELETE CASCADE` |

> **Đổi ở D134:** dòng "gỡ mẫu" trước đây chỉ đặt `deleted_at` và **để lại vector**.
> Không ai đọc tới nó (mọi câu đọc đều lọc `deleted_at IS NULL`) — nhưng "không ai
> đọc" không phải là "đã xoá". Nay nó xoá thật.

Ràng buộc `CHECK (vec IS NULL OR vec_xoa_luc IS NULL)` giữ nguyên trên cả hai bảng:
`ck_face_samples_vec_xoa` · `ck_event_faces_vec_xoa`. Chúng ở dạng **`NOT VALID`**,
tức gác mọi lượt ghi từ khi ra đời nhưng **không quét lại hàng cũ**. Kiểm một lần
sau chuyến LIVE đầu:

```sql
SELECT count(*) FROM crm_face_samples WHERE vec IS NOT NULL AND vec_xoa_luc IS NOT NULL;
SELECT count(*) FROM crm_event_faces  WHERE vec IS NOT NULL AND vec_xoa_luc IS NOT NULL;
```

Cả hai phải bằng **0**. Nếu > 0: dọn (`vec = NULL`) rồi `ALTER TABLE … VALIDATE
CONSTRAINT …`.

## 3. Những gì đã bị gỡ ở D134 — và cột nghỉ hưu

| Thứ | Trạng thái |
|---|---|
| `quetHan()` + nhịp mỗi giờ + lượt quét lúc boot (`server/crm/face-match.js`) | **xoá** |
| Bước pre-clean mỗi lượt ghi (`tools/nhan-dien/batch.js`) | **xoá** |
| `tools/nhan-dien/don-han.js` | **xoá tệp** |
| `POST /crm/face-match/quet-han` | **nghỉ hưu, no-op** — trả `retired: true`, **0 câu SQL**, vẫn `btl` |
| Index `idx_event_faces_can_don` | **DROP** |
| Cột `crm_event_faces.het_han_luc` | **giữ**, nullable, không default, **mọi hàng = NULL** |

### Vì sao giữ cột thay vì bỏ hẳn

Rollback mã ở dự án này là **redeploy commit cũ**, mà commit cũ mang nguyên câu quét
hạn. Nếu bỏ cột, bản cũ ném `column "het_han_luc" does not exist` — `face-match.js`
nuốt đúng lỗi đó, còn `batch.js` thoát mã 1, tức cả đường nhận diện đứng.

Giữ cột và để **trống** thì bản cũ chạy bình thường và xoá **0 hàng**, vì
`NULL <= now()` không bao giờ đúng. Nhờ vậy "rollback không tái kích hoạt TTL" là
một **tính chất của dữ liệu**, không phải điều người deploy phải nhớ.

**Cấm** dùng lại `het_han_luc` làm điều kiện xoá vector. Phép kiểm canh gác tĩnh
trong `test/d134-vector-vinh-vien.test.js` đếm số chỗ `SET vec = NULL` trong cây
nguồn và sẽ **đỏ** nếu có chỗ thứ sáu xuất hiện.

## 4. Đo kho vector

```
GET /crm/face-match/kho-vector        (btl)
```

Chỉ trả **số đếm** — không vector, không object key, không tên. Sáu nhóm: mẫu sống
có/thiếu vector, mặt sống có/thiếu vector, hàng không khôi phục được, và tóm tắt
lượt backfill / tái khớp gần nhất.

Cùng bộ số lấy được từ dòng lệnh:

```bash
node khoi-phuc-vector.js          # THỬ — chỉ đếm, không ghi gì
```

## 5. Khôi phục vector đang thiếu

Bỏ TTL chỉ ngăn vector **mới** biến mất; phần đã bị quét từ 10/08 tới nay không tự
quay lại. Dựng lại được vì ảnh nguồn và hình học (hộp + năm mốc) vẫn còn.

```bash
cd tools/nhan-dien
node khoi-phuc-vector.js                          # 1 · THỬ, đọc số
node khoi-phuc-vector.js --mau-thu 20             # 2 · THỬ có tính thật 20 hàng
node khoi-phuc-vector.js --commit --gioi-han 200  # 3 · lô nhỏ, đối chiếu
node khoi-phuc-vector.js --commit                 # 4 · chạy hết
node khoi-phuc-vector.js --commit                 # 5 · lần hai phải ra khôi phục 0
```

- **Không** reset `soi_luc`, **không** đẻ hàng mặt, **không** đụng candidate hay
  trạng thái BTL. Chỉ ghi hai cột `vec` / `vec_xoa_luc` trên hai bảng.
- Hàng đã `deleted_at`, ảnh nguồn đã gỡ, mẫu mồ côi nguồn: **bỏ qua**, đếm riêng.
- Mặt thiếu `moc`: bỏ qua. Cờ `--do-lai-moc` có tồn tại nhưng **mặc định tắt** —
  dò lại là dựng vector từ một hình học khác cái đã đẻ ra hàng đó, tức đổi chất
  lượng dữ liệu cũ một cách lặng lẽ. Chỉ bật khi có người quyết định bật.
- `--nghi-ms 50` khi kho đang phục vụ người dùng, để không ép MinIO.

### Hoàn tác

Mỗi lượt `--commit` ghi một nhật ký `khoi-phuc-<mã>.jsonl` chỉ gồm `{bảng, id}` —
không vector, không khoá kho, không PII. Tệp này **không** vào repo và **không** vào
coord.

```bash
node khoi-phuc-vector.js --hoan-tac khoi-phuc-<mã>.jsonl            # THỬ
node khoi-phuc-vector.js --hoan-tac khoi-phuc-<mã>.jsonl --commit   # cần lệnh Sponsor
```

Hoàn tác là một thao tác **xoá dữ liệu sinh trắc**, nên nó cần một quyết định
Sponsor mới kèm preview số lượng — không phải rollback thường.

## 6. Tái khớp toàn kho sau khi có mẫu mới

```bash
node batch.js --chi-khop-lai            # THỬ — đếm đúng số gợi ý sẽ tạo
node batch.js --chi-khop-lai --commit   # ghi thật
```

**Không** cần MinIO, **không** cần model 37 MB: chế độ này chỉ đọc vector đã lưu và
nhân hai mảng số. Chạy được từ bất kỳ máy nào có đường tới CSDL.

Bảo đảm:

- chỉ tạo gợi ý `trang_thai='cho'` — máy không tự xác nhận (CR-127);
- chỉ `INSERT`, không câu `UPDATE` nào ⇒ `xac-nhan` / `tu-choi` không thể bị hạ cấp;
- chạy lại không nhân đôi `(face_id, guest_id)`;
- không hồi sinh dòng đã xoá mềm, không dùng mẫu của khách đã xoá mềm.

> **Báo trước cho BTL:** hàng đợi duyệt sẽ **phình** sau bước này. Đó là kết quả
> mong muốn, không phải sự cố.

Mẫu **chưa có vector** không thuộc phạm vi lệnh này (chúng cần engine) — chúng được
tính trong một lượt `batch.js --commit` bình thường, hoặc bằng `khoi-phuc-vector.js`.

## 7. Người kiểm — ai, bao lâu một lần

| Việc | Người | Nhịp |
|---|---|---|
| Hai câu SQL ở §2 phải ra **0** | **Hoàng Kha** | một lần ngay sau chuyến LIVE đầu (vì `NOT VALID` không quét quá khứ) |
| `GET /crm/face-match/kho-vector` → `mat.thieu_vec` không tăng bất thường | **Hoàng Kha** | sau mỗi lần deploy |
| Sau khi thêm mẫu/avatar hàng loạt: chạy tái khớp §6 | **Hoàng Kha** | khi có đợt cập nhật avatar |

Ô "người" có tên thật vì một ô trống là quay lại đúng chỗ QC đã bắt ở D077: một cơ
chế không có chủ ngữ. Khi người này bàn giao, **thay tên khác vào**, không xoá trắng.

## 8. Nếu cần đổi lại quyết định

"Giữ vĩnh viễn" là **quyết định của Sponsor** (16/08/2026), không phải hằng số kỹ
thuật. Muốn đặt lại một hạn nào đó thì cần một quyết định Sponsor mới **kèm preview
số lượng sẽ mất**, và phải sửa cả spec D134 lẫn runbook này cùng lúc — không được
thêm lại một câu `UPDATE … SET vec = NULL` vào bất kỳ đường chạy nào trước đó.
