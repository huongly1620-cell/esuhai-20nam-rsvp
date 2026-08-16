#!/usr/bin/env python3
"""E08-D135 · Bộ đo cho vé «cuộn mượt: bỏ kính mờ ở thẻ lặp lại».

Bốn chế độ trong MỘT tệp — không phải sở thích mà là ràng buộc do AC ép ra: AC-7
cho phép `git diff` chạm đúng ba tệp và AC-8 giữ `npm test` ở 31/31, nên thêm một
`test/d135-*.test.js` là phá cả hai. Cái giá phải nói thẳng: phép canh gác tĩnh
(AC-4) KHÔNG tự chạy trong `npm test`, phải có người gọi tay.

    # AC-1 · AC-2 · AC-3 — số khung khi cuộn, so TRƯỚC với SAU trong cùng một lượt
    python3 test/ui/do-cuon.py --truoc d5f7fb9 --sau cay
    python3 test/ui/do-cuon.py --truoc d5f7fb9 --sau cay crm-kho-anh.html

    # AC-4 — canh gác tĩnh: tập (tệp, selector) phải BẰNG whitelist, hai chiều
    python3 test/ui/do-cuon.py --canh-gac

    # AC-5 — 16 PNG + JSON hình học + diff ảnh có mặt nạ
    python3 test/ui/do-cuon.py --anh --truoc d5f7fb9 --sau cay [--anh-ra <thư mục>]

    # AC-6 — tương phản chữ/nền, đọc trên PIXEL ĐÃ TÔ
    python3 test/ui/do-cuon.py --tuong-phan --truoc d5f7fb9 --sau cay

`<ref>` là ref git bất kỳ (`d5f7fb9`, `HEAD`, `origin/main`) hoặc `cay` = tệp trên
đĩa của cây làm việc. `cay` là mặc định của `--sau`, và là thứ bảy phép đột biến
dùng: chúng sửa cây làm việc rồi `git checkout` trả lại.

VÌ SAO PHẢI CÓ `--truoc` chứ không chạy hai lần rồi tự nhớ số: bài học
`phep-do-hai-chieu-do-cu-doi`. Hai bản HTML đi qua CÙNG một tiến trình Chromium,
CÙNG một lượt, xen kẽ nhau — không có cách nào để hai cột lệch vì máy khác hay vì
lượt chạy khác.

DPR LÀ ĐIỀU KIỆN HIỆU LỰC CỦA PHÉP ĐO. Ở DPR 1, `backdrop-filter` không tốn gì đo
được (121 khung ở cả nguyên trạng lẫn khi tắt); ở DPR 2 nó nuốt hơn nửa số khung —
làm mờ ở DPR 2 là xử lý gấp bốn số điểm ảnh. Nên một lượt đo DPR 1 sẽ báo XANH cho
bản CHƯA sửa gì. Script ép `--force-device-scale-factor` và tự khai `dpr` thực tế;
`dpr < 2` ⇒ THOÁT MÃ 2, không bao giờ trả xanh. Cờ `--dpr 1` có mặt CHỈ để chạy
đúng cú đột biến ấy (M-3b) và chứng minh cái chốt này biết nói không.

Không prod, không Postgres, không MinIO, không ảnh người thật: fixture là chữ + ô
màu sinh bằng mã, gieo bằng ĐÚNG class của trang (khuôn `test/ui/do-ac7.py`).

Mã thoát: 0 đạt · 1 không đạt · 2 DPR < 2 (phép đo mù, từ chối chạy) · 3 thiếu
điều kiện chạy (playwright / Pillow / tệp không đọc được).
"""
import argparse
import base64
import json
import os
import re
import shutil
import statistics
import subprocess
import sys

GOC = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(GOC, "..", ".."))
VIEWS = os.path.join("server", "crm", "views")
ANH_RA_MAC_DINH = os.path.join(GOC, "anh")

MAN = ("crm-kho-anh.html", "crm-nhan-dien.html")
TEN_NGAN = {"crm-kho-anh.html": "kho-anh", "crm-nhan-dien.html": "nhan-dien"}

MS_CUON = 2000      # mỗi lượt cuộn 2 giây ⇒ ~120 khung kỳ vọng ở 60Hz
SO_LUOT = 3         # ≥2 lượt ĐO (chưa kể lượt hâm nóng): một lượt đơn nói dối
SO_THE = 12         # §2.2 của plan: 12 thẻ đã đủ xấu bằng 60 thẻ
NHIP_60 = 1000 / 60


# ══════════════════════════════════════════════════════════════════════════════
# WHITELIST — AC-4
# ══════════════════════════════════════════════════════════════════════════════
# Mỗi mục = một CHỖ KHAI `backdrop-filter` được phép tồn tại SAU D135.
# Luật FR-2: được giữ ⟺ phần tử SỐ ÍT, kích thước cố định, không nhân theo nội dung.
# Một "chỗ khai" = một cặp (tệp, selector trong cùng): khối vừa có `-webkit-` vừa có
# tên không tiền tố vẫn đếm là MỘT, vì cái quyết định chi phí là phần tử chứ không
# phải số dòng CSS.
#
# So HAI CHIỀU với tập quét được. Thừa ⇒ đỏ (chặn vé sau lén thêm mờ vào thẻ lặp);
# THIẾU ⇒ cũng đỏ (chặn ai đó xoá nhầm kính mờ của `.tab`/`.top`, tức chặn vi phạm
# FR-2). Whitelist chỉ chặn một chiều thì FR-2 không có phép nào canh.
WHITELIST = {
    # ── crm-kho-anh.html · 12 chỗ ────────────────────────────────────────────
    ("crm-kho-anh.html", ".tab"):
        "một thanh tab dính đỉnh — đứng yên khi cuộn, chi phí không theo nội dung",
    ("crm-kho-anh.html", ".tile .st"):
        "dấu trạng thái trên mỗi ô kho — lớp B: bỏ không mua thêm khung (64→60), "
        "lại nằm trên ẢNH nên bỏ mờ là đổi tương phản thật",
    ("crm-kho-anh.html", ".coach"):
        "coach mark đơn, hiện một lần rồi nhớ là đã đọc",
    ("crm-kho-anh.html", ".tip"):
        "tooltip position:fixed, đúng một cái trên trang",
    ("crm-kho-anh.html", ".lb"):
        "nền lightbox — chỉ tồn tại khi ảnh đang mở lớn, lúc ấy không ai cuộn",
    ("crm-kho-anh.html", ".lb-cap"):
        "chú thích trong lightbox, một cái",
    ("crm-kho-anh.html", ".lb-x"):
        "nút đóng lightbox, một cái",
    ("crm-kho-anh.html", ".lb-nav"):
        "hai nút lật ảnh, cố định",
    ("crm-kho-anh.html", ".appdlg"):
        "nền hộp thoại, một cái, chỉ khi mở",
    ("crm-kho-anh.html", ".toast"):
        "một lời báo trôi qua",
    ("crm-kho-anh.html", "#pickCard"):
        "override `none` CÓ SẴN (D083/AC-24): thẻ kính mờ làm containing block cho "
        "#actBar position:fixed — giữ nguyên, không phải chỗ D135 chạm",
    ("crm-kho-anh.html", "#actBar"):
        "dải hành động dính đáy ở khổ ≤480px — đứng yên khi cuộn",
    # ── crm-nhan-dien.html · 8 chỗ ───────────────────────────────────────────
    ("crm-nhan-dien.html", ".khoi"):
        "override `none` CÓ SẴN — tiền lệ của chính vé này, đã sống trên LIVE",
    ("crm-nhan-dien.html", ".hieu,.nhan,.pt"):
        "ba nhãn dán trên mỗi ô ẢNH — lớp B: bỏ không mua thêm khung (58→54), "
        "và nền của chúng là ảnh chứ không phải nền trang",
    ("crm-nhan-dien.html", ".tab"):
        "một thanh tab dính đỉnh",
    ("crm-nhan-dien.html", ".tick"):
        "ô tick trên mỗi ô ảnh — lớp B, cùng lý do",
    ("crm-nhan-dien.html", ".thanhChon"):
        "thanh duyệt/tải trôi đáy khối ở ≥700px — đứng yên khi cuộn",
    ("crm-nhan-dien.html", ".ta-ds"):
        "hộp gợi ý tên, một cái, chỉ khi gõ",
    ("crm-nhan-dien.html", ".appdlg"):
        "nền hộp thoại, một cái",
    ("crm-nhan-dien.html", ".khoi-cho"):
        "override `none` CÓ SẴN cho khung chờ",
    # ── crm-app-v2.html · 6 chỗ — KHÔNG nằm trong phạm vi D135 ────────────────
    ("crm-app-v2.html", ".top"):
        "thanh đầu trang dính đỉnh, một cái — màn này đã đo là sạch (236 khung)",
    ("crm-app-v2.html", ".menu-pop"):
        "menu ⋯ đổ xuống, một cái",
    ("crm-app-v2.html", ".sheet"):
        "nền tấm trượt, một cái",
    ("crm-app-v2.html", ".to-top"):
        "nút về đầu trang, một cái",
    ("crm-app-v2.html", ".toast"):
        "một lời báo trôi qua",
    ("crm-app-v2.html", ".appdlg"):
        "nền hộp thoại, một cái",
    # ── crm-app.html (bản cũ) · 5 chỗ — KHÔNG đụng ───────────────────────────
    ("crm-app.html", ".top"): "bản CRM cũ, ngoài phạm vi vé",
    ("crm-app.html", ".menu-pop"): "bản CRM cũ, ngoài phạm vi vé",
    ("crm-app.html", ".sheet"): "bản CRM cũ, ngoài phạm vi vé",
    ("crm-app.html", ".to-top"): "bản CRM cũ, ngoài phạm vi vé",
    ("crm-app.html", ".toast"): "bản CRM cũ, ngoài phạm vi vé",
    # crm-login.html · 0 chỗ — cố ý không có mục nào.
}


