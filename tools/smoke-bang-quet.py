#!/usr/bin/env python3
"""E08-D126 · Kiểm bảng điều khiển máy quét trên trang Ảnh sự kiện.

Mở /crm/anh-su-kien thật bằng Chromium, ở khổ màn 390px, rồi kiểm đúng những
điều AC đòi mà chỉ trình duyệt mới trả lời được:

  AC-1 · bảng hiện dưới thanh tab, KHÔNG phải cuộn mới thấy (màn 390×844)
  AC-1 · tài khoản không phải btl thì không thấy bảng
  AC-3 · bấm Tạm dừng một luồng thì trong 5 giây trạng thái đổi và số ngừng tăng
  AC-8 · F5 giữa lúc chạy vẫn thấy đúng số luồng, đúng trạng thái
  FR-6 · nút nói đúng việc nó làm — luồng đã xong không có nút Tạm dừng

Cố ý KHÔNG in tên khách, không in nội dung ảnh — chỉ đếm và tên trạng thái.

Chạy (cần một đợt ĐANG CHẠY với ít nhất một luồng còn sống):
  CRM_BASE_URL=http://127.0.0.1:3126 \\
  CRM_SMOKE_COOKIE='esuhai_crm=<token btl>' \\
  python3 tools/smoke-bang-quet.py

Muốn kiểm luôn vế «không phải btl thì không thấy» thì thêm:
  CRM_SMOKE_COOKIE_STAFF='esuhai_crm=<token staff>'
"""
import json
import os
import sys

BASE = os.environ.get("CRM_BASE_URL", "").rstrip("/")
COOKIE = os.environ.get("CRM_SMOKE_COOKIE", "")
COOKIE_STAFF = os.environ.get("CRM_SMOKE_COOKIE_STAFF", "")
ANH = os.environ.get("CRM_SMOKE_ANH", "/crm/anh-su-kien")

if not BASE or not COOKIE:
    print(json.dumps({"ok": False, "error": "thiếu CRM_BASE_URL hoặc CRM_SMOKE_COOKIE"}))
    sys.exit(2)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(json.dumps({"ok": False,
                      "error": "chưa cài playwright cho python3 (pip install playwright && playwright install chromium)"}))
    sys.exit(3)

KQ = []


def cham(ten, dat, chi=""):
    KQ.append({"ten": ten, "dat": bool(dat), "chi": chi})
    print(("  OK  " if dat else "  HONG") + " " + ten + ((" — " + str(chi)) if chi else ""))


def cookie_cua(chuoi):
    ten, _, gt = chuoi.partition("=")
    from urllib.parse import urlparse
    u = urlparse(BASE)
    return {"name": ten.strip(), "value": gt.strip(), "domain": u.hostname, "path": "/"}


def mo(p, chuoi_cookie=COOKIE, cao=844):
    # Token phải ở lại trong hạ tầng của mình: chặn mọi request rời khỏi BASE
    # (trang có <link> tới fonts.googleapis.com). Cùng lập luận smoke-crm-ui.py.
    ctx = p.new_context(viewport={"width": 390, "height": cao})
    ctx.add_cookies([cookie_cua(chuoi_cookie)])
    ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
    pg = ctx.new_page()
    loi_js = []
    pg.on("pageerror", lambda e: loi_js.append(str(e)))
    pg.goto(BASE + ANH, wait_until="networkidle")
    return ctx, pg, loi_js


def so_luong_dong(pg):
    return pg.locator("#qDs .qluong").count()


def trang_thai_dong(pg, i):
    return pg.locator("#qDs .qluong").nth(i).locator(".qmuc").first.inner_text().strip()


def da_soi_dong(pg, i):
    o = pg.locator("#qDs .qluong").nth(i).locator(".qmuc b").first
    return o.inner_text().strip()


