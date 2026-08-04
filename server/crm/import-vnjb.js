'use strict';

/**
 * E08-D022 Pha 2 — nạp SoT "Khách Việt Nam+Nhat Ban" + đổ ảnh lên kệ MinIO.
 *
 *   node server/crm/import-vnjb.js               # dry-run, không ghi gì
 *   node server/crm/import-vnjb.js --commit      # ghi Postgres + MinIO
 *
 * Chốt Sponsor 04/08 (E08-D022 Pha 2):
 *  - SoT = DUY NHẤT sheet visible `Khách Việt Nam+Nhat Ban`. Sheet ẩn → dừng.
 *  - Mã: vnjb-<sha1(tên|đơn vị|chức vụ)[0..9]> — không dùng STT vì Ly chèn/xoá
 *    dòng là STT đổi hết, lần chạy sau sẽ nhân đôi toàn bộ.
 *  - 32 tên mơ hồ (khớp >1 khách prod): TẠO MỚI + tag `trung-ten-can-ra`,
 *    không fuzzy — ghép nhầm thì gán ảnh/buổi sai người.
 *  - 13 khách `x` cả hai buổi → `khong-du`; 11 khách trống cả hai → `chua-ro-buoi`.
 *    Hai nhóm này KHÁC NHAU: một bên đã trả lời không dự, một bên chưa trả lời.
 *  - Khách thừa (có trên prod, không trong SoT): soft-delete — TRỪ người đã
 *    đăng ký qua form. Lý do: `sync-from-rsvp.js:26` tra `deleted_at IS NULL`,
 *    nên soft-delete họ xong `backfill-rsvp.js` sẽ INSERT lại thành bản ghi mới
 *    không mang tag. Hoãn sang vé sửa sync.
 *  - SĐT: sheet KHÔNG có cột nào. Không bao giờ ghi đè phone bằng rỗng.
 *
 * Idempotent: chạy lại cùng file không tạo thêm khách/ảnh (khoá theo
 * guest_ext_id và object_key tất định).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { pool } = require('../db');
const storage = require('./storage');
const { logAudit } = require('./audit');

const COMMIT = process.argv.includes('--commit');
const WB = process.env.VNJB_XLSX
  || path.join(__dirname, '..', '..', 'data', 'inbox', 'IMPOR-BTK_DS KHACH MOI.xlsx');
const SHEET = 'Khách Việt Nam+Nhat Ban';
const PHOTO_ROOT = process.env.VNJB_PHOTOS
  || '/Users/hoangkha/Library/CloudStorage/OneDrive-Esuhai/ALESU - HÌNH KHÁCH MỜI';
const ACTOR = 'import-vnjb-0408';
// Ảnh trùng tên ở nhiều thư mục → ưu tiên theo thứ tự Sponsor chốt.
const DIR_PRIORITY = ['KHÁCH VIỆT - TGĐ', 'KHÁCH VIỆT NAM - TTLK', 'KOKATEAM'];

const C = { stt: 0, tinh: 1, phanloai: 2, vip: 4, donvi: 5, chucvu: 6, ten: 7,
  donviJP: 8, chucvuJP: 9, tenJP: 10,
  lydo: 11, phutrach: 12, toadam: 16, gala: 17, ban: 18, file: 31, ghichu: 32 };

const norm = (s) => String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim();
const HONOR = /^(anh|chị|chi|ông|ong|bà|ba|cô|co|chú|chu|thầy|thay|em|mr|mrs|ms|dr|gs|ts)\.?\s+/i;
function nameKey(s) {
  let x = norm(s).toLowerCase();
  for (let i = 0; i < 3; i++) x = x.replace(HONOR, '');
  return x.trim();
}
const ox = (v) => { const s = norm(v).toLowerCase(); return s === 'o' ? 'o' : (s === 'x' ? 'x' : (s ? '?' : '')); };
const isNA = (v) => { const s = norm(v).toLowerCase(); return !s || s === 'n/a' || s === 'na' || s === 'x' || s === '-'; };
// Chỉ nhận ô THẬT SỰ có chữ Nhật (hiragana/katakana/kanji). Cột "Họ và tên
// (tiếng Nhật)" của sheet có 186 ô nhưng 123 ô là tên Việt viết latin — nạp
// thẳng thì PG Nhật thấy tên tiếng Việt gắn nhãn tiếng Nhật.
const HAS_JP = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
const jpOnly = (v) => { const x = norm(v); return x && HAS_JP.test(x) ? x : null; };

const extOf = (f) => (String(f).match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase();
const ctype = (f) => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.heic': 'image/heic', '.webp': 'image/webp', '.jfif': 'image/jpeg', '.cr2': 'image/x-canon-cr2' })[extOf(f)] || 'application/octet-stream';

function codeOf(r) {
  return 'vnjb-' + crypto.createHash('sha1')
    .update(nameKey(r[C.ten]) + '|' + nameKey(r[C.donvi]) + '|' + nameKey(r[C.chucvu]))
    .digest('hex').slice(0, 10);
}

// Bỏ dấu tiếng Việt TRƯỚC khi slug hoá. Nếu không, "PTGĐ" → "ptg-" và
// "Đối tác/Khách hàng" → "-i-t-c-kh-ch-h-ng" — tag rác hiện nguyên xi trên /crm,
// lại còn tách một chức danh làm hai (`pl:ptg-` và `pl:ptgd` cùng là PTGĐ).
function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 24);
}

// `hasForm`: khách đã có bản đăng ký thì buổi đọc từ form (D016 luật 5 — ba nhóm
// phải RỜI NHAU). Gắn thêm tag buổi cho họ làm giao ≠ 0, KPI phải hạ dòng
// "Dự Gala". Đã sửa tay một lần trên prod; đưa vào code để chạy lại tái tạo được
// đúng trạng thái đó thay vì phá lại.
function tagsOf(r, hasForm) {
  const t = ['vnjb'];
  const td = ox(r[C.toadam]); const ga = ox(r[C.gala]);
  if (!hasForm) {
    if (td === 'o') t.push('toa-dam');
    if (ga === 'o') t.push('gala');
  }
  if (td === 'x' && ga === 'x') t.push('khong-du');           // đã trả lời KHÔNG dự
  if (td === '' && ga === '') t.push('chua-ro-buoi');          // chưa trả lời
  const vip = norm(r[C.vip]); if (/vip/i.test(vip)) t.push('vip');
  const pl = norm(r[C.phanloai]); if (pl) { const s = slug(pl); if (s) t.push('pl:' + s); }
  return t;
}

function buildPhotoIndex() {
  const files = [];
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jpe?g|png|heic|webp|jfif|cr2)$/i.test(e.name)) files.push({ abs: p, name: e.name, rel: path.relative(PHOTO_ROOT, d) });
    }
  })(PHOTO_ROOT);
  const idx = new Map();
  const add = (k, f) => { if (!k) return; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(f); };
  for (const f of files) {
    const base = norm(f.name).toLowerCase();
    const stem = base.replace(/\.[a-z0-9]+$/i, '');
    add(base, f); add(stem, f); add(nameKey(stem), f);
  }
  return { files, idx };
}

// Trình duyệt không hiển thị được HEIC/CR2 → thẻ khách có bản ghi ảnh nhưng vẫn
// ra initials, và smoke báo lệch UI/API. Bỏ qua ở khâu chọn thay vì tải lên rồi
// sửa tay (bản đầu phải chuyển 3 file bằng `sips` sau khi đã up).
const BROWSER_OK = /\.(jpe?g|png|webp|jfif)$/i;

function pickPhoto(idx, cell) {
  if (isNA(cell)) return null;
  const base = norm(cell).toLowerCase();
  const stem = base.replace(/\.[a-z0-9]+$/i, '');
  const all = idx.get(base) || idx.get(stem) || idx.get(nameKey(stem));
  const hits = (all || []).filter((f) => BROWSER_OK.test(f.name));
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const rank = (f) => { const i = DIR_PRIORITY.findIndex((d) => f.rel === d || f.rel.startsWith(d + path.sep)); return i < 0 ? 99 : i; };
  return hits.slice().sort((a, b) => rank(a) - rank(b) || a.abs.localeCompare(b.abs))[0];
}

(async () => {
  // ---- SoT: bắt buộc visible ----
  const wb = XLSX.readFile(WB);
  const i = wb.SheetNames.indexOf(SHEET);
  const meta = (wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[i]) || {};
  if (i < 0) throw new Error('không thấy sheet SoT: ' + SHEET);
  if (meta.Hidden !== 0) throw new Error('sheet SoT không ở trạng thái visible — dừng theo chốt Sponsor');

  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, defval: '', raw: false });
  const body = aoa.slice(2).filter((r) => r.some((x) => norm(x)));
  const rows = body.filter((r) => norm(r[C.ten]));

  // gộp dòng lặp: cùng mã → giữ dòng đầu
  const byCode = new Map();
  for (const r of rows) { const c = codeOf(r); if (!byCode.has(c)) byCode.set(c, r); }

  const { files, idx } = buildPhotoIndex();

  const prodRes = await pool.query(
    'SELECT id, guest_ext_id, full_name, phone, tags, response_id FROM crm_guests WHERE deleted_at IS NULL');
  const prod = prodRes.rows;
  const byExt = new Map(prod.filter((p) => p.guest_ext_id).map((p) => [p.guest_ext_id, p]));
  const byName = new Map();
  prod.forEach((p) => { const k = nameKey(p.full_name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); });

  const plan = { update: [], linkUpdate: [], create: [], photo: [], photoMissing: 0, deactivate: [], keepForm: [] };

  for (const [code, r] of byCode) {
    const nk = nameKey(r[C.ten]);
    // khách này đã có bản đăng ký chưa? (quyết định có gắn tag buổi hay không)
    const known = byExt.get(code) || ((byName.get(nk) || []).length === 1 ? byName.get(nk)[0] : null);
    const tags = tagsOf(r, !!(known && known.response_id));
    const rec = {
      code, full_name: norm(r[C.ten]), org: norm(r[C.donvi]), title: norm(r[C.chucvu]),
      table_no: norm(r[C.ban]) || null,
      note: [norm(r[C.lydo]) && 'Lý do mời: ' + norm(r[C.lydo]),
        norm(r[C.phutrach]) && 'S2 phụ trách: ' + norm(r[C.phutrach]),
        norm(r[C.ghichu]) && 'Ghi chú: ' + norm(r[C.ghichu])].filter(Boolean).join(' · ') || null,
      name_jp: jpOnly(r[C.tenJP]), title_jp: jpOnly(r[C.chucvuJP]), org_jp: jpOnly(r[C.donviJP]),
      tags, photo: pickPhoto(idx, r[C.file]),
    };
    if (!rec.photo && !isNA(r[C.file])) plan.photoMissing++;

    const hitExt = byExt.get(code);
    if (hitExt) { plan.update.push({ id: hitExt.id, rec }); continue; }
    const hits = byName.get(nk) || [];
    if (hits.length === 1) plan.linkUpdate.push({ id: hits[0].id, rec });
    else if (hits.length > 1) { rec.tags = tags.concat('trung-ten-can-ra'); plan.create.push(rec); }
    else plan.create.push(rec);
  }

  // khách thừa: có trên prod, không trong SoT
  const sotNames = new Set([...byCode.values()].map((r) => nameKey(r[C.ten])));
  const sotCodes = new Set(byCode.keys());
  for (const p of prod) {
    if (p.guest_ext_id && sotCodes.has(p.guest_ext_id)) continue;
    if (sotNames.has(nameKey(p.full_name))) continue;
    if (p.response_id !== null) plan.keepForm.push(p.id);   // chốt: KHÔNG deactivate
    else plan.deactivate.push(p.id);
  }

  const withPhoto = [...plan.update, ...plan.linkUpdate].filter((x) => x.rec.photo).length
    + plan.create.filter((r) => r.photo).length;

  console.log(JSON.stringify({
    che_do: COMMIT ? 'COMMIT (SẼ GHI)' : 'DRY-RUN (không ghi)',
    sheet: SHEET, visible: meta.Hidden === 0,
    sot: { dong: body.length, coTen: rows.length, sauKhuTrung: byCode.size },
    ke_hoach: {
      capNhatTheoMa: plan.update.length,
      noiTheoTenRoiCapNhat: plan.linkUpdate.length,
      taoMoi: plan.create.length,
      trongDoTrungTenCanRa: plan.create.filter((r) => r.tags.includes('trung-ten-can-ra')).length,
      softDeleteKhachThua: plan.deactivate.length,
      giuLaiVìCóFormĐăngKý: plan.keepForm.length,
    },
    anh: { fileOneDrive: files.length, seGan: withPhoto, khongThayFile: plan.photoMissing },
    prod_truoc: { active: prod.length },
    du_kien_sau: { active: prod.length + plan.create.length - plan.deactivate.length },
  }, null, 1));

  if (!COMMIT) { console.log('\nDRY-RUN — chưa ghi gì. Thêm --commit để thực thi.'); await pool.end(); return; }

  // ---------------- COMMIT ----------------
  let nUpd = 0, nNew = 0, nDel = 0, nPhoto = 0, nPhotoSkip = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // MERGE tag, không ghi đè. Bản đầu dùng `tags = $7` và xoá sạch `tgd116` +
    // `kcode:Kxxx` trên ~58 thẻ — `kcode` là đường DUY NHẤT truy ngược về cách
    // đánh số K của chị Ly trên DS Sếp, và ô "trong đó N từ DS Sếp" trên /crm
    // tụt từ ~114 xuống 30. Cùng khuôn với sync-from-rsvp.js:11.
    const upd = async (id, rec) => {
      const cur = await client.query('SELECT tags FROM crm_guests WHERE id = $1', [id]);
      const set = new Set(String((cur.rows[0] || {}).tags || '').split(',').map((s) => s.trim()).filter(Boolean));
      rec.tags.forEach((t) => set.add(t));
      await client.query(
        `UPDATE crm_guests SET
           full_name = $1,
           org   = CASE WHEN $2 = '' THEN org   ELSE $2 END,
           title = CASE WHEN $3 = '' THEN title ELSE $3 END,
           note  = COALESCE($4, note),
           table_no = COALESCE($5, table_no),
           guest_ext_id = COALESCE(guest_ext_id, $6),
           tags = $7,
           name_jp  = COALESCE($9,  name_jp),
           title_jp = COALESCE($10, title_jp),
           org_jp   = COALESCE($11, org_jp),
           updated_at = now()
         WHERE id = $8`,
        [rec.full_name, rec.org, rec.title, rec.note, rec.table_no, rec.code,
          Array.from(set).join(','), id, rec.name_jp, rec.title_jp, rec.org_jp]);
      nUpd++;
    };
    for (const x of plan.update) await upd(x.id, x.rec);
    for (const x of plan.linkUpdate) await upd(x.id, x.rec);
    for (const rec of plan.create) {
      const r = await client.query(
        `INSERT INTO crm_guests (guest_ext_id, full_name, org, title, note, table_no, tags, name_jp, title_jp, org_jp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (guest_ext_id) DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = now()
         RETURNING id`,
        [rec.code, rec.full_name, rec.org, rec.title, rec.note, rec.table_no, rec.tags.join(','),
          rec.name_jp, rec.title_jp, rec.org_jp]);
      rec._id = r.rows[0].id; nNew++;
    }
    if (plan.deactivate.length) {
      await client.query('UPDATE crm_guests SET deleted_at = now(), updated_at = now() WHERE id = ANY($1::bigint[])',
        [plan.deactivate]);
      nDel = plan.deactivate.length;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); client.release(); throw e; }
  client.release();

  // ---- ảnh: ngoài transaction, idempotent theo object_key ----
  if (!storage.isConfigured()) console.log('⚠ MinIO chưa cấu hình — bỏ phần ảnh');
  else {
    await storage.ensureBucket();
    const all = [...plan.update, ...plan.linkUpdate].map((x) => ({ id: x.id, rec: x.rec }))
      .concat(plan.create.map((r) => ({ id: r._id, rec: r })));
    for (const { id, rec } of all) {
      if (!id || !rec.photo) continue;
      const key = `crm/vnjb/${rec.code}/${crypto.createHash('sha1').update(rec.photo.name).digest('hex').slice(0, 16)}${extOf(rec.photo.name)}`;
      const ex = await pool.query('SELECT 1 FROM crm_photos WHERE guest_id=$1 AND object_key=$2', [id, key]);
      if (ex.rowCount) { nPhotoSkip++; continue; }
      const buf = fs.readFileSync(rec.photo.abs);
      await storage.putObjectAt(key, buf, ctype(rec.photo.name));
      await pool.query(
        'INSERT INTO crm_photos (guest_id, object_key, content_type, size, uploaded_by) VALUES ($1,$2,$3,$4,$5)',
        [id, key, ctype(rec.photo.name), buf.length, ACTOR]);
      nPhoto++;
    }
  }

  // Import 72 update + 259 insert + 31 soft-delete + 166 ảnh mà không để lại
  // dòng audit nào là ngược đúng tinh thần D024. import-tgd-116.js có ghi.
  await logAudit(pool, {
    actor_email: ACTOR, event_type: 'import_vnjb', target_type: 'batch',
    meta: { sheet: SHEET, capNhat: nUpd, taoMoi: nNew, softDelete: nDel, anhTaiLen: nPhoto, anhBoQua: nPhotoSkip },
  });

  const after = await pool.query('SELECT count(*)::int n FROM crm_guests WHERE deleted_at IS NULL');
  const ph = await pool.query('SELECT count(*)::int n FROM crm_photos');
  console.log(JSON.stringify({ ket_qua: { capNhat: nUpd, taoMoi: nNew, softDelete: nDel,
    anhTaiLen: nPhoto, anhDaCo_boQua: nPhotoSkip,
    khachActiveSau: after.rows[0].n, tongAnhSau: ph.rows[0].n } }, null, 1));
  await pool.end();
})().catch((e) => { console.error('LỖI:', e.message); process.exit(1); });
