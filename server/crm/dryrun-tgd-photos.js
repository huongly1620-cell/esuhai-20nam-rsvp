'use strict';

// DRY-RUN ONLY — classify TGĐ photo files against guest names. Writes NOTHING
// to Postgres or MinIO. Reads guest names from the Excel SoT (same names that
// were imported to production) and photo filenames from Anh Kha's OneDrive
// TGĐ subfolder. Emits aggregate counts to stdout and a full PII detail table
// to data/ (gitignored). E08-D018 Gate 1 → dry-run.
//
//   node server/crm/dryrun-tgd-photos.js [photoDir] [xlsxPath]

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const PHOTO_DIR = process.argv[2]
  || '/Users/hoangkha/Library/CloudStorage/OneDrive-Esuhai/ALESU - HÌNH KHÁCH MỜI/KHÁCH VIỆT - TGĐ';
// Default to the authoritative 116-guest K-code SoT (E08-D018 anh Kha).
const XLSX_PATH = process.argv[3]
  || path.join(__dirname, '..', '..', 'data', 'inbox', '20260729_v1_TGD_IMPORT_DS_KHACH_GALA_20NAM.xlsx');
const OUT = path.join(__dirname, '..', '..', 'data', 'dryrun-tgd-photos.txt');

const HONORIFICS = ['vo chong', 'gia dinh', 'gd', 'ong ba', 'ba', 'ong', 'chu', 'co', 'anh', 'chi',
  'em', 'thay', 'bac', 'di', 'cau', 'mo', 'me', 'ba me', 'chau', 'ts', 'pgs', 'gs'];

function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd');
}
function norm(s) {
  let t = stripDiacritics(String(s || '')).toLowerCase();
  t = t.replace(/\.(jpg|jpeg|png|heic)$/i, '');
  t = t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}
function stripHonorifics(t) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of HONORIFICS) {
      if (t === h) { t = ''; changed = true; break; }
      if (t.startsWith(h + ' ')) { t = t.slice(h.length + 1); changed = true; break; }
    }
  }
  return t.trim();
}
function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

// ---- load guests from Excel SoT (auto-detect sheet + header row) ----
const wb = XLSX.readFile(XLSX_PATH);
const sh = wb.Sheets['DS Khách'] || wb.Sheets['Khách TGĐ - gia đình'] || wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
let HEADER_ROW = 0;
for (let i = 0; i < Math.min(10, rows.length); i++) {
  if (/mã khách|họ và tên|họ tên/.test(rows[i].map(clean).join('|').toLowerCase())) { HEADER_ROW = i; break; }
}
const hdr = (rows[HEADER_ROW] || []).map(clean);
const find = (...ks) => { for (const k of ks) { const i = hdr.findIndex((h) => h.toLowerCase().includes(k.toLowerCase())); if (i >= 0) return i; } return -1; };
const cK = find('Mã khách', 'mã'); const cSTT = find('STT'); const cName = find('Họ và tên', 'họ tên');
const guests = rows.slice(HEADER_ROW + 1)
  .filter((r) => clean(r[cName]) !== '')
  .map((r) => {
    const name = clean(r[cName]);
    const nkey = stripHonorifics(norm(name));
    const id = cK >= 0 && clean(r[cK]) ? clean(r[cK]) : ('STT' + clean(r[cSTT]));
    const ext_id = cK >= 0 && clean(r[cK]) ? ('tgd-kcode-' + clean(r[cK])) : ('ly-tgd-20260728-' + clean(r[cSTT]));
    return { stt: id, name, nkey, ext_id };
  });

// ---- load photo files ----
// punctuation-preserving lowered name (diacritics stripped) so &, +, " - "
// couple-markers survive — norm() strips them, so test shared on this instead.
function punctName(f) {
  return stripDiacritics(f).toLowerCase().replace(/\.(jpg|jpeg|png|heic)$/i, '').trim();
}
const files = fs.readdirSync(PHOTO_DIR)
  .filter((f) => /\.(jpg|jpeg|png|heic)$/i.test(f) && !f.startsWith('.'))
  .map((f) => ({ file: f, nkey: stripHonorifics(norm(f)), raw: norm(f), punct: punctName(f) }));

