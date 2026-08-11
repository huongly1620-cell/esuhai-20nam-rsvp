# E08-D077 · Nhận diện khuôn mặt cho ảnh sự kiện

Chạy **tách hẳn** khỏi `esuhai-web` (FR-1): gói riêng, `node_modules` riêng, không
thêm phụ thuộc biên dịch nặng nào vào tiến trình đang phục vụ traffic.

## Cài

```
npm install
npm run tai-model      # tải YuNet + SFace, kiểm checksum, lưu vào model/
```

`tai-model` là **bước riêng có chủ đích** (AC-4). Lệnh batch thiếu file model thì
dừng, không tự tải giữa chừng — nếu batch tự tải thì "0 egress lúc chạy" không
còn kiểm được, và một lần chạy có thể lặng lẽ kéo về file khác với file đã kiểm.

## Giấy phép trọng số — đo, không chép lại lời

| Model | Việc | Giấy phép **thật** (lấy từ repo lúc tải) |
|---|---|---|
| YuNet `2023mar` | phát hiện mặt | **MIT** — Copyright (c) 2020 Shiqi Yu |
| SFace `2021dec` | đặc trưng khuôn mặt | **Apache-2.0** |

CR-134 ghi cả hai là Apache-2.0. YuNet thực tế là MIT. MIT không chặt hơn nên
không phải rào cản, nhưng hồ sơ nên khớp thực tế — đã báo để đính chính.

## Chạy trực — E08-D126

Trước D126, chạy nhiều luồng nghĩa là chia việc bằng phép tính tay:

```
node batch.js --commit --bo-qua 0    --gioi-han 1750 &
node batch.js --commit --bo-qua 1800 --gioi-han 1750 &   # rồi lệch 60 giây…
```

Tối 11/08 cách đó chạy 5 luồng và **cả 5 chết trong 11 phút**. Hàng đợi co lại
trong lúc chạy nên các cửa sổ có thể chồng nhau, không ai nhìn thấy gì cho tới
lúc mở terminal, và dừng được đúng một cách là `kill`.

Nay việc được **giữ theo tấm**, không chia theo cửa sổ:

```
node batch.js --truc                 # đứng trực, nhận luồng từ trang web
for i in 1 2 3; do node batch.js --truc & done   # ba luồng, không cần tính gì
```

Người vận hành bấm **Bắt đầu quét** ở `/crm/anh-su-kien` và chọn 1–6 luồng. Máy
quét đang trực nhận việc trong vài giây, rồi trang hiện tiến độ toàn kho, một
dòng mỗi luồng, và nút Tạm dừng / Tiếp tục cho từng luồng.

- Máy quét **đọc cờ sau mỗi tấm**. Tạm dừng ăn trong vài giây và nhả hết tấm
  chưa soi về hàng đợi — không tấm nào bị soi hai lần, không tấm nào bị bỏ.
- Mất mạng không làm sập tiến trình: lỗi kết nối được bắt ở tầng pool, tấm lỗi
  thử lại 3 lần (1s · 4s · 15s) rồi quay về hàng đợi.
- Lỗi quá 20% trong 100 tấm gần nhất thì luồng **tự tạm dừng** kèm lý do.
- `--truc --mot-luot`: làm xong một đợt rồi thoát (máy chủ web dùng cờ này khi
  nó tự dựng luồng ở máy có sẵn engine).
- `--truc` bao hàm `--commit`. Cờ cũ `--gioi-han` · `--bo-qua` · `--khop-lai`
  giữ nguyên cho lượt chạy tay, nhưng chúng **không còn** là cách chia việc.

Ctrl-C giữa chừng là an toàn: máy quét nhả tấm đang giữ trước khi thoát. Máy sập
nguồn cũng an toàn — web thấy luồng mất nhịp quá 3 phút thì đánh `mất liên lạc`
và trả tấm về hàng đợi.

## Đo được tới đâu

`node do-phat-hien.js <thư mục ảnh>` — số mặt, cỡ cạnh, thời gian mỗi ảnh.
`node do-ve-khung.js <thư mục> <tệp...>` — vẽ khung + mốc để **nhìn**, vì số mặt
hợp lý chưa phải bằng chứng khung đặt đúng chỗ.

## Kiểm giao thức hàng đợi — không cần engine

```
DATABASE_URL=postgres://…/lab node kiem-hang-doi.js --anh 600 --luong 5
```

Dựng 600 tấm giả, cho 5 luồng cùng cào một hàng đợi (khởi động cùng lúc, không
lệch giây nào), bấm tạm dừng giữa chừng, giết một luồng, rồi đếm lại: không tấm
nào bị soi hai lần, không tấm nào bị bỏ, số trên sổ khớp số trong kho. Chạy được
trên một Postgres rỗng trong 20 giây — **không** cần model, onnxruntime, sharp
hay MinIO, vì phần quyết định «tấm này thuộc về ai» nằm gọn trong `hang-doi.js`.

Lệnh này **xoá và gieo lại** dữ liệu ảnh, nên nó từ chối chạy nếu chuỗi kết nối
không mang chữ `lab` hoặc `test`.