with sync_playwright() as p:
    br = p.chromium.launch()
    ctx, pg, loi_js = mo(br)

    pg.wait_for_selector("#qKhoi:not(.an)", timeout=15000)

    # ── AC-1 · thấy được, không phải cuộn ────────────────────────────────────
    hop = pg.locator("#theDongBo").bounding_box()
    cham("AC-1 · bảng hiện trong màn 390×844 không cần cuộn",
         hop and hop["y"] + hop["height"] <= 844,
         "đáy khối ở {:.0f}px".format(hop["y"] + hop["height"]) if hop else "không thấy khối")

    tab = pg.locator("#thanhTab").bounding_box()
    cham("FR-6 · bảng nằm DƯỚI thanh tab", hop and tab and hop["y"] > tab["y"],
         "tab {:.0f}px · bảng {:.0f}px".format(tab["y"], hop["y"]) if (hop and tab) else "")

    n = so_luong_dong(pg)
    cham("có ít nhất một dòng luồng", n >= 1, str(n) + " dòng")

    tong = pg.locator("#qSo").inner_text()
    cham("dòng toàn kho có đủ số", ("Kho" in tong or "全体" in tong) and "%" in tong,
         tong.replace("\n", " ")[:90])

    # ── AC-3 · tạm dừng ăn trong 5 giây ──────────────────────────────────────
    idx = None
    for i in range(n):
        if pg.locator("#qDs .qluong").nth(i).locator("button").count() == 0:
            continue
        tt = trang_thai_dong(pg, i)
        if ("chạy" in tt) or ("実行" in tt):
            idx = i
            break
    if idx is None:
        cham("AC-3 · có luồng đang chạy để thử tạm dừng", False,
             "không luồng nào đang chạy — bật máy quét rồi chạy lại")
    else:
        pg.locator("#qDs .qluong").nth(idx).locator("button").first.click()
        pg.wait_for_timeout(5000)
        tt = trang_thai_dong(pg, idx)
        cham("AC-3 · trong 5 giây trạng thái đổi thành tạm dừng",
             "tạm dừng" in tt or "一時停止" in tt, tt)
        a = da_soi_dong(pg, idx)
        pg.wait_for_timeout(4000)
        b = da_soi_dong(pg, idx)
        cham("AC-3 · số tấm ngừng tăng ở hai nhịp đọc liên tiếp", a == b, a + " rồi " + b)

        # nút phải đổi nhãn theo trạng thái thật (FR-6)
        nhan = pg.locator("#qDs .qluong").nth(idx).locator("button").first.inner_text()
        cham("FR-6 · nút đổi thành Tiếp tục", "Tiếp tục" in nhan or "再開" in nhan, nhan.strip())

        # ── AC-8 · F5 không mất trạng thái ───────────────────────────────────
        pg.reload(wait_until="networkidle")
        pg.wait_for_selector("#qKhoi:not(.an)", timeout=15000)
        cham("AC-8 · F5 vẫn thấy đúng số luồng", so_luong_dong(pg) == n,
             str(so_luong_dong(pg)) + "/" + str(n))
        tt2 = trang_thai_dong(pg, idx)
        cham("AC-8 · F5 vẫn thấy đúng trạng thái luồng vừa tạm dừng",
             "tạm dừng" in tt2 or "一時停止" in tt2, tt2)

        # trả lại như cũ để lượt chạy sau không bị treo
        pg.locator("#qDs .qluong").nth(idx).locator("button").first.click()
        pg.wait_for_timeout(1500)

    cham("không có lỗi JavaScript trên trang", not loi_js, "; ".join(loi_js[:2]))

    anh = os.environ.get("CRM_SMOKE_ANH_OUT")
    if anh:
        pg.screenshot(path=anh, full_page=False)
        print("  ảnh màn: " + anh)
    ctx.close()

    # ── AC-1 · không phải btl thì không thấy bảng ────────────────────────────
    if COOKIE_STAFF:
        ctx2, pg2, _ = mo(br, COOKIE_STAFF)
        pg2.wait_for_timeout(2500)
        an = pg2.locator("#theDongBo").is_hidden()
        cham("AC-1 · tài khoản không phải btl không thấy bảng", an,
             "khối đang hiện" if not an else "")
        ctx2.close()
    else:
        print("  (bỏ qua vế không-btl — không có CRM_SMOKE_COOKIE_STAFF)")

    br.close()

hong = [x for x in KQ if not x["dat"]]
print("\n{}/{} phép thử đạt".format(len(KQ) - len(hong), len(KQ)))
print(json.dumps({"ok": not hong, "kq": KQ}, ensure_ascii=False))
sys.exit(1 if hong else 0)