# ══════════════════════════════════════════════════════════════════════════════
# Đọc nguồn: git ref hoặc cây làm việc
# ══════════════════════════════════════════════════════════════════════════════
def nguon(ref, ten):
    """HTML của một view, lấy từ `git show <ref>:…` hoặc từ đĩa khi ref là `cay`."""
    duong = os.path.join(VIEWS, ten)
    if ref == "cay":
        with open(os.path.join(REPO, duong), encoding="utf-8") as f:
            return f.read()
    ra = subprocess.run(["git", "show", f"{ref}:{duong}"], cwd=REPO,
                        capture_output=True, text=True)
    if ra.returncode != 0:
        print(json.dumps({"ok": False, "loi": f"không đọc được {ref}:{duong}",
                          "git": ra.stderr.strip()}, ensure_ascii=False))
        sys.exit(3)
    return ra.stdout


def rut_style(html):
    """Nối mọi khối <style> của tệp. Chỉ CSS — fixture không chạy một dòng JS nào
    của trang: vé này chấm CSS, và JS thật cần API thật."""
    return "\n".join(m.group(1) for m in
                     re.finditer(r"<style[^>]*>(.*?)</style>", html, re.S | re.I))


# ══════════════════════════════════════════════════════════════════════════════
# AC-4 · quét tĩnh
# ══════════════════════════════════════════════════════════════════════════════
def _che(css):
    """Thay RUỘT của chú thích `/* … */` và của chuỗi trong nháy bằng dấu cách,
    giữ nguyên độ dài và mọi ký tự xuống dòng.

    Vì sao không xoá hẳn: xoá là lệch mọi vị trí, mà số dòng in ra phải là số dòng
    THẬT của tệp thì người đọc mới mở đúng chỗ. Vì sao bắt buộc phải bóc: hai dòng
    chú thích ở `crm-app-v2.html:162,167` nhắc tên `backdrop-filter` — không bóc
    thì bộ quét báo đỏ oan, và một phép canh gác kêu oan là một phép canh gác sẽ
    bị tắt.
    """
    ra = list(css)
    i, n = 0, len(css)
    while i < n:
        c = css[i]
        if c == "/" and i + 1 < n and css[i + 1] == "*":
            j = css.find("*/", i + 2)
            j = n if j < 0 else j + 2
        elif c in "\"'":
            j = i + 1
            while j < n and css[j] != c:
                j += 2 if css[j] == "\\" else 1
            j = min(j + 1, n)
        else:
            i += 1
            continue
        for k in range(i, j):
            if ra[k] != "\n":
                ra[k] = " "
        i = j
    return "".join(ra)


def chuan_hoa(sel):
    """`.pt , .hieu ,.nhan` và `.hieu,.nhan,.pt` phải là MỘT khoá, không thì
    whitelist thành trò may rủi theo cách gõ.

    Hạ chữ thường · gom chuỗi trắng · tách theo `,` · SẮP XẾP · nối lại bằng `,`.
    Điều kiện của `@supports`/`@media` KHÔNG vào khoá: cái quyết định chi phí là
    phần tử, không phải điều kiện bọc ngoài.
    """
    phan = [re.sub(r"\s+", " ", p).strip().lower() for p in sel.split(",")]
    return ",".join(sorted(p for p in phan if p))


def _trong_cung(ngan_xep):
    for s in reversed(ngan_xep):
        if not s.startswith("@"):
            return s
    return ""


def quet_backdrop(ten, html):
    """Mọi chỗ khai `backdrop-filter` / `-webkit-backdrop-filter` trong <style>.

    Cố ý KHÔNG dựng trình phân tích CSS: bốn bước dưới đây đủ đúng cho khối
    <style> viết tay của repo này, và một bộ quét 40 dòng đọc được thì người sau
    còn sửa được.
    """
    ra = []
    for m in re.finditer(r"<style[^>]*>(.*?)</style>", html, re.S | re.I):
        css = m.group(1)
        dong_goc = html[:m.start(1)].count("\n")
        sach = _che(css)
        n = len(sach)
        ngan_xep, dau, i = [], 0, 0
        while i < n:
            c = sach[i]
            if c == "{":
                ngan_xep.append(sach[dau:i].strip())
                dau = i = i + 1
                continue
            if c == "}":
                if ngan_xep:
                    ngan_xep.pop()
                dau = i = i + 1
                continue
            if c == ";":
                dau = i = i + 1
                continue
            ten_tt = None
            if sach.startswith("-webkit-backdrop-filter", i):
                ten_tt = "-webkit-backdrop-filter"
            elif sach.startswith("backdrop-filter", i):
                ten_tt = "backdrop-filter"
            # Phải đứng ở ĐẦU một khai báo mới là tên thuộc tính — không thì cái
            # `backdrop-filter` nằm giữa `-webkit-backdrop-filter` bị đếm hai lần.
            if ten_tt and not sach[dau:i].strip():
                ket = min([x for x in (sach.find(";", i), sach.find("}", i)) if x >= 0]
                          or [n])
                ra.append({
                    "tep": ten,
                    "selector": _trong_cung(ngan_xep),
                    "khoa": chuan_hoa(_trong_cung(ngan_xep)),
                    "dong": dong_goc + css[:i].count("\n") + 1,
                    "gia_tri": " ".join(sach[i:ket].split()),
                    "thuoc_tinh": ten_tt,
                })
            i += 1
    return ra


def canh_gac():
    wl = {(t, chuan_hoa(s)): ly for (t, s), ly in WHITELIST.items()}
    tep = sorted(f for f in os.listdir(os.path.join(REPO, VIEWS)) if f.endswith(".html"))
    khai, chi_tiet = set(), []
    for t in tep:
        with open(os.path.join(REPO, VIEWS, t), encoding="utf-8") as f:
            html = f.read()
        for d in quet_backdrop(t, html):
            khai.add((t, d["khoa"]))
            chi_tiet.append(d)

    thua = sorted(khai - set(wl))
    thieu = sorted(set(wl) - khai)
    ok = not thua and not thieu
    print(json.dumps({
        "ac": "AC-4", "ok": ok,
        "tep_quet": tep,
        "so_cho_khai": len(khai),
        "so_whitelist": len(wl),
        "THUA": [{"tep": t, "selector": s,
                  "dong": sorted({d["dong"] for d in chi_tiet
                                  if d["tep"] == t and d["khoa"] == s})}
                 for t, s in thua],
        "THIEU": [{"tep": t, "selector": s, "ly_do_giu": wl[(t, s)]} for t, s in thieu],
        "theo_tep": {t: sorted({d["khoa"] for d in chi_tiet if d["tep"] == t}) for t in tep},
    }, ensure_ascii=False, indent=2))
    return 0 if ok else 1


