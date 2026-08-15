#!/usr/bin/env python3
"""E08-D128 · Phép đo AC-7 trên trình duyệt thật.

    python3 test/ui/do-ac7.py            # in JSON, mã thoát 0 = đạt
    python3 test/ui/do-ac7.py --anh      # kèm ảnh chụp màn vào test/ui/anh/

Đo CÙNG MỘT trang bằng HAI vai rồi so hai cột với nhau. Chỉ đo một cột thì không
nói được gì: «không thấy nút GHI» có thể vì vai staff đã ẩn nó, mà cũng có thể vì
trang chưa nạp xong hay bộ chọn viết sai. Hai cột khác nhau ở đúng những chỗ AC-7
đòi, và GIỐNG nhau ở phần còn lại, mới là một phép đo.

Máy chủ là `test/ui/lab-server.js` (CSDL giả, xem test/lab.js) — không đụng prod,
không cần Postgres, không cần MinIO.
"""
import json
import os
import subprocess
import sys

GOC = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(GOC, "..", ".."))
CHUP = "--anh" in sys.argv

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(json.dumps({"ok": False, "error":
                      "chưa cài playwright cho python3 (pip install playwright && playwright install chromium)"}))
    sys.exit(3)


def hien(page, sel):
    """Thấy được bằng mắt — không phải chỉ 'có trong DOM'. Một nút `display:none`
    vẫn đếm được bằng querySelector, và đó đúng là thứ vé này bảo phải ẩn."""
    el = page.query_selector(sel)
    return bool(el and el.is_visible())


def do_mot_vai(page, goc, ten_vai):
    loi_mang = []
    page.on("response", lambda r: loi_mang.append(f"{r.status} {r.url.replace(goc, '')}")
            if r.status in (401, 403) else None)
    loi_console = []
    page.on("pageerror", lambda e: loi_console.append(str(e)))

    # ── bước 1 · vào URL KHÔNG ĐUÔI, xem trang đưa mình đi đâu ──
    page.goto(goc + "/crm/anh-su-kien", wait_until="networkidle")
    duong = page.url.replace(goc, "")
    page.wait_for_timeout(400)

    # ── bước 2 · đứng trên CÙNG một màn để hai cột so được với nhau ──
    # Không có bước này thì cột `btl` đo ở tab Phân loại còn cột `staff` ở Theo
    # khách: hai màn khác nhau thì mọi con số chênh nhau đều vô nghĩa.
    page.goto(goc + "/crm/anh-su-kien/theo-khach", wait_until="networkidle")
    page.wait_for_timeout(500)

    d = {
        "duong_sau_khi_vao_khong_duoi": duong,
        "bang_dong_bo_D126_hien": hien(page, "#theDongBo"),
        "chip_phan_loai_hien": hien(page, "#tabAnh"),
        "chip_kho_hien": hien(page, "#tabKho"),
        "chip_theo_khach_hien": hien(page, "#tabKhach"),
        "nut_ve_crm_hien": hien(page, "#veCrm"),
        "so_nut_GHI_duyet": len(page.query_selector_all("[data-lo]")),
        "so_tam_album": len(page.query_selector_all(".anh-o.alb")),
        "so_tam_cho_duyet": len(page.query_selector_all(".anh-o.cho")),
        "so_o_tick_tren_tam_album": len(page.query_selector_all(".anh-o.alb .tick input")),
        "so_o_tick_tren_tam_cho": len(page.query_selector_all(".anh-o.cho .tick input")),
        "loi_401_403": sorted(set(loi_mang)),
        "loi_javascript": loi_console,
    }

    # Tick một tấm rồi xem thanh dưới khối mọc ra cái gì.
    o = page.query_selector(".khoi .anh-o .tick input")
    if o:
        o.check()
        page.wait_for_timeout(150)
        d["sau_khi_tick_so_nut_GHI"] = len(page.query_selector_all(".khoi [data-lo]"))
        d["sau_khi_tick_co_nut_tai"] = bool(page.query_selector(".khoi [data-tai-mo]:not([disabled])"))
    else:
        d["sau_khi_tick_so_nut_GHI"] = 0
        d["sau_khi_tick_co_nut_tai"] = False

    if CHUP:
        thu = os.path.join(GOC, "anh")
        os.makedirs(thu, exist_ok=True)
        page.screenshot(path=os.path.join(thu, f"d128-{ten_vai}-theo-khach.png"), full_page=True)

    # ── trang KHO ──
    page.goto(goc + "/crm/anh-su-kien/kho", wait_until="networkidle")
    page.wait_for_timeout(400)
    d["kho_hien_bao_chi_ban_to_chuc"] = hien(page, "#chiXemKho")
    d["kho_hien_nut_chon_thu_muc"] = hien(page, "#btnFolder")
    if CHUP:
        page.screenshot(path=os.path.join(GOC, "anh", f"d128-{ten_vai}-kho.png"), full_page=True)
    return d


