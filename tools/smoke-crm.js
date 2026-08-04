#!/usr/bin/env node
'use strict';

/**
 * npm run smoke:crm — E08-D025
 *
 * Gói chuỗi smoke Bearer đã chứng minh tay ở D024 thành một lệnh chạy được
 * trước/sau mọi deploy CRM. In một dòng cuối PASS|FAIL, exit 0|1.
 *
 *   CRM_SMOKE_BEARER=… npm run smoke:crm
 *
 * Env:
 *   CRM_SMOKE_BEARER  (bắt buộc) token smoke — CHỈ từ env, không bao giờ in ra
 *   CRM_BASE_URL      (tuỳ chọn) mặc định prod Railway
 *   DATABASE_URL      (tuỳ chọn) bật đối chiếu SQL độc lập cho AC-4
 *   SMOKE_EXPECT_INVITED (tuỳ chọn) ghim đúng số khách mời, lệch là FAIL
 *   SMOKE_SKIP_UI=1   (tuỳ chọn) bỏ phần Playwright — dòng cuối sẽ NÓI RÕ là đã bỏ
 *
 * Nguyên tắc: thà FAIL còn hơn PASS nhầm. Không phép kiểm nào được "bỏ qua
 * im lặng"; không in token; không in tên/SĐT khách (chỉ đếm).
 */

const { execFileSync } = require('child_process');
const path = require('path');

const BASE = (process.env.CRM_BASE_URL || 'https://esuhai-web-production.up.railway.app').replace(/\/+$/, '');
const TOK = process.env.CRM_SMOKE_BEARER || '';
const SKIP_UI = process.env.SMOKE_SKIP_UI === '1';
const TIMEOUT_MS = 25000;
// Sàn số khách mời. Danh sách chỉ tăng tới 08/08 (04/08: prod 173, D018 merge
// 144→154, sau đó Ly bổ sung). Đây là mỏ neo NGOÀI API khi chạy không có
// DATABASE_URL — thiếu nó thì mất sạch dữ liệu vẫn ra PASS. Ghi đè bằng
// SMOKE_EXPECT_INVITED. Cập nhật khi có đợt import mới; đừng hạ để cho qua.
const INVITED_FLOOR = Number(process.env.SMOKE_INVITED_FLOOR || 170);
// Trần nhóm "thật sự chưa rõ buổi". Sàn invited chỉ neo TỔNG — hồi quy D016
// kiểu 30 người rơi từ `tagged` sang `unknown` giữ nguyên tổng nên lọt lưới.
// Prod 04/08: 18. Wave C sẽ kéo xuống chứ không đẩy lên.
const UNKNOWN_CEILING = Number(process.env.SMOKE_UNKNOWN_CEILING || 30);

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
}

