'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   E08-D128 · PHÒNG THÍ NGHIỆM CHO PHÉP KIỂM CRM
   ══════════════════════════════════════════════════════════════════════════════
   Dựng đúng cái app thật (`server/crm/index.js` mount lên express như
   `server/index.js` làm), rồi thay ĐÚNG MỘT thứ: `pool.query`.

   Vì sao thay ở `pool` chứ không dựng Postgres:
     · Vé D128 hỏi về ĐƯỜNG QUYẾT ĐỊNH — ai được mint mã, ai mở được trang nào,
       tuyến nào trả 403 — chứ không hỏi về SQL trả đúng dòng nào. Một CSDL thật
       kiểm thứ khác, và nó không chạy được trên máy không có Docker.
     · `server/db.js` xuất MỘT đối tượng `pool` dùng chung; mọi module CRM giữ
       tham chiếu tới chính nó. Gán đè `pool.query` là thay được cho cả cây mà
       không đụng một dòng mã sản phẩm nào.
   Đổi lại, mọi khẳng định ở đây phải là khẳng định về HÀNH VI HTTP hoặc về CÂU
   SQL ĐÃ GỬI ĐI — không phải về dữ liệu trả về, vì dữ liệu ấy là do lab bịa.

   Đường GHI thật (Docker PG + CREATE_SQL) là việc của Gate 2 §B7; lab này cố ý
   không giả vờ thay thế nó. */

const http = require('http');
const express = require('express');
const db = require('../server/db');

