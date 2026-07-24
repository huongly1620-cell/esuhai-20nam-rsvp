/* ============================================================================
 * CẤU HÌNH CHUNG cho cả 2 trang (dang-ky.html + tiec-toi.html)
 * ESUHAI Group · 20 Năm · Xác nhận tham dự · 08.08.2026
 * ----------------------------------------------------------------------------
 * SoT hiện tại: backend Railway + Postgres (KHÔNG còn Google Sheet / Apps Script).
 * Form gửi JSON tới API cùng origin: POST /api/rsvp  → ghi thẳng Postgres.
 *
 * Vì trang được phục vụ bởi chính server Railway nên endpoint để TƯƠNG ĐỐI
 * ("/api/rsvp") là đủ — không cần dán link, không CORS.
 *
 * (Đường Google Apps Script cũ đã DEPRECATED — xem apps-script/*.)
 * ========================================================================== */

window.RSVP_ENDPOINT = "/api/rsvp";