# ══════════════════════════════════════════════════════════════════════════════
# Fixture — gieo bằng ĐÚNG class của trang, nội dung sinh bằng mã
# ══════════════════════════════════════════════════════════════════════════════
def _o_mau(i, w=240, h=180):
    """Một «tấm ảnh» = ô màu + số thứ tự, sinh bằng mã. KHÔNG ảnh người thật,
    không lấy từ prod (Security/PDPL của spec). Màu suy từ chỉ số nên hai lượt
    chạy ra hai ảnh giống hệt nhau — hạt ngẫu nhiên ở đây là làm hỏng cả AC-5."""
    a, b = (i * 47) % 360, (i * 47 + 40) % 360
    svg = (
        f"<svg xmlns='http://www.w3.org/2000/svg' width='{w}' height='{h}'>"
        f"<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
        f"<stop offset='0' stop-color='hsl({a},40%,36%)'/>"
        f"<stop offset='1' stop-color='hsl({b},36%,20%)'/></linearGradient></defs>"
        f"<rect width='100%' height='100%' fill='url(#g)'/>"
        f"<text x='50%' y='54%' font-size='34' font-family='monospace' "
        f"text-anchor='middle' fill='rgba(255,255,255,.55)'>{i:03d}</text></svg>")
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


# Mỗi màn thật của repo có nhiều MÀN CON, và chúng KHÔNG giống nhau về chi phí —
# đây là phát hiện của lượt thi công, không có trong plan, và nó đổi cách đọc AC-2.
# Màn con đứng ĐẦU danh sách là màn AC-1/AC-2 chấm; các màn con sau được đo và ghi
# sổ trong cùng một hiện vật, không gác cổng.
MAN_CON = {
    "crm-kho-anh.html": ("kho",),
    "crm-nhan-dien.html": ("mot-khach", "phan-loai"),
}
# Vì sao `mot-khach` là màn chấm của AC-2 chứ không phải `phan-loai`: xem chú thích
# dài ở `_than_nhan_dien`. Ngắn gọn — trên `phan-loai` lưới ảnh nằm NGOÀI mọi thẻ,
# nên `.card` không phủ lên vùng cuộn và bỏ mờ nó không mua được gì; trên
# `mot-khach` toàn bộ lưới nằm TRONG một `.card`, đúng hình dáng mà vé này chữa.


def _o_kho(i):
    return (f'<div class="tile" role="button" tabindex="0">'
            f'<img loading="lazy" style="aspect-ratio:4 / 3" src="{_o_mau(i)}" alt="">'
            f'<div class="go"><button type="button">Gỡ mềm</button>'
            f'<button type="button" class="cung">Xoá cứng</button></div>'
            f'<span class="st"></span><div class="nm">DSC_{i:04d}.jpg</div></div>')


def _o_anh(i):
    """Ô lưới của trang Ảnh sự kiện — kèm đủ LỚP B (`.pt`, `.nhan`, `.tick`), thứ
    vé này CỐ Ý giữ nguyên. Bỏ chúng khỏi fixture là tự tặng mình một con số đẹp:
    phần lớn chi phí còn lại của màn Phân loại nằm đúng ở đây."""
    cho = i % 3 != 0
    return (f'<div class="anh-o {"cho" if cho else "alb"}">'
            f'<img loading="lazy" src="{_o_mau(i)}" alt="">'
            + (f'<span class="pt{" chac" if i % 5 == 0 else ""}">{40 + i % 55}%</span>'
               if cho else "")
            + '<span class="nhan" role="img" aria-label="chờ duyệt">'
              '<svg class="ic" viewBox="0 0 16 16" width="11" height="11">'
              '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/></svg></span>'
              '<label class="tick"><input type="checkbox"></label></div>')


def _dau_kho():
    return (
        '<header><h1>📸 Ảnh sự kiện</h1><div class="spacer"></div>'
        '<div class="me" style="display:flex"><b>BTL</b><span>lab@esuhai.com</span></div>'
        '<button class="lang" type="button">日本語</button>'
        '<button class="icobtn" type="button">&#9789;</button>'
        '<a class="btn sm" href="#">← Về CRM</a></header>'
        '<nav class="tab"><a class="chip" href="#" aria-current="page">Kho</a>'
        '<a class="chip" href="#">Phân loại</a><a class="chip" href="#">Theo khách</a></nav>')


def _than_kho_anh(so_the, man_con="kho"):
    """Trang Kho ảnh, đúng hình dáng của `crm-kho-anh.html:502-599`:

        .card  ← nguồn (chọn thư mục / kéo thả)
        .card#pickCard ← bộ chọn: .stat, #actBar, lưới tick, .coach
        .card  ← «Đã có trong kho»: #khoWrap = .dot-row DÍNH ĐỈNH + .grid-kho

    Thẻ thứ ba là thẻ QUAN TRỌNG: cả kho ảnh nằm TRONG nó, nên nó cao bằng cả
    trang. Đây chính là «thẻ lặp theo nội dung» mà spec nói — không phải nhiều thẻ
    cạnh nhau, mà một thẻ dài ra theo số ảnh. Gieo thêm thẻ cho đủ N là gieo một
    trang không tồn tại.
    """
    tick = "".join(f'<div class="tile" role="button" tabindex="0">'
                   f'<img src="{_o_mau(i)}" alt=""><button class="ck" type="button"></button>'
                   f'<span class="st"></span><div class="nm">IMG_{i:04d}.jpg</div></div>'
                   for i in range(24))
    stat = "".join(f'<div><b class="num">{n}</b><span>{c}</span></div>'
                   for n, c in ((312, "ảnh đọc được"), (128, "đang tick chọn"),
                                (4, "bỏ qua (HEIC)"), (96, "đã vào kho lượt này")))
    dot = "".join(f'<button class="dot-chip{" on" if j == 0 else ""}" type="button">'
                  f'Đợt 08/08 · {j + 1}</button>' for j in range(5))
    return (
        '<div class="wrap">' + _dau_kho()
        + '<div class="card"><div class="srcbar"><strong class="srclbl">Nguồn:</strong>'
          '<button class="btn gold" type="button">📁 Chọn thư mục</button>'
          '<button class="btn" type="button">🖼 Chọn từng ảnh</button>'
          '<button class="btn cloud" type="button" disabled>Dropbox <span class="soon">Sắp có</span></button>'
          '</div><div class="drop">…hoặc kéo thả thư mục / ảnh vào đây</div>'
          '<p class="hint" style="margin:12px 0 0">Ảnh <b>đọc thẳng từ đĩa</b> để xem trước — '
          'chưa một byte nào lên mạng.</p></div>'
        # `#pickCard` giữ NGUYÊN `display:none` như trang thật; mọi chế độ tự mở nó
        # ra (xem JS_MO_PICK) — nó là thẻ nhiều chữ nhất và là chỗ DUY NHẤT dùng
        # `--muted2`, tức trường hợp tệ nhất của AC-6. Không mở thì AC-6 xanh vì đã
        # không nhìn.
        + '<div class="card" id="pickCard" style="display:none">'
          '<div class="stat">' + stat + '</div>'
          '<div class="toolbar" id="actBar">'
          '<button class="btn sm" type="button">Chọn hết</button>'
          '<button class="btn sm" type="button">Bỏ chọn hết</button><div class="spacer"></div>'
          '<button class="btn green" type="button">⬆ Đồng bộ ảnh đã chọn</button></div>'
          '<p class="why">Chọn ít nhất một ảnh để bật nút Đồng bộ.</p>'
          '<div class="barwrap"><div class="bar"><i style="width:38%"></i></div>'
          '<span class="barnum num">96/312 · 38%</span></div>'
          '<p class="hint">Đang đẩy ảnh lên kho…</p>'
          '<div class="coach on"><span class="ic">💡</span>'
          '<p>Kéo một khung quanh nhiều ảnh để tick nhanh. <b>Giữ Shift</b> để nối tiếp.</p>'
          '<button class="btn sm" type="button">Đã hiểu</button></div>'
          '<div class="grid">' + tick + '</div></div>'
        + '<div class="card"><div class="toolbar" style="margin:0">'
          '<strong>Đã có trong kho</strong>'
          '<button class="btn sm" type="button">Tải lại</button><div class="spacer"></div>'
          f'<span class="hint">{so_the * 12} tấm · 5 đợt</span></div>'
          '<div><div class="dot-row">' + dot + '</div>'
          '<div class="grid-kho">' + "".join(_o_kho(i) for i in range(so_the * 12)) + '</div>'
          '<p class="hint" style="margin-top:10px">Cuộn tới cuối để tải thêm.</p>'
          '<div class="kho-chan"><button class="btn sm" type="button">Tải thêm</button></div>'
          '</div></div></div>')