async function req(pathname, { method = 'GET', bearer = false, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const h = Object.assign({}, headers);
    if (bearer) h.Authorization = 'Bearer ' + TOK;
    const r = await fetch(BASE + pathname, { method, headers: h, signal: ctl.signal });
    let body = null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) body = await r.json().catch(() => null);
    else body = await r.text().catch(() => '');
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: null, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---- AC-1: đóng đúng khi phải đóng -----------------------------------------
// Auth gắn PER-ROUTE, không có guard bao trùm (`app.use('/crm'…)` không tồn tại).
// Bỏ `requireCrmAuth` ở một route là sửa đúng một dòng và các route khác không
// hề biết — nên phải thử từng route, không chỉ /crm/me. Route rò tên + SĐT của
// toàn bộ khách là /crm/guests, và nó nằm ở file khác với /crm/me.
const PROTECTED = ['/crm/me', '/crm/guests?limit=1', '/crm/guests/1', '/crm/stats', '/crm/photos/1', '/crm/audit'];

async function ac1() {
  const cases = [
    ['không header', {}],
    ['Bearer sai', { bearer: false, headers: { Authorization: 'Bearer ' + 'z'.repeat(TOK.length || 43) } }],
    ['scheme Basic', { bearer: false, headers: { Authorization: 'Basic ' + TOK } }],
  ];
  for (const p of PROTECTED) {
    for (const [label, opt] of cases) {
      const r = await req(p, opt);
      record(`AC-1 ${p} · ${label} → 401`, r.status === 401, `nhận ${r.status || r.error}`);
    }
  }
  // Hai lane shell: /crm (theo CRM_UI) và /crm/classic (đường lùi, LUÔN trả
  // shell cũ). Khẳng định body ĐÚNG LÀ trang login, thay vì chỉ phủ định một id
  // riêng của shell v2 — phủ định kiểu đó thành no-op ngay khi lật CRM_UI=classic.
  for (const p of ['/crm', '/crm/classic']) {
    const shell = await req(p);
    const html = typeof shell.body === 'string' ? shell.body : '';
    const isLogin = html.includes('id="email"');          // chỉ có ở crm-login.html
    const leaksShell = html.includes('id="list"');        // có ở CẢ HAI shell app
    record(`AC-1 ${p} không auth = trang login`,
      shell.status === 200 && isLogin && !leaksShell,
      leaksShell ? 'LỘ shell app!' : (isLogin ? 'đúng trang login' : `không nhận ra trang login (status ${shell.status})`));
  }
}

// ---- AC-2: mở đúng khi phải mở ---------------------------------------------
async function ac2() {
  const me = await req('/crm/me', { bearer: true });
  const okMe = me.status === 200 && me.body && me.body.role === 'staff'
    && String(me.body.email || '').startsWith('crm-smoke-agent@');
  record('AC-2 /crm/me 200 + role=staff', okMe,
    me.status === 200 && me.body ? `role=${me.body.role}` : `status ${me.status || me.error}`);

  const g = await req('/crm/guests?limit=1000', { bearer: true });
  const rows = g.body && Array.isArray(g.body.rows) ? g.body.rows : null;
  record('AC-2 /crm/guests 200', g.status === 200 && rows !== null,
    rows ? `${rows.length} thẻ` : `status ${g.status || g.error}`);

  const s = await req('/crm/stats', { bearer: true });
  record('AC-2 /crm/stats 200', s.status === 200 && s.body && s.body.ok === true,
    s.status === 200 ? '' : `status ${s.status || s.error}`);

  // `rows` chỉ được in ra chứ chưa từng được assert: 200 + mảng RỖNG vẫn lọt,
  // và khi bỏ UI thì không còn gì bắt "0 khách trên màn lễ tân".
  const stats = s.status === 200 ? s.body : null;
  if (stats && rows) {
    record('AC-2 số thẻ khớp invited', rows.length === stats.invited, `${rows.length} vs ${stats.invited}`);
  }
  // /crm/stats bị đóng băng / cache cũ thì mọi con số vẫn "đúng với nhau".
  if (stats && stats.asOf) {
    // Cho phép lệch đồng hồ hai chiều: server thường nhanh/chậm hơn máy chạy
    // smoke vài trăm ms, không phải dấu hiệu hỏng. Chỉ bắt ca asOf CŨ HẲN
    // (stats bị đóng băng / cache) hoặc ngày giờ vô lý.
    const age = Date.now() - Date.parse(stats.asOf);
    record('AC-2 stats tươi (<2 phút)', Number.isFinite(age) && age > -60000 && age < 120000,
      Number.isFinite(age) ? `${Math.round(age / 1000)}s` : 'asOf không đọc được');
  } else if (stats) {
    record('AC-2 stats có asOf', false, 'thiếu field asOf');
  }

  return {
    stats: s.status === 200 ? s.body : null,
    guests: rows,
    photos: rows ? rows.filter((x) => x && x.photo_url).length : 0,
  };
}

// ---- AC-3: RBAC còn nguyên (staff phải bị chặn) ----------------------------
// Chỉ dùng đường ĐỌC hoặc đường bị deny trước khi chạm dữ liệu — không tạo,
// không xoá khách thật. DELETE dùng id chắc chắn không tồn tại; nếu RBAC hỏng
// thì nó trả 404 chứ không xoá ai (403 phải đến TRƯỚC khi tìm bản ghi).
async function ac3() {
  const lanes = [
    ['GET /crm/audit', '/crm/audit', 'GET'],
    ['GET /crm/audit/export.csv', '/crm/audit/export.csv', 'GET'],
    ['POST /crm/import', '/crm/import', 'POST'],
    ['POST /crm/guests', '/crm/guests', 'POST'],
    ['DELETE /crm/guests/:id (id không tồn tại)', '/crm/guests/999999999', 'DELETE'],
  ];
  for (const [label, p, method] of lanes) {
    const r = await req(p, { method, bearer: true });
    record(`AC-3 ${label} → 403`, r.status === 403, `nhận ${r.status || r.error}`);
  }
}

// ---- AC-4: phân hoạch buổi ---------------------------------------------------
async function ac4(stats) {
  if (!stats) { record('AC-4 phân hoạch buổi', false, 'không có /crm/stats để kiểm'); return; }
  const sl = stats.sessionList || {};
  const fk = stats.sessionFormKnown || {};
  const sum = (sl.tagged || 0) + (fk.total || 0) + (stats.sessionUnknown || 0);

  record('AC-4 tagged+form+unknown = invited',
    sum === stats.invited && typeof stats.invited === 'number',
    `${sl.tagged} + ${fk.total} + ${stats.sessionUnknown} = ${sum} vs invited ${stats.invited}`);

  record('AC-4 hai nguồn rời nhau (disjoint)',
    stats.integrity && stats.integrity.disjoint === true,
    stats.integrity ? `overlap ${stats.integrity.overlapTagAndForm}` : 'thiếu khối integrity');

  record('AC-4 chi tiết nhóm form cộng đủ',
    (fk.gala || 0) + (fk.toaDamGala || 0) + (fk.toaDamOnly || 0) + (fk.unspecified || 0) === (fk.total || 0),
    `${fk.gala}+${fk.toaDamGala}+${fk.toaDamOnly}+${fk.unspecified} vs ${fk.total}`);

  record('AC-4 invited > 0', stats.invited > 0, `invited ${stats.invited}`);

  // MỎ NEO NGOÀI. Bốn phép trên đều là bất biến NỘI TẠI: mọi con số cùng đọc
  // một snapshot REPEATABLE READ của crm_guests, nên khi row biến mất chúng
  // tụt đồng bộ và vẫn "khớp nhau". Mất 172/173 khách vẫn ra 1+0+0=1 ✓.
  // Phải có ít nhất một nguồn đối chứng độc lập với chính API đang kiểm.
  const want = process.env.SMOKE_EXPECT_INVITED ? parseInt(process.env.SMOKE_EXPECT_INVITED, 10) : null;
  if (want !== null) {
    record('AC-4 invited khớp SMOKE_EXPECT_INVITED', stats.invited === want, `${stats.invited} vs ${want}`);
  } else {
    // Sàn ghim trong script: danh sách chỉ được phép TĂNG tới 08/08.
    // Cập nhật khi có đợt import mới (đừng hạ để cho qua).
    record(`AC-4 invited ≥ sàn ${INVITED_FLOOR}`, stats.invited >= INVITED_FLOOR,
      `${stats.invited} (sàn ghi trong script, mốc 04/08: prod 173)`);
  }
  // Neo hình dạng phân hoạch, không chỉ tổng.
  record(`AC-4 chưa-rõ-buổi ≤ trần ${UNKNOWN_CEILING}`, (stats.sessionUnknown || 0) <= UNKNOWN_CEILING,
    `${stats.sessionUnknown} (mốc 04/08: prod 18)`);

  // Đối chiếu SQL độc lập — chỉ chạy khi có DATABASE_URL.
  if (!process.env.DATABASE_URL) {
    // Không có DATABASE_URL *và* không ghim SMOKE_EXPECT_INVITED = không có
    // nguồn đối chứng nào ngoài chính API. Nói rõ là chưa đối chiếu; sàn ở trên
    // là mỏ neo duy nhất còn lại.
    console.log(`  ..    AC-4 đối chiếu SQL: BỎ QUA (không có DATABASE_URL) — mỏ neo duy nhất là ${want !== null ? 'SMOKE_EXPECT_INVITED' : 'sàn ' + INVITED_FLOOR}`);
    return;
  }
  try {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const tag = (t) => `(',' || COALESCE(g.tags,'') || ',') ILIKE '%,${t},%'`;
    const q = await c.query(`
      WITH g AS (SELECT g.id, g.response_id, ${tag('toa-dam')} td, ${tag('gala')} ga
                 FROM crm_guests g WHERE g.deleted_at IS NULL)
      SELECT count(*)::int invited,
             count(*) FILTER (WHERE td OR ga)::int tagged,
             count(*) FILTER (WHERE NOT td AND NOT ga AND response_id IS NOT NULL)::int form_known,
             count(*) FILTER (WHERE NOT td AND NOT ga AND response_id IS NULL)::int unknown_
      FROM g`);
    await c.end();
    const d = q.rows[0];
    const ok = d.invited === stats.invited && d.tagged === sl.tagged
      && d.form_known === fk.total && d.unknown_ === stats.sessionUnknown;
    record('AC-4 /crm/stats khớp SQL độc lập ±0', ok,
      `SQL ${d.invited}/${d.tagged}/${d.form_known}/${d.unknown_} vs API ${stats.invited}/${sl.tagged}/${fk.total}/${stats.sessionUnknown}`);
  } catch (e) {
    record('AC-4 đối chiếu SQL', false, 'lỗi truy vấn: ' + e.message);
  }
}

// ---- AC-5: UI thật -----------------------------------------------------------
function ac5(stats, apiPhotos) {
  if (SKIP_UI) {
    console.log('  ..    AC-5 UI: BỎ QUA theo SMOKE_SKIP_UI=1');
    return { skipped: true };
  }
  let ui;
  try {
    const raw = execFileSync('python3', [path.join(__dirname, 'smoke-crm-ui.py')], {
      env: Object.assign({}, process.env, { CRM_BASE_URL: BASE }),
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    ui = JSON.parse(raw.trim().split('\n').pop());
  } catch (e) {
    const out = (e.stdout || '').trim();
    try { ui = JSON.parse(out.split('\n').pop()); } catch (_) { ui = { ok: false, error: (e.message || '').slice(0, 200) }; }
  }
  if (!ui || !ui.ok) {
    record('AC-5 mở /crm bằng Playwright', false, (ui && ui.error) || 'không chạy được');
    return { skipped: false };
  }
  record('AC-5 #kpiCard có và hiện', ui.kpiCard >= 1 && ui.kpiVisible === true, `count=${ui.kpiCard} visible=${ui.kpiVisible}`);
  const wantCards = stats && stats.invited > 0;
  record('AC-5 danh sách khách có thẻ', wantCards ? ui.guestCards > 0 : true, `${ui.guestCards} thẻ (invited ${stats && stats.invited})`);
  record('AC-5 số thẻ UI khớp invited', !wantCards || ui.guestCards === stats.invited, `UI ${ui.guestCards} vs API ${stats && stats.invited}`);
  record('AC-5 ảnh UI khớp API', ui.photos === apiPhotos, `UI ${ui.photos} vs API ${apiPhotos}`);
  record('AC-5 không lỗi JS', Array.isArray(ui.jsErrors) && ui.jsErrors.length === 0, (ui.jsErrors || []).join(' | ') || 'sạch');
  // KPI trên màn phải nói cùng con số với API. So SỐ đọc từ đúng ô "Tổng khách
  // mời", không phải includes() trên cả blob — "173" khớp nhầm cả 1730, 2173.
  if (stats) {
    record('AC-5 số trên khối KPI khớp invited', ui.kpiInvited === stats.invited,
      `UI ${ui.kpiInvited === null ? 'không đọc được' : ui.kpiInvited} vs API ${stats.invited}`);
  }
  return { skipped: false };
}

// ---- chạy --------------------------------------------------------------------
(async () => {
  console.log(`smoke:crm → ${BASE}`);
  if (!TOK) {
    console.log(' FAIL  thiếu CRM_SMOKE_BEARER (chỉ nhận qua env)');
    console.log('\nFAIL — chưa có token, không chạy được phép kiểm nào.');
    process.exit(1);
  }

  await ac1();
  const { stats, photos } = await ac2();
  await ac3();
  await ac4(stats);
  const ui = ac5(stats, photos);

  const total = results.length;
  const passed = total - failed;
  const skipNote = ui && ui.skipped ? ' · UI ĐÃ BỎ QUA (SMOKE_SKIP_UI=1)' : '';
  // Không có DATABASE_URL và không ghim SMOKE_EXPECT_INVITED = mọi con số chỉ
  // được đối chiếu với chính API đang kiểm, ngoài sàn/trần ghim sẵn. "PASS"
  // trần dễ bị đọc thành "dữ liệu đã được xác minh" — nói thẳng là chưa.
  const noAnchor = !process.env.DATABASE_URL && !process.env.SMOKE_EXPECT_INVITED;
  const anchorNote = noAnchor ? ' · MỨC GIẢM: chưa đối chiếu nguồn độc lập (đặt DATABASE_URL để kiểm đầy đủ)' : '';
  const line = failed === 0
    ? `PASS — ${passed}/${total} phép kiểm · ${BASE}${skipNote}${anchorNote}`
    : `FAIL — ${failed}/${total} phép kiểm hỏng · ${BASE}${skipNote}${anchorNote}`;
  console.log('\n' + line);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nFAIL — smoke ném lỗi: ${e && e.message}`);
  process.exit(1);
});