// ── Cơ sở dữ liệu giả ─────────────────────────────────────────────────────────
// Hai bảng thật sự có trạng thái (D128 đo chúng); phần còn lại là câu trả lời
// vừa đủ để tuyến không ném 500.
function taoDb() {
  const st = {
    staff_users: new Map(),        // email -> {email, role, active}
    crm_auth_codes: new Map(),     // email -> {code_hash, expires_at, attempts}
    daDuyet: new Set(),            // event_photo_id (chuỗi) đã có dòng `xac-nhan`
    audit: [],
    sql: [],                       // toàn bộ câu đã gửi — để khẳng định về WHERE
    /* Dữ liệu cho phép đo GIAO DIỆN. Rỗng thì mọi tuyến trả list rỗng (đủ cho
       phép đo HTTP); đổ dữ liệu vào thì màn «Theo khách» vẽ ra thật. */
    fixture: { khach: [], anh: [] },
  };

  st.query = async (text, params = []) => {
    const s = String(text);
    st.sql.push(s);

    // ── staff_users ──
    if (/SELECT email, role, active FROM staff_users/.test(s)) {
      const u = st.staff_users.get(params[0]);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (/INSERT INTO staff_users/.test(s)) {
      const email = params[0];
      if (!st.staff_users.has(email)) st.staff_users.set(email, { email, role: 'staff', active: true });
      const u = st.staff_users.get(email);
      return { rows: [u], rowCount: 1 };
    }

    // ── crm_auth_codes ──
    if (/INSERT INTO crm_auth_codes/.test(s)) {
      st.crm_auth_codes.set(params[0], { code_hash: params[1], expires_at: params[2], attempts: 0 });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT code_hash, expires_at, attempts FROM crm_auth_codes/.test(s)) {
      const c = st.crm_auth_codes.get(params[0]);
      return { rows: c ? [c] : [], rowCount: c ? 1 : 0 };
    }
    if (/UPDATE crm_auth_codes SET attempts/.test(s)) {
      const c = st.crm_auth_codes.get(params[0]);
      if (c) c.attempts += 1;
      return { rows: [], rowCount: c ? 1 : 0 };
    }
    if (/DELETE FROM crm_auth_codes/.test(s)) {
      st.crm_auth_codes.delete(params[0]);
      return { rows: [], rowCount: 1 };
    }

    /* ── gác D107 (`tamDaDuyet`): tấm nào đã có một dòng `xac-nhan` ──
       Khớp bằng mệnh đề WHERE đầy đủ, không bằng «SELECT 1 FROM crm_face_candidates»:
       `demCho` trong face-match.js cũng mở đầu đúng như thế bên trong NOT EXISTS,
       và một regex rộng ở đây sẽ trả nhầm hình dạng cho tuyến `khoi` → 500. */
    if (/WHERE event_photo_id = \$1 AND deleted_at IS NULL AND trang_thai = 'xac-nhan' LIMIT 1/.test(s)) {
      const co = st.daDuyet.has(String(params[0]));
      return { rows: co ? [{ '?column?': 1 }] : [], rowCount: co ? 1 : 0 };
    }

    // ── audit ──
    if (/INSERT INTO crm_audit_events/.test(s)) {
      st.audit.push({ actor: params[0], event: params[1] });
      return { rows: [], rowCount: 1 };
    }

    // ── face-match: dữ liệu cho màn «Theo khách» (rỗng nếu không đổ fixture) ──
    if (/SELECT \* FROM k WHERE true/.test(s)) {
      return { rows: st.fixture.khach, rowCount: st.fixture.khach.length };
    }
    if (/row_number\(\) OVER \(PARTITION BY m\.guest_id/.test(s)) {
      /* Tôn trọng ĐÚNG mệnh đề mà mã sản phẩm vừa sinh ra: nếu câu chỉ hỏi
         `('xac-nhan')` thì lab không được trả dòng `cho`. Nếu bỏ qua chỗ này thì
         phép đo giao diện sẽ xanh kể cả khi bộ lọc theo vai bị gỡ mất. */
      const chiAlbum = /IN \('xac-nhan'\)/.test(s);
      const rows = st.fixture.anh.filter((a) => !chiAlbum || a.trang_thai === 'xac-nhan');
      return { rows, rowCount: rows.length };
    }
    if (/count\(\*\)::int n FROM k\b/.test(s)) {
      return { rows: [{ n: st.fixture.khach.length }], rowCount: 1 };
    }
    if (/count\(\*\)::int n FROM crm_event_photos/.test(s)) return { rows: [{ n: 0 }], rowCount: 1 };
    if (/FROM crm_guests\s*\n?\s*WHERE id = \$1/.test(s) || /SELECT id, full_name, name_jp, org, org_jp FROM crm_guests/.test(s)) {
      return { rows: [{ id: params[0], full_name: 'Khách Lab', name_jp: null, org: null, org_jp: null }], rowCount: 1 };
    }
    if (/FILTER \(WHERE m\.trang_thai/.test(s)) {
      return { rows: [{ so_album: 0, so_cho: 0 }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };
  /* Các tuyến GHI lấy MỘT client riêng để chạy transaction (`pool.connect()`).
     Không thay cả cửa này thì `pg` đi mở kết nối thật tới một `DATABASE_URL`
     không tồn tại và lượt gọi treo — treo chứ không lỗi, tức phép kiểm đứng im
     chứ không đỏ. BEGIN/COMMIT/ROLLBACK rơi vào nhánh mặc định (rows rỗng); lab
     này không giả vờ có transaction, nó chỉ không được phép treo. */
  st.connect = async () => ({ query: st.query, release() {} });
  return st;
}

// ── Máy chủ lab ───────────────────────────────────────────────────────────────
/* PNG 1×1 — đủ để `<img>` không gãy trong phép đo giao diện. */
const ANH_GIA = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function moLab(tuyChon = {}) {
  const st = taoDb();
  const gocQuery = db.pool.query;
  const gocConnect = db.pool.connect;
  db.pool.query = st.query;
  db.pool.connect = st.connect;

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  /* Chỉ cho phép đo GIAO DIỆN: trả một PNG 1×1 thay cho bytes trong MinIO, đăng ký
     TRƯỚC `crm.mount` nên nó che tuyến thật.
     Nói thẳng cái nó bỏ qua: tuyến này KHÔNG đi qua gác D107 (`tamDaDuyet`). Cổng
     ấy được đo riêng ở AC-6e bằng HTTP thật — chỗ này chỉ để lưới ảnh có hình mà
     chụp màn, không phải để khẳng định điều gì về quyền. */
  if (tuyChon.anhGia) {
    app.get('/crm/event-photos/:id/thumb', (req, res) => res.type('png').send(ANH_GIA));
    app.get('/crm/event-photos/:id/preview', (req, res) => res.type('png').send(ANH_GIA));
  }
  // require SAU khi pool đã bị thay là không cần thiết (tham chiếu chung), nhưng
  // để trong hàm cho rõ: app dựng lên rồi mới nhận yêu cầu nào.
  require('../server/crm').mount(app);

  const srv = http.createServer(app);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const goc_url = 'http://127.0.0.1:' + srv.address().port;

  return {
    db: st,
    url: goc_url,
    async dong() {
      db.pool.query = gocQuery;
      db.pool.connect = gocConnect;
      /* `closeAllConnections` trước `close`: `fetch` của Node giữ socket keep-alive,
         nên `close()` một mình sẽ đợi chúng hết hạn — phép kiểm xanh rồi mà tiến
         trình còn ngồi đó vài chục giây. */
      if (srv.closeAllConnections) srv.closeAllConnections();
      await new Promise((ok) => srv.close(ok));
    },
    /* Một lượt gọi. `cookie` là chuỗi Cookie thô — cách duy nhất lab mang danh
       tính đi, đúng như trình duyệt làm. KHÔNG tự ký token: nếu lab tự ký thì nó
       kiểm chữ ký của chính nó, không kiểm đường đăng nhập thật. */
    async goi(duong, { method = 'GET', cookie = '', body = null, redirect = 'manual' } = {}) {
      const h = {};
      if (cookie) h.cookie = cookie;
      if (body) h['content-type'] = 'application/json';
      const r = await fetch(goc_url + duong, {
        method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect,
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* HTML */ }
      return { status: r.status, headers: r.headers, text, json };
    },
  };
}

/* Chạy TRỌN chuỗi đăng nhập thật để lấy cookie: xin mã → đọc mã in ra log →
   nhập mã → nhận Set-Cookie. Không có đường tắt nào ở đây là cố ý — cookie do
   một đường tắt sinh ra không chứng minh được đường thật còn chạy. */
async function dangNhap(lab, email) {
  const bat = batLog();
  try {
    const xin = await lab.goi('/auth/request-code', { method: 'POST', body: { email } });
    if (xin.status !== 202) throw new Error('request-code trả ' + xin.status);
  } finally { bat.tha(); }
  const ma = bat.ma(email);
  if (!ma) throw new Error('không có mã OTP nào in ra cho ' + email);
  const ok = await lab.goi('/auth/verify', { method: 'POST', body: { email, code: ma } });
  if (ok.status !== 200) throw new Error('verify trả ' + ok.status + ' ' + ok.text);
  const sc = ok.headers.get('set-cookie') || '';
  return sc.split(';')[0];
}

/* Bắt `console.log` để đọc mã OTP ở chế độ `OTP_DELIVERY=console` — cũng chính
   là bằng chứng của AC-1 («in mã ra log»). */
function batLog() {
  const cu = console.log;
  const dong = [];
  console.log = (...a) => { dong.push(a.join(' ')); };
  return {
    tha() { console.log = cu; },
    dong,
    ma(email) {
      const d = dong.filter((x) => x.indexOf('[crm-otp] code for ' + email + ':') === 0).pop();
      return d ? (d.match(/:\s*(\d{6})/) || [])[1] : null;
    },
  };
}

module.exports = { moLab, dangNhap, batLog };