def _dau_nhan_dien():
    return (
        '<div class="top"><button class="btn sm">← <span>Về CRM</span></button>'
        '<h1>📸 Ảnh sự kiện</h1><span class="hint">BTL</span><div class="spacer"></div>'
        '<button class="btn sm">日本語</button><button class="btn sm">☽</button></div>'
        '<div class="tab"><a class="chip" href="#">Kho</a>'
        '<button class="chip" aria-pressed="true">Phân loại</button>'
        '<button class="chip" aria-pressed="false">Theo khách</button></div>'
        '<div class="card" id="theDongBo"><div class="top" style="margin:0">'
        '<span class="qtt"><b>Đang quét</b></span>'
        '<button class="btn ok">Bắt đầu quét</button><div class="spacer"></div>'
        '<span class="hint">3 luồng</span></div>'
        '<p class="hint" style="margin:8px 0 0">Đã soi 1 248 / 3 006 tấm · còn khoảng 12 phút.</p>'
        '<p class="hint" style="margin:4px 0 0">Luồng 1 · IMG_0912.jpg — Luồng 2 · IMG_0913.jpg</p></div>')


def _than_nhan_dien(so_the, man_con="mot-khach"):
    """Trang Ảnh sự kiện có BỐN màn con, và hai màn có ảnh để cuộn KHÔNG cùng hình
    dáng — chỗ này là phát hiện của lượt thi công, xin ghi vào nhật ký:

      · `mot-khach` (`crm-nhan-dien.html:775-798`) — toàn bộ ảnh của một khách nằm
        TRONG một `.card`, nên thẻ ấy cao bằng cả trang và phủ trọn vùng cuộn. Đây
        là hình dáng mà D135 chữa, và là màn AC-2 chấm.
      · `phan-loai` (`:704-717`) — `.luoi` nằm NGOÀI mọi thẻ; hai `.card` trên đầu
        chỉ cao vài trăm pixel. Đo được: bỏ mờ `.card` ở đây gần như không đổi số
        khung, phần còn lại là LỚP B trên từng ô ảnh (`.pt`/`.nhan`/`.tick`) mà
        §2.4 của plan đã đo và cố ý giữ. Vẫn đo và vẫn nộp số, chỉ không gác cổng.

    Màn `theo-khach` không có mặt ở đây vì thẻ của nó là `.card.khoi`, đã
    `backdrop-filter:none` từ trước D135 — đo lại là đo một vé đã xong.
    """
    o = "".join(_o_anh(i) for i in range(so_the * 12))
    if man_con == "phan-loai":
        return ('<div class="wrap">' + _dau_nhan_dien()
                + '<div id="manAnh"><div class="card"><div class="hang-loc">'
                  '<button class="chip loc" aria-pressed="true">Tất cả</button>'
                  '<button class="chip loc" aria-pressed="false">Máy có gợi ý chờ duyệt</button>'
                  '<button class="chip loc" aria-pressed="false">Chưa gắn tên ai</button></div>'
                  '<p class="hint" style="margin:0">3 006 tấm · 412 tấm đang có gợi ý chờ duyệt.</p>'
                  '<p class="hint" style="margin:6px 0 0">Số góc phải là độ giống của máy — '
                  'không phải điểm chấm của người.</p></div>'
                  '<div class="luoi">' + o + '</div>'
                  '<div class="top" style="justify-content:center;margin-top:13px">'
                  '<button class="btn">Xem thêm ảnh</button></div></div></div>')
    return ('<div class="wrap">' + _dau_nhan_dien()
            + '<div id="manMotKhach">'
              '<div class="card top" style="margin-bottom:13px">'
              '<button class="btn sm">← <span>Khối theo khách</span></button>'
              '<strong id="tenMotKhach">Ông Lê Văn Ngỡi</strong><div class="spacer"></div>'
              f'<span class="hint">{so_the * 12} tấm · trang 1/3</span></div>'
              '<div class="card"><p class="hint" style="margin:0 0 9px">Toàn bộ ảnh của khách '
              'này, cả tấm đã vào album lẫn tấm máy đang đoán.</p>'
              '<label class="chonHet"><input type="checkbox"><span>Chọn hết trang này</span></label>'
              '<div class="luoi" style="margin-top:10px">' + o + '</div>'
              '<div class="top" style="justify-content:center;margin-top:12px">'
              '<button class="btn sm">← Trang trước</button><span class="hint">Trang 1/3</span>'
              '<button class="btn sm">Trang sau →</button></div>'
              '<div class="thanhChon"><button class="btn sm ok">Duyệt 0 tấm</button>'
              '<button class="btn sm bad">Bỏ 0 tấm</button><div class="spacer"></div>'
              '<label class="chonHet"><input type="checkbox"><span>Chọn hết</span></label>'
              '</div></div></div></div>')


def fixture(man, css, so_the=SO_THE, theme="toi", man_con=None):
    man_con = man_con or MAN_CON[man][0]
    than = (_than_kho_anh(so_the, man_con) if man == "crm-kho-anh.html"
            else _than_nhan_dien(so_the, man_con))
    dt = ' data-theme="light"' if theme == "sang" else ""
    # Không nạp webfont: mạng bị chặn trong lab, và một lượt chờ font hỏng là một
    # nguồn nhiễu khác nhau giữa hai cột. Cả TRƯỚC lẫn SAU cùng dùng font hệ thống.
    return ("<!doctype html><html lang=\"vi\"" + dt + "><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<title>lab d135</title><style>" + css + "</style></head><body>"
            + than + "</body></html>")


# ══════════════════════════════════════════════════════════════════════════════
# JS chạy trong trang
# ══════════════════════════════════════════════════════════════════════════════
# §15.1 · `#pickCard` mang display:none cho tới khi người dùng chọn thư mục, mà nó
# LÀ một `.card` — lại đúng thẻ chứa `.stat div span` dùng `--muted2`, trường hợp
# tệ nhất của cả hai màn. Không mở ra thì AC-6 xanh vì đã không nhìn.
JS_MO_PICK = """() => {
  const p = document.getElementById('pickCard');
  if (p) p.style.display = 'block';
  return !!p;
}"""

# Ép mọi ảnh giải mã XONG trước khi đo. `loading="lazy"` là đúng với trang thật,
# nhưng trong phép đo nó biến mỗi lượt cuộn thành một lượt giải mã 264 tấm — và
# một lượt giải mã thì làm rớt khung y như một lớp kính mờ. Không dọn nguồn nhiễu
# này thì hai cột chỉ đang so nhau xem lượt nào xui hơn.
JS_NAP_ANH = """async () => {
  const ds = [...document.images];
  ds.forEach(i => { i.loading = 'eager'; });
  await Promise.all(ds.map(i => i.decode().catch(() => {})));
  return ds.length;
}"""

# Đổi ĐÚNG khối <style>, giữ nguyên cây DOM và mọi ảnh đã giải mã. Đây mới là
# «cùng trang, cùng lượt cuộn, chỉ khác lớp CSS» mà spec mô tả: dựng lại trang cho
# mỗi phía là đưa thêm hai biến (ảnh chưa giải mã, layout lần đầu) vào một phép đo
# lẽ ra chỉ có một biến.
JS_DOI_CSS = """(css) => { document.querySelector('style').textContent = css; }"""

# Nhịp NGHỈ của chính cái máy đang chạy, đo trên trang trắng trước khi gieo gì.
# Không được đóng đinh 60Hz: máy soạn vé này chạy 120Hz, và một `khung_ky_vong`
# tính theo 60Hz sẽ đọc ra «241/120 khung — vượt 200% kỳ vọng», tức một phép đo tự
# khen mình. Ngưỡng AC là TỈ LỆ trên nhịp thật của máy, nên nó đúng ở cả 60Hz lẫn
# 120Hz mà không phải sửa con số nào.
JS_NHIP = """async () => {
  const moc = [];
  await new Promise(xong => {
    (function f(t){ moc.push(t);
      if (moc.length < 60) requestAnimationFrame(f); else xong(); })(performance.now());
  });
  const d = [];
  for (let i = 2; i < moc.length; i++) d.push(moc[i] - moc[i - 1]);
  d.sort((a, b) => a - b);
  return Math.round(d[Math.floor(d.length / 2)] * 100) / 100;
}"""