def main():
    proc = subprocess.Popen([ "node", os.path.join(GOC, "lab-server.js") ],
                            cwd=REPO, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    try:
        dong = ""
        for _ in range(50):
            dong = proc.stdout.readline()
            if dong.startswith("{"):
                break
        cfg = json.loads(dong)
        goc = cfg["url"]

        ra = {}
        with sync_playwright() as p:
            br = p.chromium.launch()
            for ten, ck in (("staff", cfg["cookieStaff"]), ("btl", cfg["cookieBtl"])):
                ten_ck, gt = ck.split("=", 1)
                ctx = br.new_context(viewport={"width": 430, "height": 900})
                ctx.add_cookies([{ "name": ten_ck, "value": gt,
                                   "url": goc, "httpOnly": True, "sameSite": "Lax" }])
                ra[ten] = do_mot_vai(ctx.new_page(), goc, ten)
                ctx.close()
            br.close()
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    s, b = ra["staff"], ra["btl"]
    # Mỗi dòng: (tên AC, điều phải đúng). Viết dưới dạng SO SÁNH HAI VAI ở đâu có thể.
    kiem = [
        ("AC-7a · staff vào URL không đuôi ⇒ Theo khách",
         s["duong_sau_khi_vao_khong_duoi"] == "/crm/anh-su-kien/theo-khach"),
        ("AC-7a · btl KHÔNG bị chuyển",
         b["duong_sau_khi_vao_khong_duoi"] == "/crm/anh-su-kien"),
        ("AC-7b · bảng đồng bộ D126 ẩn với staff, còn với btl",
         (not s["bang_dong_bo_D126_hien"]) and b["bang_dong_bo_D126_hien"]),
        # Đếm CẢ trước lẫn sau cú tick. Chỉ đếm sau thì phép đo tự lừa mình: khi
        # không có ô tick nào trên màn, kịch bản không bấm được gì, và «0 nút GHI»
        # đọc ra đạt trong khi ba cái nút xám vẫn nằm đó.
        ("AC-7c · không nút GHI duyệt nào với staff, btl vẫn có",
         s["so_nut_GHI_duyet"] == 0 and s["sau_khi_tick_so_nut_GHI"] == 0
         and b["so_nut_GHI_duyet"] >= 3 and b["sau_khi_tick_so_nut_GHI"] >= 3),
        ("AC-7d · chip Phân loại / Kho ẩn với staff, còn với btl",
         (not s["chip_phan_loai_hien"]) and (not s["chip_kho_hien"])
         and b["chip_phan_loai_hien"] and b["chip_kho_hien"]),
        ("AC-7e · nút «Về CRM» (403 với staff) ẩn với staff",
         (not s["nut_ve_crm_hien"]) and b["nut_ve_crm_hien"]),
        ("AC-7f · staff chỉ thấy tấm ĐÃ duyệt; btl thấy cả gợi ý chờ",
         s["so_tam_album"] > 0 and s["so_tam_cho_duyet"] == 0 and b["so_tam_cho_duyet"] > 0),
        ("AC-7g · ô tick của staff nằm trên tấm album (để tải), của btl trên tấm chờ",
         s["so_o_tick_tren_tam_album"] > 0 and s["so_o_tick_tren_tam_cho"] == 0
         and b["so_o_tick_tren_tam_cho"] > 0 and b["so_o_tick_tren_tam_album"] == 0),
        ("AC-7h · staff tick xong vẫn tải được",
         s["sau_khi_tick_co_nut_tai"]),
        ("AC-7i · trang Kho nói rõ dành cho BTL với staff, nguyên vẹn với btl",
         s["kho_hien_bao_chi_ban_to_chuc"] and (not s["kho_hien_nut_chon_thu_muc"])
         and b["kho_hien_nut_chon_thu_muc"]),
        ("AC-7j · staff không gặp 401/403 nào trên đường đi",
         s["loi_401_403"] == []),
        ("AC-7k · không lỗi JavaScript ở cả hai vai",
         s["loi_javascript"] == [] and b["loi_javascript"] == []),
    ]
    hong = [t for t, ok in kiem if not ok]
    print(json.dumps({"ok": not hong, "hong": hong,
                      "kiem": {t: ok for t, ok in kiem}, "do_duoc": ra},
                     ensure_ascii=False, indent=2))
    sys.exit(0 if not hong else 1)


if __name__ == "__main__":
    main()
