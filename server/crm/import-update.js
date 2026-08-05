'use strict';

// E08-D032 — vòng «xuất Excel để cập nhật → sửa → nhập ngược».
//
// TÁCH HẲN khỏi `/crm/import` và khỏi `admin.js`:
//  * `/crm/import` là đường nạp danh sách mới, dùng `detectCol` khớp MỜ.
//  * `admin.js` ghi `table_no = $1` nên ô rỗng XOÁ dữ liệu — và sẽ bị bỏ (CR-33).
//
// HAI LỆNH TÁCH BẠCH, không phải một nút có cờ:
//    POST /crm/import-update/dry-run   → chỉ đếm, KHÔNG ghi một byte nào
//    POST /crm/import-update/commit    → ghi, trong MỘT transaction
// Gộp làm một với cờ `?commit=1` thì sớm muộn có người bấm nhầm thành ghi thật.

const crypto = require('crypto');
const { pool } = require('../db');
const { logAudit } = require('./audit');
const { ipOf } = require('./auth');
const att = require('./attendance');
const { nameKey } = require('./vnjb-keys');

// ---- dò cột: khớp CHÍNH XÁC, không `indexOf` ------------------------------
// M2: `norm()` của import.js dùng NFD, mà NFD KHÔNG tách chữ Đ (U+0110 là ký tự
// riêng). "Đơn vị" → "đonvi": không khớp khoá `donvi` (mất cột Đơn vị) nhưng
// CHỨA "nv" nên khớp khoá `nv` của `assigned` ⇒ tên công ty chui vào
// crm_assignments.staff_email. Ở đây đổi Đ→D TRƯỚC khi NFD, và so khớp CẢ CHUỖI
// chứ không phải `indexOf` — chính `indexOf` là thứ để "nv" ăn "đonvi".
// KHÔNG sửa `norm()` toàn cục: nó là mìn chung của các đường import đang chạy,
// phải là vé riêng có Gate 2 của chính nó (CR-39).
function key(s) {
  return String(s == null ? '' : s).normalize('NFC')
    .replace(/[ĐÐ]/g, 'D').replace(/[đð]/g, 'd')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const COLS = {
  ma: ['makhachkhoakhongsua', 'makhach', 'maid', 'guestextid'],
  ten: ['hoten', 'ten'],
  donvi: ['donvi'],
  chuc: ['chucdanh', 'chucvu'],
  ban: ['ban', 'soban'],
  ghe: ['ghe', 'soghe'],
  attn: ['trangthaithamdukhongthamduchoxacnhan', 'trangthai'],
  phutrach: ['phutrach', 'nguoiphutrach'],
};

function mapHeader(hdr) {
  const k = hdr.map(key);
  const out = {};
  for (const name of Object.keys(COLS)) {
    out[name] = -1;
    for (const want of COLS[name]) { const i = k.indexOf(want); if (i > -1) { out[name] = i; break; } }
  }
  return { idx: out, keys: k };
}

// ---- ô trạng thái ---------------------------------------------------------
const ATT_TEXT = {
  thamdu: 'du', codu: 'du',
  khongthamdu: 'khong', khongdu: 'khong',
  choxacnhan: 'cho', chuaxacnhan: 'cho',
};
// CR-44: Ly phải xoá được `table_no = "Không tham dự"` của thẻ 39, mà luật
// «ô rỗng = không đổi» thì không xoá được gì. Quy ước xoá TƯỜNG MINH.
// CẤM `x`/`X`: trong chính file của Ly, `x` mang nghĩa «không dự».
const DEL = new Set(['xoa', 'xoatrong', 'delete', 'clear']);
const isDel = (v) => DEL.has(key(v));

const clean = (v) => String(v == null ? '' : v).trim();

// Khoá cho khách MỚI — tất định từ nội dung, không ngẫu nhiên: chạy đúng file đó
// hai lần thì lần hai KHỚP dòng cũ và UPDATE, không đẻ bản thứ hai.
// Cùng công thức `vnjb-<sha1>` của D022.
function newCode(ten, donvi, chuc) {
  return 'upd-' + crypto.createHash('sha1')
    .update(nameKey(ten) + '|' + nameKey(donvi) + '|' + nameKey(chuc))
    .digest('hex').slice(0, 10);
}

// ---- lập kế hoạch (dùng chung cho dry-run và commit) -----------------------
async function plan(client, rows) {
  if (!rows || rows.length < 2) { const e = new Error('File trống.'); e.code = 'EMPTY'; throw e; }
  const { idx } = mapHeader(rows[0]);
  if (idx.ma < 0) { const e = new Error('Cần cột "Mã khách".'); e.code = 'NOMA'; throw e; }

  const cur = (await client.query(
    'SELECT id, guest_ext_id, table_no, seat_no, att_override FROM crm_guests WHERE deleted_at IS NULL')).rows;
  const byExt = new Map(cur.filter((x) => x.guest_ext_id).map((x) => [x.guest_ext_id, x]));

  const capNhat = []; const taoMoi = []; const khongKhop = []; const loi = [];
  let xoaBan = 0; let xoaGhe = 0; let xoaAtt = 0;
  const seenCode = new Set();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const g = (i) => (i > -1 ? clean(row[i]) : '');
    const ma = g(idx.ma); const ten = g(idx.ten);
    if (!ma && !ten) continue;                       // dòng trống hoàn toàn

    // Ô trạng thái: chữ lạ thì HỎNG CẢ DÒNG, không bỏ qua im lặng — Ly gõ "Ko
    // tham dự" mà màn báo "đã cập nhật" chính là báo xanh giả (lớp lỗi CỬA-2).
    const attRaw = g(idx.attn);
    let attVal;                                       // undefined = không đổi
    if (attRaw) {
      if (isDel(attRaw)) { attVal = null; xoaAtt++; }
      else {
        const m = ATT_TEXT[key(attRaw)];
        if (!m) { loi.push({ dong: r + 1, ma, lyDo: 'Trạng thái không hiểu: "' + attRaw + '"' }); continue; }
        attVal = m;
      }
    }
    const banRaw = g(idx.ban); const gheRaw = g(idx.ghe);
    const val = (raw, onDel) => {
      if (!raw) return undefined;                     // ô rỗng = KHÔNG đổi
      if (isDel(raw)) { onDel(); return null; }        // xoá tường minh
      return raw;
    };
    const rec = {
      dong: r + 1, ma,
      ten, donvi: g(idx.donvi) || undefined, chuc: g(idx.chuc) || undefined,
      ban: val(banRaw, () => { xoaBan++; }),
      ghe: val(gheRaw, () => { xoaGhe++; }),
      att: attVal,
    };

    const hit = ma ? byExt.get(ma) : null;
    if (hit) { rec.id = hit.id; capNhat.push(rec); continue; }
    if (ma) { khongKhop.push({ dong: r + 1, ma }); continue; }
    if (!ten) continue;
    const code = newCode(ten, rec.donvi || '', rec.chuc || '');
    // Chạy LẠI đúng file đó: khoá tất định nên khách mới của lượt trước đã có
    // thẻ ⇒ lần này là CẬP NHẬT, không phải lỗi. Nếu coi là lỗi thì luật
    // «có lỗi thì không ghi gì» sẽ chặn cả file — mà nhập lại cùng file là
    // việc Ly làm thường xuyên nhất.
    const daCo = byExt.get(code);
    if (daCo) { rec.id = daCo.id; rec.ma = code; capNhat.push(rec); continue; }
    // Hai DÒNG trong CÙNG file trùng khoá thì mới là lỗi thật — không im lặng gộp.
    if (seenCode.has(code)) {
      loi.push({ dong: r + 1, ma: code, lyDo: 'Trùng khoá với một dòng khác trong cùng file (cùng tên + đơn vị + chức danh)' });
      continue;
    }
    seenCode.add(code);
    rec.code = code;
    taoMoi.push(rec);
  }
  return { capNhat, taoMoi, khongKhop, loi, xoa: { ban: xoaBan, ghe: xoaGhe, att: xoaAtt }, idx };
}

