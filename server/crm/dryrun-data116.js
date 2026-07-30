'use strict';

// DRY-RUN ONLY (E08-D018 Part A) — reconcile the new 116-guest K-code SoT
// against the 114 STT-keyed guests already in production (proxied by the old
// Excel, whose names == what was imported). Writes NOTHING. Reports the
// double-load risk: how many of the 116 already exist (by normalized name),
// how many are brand new, and how the merge should be keyed.
//
//   node server/crm/dryrun-data116.js [newXlsx] [oldXlsx]

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const NEW = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'inbox', '20260729_v1_TGD_IMPORT_DS_KHACH_GALA_20NAM.xlsx');
const OLD = process.argv[3] || path.join(__dirname, '..', '..', 'data', 'inbox', '2026-07-28-DS-khach-TGD-Gia-dinh.xlsx');
const OUT = path.join(__dirname, '..', '..', 'data', 'dryrun-data116.txt');

const HONORIFICS = ['vo chong', 'gia dinh', 'gd', 'ong ba', 'ba', 'ong', 'chu', 'co', 'anh', 'chi',
  'em', 'thay', 'bac', 'di', 'cau', 'mo', 'me', 'chau', 'ban', 'ts', 'pgs', 'gs'];
function stripD(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd'); }
function norm(s) { return stripD(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function stripH(t) { let c = true; while (c) { c = false; for (const h of HONORIFICS) { if (t === h) { t = ''; c = true; break; } if (t.startsWith(h + ' ')) { t = t.slice(h.length + 1); c = true; break; } } } return t.trim(); }
function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

function loadSheet(file, sheetName) {
  const wb = XLSX.readFile(file);
  const sh = wb.Sheets[sheetName] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  return rows;
}
function headerIdx(rows) {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const line = rows[i].map(clean).join('|').toLowerCase();
    if (/mã khách|họ và tên|họ tên/.test(line)) return i;
  }
  return 0;
}

// ---- NEW 116 (K-code) ----
const nr = loadSheet(NEW, 'DS Khách');
const nh = headerIdx(nr); const nhdr = (nr[nh] || []).map(clean);
const nfind = (...ks) => { for (const k of ks) { const i = nhdr.findIndex((h) => h.toLowerCase().includes(k.toLowerCase())); if (i >= 0) return i; } return -1; };
const NK = nfind('Mã khách', 'mã'); const NN = nfind('Họ và tên', 'họ tên');
const news = nr.slice(nh + 1).filter((r) => clean(r[NN]) !== '').map((r) => {
  const name = clean(r[NN]);
  return { kcode: clean(r[NK]), name, nkey: stripH(norm(name)), ext_id: 'tgd-kcode-' + clean(r[NK]) };
});

// ---- OLD 114 (STT) ----
const or = loadSheet(OLD, 'Khách TGĐ - gia đình');
const oh = 2; const ohdr = (or[oh] || []).map(clean);
const ofind = (...ks) => { for (const k of ks) { const i = ohdr.findIndex((h) => h.toLowerCase().includes(k.toLowerCase())); if (i >= 0) return i; } return -1; };
const OS = ofind('STT'); const ON = ofind('Họ và tên');
const olds = or.slice(oh + 1).filter((r) => clean(r[ON]) !== '').map((r) => {
  const name = clean(r[ON]);
  return { stt: clean(r[OS]), name, nkey: stripH(norm(name)), ext_id: 'ly-tgd-20260728-' + clean(r[OS]) };
});

// ---- overlap by normalized name ----
const oldByKey = new Map();
olds.forEach((o) => { if (!oldByKey.has(o.nkey)) oldByKey.set(o.nkey, []); oldByKey.get(o.nkey).push(o); });

const overlap = []; const fresh = []; const ambiguous = [];
for (const n of news) {
  const hits = n.nkey ? (oldByKey.get(n.nkey) || []) : [];
  if (hits.length === 1) overlap.push({ n, o: hits[0] });
  else if (hits.length >= 2) ambiguous.push({ n, hits });
  else fresh.push(n);
}
// old guests NOT matched by any new K (would be orphaned if we switched keys)
const matchedOldKeys = new Set(overlap.map((x) => x.o.nkey).concat(ambiguous.flatMap((x) => x.hits.map((h) => h.nkey))));
const oldUnmatched = olds.filter((o) => !matchedOldKeys.has(o.nkey));

console.log('==== DRY-RUN DATA 116 vs 114 (no writes) ====');
console.log('NEW SoT (K-code) guests :', news.length);
console.log('OLD production (STT)    :', olds.length);
console.log('---------------------------------------------');
console.log('OVERLAP (116-K khớp tên 1 khách STT cũ) :', overlap.length, '  ← nếu INSERT theo K sẽ NHÂN ĐÔI');
console.log('AMBIGUOUS (khớp ≥2 khách cũ, trùng tên) :', ambiguous.length);
console.log('FRESH (mới hoàn toàn, chưa có trong prod):', fresh.length);
console.log('OLD-STT không khớp K nào (mồ côi nếu đổi key):', oldUnmatched.length);
console.log('---------------------------------------------');
console.log('full PII detail →', path.relative(path.join(__dirname, '..', '..'), OUT), '(gitignored)');

const L = [];
L.push('DRY-RUN DATA 116 (K-code) vs 114 (STT) — KHÔNG ghi DB.');
L.push('Đối chiếu theo TÊN chuẩn hóa (bỏ kính ngữ, bỏ dấu, hạ chữ).');
L.push('');
L.push('### FRESH — mới hoàn toàn (' + fresh.length + ') → INSERT tgd-kcode-{K}');
fresh.forEach((n) => L.push(n.kcode + ' · ' + n.name));
L.push('');
L.push('### OVERLAP — đã có (trùng tên khách STT cũ) (' + overlap.length + ') → UPDATE bản cũ, KHÔNG insert');
L.push('Kcode · Tên (SoT) | khớp STT cũ · ext_id cũ');
overlap.forEach((x) => L.push(x.n.kcode + ' · ' + x.n.name + '  |  STT ' + x.o.stt + ' · ' + x.o.ext_id));
L.push('');
L.push('### AMBIGUOUS — trùng tên ≥2 khách cũ (' + ambiguous.length + ') → CẦN người quyết');
ambiguous.forEach((x) => L.push(x.n.kcode + ' · ' + x.n.name + '  |  ' + x.hits.map((h) => 'STT ' + h.stt).join(', ')));
L.push('');
L.push('### OLD-STT không có trong 116 (' + oldUnmatched.length + ') → xem có nên giữ/xoá');
oldUnmatched.forEach((o) => L.push('STT ' + o.stt + ' · ' + o.name));
fs.writeFileSync(OUT, L.join('\n') + '\n');
