#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tạo QR code cho link Landing page — Gala 20 năm ESUHAI Group.
Xuất bản lúc: 2026-07-24 17:32  ·  CL1 – Hương Ly

CÁCH DÙNG (sau khi đã có link GitHub Pages công khai):
    python3 make_qr.py "https://<tên-github>.github.io/esuhai-20nam-rsvp/dang-ky.html" QR_ToaDam_Gala
    python3 make_qr.py "https://<tên-github>.github.io/esuhai-20nam-rsvp/tiec-toi.html" QR_ChiGala

Mỗi lệnh tạo 2 file trong thư mục này:
    <tên>.png   (dán vào thiệp mời / poster / màn hình)
    <tên>.svg   (in khổ lớn không vỡ nét)

Nếu bỏ trống tên file, mặc định là "QR_DangKy_ESUHAI20".
"""
import sys

try:
    import segno
except ImportError:
    sys.exit("Chưa có thư viện 'segno'. Cài bằng:  python3 -m pip install --user segno")


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print(__doc__)
        sys.exit("Thiếu link. Ví dụ:  python3 make_qr.py \"https://....github.io/esuhai-20nam-rsvp/dang-ky.html\"")

    url = sys.argv[1].strip()
    out = sys.argv[2].strip() if len(sys.argv) > 2 else "QR_DangKy_ESUHAI20"

    # error='m' (sửa lỗi 15%) — cân bằng độ bền và độ thưa. Link GitHub Pages ngắn nên QR thoáng, đẹp.
    qr = segno.make(url, error="m")

    png, svg = out + ".png", out + ".svg"
    # Màu navy ESUHAI trên nền trắng để tương phản cao, quét nhạy.
    qr.save(png, scale=14, border=4, dark="#0b1e38", light="#ffffff")
    qr.save(svg, scale=14, border=4, dark="#0b1e38", light="#ffffff")

    print("✔ Đã tạo QR code:")
    print("   -", png)
    print("   -", svg)
    print("   Link đã mã hoá:", url)
    print("\nHãy quét thử bằng camera điện thoại để kiểm tra trước khi gửi khách.")


if __name__ == "__main__":
    main()