const tomTat = (p) => ({
  capNhat: p.capNhat.length,
  // Ở lượt GHI, `taoMoi` là số dòng THẬT SỰ chèn được (ON CONFLICT có thể hụt
  // trong im lặng); ở dry-run là số dự kiến.
  taoMoi: (p.daChen !== undefined ? p.daChen : p.taoMoi.length),
  taoMoiDuKien: p.taoMoi.length,
  khongKhop: p.khongKhop.length, loi: p.loi.length,
  seXoa: p.xoa,
  danhSachKhongKhop: p.khongKhop.slice(0, 50),
  danhSachLoi: p.loi.slice(0, 50),
  // Cột «Phụ trách» CÓ trong file để Ly nhìn, nhưng KHÔNG ghi: nó lấy từ chuỗi
  // note («S2 phụ trách»), là TÊN người, trong khi crm_assignments.staff_email
  // là email. Ghi tên vào cột email chính là hình dạng của mìn M2.
  ghiChu: 'Cột «Phụ trách» chỉ để xem, KHÔNG ghi vào hệ thống.',
});

function mount(app, requireCrmAuth, requireRole, upload, parseUpload) {
  // ---- pha 1: chỉ đếm ----
  app.post('/crm/import-update/dry-run', requireCrmAuth, requireRole('btl'), upload.single('file'), async (req, res) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN TRANSACTION READ ONLY');
      const p = await plan(client, parseUpload(req));
      await client.query('ROLLBACK');
      return res.json({ ok: true, dryRun: true, ...tomTat(p) });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[import-update] dry-run failed:', err.message);
      return res.status(err.code ? 400 : 500).json({ ok: false, error: err.message });
    } finally { if (client) client.release(); }
  });

  // ---- pha 2: ghi, một transaction ----
  app.post('/crm/import-update/commit', requireCrmAuth, requireRole('btl'), upload.single('file'), async (req, res) => {
    let client;
    try {
      client = await pool.connect();
      let p;
      try {
        await client.query('BEGIN');
        p = await plan(client, parseUpload(req));
        // Có dòng hỏng thì KHÔNG ghi gì cả. Ghi một nửa rồi báo lỗi là trạng
        // thái tệ nhất: Ly không biết phần nào đã vào.
        if (p.loi.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ ok: false, error: 'Có ' + p.loi.length + ' dòng lỗi — chưa ghi gì.', ...tomTat(p) });
        }
        for (const rec of p.capNhat) {
          await client.query(
            `UPDATE crm_guests SET
               org       = COALESCE($2, org),
               title     = COALESCE($3, title),
               table_no  = CASE WHEN $4::boolean THEN $5::text ELSE table_no END,
               seat_no   = CASE WHEN $6::boolean THEN $7::text ELSE seat_no END,
               att_override = CASE WHEN $8::boolean THEN $9::text ELSE att_override END,
               att_override_at = CASE WHEN $8::boolean THEN now() ELSE att_override_at END,
               att_override_by = CASE WHEN $8::boolean THEN $10::text ELSE att_override_by END,
               updated_at = now()
             WHERE id = $1 AND deleted_at IS NULL`,
            [rec.id, rec.donvi || null, rec.chuc || null,
              rec.ban !== undefined, rec.ban === undefined ? null : rec.ban,
              rec.ghe !== undefined, rec.ghe === undefined ? null : rec.ghe,
              rec.att !== undefined, rec.att === undefined ? null : rec.att,
              req.actor.email]);
        }
        // ON CONFLICT DO NOTHING có thể chèn hụt trong im lặng. Đếm số dòng THẬT
        // SỰ chèn được và báo con số đó, đừng báo lại độ dài danh sách dự kiến.
        let daChen = 0;
        for (const rec of p.taoMoi) {
          const ins = await client.query(
            `INSERT INTO crm_guests (guest_ext_id, full_name, org, title, table_no, seat_no, att_override, att_override_at, att_override_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END, CASE WHEN $7::text IS NULL THEN NULL ELSE $8::text END)
             ON CONFLICT (guest_ext_id) DO NOTHING RETURNING id`,
            [rec.code, rec.ten, rec.donvi || null, rec.chuc || null,
              rec.ban === undefined ? null : rec.ban, rec.ghe === undefined ? null : rec.ghe,
              rec.att === undefined ? null : rec.att, req.actor.email]);
          daChen += ins.rowCount;
        }
        p.daChen = daChen;
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }

      await logAudit(pool, { actor_email: req.actor.email, event_type: 'import_update',
        target_type: 'crm_guests', meta: tomTat(p), ip: ipOf(req) });
      return res.json({ ok: true, dryRun: false, ...tomTat(p) });
    } catch (err) {
      console.error('[import-update] commit failed:', err.message);
      return res.status(err.code ? 400 : 500).json({ ok: false, error: err.message });
    } finally { if (client) client.release(); }
  });
}

module.exports = { mount, key, mapHeader, newCode, ATT_TEXT, isDel, plan };
