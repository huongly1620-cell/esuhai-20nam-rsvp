'use strict';

// Loader for TGĐ guest photos (E08-D018 Part B). Matches photo files to the
// 116-guest SoT by NAME (mock's "Tên file ảnh" column is discarded), resolves
// each to the production guest via its kcode tag, and uploads CONFIDENT + SHARED
// matches (couples attached to each member). Idempotent: deterministic object
// key crm/tgd/{Kxxx}/{sha1(filename)}.ext + existence check → rerun makes no
// duplicate object or row. Excludes the K103 false-positive and Kha-May.
//
//   DATABASE_URL=... MINIO_*=... node server/crm/load-tgd-photos.js [dir] [xlsx] [--commit]
//   default = DRY (resolves guest_ids + keys, no MinIO/DB writes)

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { pool } = require('../db');
const storage = require('./storage');
const { logAudit } = require('./audit');

const DIR = process.argv.find((a, i) => i >= 2 && !a.startsWith('--') && !/\.xlsx$/i.test(a))
  || '/Users/hoangkha/Library/CloudStorage/OneDrive-Esuhai/ALESU - HÌNH KHÁCH MỜI/KHÁCH VIỆT - TGĐ';
const XLSX_PATH = process.argv.find((a) => /\.xlsx$/i.test(a))
  || path.join(__dirname, '..', '..', 'data', 'inbox', '20260729_v1_TGD_IMPORT_DS_KHACH_GALA_20NAM.xlsx');
const COMMIT = process.argv.includes('--commit');
const EXCLUDE_KCODES = new Set(['K103']); // false containment on "Minh" (anh Kha)

const HONORIFICS = ['vo chong', 'gia dinh', 'gd', 'ong ba', 'ba', 'ong', 'chu', 'co', 'anh', 'chi',
  'em', 'thay', 'bac', 'di', 'cau', 'mo', 'me', 'chau', 'ban', 'ts', 'pgs', 'gs'];
function stripD(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd'); }
function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function norm(s) { return stripD(s).toLowerCase().replace(/\.(jpg|jpeg|png|heic)$/i, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function stripH(t) { let c = true; while (c) { c = false; for (const h of HONORIFICS) { if (t === h) { t = ''; c = true; break; } if (t.startsWith(h + ' ')) { t = t.slice(h.length + 1); c = true; break; } } } return t.trim(); }
function punct(f) { return stripD(f).toLowerCase().replace(/\.(jpg|jpeg|png|heic)$/i, '').trim(); }
const SHARED_MARK = /\bva\b|&|\bvo chong\b|\bgia dinh\b|\bong ba\b|\+|\s-\s|\bva con\b|\bcon gai\b|\bphu nhan\b/;
function ctype(f) { return /\.png$/i.test(f) ? 'image/png' : 'image/jpeg'; }

function readGuests() {
  const wb = XLSX.readFile(XLSX_PATH);
  const sh = wb.Sheets['DS Khách'] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  let hr = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) if (/mã khách|họ và tên/.test(rows[i].map(clean).join('|').toLowerCase())) { hr = i; break; }
  const hdr = (rows[hr] || []).map(clean);
  const find = (...ks) => { for (const k of ks) { const i = hdr.findIndex((h) => h.toLowerCase().includes(k.toLowerCase())); if (i >= 0) return i; } return -1; };
  const cK = find('Mã khách', 'mã'); const cN = find('Họ và tên', 'họ tên');
  return rows.slice(hr + 1).filter((r) => clean(r[cN]) !== '').map((r) => ({
    kcode: clean(r[cK]), name: clean(r[cN]), nkey: stripH(norm(clean(r[cN]))),
  }));
}

function classify(guests, files) {
  const byNkey = new Map();
  guests.forEach((g) => { if (!g.nkey) return; if (!byNkey.has(g.nkey)) byNkey.set(g.nkey, []); byNkey.get(g.nkey).push(g); });
  const match = (p) => {
    const exact = guests.filter((g) => g.nkey && g.nkey === p.nkey);
    if (exact.length) return exact;
    return guests.filter((g) => g.nkey && g.nkey.length >= 4 && (p.nkey.includes(g.nkey) || p.raw.includes(g.nkey)));
  };
  const assigns = []; // {file, kcodes:[]}
  for (const f of files) {
    const p = { file: f, nkey: stripH(norm(f)), raw: norm(f), punct: punct(f) };
    const isShared = SHARED_MARK.test(' ' + p.punct + ' ');
    const hits = match(p).filter((g) => !EXCLUDE_KCODES.has(g.kcode));
    if (!hits.length) continue; // unmatched (e.g. Kha - May) → skip
    if (hits.length === 1 && !isShared) assigns.push({ file: f, kcodes: [hits[0].kcode], kind: 'confident' });
    else assigns.push({ file: f, kcodes: hits.map((g) => g.kcode), kind: 'shared' });
  }
  return assigns;
}

async function main() {
  const guests = readGuests();
  const files = fs.readdirSync(DIR).filter((f) => /\.(jpg|jpeg|png)$/i.test(f) && !f.startsWith('.'));
  const assigns = classify(guests, files);
  const pairs = [];
  for (const a of assigns) for (const k of a.kcodes) pairs.push({ file: a.file, kcode: k, kind: a.kind });
  console.log(`[load-tgd-photos] files=${files.length} assignments=${assigns.length} (guest-photo pairs=${pairs.length}) · mode: ${COMMIT ? 'COMMIT' : 'DRY'}`);
  if (COMMIT && !storage.isConfigured()) { console.error('  MinIO not configured — abort commit.'); await pool.end(); process.exit(1); }
  if (COMMIT) await storage.ensureBucket();

  let uploaded = 0; let skipped = 0; let noGuest = 0;
  for (const p of pairs) {
    const g = await pool.query("SELECT id FROM crm_guests WHERE tags LIKE $1 AND deleted_at IS NULL", ['%kcode:' + p.kcode + '%']);
    if (!g.rows[0]) { noGuest++; console.log(`  ! no guest for ${p.kcode} (${p.file}) — run importer first`); continue; }
    const gid = g.rows[0].id;
    const ext = /\.png$/i.test(p.file) ? '.png' : '.jpg';
    const key = `crm/tgd/${p.kcode}/${crypto.createHash('sha1').update(p.file).digest('hex').slice(0, 16)}${ext}`;
    const ex = await pool.query('SELECT 1 FROM crm_photos WHERE guest_id=$1 AND object_key=$2', [gid, key]);
    if (ex.rows[0]) { skipped++; continue; }
    if (!COMMIT) { uploaded++; continue; } // DRY counts what WOULD upload
    const buf = fs.readFileSync(path.join(DIR, p.file));
    await storage.putObjectAt(key, buf, ctype(p.file));
    await pool.query(
      `INSERT INTO crm_photos (guest_id, object_key, content_type, size, uploaded_by) VALUES ($1,$2,$3,$4,$5)`,
      [gid, key, ctype(p.file), buf.length, 'import:tgd-photos']);
    uploaded++;
  }
  if (COMMIT) await logAudit(pool, { actor_email: 'import:tgd-photos', event_type: 'import_tgd_photos', target_type: 'import', meta: { uploaded, skipped, noGuest } });
  console.log(`[load-tgd-photos] ${COMMIT ? 'COMMITTED' : 'DRY'}: ${COMMIT ? 'uploaded' : 'would upload'}=${uploaded} already=${skipped} no-guest=${noGuest}`);
  await pool.end();
}

main().catch((e) => { console.error('[load-tgd-photos] failed:', e.message); process.exit(1); });
