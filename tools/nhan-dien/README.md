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

## Đo được tới đâu

`node do-phat-hien.js <thư mục ảnh>` — số mặt, cỡ cạnh, thời gian mỗi ảnh.
`node do-ve-khung.js <thư mục> <tệp...>` — vẽ khung + mốc để **nhìn**, vì số mặt
hợp lý chưa phải bằng chứng khung đặt đúng chỗ.