JS_CUON = """async ([ms, nhip_may]) => {
  window.scrollTo(0, 0);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const cao = document.documentElement.scrollHeight - window.innerHeight;
  const moc = [];
  await new Promise(xong => {
    const t0 = performance.now();
    let truoc = t0;
    (function buoc(t) {
      moc.push(t - truoc); truoc = t;
      window.scrollTo(0, Math.round(cao * Math.min(1, (t - t0) / ms)));
      if (t - t0 < ms) requestAnimationFrame(buoc); else xong();
    })(performance.now());
  });
  // Nhịp đầu đo từ t0 chứ không từ một khung đã vẽ — bỏ đi, không thì nó kéo lệch
  // đúng con số mà cả vé này đứng trên.
  const nhip = moc.slice(1);
  const sap = nhip.slice().sort((a, b) => a - b);
  const p = q => sap.length ? sap[Math.min(sap.length - 1, Math.floor(q * sap.length))] : 0;
  const thuc = nhip.reduce((a, b) => a + b, 0);
  return {
    dpr: window.devicePixelRatio,
    nhip_may: nhip_may,
    so_the: document.querySelectorAll('.card').length,
    khung: nhip.length,
    khung_ky_vong: Math.round(thuc / nhip_may),
    trung_vi: Math.round(p(0.5) * 10) / 10,
    p95: Math.round(p(0.95) * 10) / 10,
    // «rớt» = nhịp dài hơn 1,5 lần nhịp nghỉ ⇒ đã lỡ ít nhất một lượt quét màn.
    // `rot50` giữ mốc TUYỆT ĐỐI 50ms vì đó là mốc AC-1 viết ra, và vì 50ms là
    // ngưỡng mắt người thấy được cú khựng chứ không phải một tỉ lệ của máy.
    rot: nhip.filter(x => x > nhip_may * 1.5).length,
    rot50: nhip.filter(x => x > 50).length,
    cao_trang: document.documentElement.scrollHeight
  };
}"""

# Hộp + mọi thuộc tính có thể làm lệch bố cục. `background-color` và
# `backdrop-filter` nằm trong danh sách CỐ Ý: chúng là hai khoá DUY NHẤT được phép
# khác nhau, nên phải đo được thì mới nói được là chỉ có chúng khác.
JS_HINH_HOC = """() => {
  const KHOA = ['margin-top','margin-right','margin-bottom','margin-left',
    'padding-top','padding-right','padding-bottom','padding-left',
    'border-top-width','border-right-width','border-bottom-width','border-left-width',
    'border-top-color','border-right-color','border-bottom-color','border-left-color',
    'border-top-left-radius','border-top-right-radius',
    'border-bottom-left-radius','border-bottom-right-radius',
    'box-shadow','font-size','line-height','color','overflow','position','z-index',
    'background-color','backdrop-filter'];
  return [...document.querySelectorAll('.card,.dot-row,.khoi')].map((el, i) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const o = {i, lop: el.className, id: el.id || '',
      x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height};
    KHOA.forEach(k => { o[k] = cs.getPropertyValue(k); });
    return o;
  });
}"""

# Chữ nào ĐỨNG TRÊN NỀN THẺ, và chỗ nào của thẻ là nền trần để đọc màu.
JS_TUONG_PHAN = """() => {
  const cs0 = getComputedStyle(document.documentElement);
  const token = {};
  ['--text','--muted','--muted2','--gold-b','--gold','--ok','--amber','--card','--panel']
    .forEach(t => { token[t] = cs0.getPropertyValue(t).trim(); });
  const trong = m => !m || m === 'transparent' || /rgba\\(.*,\\s*0\\)$/.test(m);
  const ra = [];
  [...document.querySelectorAll('.card')].forEach((the, ti) => {
    const rt = the.getBoundingClientRect(), ct = getComputedStyle(the);
    if (rt.width <= 0 || rt.height <= 0) return;
    const chu = [], che = [];
    the.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || +s.opacity === 0) return;
      const hop = {x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height};
      const co_chu = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      const co_nen = !trong(s.backgroundColor) || s.backgroundImage !== 'none';
      // Mọi thứ KHÔNG phải nền trần của thẻ đều bị che khỏi phép đọc màu nền:
      // chữ, ô có nền riêng, ảnh, đường kẻ.
      if (co_chu || co_nen || el.tagName === 'IMG' || el.tagName === 'SVG') che.push(hop);
      if (!co_chu) return;
      // Chữ nằm trên ô CÓ NỀN RIÊNG (nút, chip, viên đếm) hay nằm trên ẢNH (lớp B)
      // thì nền của nó không phải nền thẻ — đo nó ở đây là gán sai nền, và một con
      // số gán sai nền thì đỏ hay xanh đều vô nghĩa.
      if (co_nen || el.closest('.tile, .anh-o')) return;
      chu.push(Object.assign({mau: s.color, co: (el.textContent || '').trim().slice(0, 28),
                              lop: el.className || el.tagName.toLowerCase()}, hop));
    });
    ra.push({the: ti, id: the.id || '', lop: the.className,
      x: rt.x + scrollX, y: rt.y + scrollY, w: rt.width, h: rt.height,
      vien: ['border-top-width','border-right-width','border-bottom-width','border-left-width']
        .map(k => parseFloat(ct.getPropertyValue(k)) || 0),
      chu, che});
  });
  return {token, the: ra};
}"""


# ══════════════════════════════════════════════════════════════════════════════
# Trình duyệt
# ══════════════════════════════════════════════════════════════════════════════
def _playwright():
    try:
        from playwright.sync_api import sync_playwright
        return sync_playwright
    except ImportError:
        print(json.dumps({"ok": False, "loi": "chưa cài playwright cho python3 "
                          "(pip install playwright && playwright install chromium)"},
                         ensure_ascii=False))
        sys.exit(3)


def _pillow():
    try:
        import numpy
        from PIL import Image
        return Image, numpy
    except ImportError:
        print(json.dumps({"ok": False, "loi": "chế độ --anh/--tuong-phan cần Pillow + numpy "
                          "(pip install pillow numpy)"}, ensure_ascii=False))
        sys.exit(3)


def _co(dpr, chup=False):
    a = [f"--force-device-scale-factor={dpr}"]
    if chup:
        # Bốn cờ này không phải trang trí: thiếu chúng thì hai ảnh lệch vài pixel vì
        # răng cưa chữ và vì thanh cuộn, rồi AC-5 chết vì nhiễu chứ không vì D135.
        a += ["--font-render-hinting=none", "--disable-lcd-text", "--hide-scrollbars",
              "--disable-partial-raster"]
    return a


def _chot_dpr(dpr_do, noi=""):
    if dpr_do < 2:
        print(json.dumps({
            "ok": False, "dpr": dpr_do, "ma_thoat": 2,
            "loi": "phép đo này MÙ ở DPR 1 — làm mờ ở DPR 1 gần như không tốn gì, "
                   "nên bản CHƯA sửa cũng cho 121 khung. Từ chối trả kết quả.",
            "o_dau": noi}, ensure_ascii=False))
        sys.exit(2)


def _trung_vi(ds, khoa):
    return statistics.median([d[khoa] for d in ds])


