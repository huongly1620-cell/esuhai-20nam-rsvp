#!/usr/bin/env python3
"""Phần UI của `npm run smoke:crm` (E08-D025).

Mở /crm thật bằng Chromium + header Bearer, đếm DOM, in JSON ra stdout.
Cố ý KHÔNG in tên/SĐT khách — chỉ đếm. Token nhận qua env, không qua argv
(argv lộ trong `ps`).

Chạy riêng:  CRM_SMOKE_BEARER=… CRM_BASE_URL=… python3 tools/smoke-crm-ui.py
"""
import json
import os
import sys

BASE = os.environ.get("CRM_BASE_URL", "").rstrip("/")
TOK = os.environ.get("CRM_SMOKE_BEARER", "")

if not BASE or not TOK:
    print(json.dumps({"ok": False, "error": "thiếu CRM_BASE_URL hoặc CRM_SMOKE_BEARER"}))
    sys.exit(2)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(json.dumps({"ok": False, "error": "chưa cài playwright cho python3 (pip install playwright && playwright install chromium)"}))
    sys.exit(3)

out = {"ok": False}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        # Token phải ở lại trong hạ tầng của mình. `/crm` có <link> tới
        # fonts.googleapis.com, mà extra_http_headers gắn Authorization cho MỌI
        # origin → mỗi lần smoke là một dòng access log của Google có token.
        #
        # Cách chặn: giữ extra_http_headers (ảnh /crm/photos/:id cần auth), rồi
        # ABORT mọi request rời khỏi biên giới. Không viết lại header — thử rồi:
        # continue_(headers=…) làm mất ngữ cảnh fetch của ảnh và Chromium chặn
        # bằng ERR_BLOCKED_BY_ORB, ảnh về 0. Redirect /crm/photos → MinIO là
        # phần nối tiếp của cùng một request nên không đi qua handler này.
        ctx = browser.new_context(
            viewport={"width": 1000, "height": 1400},
            extra_http_headers={"Authorization": "Bearer " + TOK},
        )
        blocked = []

        def _keep_token_inside(route):
            url = route.request.url
            if url.startswith(BASE):
                route.continue_()
                return
            redirected_from = route.request.redirected_from
            if redirected_from is not None and redirected_from.url.startswith(BASE):
                route.continue_()   # ta tự redirect tới đó (MinIO) — hạ tầng của mình
                return
            blocked.append(url.split("/")[2] if "//" in url else url)
            route.abort()

        ctx.route("**/*", _keep_token_inside)
        page = ctx.new_page()
        js_errors = []
        page.on("pageerror", lambda e: js_errors.append(str(e)[:200]))
        page.goto(BASE + "/crm", wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(2500)

        has_kpi = page.locator("#kpiCard").count()
        # Đọc ĐÚNG ô số đầu tiên của KPI ("Tổng khách mời") thay vì dò chuỗi con
        # trong cả khối: includes("173") khớp nhầm với 1730, 2173, hay bất kỳ số
        # nào khác chứa nó — UI vẽ sai vẫn lọt.
        kpi_invited = None
        if has_kpi:
            box = page.locator("#kpiCard .kgrid .kbox").first.locator(".kn")
            if box.count():
                try:
                    kpi_invited = int("".join(ch for ch in box.inner_text() if ch.isdigit()) or "-1")
                except ValueError:
                    kpi_invited = None

        out = {
            "ok": True,
            "title": page.title(),
            "kpiCard": has_kpi,
            "kpiVisible": page.locator("#kpiCard").is_visible() if has_kpi else False,
            "kpiInvited": kpi_invited,
            # chỉ đếm thẻ khách thật (div.g[data-id]) — "#list > div" đếm cả
            # khung skeleton lúc đang tải và khung "không tìm thấy"
            "guestCards": page.locator("#list > div.g[data-id]").count(),
            "photos": page.locator("#list .av img").count(),
            "langBtn": page.locator("text=日本語").count(),
            "jsErrors": js_errors,
            # origin ngoài đã bị chặn để token không rời hạ tầng — báo ra để
            # người đọc biết chuyện đó có xảy ra, không giấu
            "blockedOrigins": sorted(set(blocked)),
        }
        browser.close()
except Exception as exc:  # noqa: BLE001 — smoke phải báo lỗi chứ không nuốt
    out = {"ok": False, "error": type(exc).__name__ + ": " + str(exc)[:300]}

print(json.dumps(out, ensure_ascii=False))
sys.exit(0 if out.get("ok") else 1)
