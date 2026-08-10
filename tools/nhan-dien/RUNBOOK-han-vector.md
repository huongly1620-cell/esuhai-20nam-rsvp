# Runbook — hạn 7 ngày của vector khuôn mặt (E08-D077)

**Chủ ngữ chính:** tiến trình `esuhai-web`. Không phải một người phải nhớ.

## Ai xoá, lúc nào

| Đường | Chạy khi nào | Phạm vi |
|---|---|---|
| **Tự động** — `server/crm/face-match.js` | 20 giây sau khi máy chủ khởi động, rồi **mỗi giờ** | `crm_event_faces.vec` quá `het_han_luc` |
| Tay — `npm run don-han -- --commit` | khi cần kiểm chứng hoặc dọn ngay | như trên |
| Route — `POST /crm/face-match/quet-han` (btl) | khi cần số trước/sau để đối chiếu | như trên |

Ba đường **cùng một câu lệnh**, nên đo đường nào cũng là đo thứ đang chạy hàng giờ.

## Cái gì KHÔNG hết hạn theo đồng hồ — và vì sao

`crm_face_samples.vec` (cả `crm-photos` lẫn `cat-tay`) **không** hết hạn theo thời
gian. Ba lý do, theo thứ tự quan trọng:

1. **Hết hạn không xoá được gì thật.** Ảnh nguồn vẫn nằm trong kho, nên vector
   luôn tính lại được. Xoá cái dẫn xuất mà giữ cái gốc là hình thức.
2. **Nó tự mâu thuẫn.** Bản trước vừa xoá vector mẫu quá hạn vừa để lượt batch kế
   tiếp tính lại chính chúng — hàng ra khỏi đó **vừa giữ sinh trắc vừa mang
   `vec_xoa_luc`**. Dấu chứng minh đã xoá lại chứng minh điều ngược lại.
3. **Mẫu là hệ quả của một quyết định của người**, không phải chỉ mục hàng loạt.
   BTL khoanh mặt để dạy máy nhận ra một khách không có ảnh chân dung; cho nó
   biến mất sau 7 ngày là làm khách đó lặng lẽ rơi khỏi nhận diện mà người khoanh
   không nhận được tín hiệu nào.

Ràng buộc `CHECK (vec IS NULL OR vec_xoa_luc IS NULL)` đặt ở **tầng CSDL** trên cả
hai bảng: trạng thái mâu thuẫn nay **không biểu diễn được**, không phụ thuộc vào
việc mọi đường ghi đều nhớ kiểm.

Hai tên ràng buộc: `ck_face_samples_vec_xoa` · `ck_event_faces_vec_xoa`. Trên CSDL
**đã có sẵn bảng**, `CREATE TABLE IF NOT EXISTS` không thêm được gì — nên `crm-db.js`
có khối `ALTER` riêng, tự hỏi `pg_constraint` (Postgres **không** có `ADD CONSTRAINT
IF NOT EXISTS`). Khối đó thêm ràng buộc ở dạng **`NOT VALID`**: chặn mọi lượt ghi từ
đó về sau, nhưng **không quét lại hàng cũ**. Nghĩa là nếu một CSDL đã lỡ mang hàng
mâu thuẫn từ bản trước, hàng đó **vẫn nằm đó** — ràng buộc không tự dọn hộ. Kiểm:

```sql
SELECT count(*) FROM crm_face_samples WHERE vec IS NOT NULL AND vec_xoa_luc IS NOT NULL;
SELECT count(*) FROM crm_event_faces  WHERE vec IS NOT NULL AND vec_xoa_luc IS NOT NULL;
```

Cả hai phải bằng **0**. Nếu > 0: dọn (`vec = NULL`) rồi
`ALTER TABLE … VALIDATE CONSTRAINT …` để ràng buộc phủ luôn quá khứ.

## Đường xoá thật của vector mẫu

Gắn với **vòng đời dữ liệu**, không gắn với đồng hồ:

| Hành động | Hệ quả |
|---|---|
| Gỡ mềm ảnh nguồn (`DELETE /crm/event-photos/:id`) | mẫu `deleted_at` + `vec = NULL` + `vec_xoa_luc`; khớp sinh từ mẫu quay về chờ duyệt |
| Gỡ mẫu (`DELETE /crm/face-match/sample/:id`) | khớp quay về chờ duyệt, báo số đã đánh dấu gửi |
| Xoá cứng ảnh (`DELETE /crm/event-photos/:id/vinh-vien`) | xoá hẳn Postgres + object MinIO |

## Người kiểm — ai, bao lâu một lần

| Việc | Người | Nhịp |
|---|---|---|
| Đối chiếu số quá hạn còn sót = 0 | **Hoàng Kha** | sau mỗi lần deploy, và **thứ Hai hàng tuần** |
| Cách kiểm | `POST /crm/face-match/quet-han` → đọc `con_lai` phải bằng **0** | |
| Nếu `con_lai` > 0 | máy chủ có thể vừa khởi động lại liên tục (nhịp chưa tới) hoặc bảng lỗi — xem log `[face-match] quét hạn lỗi` | |
| Hai câu SQL ở mục trên phải ra **0** | **Hoàng Kha** | **một lần** ngay sau chuyến LIVE đầu — vì `NOT VALID` không quét quá khứ |

Ô "người" ở trên có tên thật vì một ô trống là quay lại đúng chỗ QC đã bắt: một
cơ chế không có chủ ngữ. Khi người này bàn giao, **thay tên khác vào**, không xoá
trắng — không ai kiểm thì cơ chế coi như không có, dù mã vẫn chạy hàng giờ.

## Đổi con số 7 ngày

Mặc định nằm ở `crm-db.js` (`het_han_luc DEFAULT now() + interval '7 days'`).
Đây là **quyết định của Sponsor** (khoá 10/08), không phải hằng số kỹ thuật — đổi
thì sửa cả CR-134 và runbook này cùng lúc.