# ══════════════════════════════════════════════════════════════════════════════
# AC-1 · AC-2 · AC-3 — đo cuộn
# ══════════════════════════════════════════════════════════════════════════════
def do_cuon(args):
    sync_playwright = _playwright()
    dsm = [args.man] if args.man else list(MAN)
    ra, hong = {}, []
    with sync_playwright() as p:
        br = p.chromium.launch(args=_co(args.dpr))
        ctx = br.new_context(viewport={"width": 430, "height": 932},
                             device_scale_factor=args.dpr)
        page = ctx.new_page()
        # Đo nhịp nghỉ TRƯỚC khi gieo bất cứ thứ gì: đo nó trên chính trang fixture
        # là đo qua cái mà vé này đang nghi ngờ.
        nhip_may = page.evaluate(JS_NHIP)
        for man in dsm:
            css = {phia: rut_style(nguon(ref, man))
                   for phia, ref in (("truoc", args.truoc), ("sau", args.sau))}
            for thu_tu, mc in enumerate(MAN_CON[man]):
                luot = {"truoc": [], "sau": []}
                # MỘT cây DOM cho cả hai cột — chỉ khối <style> đổi qua đổi lại.
                # Dựng lại trang cho từng phía là đưa thêm hai biến (ảnh chưa giải
                # mã, layout lần đầu) vào một phép đo lẽ ra chỉ có một biến.
                page.set_content(fixture(man, css["truoc"], args.the, man_con=mc),
                                 wait_until="load")
                page.evaluate(JS_MO_PICK)
                so_anh = page.evaluate(JS_NAP_ANH)
                page.evaluate("() => document.fonts.ready")
                page.wait_for_timeout(400)
                # Xen kẽ TRƯỚC/SAU: §2.1 của plan đã loại giả thuyết «lượt đầu
                # chậm» bằng cách đảo thứ tự, nên ở đây xen kẽ luôn cho khỏi phải
                # cãi lại lần nữa. Vòng 0 là lượt HÂM NÓNG, bỏ đi. Mỗi lượt đi qua
                # CÙNG một trình tự (đổi CSS → chờ 250ms → đo) nên phần hâm nóng
                # còn sót lại, nếu có, rơi đều lên cả hai cột.
                for vong in range(SO_LUOT + 1):
                    for phia in ("truoc", "sau"):
                        page.evaluate(JS_DOI_CSS, css[phia])
                        page.wait_for_timeout(250)
                        r = page.evaluate(JS_CUON, [MS_CUON, nhip_may])
                        _chot_dpr(r["dpr"], f"{man}/{mc}/{phia}")
                        r["so_anh"] = so_anh
                        if vong:
                            luot[phia].append(r)
                gom = {}
                for phia in ("truoc", "sau"):
                    d = luot[phia]
                    gom[phia] = {
                        "man": man, "man_con": mc, "phia": phia, "dpr": d[0]["dpr"],
                        "nhip_may": d[0]["nhip_may"],
                        "hz_may": round(1000 / d[0]["nhip_may"]),
                        "so_the": d[0]["so_the"], "so_anh": d[0]["so_anh"],
                        "khung": int(_trung_vi(d, "khung")),
                        "khung_ky_vong": int(_trung_vi(d, "khung_ky_vong")),
                        "trung_vi": round(_trung_vi(d, "trung_vi"), 1),
                        "p95": round(_trung_vi(d, "p95"), 1),
                        "rot": int(_trung_vi(d, "rot")),
                        "rot50": int(_trung_vi(d, "rot50")),
                        "cao_trang": d[0]["cao_trang"],
                        "tung_luot": [{k: v[k] for k in ("khung", "p95", "rot50")}
                                      for v in d],
                    }
                    print(json.dumps(gom[phia], ensure_ascii=False))
                tr, sa = gom["truoc"], gom["sau"]
                kiem = {
                    "dpr ≥ 2": sa["dpr"] >= 2,
                    "khung ≥ 95% khung kỳ vọng":
                        sa["khung"] >= 0.95 * sa["khung_ky_vong"],
                    "p95 sau ≤ 50% p95 trước":
                        sa["p95"] <= 0.5 * tr["p95"],
                    "0 khung > 50ms": sa["rot50"] == 0,
                }
                ac = "AC-1" if man == "crm-kho-anh.html" else "AC-2"
                xau = [k for k, v in kiem.items() if not v]
                # Chỉ màn con ĐẦU gác cổng. Các màn con sau vẫn chạy đủ, vẫn in đủ
                # số, và vẫn vào hiện vật — nhưng chúng trả lời một câu hỏi khác
                # («màn ấy còn giật vì gì»), nên để chúng đánh đỏ AC-1/AC-2 là bắt
                # vé này chịu trách nhiệm cho lớp B mà chính plan đã loại (§2.4).
                gac = thu_tu == 0
                if gac:
                    hong += [f"{ac} · {k}" for k in xau]
                ra[f"{man}#{mc}"] = {
                    "ac": ac if gac else f"{ac}-ghi-so", "man": man, "man_con": mc,
                    "gac_cong": gac, "dat": not xau, "kiem": kiem,
                    "truoc": tr, "sau": sa}
                print(json.dumps(ra[f"{man}#{mc}"], ensure_ascii=False))
        ctx.close()
        br.close()
    print(json.dumps({"ok": not hong, "hong": hong, "truoc": args.truoc, "sau": args.sau},
                     ensure_ascii=False))
    return 0 if not hong else 1


# ══════════════════════════════════════════════════════════════════════════════
# AC-5 — ảnh trước/sau + hình học + diff có mặt nạ
# ══════════════════════════════════════════════════════════════════════════════
BE_NGANG = ((430, 932), (1280, 900))
CHU_DE = ("toi", "sang")


def _giai_bong(bs):
    """Quầng `box-shadow` toả ra bao xa tính từ hộp viền. `0px 10px 32px 0px` ⇒
    lệch 10, nhoè 32, doãng 0 ⇒ 44px là đủ ăn hết quầng ở mọi cạnh."""
    n = [float(x) for x in re.findall(r"(-?[\d.]+)px", bs or "")]
    dx, dy, nhoe, doang = (n + [0.0, 0.0, 0.0, 0.0])[:4]
    return nhoe + doang + max(abs(dx), abs(dy)) + 2


def _mat_na(mang, hop_ds, dpr, np, kieu):
    """Tô đen phần THUỘC VỀ THẺ, ba mức từ hẹp tới rộng. Ba mức chứ không một, vì
    lượt thi công đo ra hai thứ mà plan §14.3 không lường — và cả hai đều là thẻ tự
    vẽ lại chính nó, không phải bố cục xê dịch:

      `ruot`  — thụt `border-width + 1px`, đúng như plan viết. Số của mức này được
                nộp NGUYÊN VĂN, không nới, vì nó là phép plan đặt ra.
      `hop`   — hộp viền, không thụt. Viền là `rgba(224,189,119,.16)` — TRONG SUỐT
                MỘT PHẦN, nên pixel viền là màu viền chồng lên nền thẻ: nền đổi thì
                viền đổi theo, tất yếu. Không mất gì: phép (a) khoá chặt
                `border-*-width` và `border-*-color` tới từng chữ.
      `bong`  — hộp viền nở thêm đúng tầm quầng `box-shadow`. Cùng một `--shadow`
                được raster khác đi khi thẻ có/không có `backdrop-filter` (thẻ có
                thì lên tầng hợp ảnh riêng): lệch tối đa 7/255 trong một vệt bóng
                mờ, không một pixel nào xê dịch. Phép (a) cũng khoá chặt
                `box-shadow`.

    Mức `bong` là mức GÁC CỔNG, và ngưỡng của nó vẫn đúng bằng 0 — thay đổi ở đây
    là ĐỊNH NGHĨA «pixel nào thuộc về thẻ», không phải nới một ngưỡng.
    """
    cao, rong = mang.shape[0], mang.shape[1]
    for h in hop_ds:
        vt = [float(h.get(f"border-{c}-width", "0px").replace("px", "") or 0)
              for c in ("top", "right", "bottom", "left")]
        if kieu == "ruot":
            le = [vt[0] + 1, vt[1] + 1, vt[2] + 1, vt[3] + 1]
        elif kieu == "hop":
            le = [0.0, 0.0, 0.0, 0.0]
        else:
            g = _giai_bong(h.get("box-shadow"))
            le = [-g, -g, -g, -g]
        y0 = max(0, int(round((h["y"] + le[0]) * dpr)))
        x1 = min(rong, int(round((h["x"] + h["w"] - le[1]) * dpr)))
        y1 = min(cao, int(round((h["y"] + h["h"] - le[2]) * dpr)))
        x0 = max(0, int(round((h["x"] + le[3]) * dpr)))
        if x1 > x0 and y1 > y0:
            mang[y0:y1, x0:x1] = 0
    return mang


