# Đo ảnh chậm — số thật, chưa sửa mã

05/08/2026 · tip **`059c54a`** · **read-only**, không deploy, không đụng mã
Đo bằng Chromium thật (Playwright) ở 390×844, phiên Bearer, prod
`https://esuhai-web-production.up.railway.app`

**Mạng đo:** đường truyền máy R1 (văn phòng/nhà, có dây) — đo được **≈ 9,4 MB/s**
(tải một ảnh 11,53 MB mất 1226 ms). **Đây KHÔNG phải wifi hội trường.** Mọi con số thời gian dưới
đây là **cận dưới lạc quan**; số MB mới là thứ không đổi theo mạng.

---

## 1. Vừa mở màn (T0) — chưa cuộn dòng nào

| màn | ảnh tải | **tổng tải về** | ảnh to nhất | TTFB giữa | TTFB max | mở xong sau |
|---|---|---|---|---|---|---|
| `/crm` | 8 | **4,47 MB** | 2,04 MB | 208 ms | 225 ms | 4,4 s |
| cửa Gala | 10 | **13,03 MB** | 4,29 MB | 212 ms | 622 ms | 4,6 s |

> **Anh thấy chậm ngay khi chưa cuộn là có thật.** Mở cửa Gala kéo về **13 MB** chỉ để vẽ
> ~10 khách đầu màn. Trên đường 9,4 MB/s là 1,4 s; trên wifi hội trường chia cho vài chục máy
> thì xem bảng §4.

## 2. Cuộn (T1 · T2)

| màn | cuộn 2 màn: thêm | cuộn **hết** list: thêm | tổng cả phiên |
|---|---|---|---|
| `/crm` | 0 ảnh · 0 MB | 103 ảnh · 55,17 MB | 111 ảnh · **59,65 MB** |
| cửa Gala | 6 ảnh · 4,57 MB | 95 ảnh · 145,04 MB | 111 ảnh · **162,64 MB** |

TTFB khi cuộn nhanh tăng mạnh — `/crm` **TTFB giữa 1412 ms, max 4837 ms**: các ảnh nặng xếp
hàng sau nhau, ảnh sau phải chờ ảnh trước.

PG ở cửa lướt tìm một khách = kịch bản T2. **Một lượt lướt hết danh sách Gala = 162 MB.**

## 3. Kho ảnh — vì sao nặng

`crm_photos`, 202 ảnh / 188 khách, **tổng 296,9 MB**, trung bình **1505 KB**.

| phân vị | cỡ |
|---|---|
| p50 | **315 KB** |
| p90 | **4012 KB** |
| p99 | **18 797 KB** |
| lớn nhất | **19,87 MB** |

| nhóm cỡ | số ảnh | chiếm |
|---|---|---|
| < 200 KB | 74 | 6,4 MB |
| 200–500 KB | 45 | 13,9 MB |
| 0,5–1 MB | 22 | 15,0 MB |
| 1–2 MB | 24 | 33,3 MB |
| 2–5 MB | 20 | 59,6 MB |
| **> 5 MB** | **17** | **168,6 MB** |

**17 ảnh (8% số file) chiếm 57% dung lượng kho.** Đây là ảnh máy ảnh/điện thoại gốc, chưa hề
thu nhỏ.

Riêng **ảnh đang thật sự làm avatar** (mỗi khách một tấm mới nhất, không tính ảnh quà):
**165 ảnh · 234,8 MB · trung bình 1457 KB · to nhất 19,87 MB.**

## 4. Quy đổi ra thời gian theo đường truyền

Chỉ là phép chia `MB ÷ tốc độ` — cho anh ước lượng hội trường:

| đường truyền | mở cửa Gala (13,03 MB) | lướt hết list (162,6 MB) |
|---|---|---|
| 9,4 MB/s *(mạng em đo)* | 1,4 s | 17 s |
| 2 MB/s *(wifi tốt, ít máy)* | 6,5 s | 81 s |
| 0,5 MB/s *(wifi đông máy)* | **26 s** | **5,4 phút** |
| 0,25 MB/s *(4G yếu / wifi nghẽn)* | **52 s** | **10,8 phút** |

## 5. Lazy (D027) — **không** regress

| màn | `<img>` trong list | có `loading="lazy"` |
|---|---|---|
| `/crm` | 165 | **165/165** |
| cửa Gala | 162 | **162/162** |
| cửa Tọa đàm | — | thẻ `loading="lazy"` có trong mã |

Bằng chứng lazy đang **chạy đúng**: `/crm` mở màn chỉ tải 8/165 ảnh (4,8%), và cuộn 2 màn đầu
**không tải thêm tấm nào** (ảnh dưới đó đã nằm trong ngưỡng nạp trước của trình duyệt).

⇒ **Chậm không phải do lazy hỏng.** Lazy đang che được phần lớn; cái lộ ra là **mỗi tấm nó tải
đều là file gốc**.

## 6. Chi phí redirect

`/crm/photos/:id` trả **302** rồi mới sang MinIO presign. Riêng bước 302 đo được **81 ms** (chưa
tải một byte ảnh nào). Với 165 avatar là **~13 giây thuần vòng lặp**, kể cả khi ảnh nhẹ tới đâu.
Trên mạng trễ cao (4G hội trường) con số này nhân lên.

---

## Kết luận đo được (không suy diễn)

1. **Chậm ngay khi chưa cuộn là thật** — cửa Gala kéo **13,03 MB** ở màn đầu.
2. **Gốc là kích thước file, không phải lazy.** Lazy đúng (165/165), nhưng mỗi tấm là ảnh gốc
   trung bình 1,4 MB, cá biệt 19,87 MB.
3. **17 ảnh > 5 MB gánh 57% kho** — đây là chỗ tập trung thiệt hại.
4. **Redirect 302 mỗi ảnh** cộng thêm ~81 ms/tấm, độc lập với việc thu nhỏ ảnh.
5. Một lượt PG lướt hết danh sách Gala = **162,6 MB**. Trên wifi 0,5 MB/s là **hơn 5 phút**.

**Dừng ở đây theo prompt.** Không thiết kế thumbnail, không đụng mã, chờ anh GO D029.

---

§B7: đây là bản ĐO, không phải Gate. Số trên do R1 tự chạy trên prod lúc 07:1x–07:2x ngày 05/08;
dữ liệu prod đang sống (348 khách active) nên đo lại lúc khác có thể lệch vài phần trăm.