// ---- classify ----
// couple/family markers — word-bounded so "phuong bac" ≠ "ong ba", etc.
// Tested on punctName (punctuation intact) so &, +, " - " count too.
const SHARED_MARK = /\bva\b|&|\bvo chong\b|\bgia dinh\b|\bong ba\b|\+|\s-\s|\bva con\b|\bcon gai\b|\bphu nhan\b/;
function guestsMatching(photo) {
  // exact key match first
  const exact = guests.filter((g) => g.nkey && g.nkey === photo.nkey);
  if (exact.length) return { how: 'exact', list: exact };
  // containment: guest key fully contained in photo key (handles "X và Y", extra words)
  const contained = guests.filter((g) => g.nkey && g.nkey.length >= 4
    && (photo.nkey.includes(g.nkey) || photo.raw.includes(g.nkey)));
  if (contained.length) return { how: 'contains', list: contained };
  return { how: 'none', list: [] };
}

const cats = { match: [], shared: [], ambiguous: [], unmatched: [] };
const usedGuestExt = new Set();
for (const p of files) {
  const isShared = SHARED_MARK.test(' ' + p.punct + ' ');
  const m = guestsMatching(p);
  if (m.list.length === 1 && !isShared) {
    cats.match.push({ p, g: m.list[0], how: m.how });
    usedGuestExt.add(m.list[0].ext_id);
  } else if (m.list.length >= 2 || (isShared && m.list.length >= 1)) {
    cats.shared.push({ p, list: m.list, how: m.how, isShared });
    m.list.forEach((g) => usedGuestExt.add(g.ext_id));
  } else if (m.list.length === 1 && isShared) {
    cats.shared.push({ p, list: m.list, how: m.how, isShared });
    usedGuestExt.add(m.list[0].ext_id);
  } else {
    cats.unmatched.push({ p });
  }
}
const guestsNoPhoto = guests.filter((g) => !usedGuestExt.has(g.ext_id));

// ---- aggregate to stdout (NO names) ----
console.log('==== DRY-RUN TGĐ PHOTOS (no writes) ====');
console.log('photo dir      :', PHOTO_DIR);
console.log('guests (Excel) :', guests.length);
console.log('photo files    :', files.length);
console.log('--------------------------------------');
console.log('CONFIDENT match (1 guest, not shared):', cats.match.length);
console.log('SHARED/couple (≥1 guest, needs Ly)   :', cats.shared.length);
console.log('UNMATCHED (photo → no guest)         :', cats.unmatched.length);
console.log('guests WITH a photo                  :', usedGuestExt.size, '/', guests.length);
console.log('guests WITHOUT any photo             :', guestsNoPhoto.length);
console.log('--------------------------------------');
console.log('full PII detail written to           :', path.relative(path.join(__dirname, '..', '..'), OUT), '(gitignored)');

// ---- full detail to gitignored file ----
const L = [];
L.push('DRY-RUN TGĐ PHOTOS — ' + PHOTO_DIR);
L.push('(KHÔNG ghi DB/MinIO. Bảng để anh/Ly duyệt. PII — file này gitignored.)');
L.push('');
L.push('### 1) MATCH CHẮC (' + cats.match.length + ') — sẽ upload nếu anh duyệt');
L.push('STT | guest_ext_id | Tên khách (CRM) | File ảnh | cách khớp');
cats.match.forEach((x) => L.push([x.g.stt, x.g.ext_id, x.g.name, x.p.file, x.how].join(' | ')));
L.push('');
L.push('### 2) SHARED / COUPLE / AMBIGUOUS (' + cats.shared.length + ') — CẦN Ly xác nhận, KHÔNG auto');
L.push('File ảnh | Số khách khớp | Các khách (STT·tên) | shared-marker');
cats.shared.forEach((x) => L.push([x.p.file, x.list.length,
  x.list.map((g) => g.stt + '·' + g.name).join(' ; ') || '(0 — chỉ marker)', x.isShared].join(' | ')));
L.push('');
L.push('### 3) UNMATCHED (' + cats.unmatched.length + ') — ảnh không khớp khách nào');
cats.unmatched.forEach((x) => L.push(x.p.file));
L.push('');
L.push('### 4) KHÁCH CHƯA CÓ ẢNH (' + guestsNoPhoto.length + '/' + guests.length + ')');
guestsNoPhoto.forEach((g) => L.push(g.stt + '·' + g.name));
fs.writeFileSync(OUT, L.join('\n') + '\n');