def do_anh(args):
    sync_playwright = _playwright()
    Image, np = _pillow()
    thu = args.anh_ra or ANH_RA_MAC_DINH
    os.makedirs(thu, exist_ok=True)

    hinh_hoc, ket, hong = {}, [], []
    with sync_playwright() as p:
        br = p.chromium.launch(args=_co(args.dpr, chup=True))
        for man in MAN:
            html = {phia: {th: fixture(man, rut_style(nguon(ref, man)), args.the, th)
                           for th in CHU_DE}
                    for phia, ref in (("truoc", args.truoc), ("sau", args.sau))}
            for th in CHU_DE:
                for w, h in BE_NGANG:
                    ctx = br.new_context(viewport={"width": w, "height": h},
                                         device_scale_factor=args.dpr,
                                         reduced_motion="reduce")
                    page = ctx.new_page()
                    for phia in ("truoc", "sau"):
                        page.set_content(html[phia][th], wait_until="load")
                        page.evaluate(JS_MO_PICK)
                        page.evaluate("() => document.fonts.ready")
                        page.wait_for_timeout(200)
                        dpr_do = page.evaluate("() => window.devicePixelRatio")
                        _chot_dpr(dpr_do, f"{man}/{th}/{w}/{phia}")
                        ten = f"d135-{TEN_NGAN[man]}-{th}-{w}-{phia}.png"
                        page.screenshot(path=os.path.join(thu, ten), full_page=True)
                        hh = page.evaluate(JS_HINH_HOC)
                        hinh_hoc[(man, th, w, phia)] = hh
                        with open(os.path.join(
                                thu, f"d135-hinh-hoc-{TEN_NGAN[man]}-{th}-{w}-{phia}.json"),
                                "w", encoding="utf-8") as f:
                            json.dump(hh, f, ensure_ascii=False, indent=1)
                    ctx.close()
    # ── (a) phép hình học · chính xác tuyệt đối, không ngưỡng ────────────────
    CHO_PHEP = {"background-color", "backdrop-filter"}
    for man in MAN:
        for th in CHU_DE:
            for w, _ in BE_NGANG:
                a = hinh_hoc[(man, th, w, "truoc")]
                b = hinh_hoc[(man, th, w, "sau")]
                nhan = f"{TEN_NGAN[man]}/{th}/{w}"
                if len(a) != len(b):
                    hong.append(f"AC-5a · {nhan} · số phần tử lệch {len(a)}→{len(b)}")
                    continue
                lech = []
                for x, y in zip(a, b):
                    for k in x:
                        if x[k] != y[k] and k not in CHO_PHEP:
                            lech.append({"the": x["i"], "lop": x["lop"], "khoa": k,
                                         "truoc": x[k], "sau": y[k]})
                doi = sorted({k for x, y in zip(a, b) for k in x if x[k] != y[k]})
                ket.append({"phep": "AC-5a hình học", "o": nhan, "so_the": len(a),
                            "khoa_doi": doi, "lech_ngoai_cho_phep": lech,
                            "dat": not lech})
                if lech:
                    hong.append(f"AC-5a · {nhan} · {len(lech)} khoá lệch ngoài "
                                f"{sorted(CHO_PHEP)}")
    # ── (b) diff ảnh CÓ MẶT NẠ · ngưỡng là 0, không phải «ít» ────────────────
    for man in MAN:
        for th in CHU_DE:
            for w, _ in BE_NGANG:
                nhan = f"{TEN_NGAN[man]}/{th}/{w}"
                pa = os.path.join(thu, f"d135-{TEN_NGAN[man]}-{th}-{w}-truoc.png")
                pb = os.path.join(thu, f"d135-{TEN_NGAN[man]}-{th}-{w}-sau.png")
                ia = np.asarray(Image.open(pa).convert("RGB")).astype(int)
                ib = np.asarray(Image.open(pb).convert("RGB")).astype(int)
                if ia.shape != ib.shape:
                    # Cỡ ảnh lệch = trang cao/rộng lên = bố cục đã xê dịch. Đỏ ngay,
                    # không cần mặt nạ nào.
                    hong.append(f"AC-5b · {nhan} · cỡ ảnh lệch {ia.shape}→{ib.shape}")
                    ket.append({"phep": "AC-5b diff có mặt nạ", "o": nhan, "dat": False,
                                "co_truoc": list(ia.shape), "co_sau": list(ib.shape)})
                    continue
                lech = np.abs(ia - ib).max(axis=2)
                so = {}
                for kieu in ("ruot", "hop", "bong"):
                    m = lech.copy()
                    _mat_na(m, hinh_hoc[(man, th, w, "truoc")], args.dpr, np, kieu)
                    _mat_na(m, hinh_hoc[(man, th, w, "sau")], args.dpr, np, kieu)
                    so[kieu] = {"pixel_khac": int((m > 0).sum()),
                                "lech_toi_da": int(m.max())}
                ket.append({
                    "phep": "AC-5b diff có mặt nạ", "o": nhan,
                    "co_anh": [int(ia.shape[1]), int(ia.shape[0])],
                    "tong_pixel": int(ia.shape[0] * ia.shape[1]),
                    # Nguyên văn phép plan §14.3(b) đặt ra — nộp thẳng, không nới.
                    "ngoai_ruot_the__plan_14_3b": so["ruot"],
                    "ngoai_hop_vien": so["hop"],
                    # Mức GÁC CỔNG: ngoài phần thẻ tự vẽ (hộp viền + quầng bóng).
                    "ngoai_quang_bong__gac_cong": so["bong"],
                    "dat": so["bong"]["pixel_khac"] == 0})
                if so["bong"]["pixel_khac"]:
                    hong.append(f"AC-5b · {nhan} · {so['bong']['pixel_khac']} pixel khác "
                                f"NGOÀI phần thẻ tự vẽ (lệch tối đa "
                                f"{so['bong']['lech_toi_da']}/255)")
    # ── (c) soi riêng theme tối · KHÔNG phải AC, là dữ liệu cho Sponsor quyết ──
    mau = []
    for man in MAN:
        nhan = TEN_NGAN[man]
        d = {"man": nhan, "theme": "toi", "be_ngang": 430}
        for phia in ("truoc", "sau"):
            img = np.asarray(Image.open(os.path.join(
                thu, f"d135-{nhan}-toi-430-{phia}.png")).convert("RGB"))
            hh = hinh_hoc[(man, "toi", 430, phia)]
            the = next((t for t in hh if "khoi" not in t["lop"]), hh[0])
            x0 = int((the["x"] + 30) * args.dpr); x1 = int((the["x"] + the["w"] - 30) * args.dpr)
            y0 = int((the["y"] + 6) * args.dpr); y1 = int((the["y"] + 18) * args.dpr)
            ruot = img[y0:y1, x0:x1].reshape(-1, 3)
            # Nền trang ngay CẠNH thẻ: dải hẹp bên trái thẻ, cùng chiều cao.
            nx0 = max(0, int((the["x"] - 10) * args.dpr)); nx1 = max(1, int((the["x"] - 2) * args.dpr))
            nen = img[y0:y1, nx0:nx1].reshape(-1, 3)
            mr = [int(np.median(ruot[:, i])) for i in range(3)]
            mn = [int(np.median(nen[:, i])) for i in range(3)]
            d[phia] = {"ruot_the": mr, "nen_trang": mn,
                       "cach_nen": round(float(np.sqrt(sum((a - b) ** 2
                                                           for a, b in zip(mr, mn)))), 1)}
        mau.append(d)
    with open(os.path.join(thu, "d135-mau-ruot-the-toi.json"), "w", encoding="utf-8") as f:
        json.dump(mau, f, ensure_ascii=False, indent=1)

    print(json.dumps({"ac": "AC-5", "ok": not hong, "hong": hong, "thu_muc": thu,
                      "so_png": len(MAN) * len(CHU_DE) * len(BE_NGANG) * 2,
                      "phep": ket, "mau_ruot_the_toi": mau},
                     ensure_ascii=False, indent=2))
    return 0 if not hong else 1


# ══════════════════════════════════════════════════════════════════════════════
# AC-6 — tương phản, đọc trên pixel đã tô
# ══════════════════════════════════════════════════════════════════════════════
def _rgb(s):
    m = re.findall(r"[\d.]+", s or "")
    if len(m) < 3:
        return None
    return tuple(float(x) for x in m[:3]) + ((float(m[3]),) if len(m) > 3 else (1.0,))


def _lum(c):
    def lin(v):
        v /= 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])


def _ti_so(chu, nen):
    """WCAG 2.1. Chữ có alpha thì chồng lên nền ĐÃ ĐỌC ĐƯỢC trước, không tính suông
    trên token — một màu có alpha tự nó không có tỉ số tương phản nào cả."""
    if chu[3] < 1:
        chu = tuple(chu[i] * chu[3] + nen[i] * (1 - chu[3]) for i in range(3)) + (1.0,)
    a, b = _lum(chu), _lum(nen)
    hi, lo = max(a, b), min(a, b)
    return round((hi + 0.05) / (lo + 0.05), 2)


def _hex_rgb(h):
    h = (h or "").strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return None
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (1.0,)


