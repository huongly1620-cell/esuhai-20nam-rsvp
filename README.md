# Landing page Xác nhận tham dự — Gala 20 năm ESUHAI Group

Trang mời khách **xác nhận tham dự** và **gửi lời chúc / ý kiến** cho lễ kỷ niệm
**20 năm ESUHAI Group** · Thứ Bảy **08/08/2026** · GEM Center, TP. Hồ Chí Minh.

*Xuất bản lúc: 2026-07-24 17:32 · CL1 – Hương Ly*

---

## Hai trang (2 link riêng cho 2 nhóm khách)

| Trang | Dành cho | Nội dung |
|---|---|---|
| **`dang-ky.html`** | Khách dự **cả Tọa đàm chiều + Gala tối** | Đầy đủ 2 phần, khách tự chọn phần tham dự |
| **`tiec-toi.html`** | Khách **chỉ dự Gala tối** | Tự ẩn phần Tọa đàm, đổi lời dẫn thành thư mời Dạ tiệc |

`index.html` chỉ là trang gốc, tự chuyển hướng sang `dang-ky.html`.

Khách điền xong → dữ liệu tự **ghi 1 dòng vào Google Sheet** của ban tổ chức
(tên, đơn vị, số khách, ẩm thực, lời chúc, ghi chú…).

---

## Cách hoạt động (2 mảnh ghép)

```
  Khách  ──►  GitHub Pages (trang đẹp)  ──►  Google Apps Script  ──►  Google Sheet
              dang-ky.html / tiec-toi.html    (Code.gs, link /exec)     (danh sách khách)
```

- **GitHub Pages** lo phần *hiển thị trang đẹp + link công khai* (miễn phí).
- **Google Sheet + Apps Script** lo phần *chứa dữ liệu* (miễn phí).

---

## Cấu trúc thư mục

```
esuhai-20nam-rsvp/
├── index.html                     # trang gốc → chuyển hướng sang dang-ky.html
├── dang-ky.html                   # TRANG 1: Tọa đàm + Gala
├── tiec-toi.html                  # TRANG 2: chỉ Gala tối
├── config.js                      # ★ CHỖ DUY NHẤT cần sửa: dán link /exec vào đây
├── apps-script/
│   ├── Code.gs                    # backend: nhận dữ liệu, ghi vào Google Sheet
│   └── HUONG_DAN_DEPLOY.md        # cách deploy Apps Script + lấy link /exec
├── tools/
│   └── make_qr.py                 # tạo mã QR từ link
├── HUONG_DAN_GITHUB.md            # cách đưa lên GitHub + bật Pages (kéo-thả, không cần Terminal)
└── README.md                      # file này
```

---

## Bắt đầu từ đâu?

1. **Đưa trang lên mạng:** làm theo **[HUONG_DAN_GITHUB.md](HUONG_DAN_GITHUB.md)**.
2. **Nối với Google Sheet:** làm theo **[apps-script/HUONG_DAN_DEPLOY.md](apps-script/HUONG_DAN_DEPLOY.md)**,
   rồi dán link `/exec` vào **`config.js`**.
3. **Tạo QR** cho 2 link bằng `tools/make_qr.py`.

> Mọi thắc mắc trong lúc làm, chụp màn hình gửi trợ lý — sẽ hướng dẫn tiếp từng bước.