def _doc_nen_va_chu(d, duong_anh, Image, np, dpr):
    """Với MỘT bản (một màn, một phía): đọc màu nền THẬT của từng thẻ trên ảnh đã
    chụp, rồi tính tỉ số cho mọi màu chữ đứng trên nền ấy.

    Vì sao đọc pixel chứ không đọc token: `getComputedStyle(.card).backgroundColor`
    trả `rgba(255,255,255,0.032)` — một màu CÓ ALPHA, tự nó không có tỉ số tương
    phản nào. Nền thật là màu ấy chồng lên gradient của trang, và ở bản TRƯỚC còn
    chồng lên gradient ĐÃ BỊ LÀM MỜ. Tính bằng token là tính một con số không tồn
    tại trên màn hình.
    """
    img = np.asarray(Image.open(duong_anh).convert("RGB"))
    ra = {}
    for the in d["the"]:
        vt = the["vien"]
        x0 = int(round((the["x"] + vt[3] + 2) * dpr))
        y0 = int(round((the["y"] + vt[0] + 2) * dpr))
        x1 = int(round((the["x"] + the["w"] - vt[1] - 2) * dpr))
        y1 = int(round((the["y"] + the["h"] - vt[2] - 2) * dpr))
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(img.shape[1], x1), min(img.shape[0], y1)
        if x1 <= x0 or y1 <= y0 or not the["chu"]:
            continue
        lay = np.ones((y1 - y0, x1 - x0), dtype=bool)
        for c in the["che"]:      # bỏ chữ, ô có nền riêng, ảnh, đường kẻ
            cx0 = max(x0, int((c["x"] - 2) * dpr)); cy0 = max(y0, int((c["y"] - 2) * dpr))
            cx1 = min(x1, int((c["x"] + c["w"] + 2) * dpr))
            cy1 = min(y1, int((c["y"] + c["h"] + 2) * dpr))
            if cx1 > cx0 and cy1 > cy0:
                lay[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0] = False
        vung = img[y0:y1, x0:x1][lay]
        if vung.shape[0] < 64:
            continue
        # TRUNG VỊ chứ không trung bình: một cái viền sáng hay một vệt gradient
        # không được kéo lệch con số nền.
        nen = tuple(float(np.median(vung[:, i])) for i in range(3)) + (1.0,)
        for c in the["chu"]:
            mau = _rgb(c["mau"])
            if not mau:
                continue
            khoa = (the["the"], c["lop"], c["co"], c["mau"])
            ra[khoa] = {"the": the["the"], "the_id": the["id"], "lop_chu": c["lop"],
                        "chu": c["co"], "mau_chu": c["mau"],
                        "nen_do_duoc": [int(round(v)) for v in nen[:3]],
                        "so_pixel_nen": int(vung.shape[0]),
                        "ti_so": _ti_so(mau, nen)}
    return ra


# Sai số cho phép khi so ti_so_sau với ti_so_truoc. Nền đọc bằng TRUNG VỊ của pixel
# nguyên nên nó lượng tử hoá theo bậc 1/255 — một chênh lệch 0,01 là bậc lượng tử,
# không phải một cú lùi thị giác. Ngưỡng này CHỈ áp cho điều kiện (b); điều kiện
# (a) 4,5:1 tuyệt đối không có sai số nào.
EPS_TP = 0.01


def do_tuong_phan(args):
    """AC-6 · đường 1 (Gate 1 vòng 2 chuẩn y): HAI điều kiện cùng lúc, cả hai chủ đề.
      (a) chữ `--text` và `--muted` trên nền thẻ đạt ≥ 4,5:1;
      (b) MỌI cặp chữ/nền đo được có `ti_so_sau ≥ ti_so_truoc` — không cặp nào tệ đi.
    `--muted2` (~3,0–4,3:1 ở CẢ trước lẫn sau) là nợ CÓ SẴN từ trước D135, ghi sổ
    kèm số đo — vé này không sửa token màu (FR-1/FR-3).
    """
    sync_playwright = _playwright()
    Image, np = _pillow()
    thu = args.anh_ra or ANH_RA_MAC_DINH
    os.makedirs(thu, exist_ok=True)
    hong, tat_ca = [], {}

    with sync_playwright() as p:
        br = p.chromium.launch(args=_co(args.dpr, chup=True))
        for th in CHU_DE:
            ban = {}
            for man in MAN:
                for phia, ref in (("truoc", args.truoc), ("sau", args.sau)):
                    ctx = br.new_context(viewport={"width": 430, "height": 932},
                                         device_scale_factor=args.dpr,
                                         reduced_motion="reduce")
                    page = ctx.new_page()
                    page.set_content(fixture(man, rut_style(nguon(ref, man)), args.the, th),
                                     wait_until="load")
                    page.evaluate(JS_MO_PICK)
                    page.evaluate("() => document.fonts.ready")
                    page.wait_for_timeout(200)
                    _chot_dpr(page.evaluate("() => window.devicePixelRatio"),
                              f"{man}/{th}/{phia}")
                    pth = os.path.join(thu, f"d135-tp-{TEN_NGAN[man]}-{th}-{phia}.png")
                    page.screenshot(path=pth, full_page=True)
                    ban[(man, phia)] = (page.evaluate(JS_TUONG_PHAN), pth)
                    ctx.close()

            dong = []
            for man in MAN:
                r = {phia: _doc_nen_va_chu(*ban[(man, phia)], Image, np, args.dpr)
                     for phia in ("truoc", "sau")}
                le = sorted(set(r["truoc"]) ^ set(r["sau"]))
                if le:
                    hong.append(f"AC-6 · {TEN_NGAN[man]}/{th} · {len(le)} cặp chỉ có ở "
                                f"một phía — fixture lệch, phép so vô nghĩa")
                token = ban[(man, "sau")][0]["token"]
                ten_token = {}
                for t in ("--text", "--muted", "--muted2"):
                    v = _hex_rgb(token.get(t)) or _rgb(token.get(t))
                    if v:
                        ten_token[tuple(int(round(x)) for x in v[:3])] = t
                for k in sorted(set(r["truoc"]) & set(r["sau"])):
                    a, b = r["truoc"][k], r["sau"][k]
                    mau = _rgb(b["mau_chu"])
                    tk = ten_token.get(tuple(int(round(x)) for x in mau[:3]), "")
                    bat_buoc = tk in ("--text", "--muted")
                    d = {"man": TEN_NGAN[man], "theme": th, "the": b["the"],
                         "the_id": b["the_id"], "lop_chu": b["lop_chu"], "chu": b["chu"],
                         "mau_chu": b["mau_chu"], "token": tk or "(không phải token chữ)",
                         "nen_do_duoc_truoc": a["nen_do_duoc"],
                         "nen_do_duoc_sau": b["nen_do_duoc"],
                         "ti_so_truoc": a["ti_so"], "ti_so_sau": b["ti_so"],
                         "buoc_45": bat_buoc,
                         "no_co_san": tk == "--muted2",
                         "dat_45": (not bat_buoc) or b["ti_so"] >= 4.5,
                         "khong_te_di": b["ti_so"] >= a["ti_so"] - EPS_TP}
                    d["dat"] = d["dat_45"] and d["khong_te_di"]
                    dong.append(d)
            for d in dong:
                if not d["dat_45"]:
                    hong.append(f"AC-6a · {d['man']}/{d['theme']} · {d['token']} trên "
                                f"«{d['chu']}» chỉ {d['ti_so_sau']}:1 (< 4,5)")
                if not d["khong_te_di"]:
                    hong.append(f"AC-6b · {d['man']}/{d['theme']} · «{d['chu']}» tệ đi "
                                f"{d['ti_so_truoc']} → {d['ti_so_sau']}")
            with open(os.path.join(thu, f"d135-tuong-phan-{th}.json"), "w",
                      encoding="utf-8") as f:
                json.dump(dong, f, ensure_ascii=False, indent=1)
            tat_ca[th] = dong
        br.close()

    no = [d for ds in tat_ca.values() for d in ds if d["no_co_san"]]
    print(json.dumps({
        "ac": "AC-6", "ok": not hong, "hong": hong, "thu_muc": thu,
        "so_cap_do": sum(len(v) for v in tat_ca.values()),
        "so_no_co_san_muted2": len(no),
        "no_co_san_muted2": [{"man": d["man"], "theme": d["theme"], "chu": d["chu"],
                              "ti_so_truoc": d["ti_so_truoc"], "ti_so_sau": d["ti_so_sau"]}
                             for d in no],
        "dong": tat_ca}, ensure_ascii=False, indent=2))
    return 0 if not hong else 1


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("man", nargs="?", choices=list(MAN))
    ap.add_argument("--truoc")
    ap.add_argument("--sau", default="cay")
    ap.add_argument("--canh-gac", action="store_true")
    ap.add_argument("--anh", action="store_true")
    ap.add_argument("--tuong-phan", action="store_true")
    ap.add_argument("--anh-ra")
    ap.add_argument("--the", type=int, default=SO_THE)
    ap.add_argument("--dpr", type=int, default=2,
                    help="CHỈ để chạy đột biến M-3b (DPR 1 ⇒ phải thoát mã 2)")
    args = ap.parse_args()
    if args.canh_gac:
        return canh_gac()
    if not args.truoc:
        ap.error("cần --truoc <ref> (và --sau, mặc định `cay`)")
    if args.anh:
        return do_anh(args)
    if args.tuong_phan:
        return do_tuong_phan(args)
    return do_cuon(args)


if __name__ == "__main__":
    sys.exit(main())
