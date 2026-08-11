'use strict';
/* E08-D120 · MỘT NGƯỜI MỘT LINK — album riêng của khách + dòng việc đã xảy ra.
   Trục [X]: link gắn vào `crm_guests.id`, ảnh lấy từ đúng album MinIO của người
   ấy. KHÔNG đẻ sổ khách thứ hai, KHÔNG bảng timeline (I5 — dòng việc là CHIẾU
   từ những bảng đã có: check-in, album, ghi nhận).

   Hai diện người dùng, hai gác cổng khác hẳn nhau — đó là lý do cả hai nằm
   chung một tệp, để người sửa sau nhìn thấy ranh giới bằng mắt:
     · `/crm/guests/:id/album-link*`  — `btl` + OTP. Tạo / xem sổ / thu hồi.
     · `/album/:token`                — KHÔNG đăng nhập. Token LÀ chìa, nên mọi
       thứ ở nhánh này phải tự chứng minh: token còn sống, tấm ảnh đúng của
       khách ấy, và không một chữ nào của người khác lọt ra.

   CẤM `CRM_DOOR_OPEN` (§spec Security): nhánh btl dùng `requireCrmAuth`, KHÔNG
   dùng `requireDoorOrAuth`. Cửa mở là một cánh cửa không tên — nó không được
   tạo cũng không được đọc token của ai. */

const crypto = require('crypto');
const { pool } = require('../db');
const { hashIp } = require('./audit');
const { ipOf } = require('./auth');
const storage = require('./storage');

/* ── Token ────────────────────────────────────────────────────────────────────
   32 byte ngẫu nhiên = 256 bit (spec đòi ≥128). base64url ⇒ 43 ký tự, an toàn
   trên URL và trong tin nhắn Zalo/Signal mà không bị bẻ dòng.
   Máy chủ CHỈ giữ băm. Bản thô ra đời đúng một lần, trong đáp của lượt tạo:
   rò sổ Postgres không đưa cho ai một đường dẫn dùng được. Có pepper riêng để
   một bản sao lưu CSDL không tự nó là một bộ chìa. */
const TOKEN_BYTES = 32;
const PEPPER = process.env.ALBUM_LINK_SALT || process.env.CRM_SESSION_SECRET
  || process.env.SESSION_SECRET || 'esuhai20-album-link-pepper';
function taoToken() { return crypto.randomBytes(TOKEN_BYTES).toString('base64url'); }
function bam(tok) { return crypto.createHash('sha256').update(String(tok) + PEPPER).digest('hex'); }
/* Chỉ chữ của base64url. Chặn ở đây thì mọi thứ lạ (dấu chấm, gạch chéo, %00)
   chết trước khi chạm CSDL, và log không đầy rác của người dò. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

const NGAY_MAC_DINH = Math.max(1, Math.min(3650,
  parseInt(process.env.ALBUM_LINK_NGAY || '90', 10) || 90));

/* ── Hạn tần suất (spec §Security) ────────────────────────────────────────────
   Trong RAM, một web service — cùng khuôn với hạn OTP ở auth.js. Hai mức khác
   nhau vì chúng chặn hai thứ khác nhau:
     · MO_*   — người thật mở trang. Rộng tay: một khách bấm tới bấm lui.
     · SAI_*  — token KHÔNG khớp. Đây mới là dấu vết của máy dò. Siết chặt.
   Ảnh KHÔNG tính vào hai mức này: một trang 60 tấm là 60 lượt gọi ảnh, tính
   chung thì chính khách thật bị chặn giữa lúc xem album của mình. */
const MO_MAX = 60, MO_CUA_SO = 10 * 60 * 1000;
const SAI_MAX = 20, SAI_CUA_SO = 10 * 60 * 1000;
const ANH_MAX = 900, ANH_CUA_SO = 10 * 60 * 1000;
const nhip = new Map();
function quaNhip(key, max, cuaSo) {
  const now = Date.now();
  const arr = (nhip.get(key) || []).filter((t) => now - t < cuaSo);
  if (arr.length >= max) { nhip.set(key, arr); return true; }
  arr.push(now); nhip.set(key, arr);
  /* Bản đồ này sống suốt đời tiến trình — dọn khoá nguội để một đợt dò không
     biến nó thành chỗ rò bộ nhớ. */
  if (nhip.size > 5000) {
    for (const [k, v] of nhip) { if (!v.length || now - v[v.length - 1] > cuaSo) nhip.delete(k); }
  }
  return false;
}

/* ── Dòng việc pha 1 (I5 · CHIẾU, không bảng mới) ─────────────────────────────
   Danh sách TRẮNG chứ không danh sách đen. `crm_interactions.kind` là chữ tự do
   (cột TEXT, cửa ghi 'qua-tang', 'ghi-chu-quay'…), nên lọc kiểu «bỏ những loại
   nhạy cảm» sẽ hở ngay lần đầu có ai đó thêm một loại mới — và cái hở ấy là
   ghi chú nội bộ hiện trên màn của khách. Danh sách trắng thì loại mới mặc
   định KHÔNG lên trang khách; muốn lên phải có người sửa đúng dòng này.
   Chỉ lấy LOẠI + NGÀY. Không `body` (ghi chú nội bộ), không `actor_email`
   (tên nhân viên). GĐ8 `life`/`market` vì thế không thể lọt kể cả khi ra đời. */
const VIEC_TRANG = {
  'gọi': 'Trao đổi qua điện thoại',
  'goi': 'Trao đổi qua điện thoại',
  'gặp': 'Gặp trực tiếp',
  'gap': 'Gặp trực tiếp',
  'gửi ảnh': 'Công ty gửi ảnh',
  'gui anh': 'Công ty gửi ảnh',
};
const BUOI_TEN = { 'toa-dam': 'Tọa đàm chuyên đề', 'gala': 'Gala Lễ kỷ niệm 20 năm' };

/* Máy XEM TRƯỚC của ứng dụng nhắn tin. Zalo / Messenger / Telegram tự tải đường
   dẫn ngay khi nhân viên DÁN nó vào ô soạn tin — trước khi khách chạm vào bất
   cứ thứ gì. Đếm những lượt ấy là hồ sơ báo «khách đã mở» trong khi khách chưa
   nhận được tin: một con số sai về NGƯỜI, đúng thứ AC-6 hứa là đúng.
   Danh sách CỐ Ý chỉ gồm máy xem trước, KHÔNG gồm `curl`/`wget`/thư viện HTTP:
   người kiểm thử mở link bằng dòng lệnh vẫn phải được đếm, nếu không thì phép
   đo của họ đo nhầm cái bộ lọc này. Lượt bị bỏ đếm VẪN vào sổ audit (`bot:true`)
   — bỏ đếm khác hẳn với giấu đi. */
const MAY_XEM_TRUOC = /facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|skypeuripreview|zalo|embedly|googlebot|bingbot|applebot|pinterest|redditbot|vkshare|quora link preview/i;

function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ngay(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (_) { return String(iso).slice(0, 10); }
}

/* ── Trang khách ──────────────────────────────────────────────────────────────
   Dựng ở MÁY CHỦ, một tệp, không JS ngoài. Trang này ra khỏi vòng đăng nhập nên
   càng ít bề mặt càng tốt: không fetch, không bundle, không CDN. */
function trangHong(tieuDe, loi) {
  return '<!doctype html><html lang="vi"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>' + esc(tieuDe) + '</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'padding:24px;background:#0b1a30;color:#e9e6df;font-family:system-ui,Segoe UI,Arial,sans-serif;text-align:center}'
    + '.b{max-width:360px}h1{font-size:1.15rem;margin:12px 0 8px}p{color:#b9b096;line-height:1.6;margin:0}</style>'
    /* KHÔNG một chữ nào của hồ sơ ở đây (AC-4): không tên khách, không đơn vị,
       không cả việc «khách này có tồn tại hay không». */
    + '<div class="b"><div style="font-size:40px">🔒</div><h1>' + esc(tieuDe) + '</h1>'
    + '<p>' + esc(loi) + '</p></div></html>';
}

function trangKhach(o) {
  const anh = o.anh.map((x, i) => {
    const g = '/album/' + encodeURIComponent(o.token) + '/anh/' + encodeURIComponent(String(x.id));
    /* alt rỗng + aria-label đếm số: ảnh nhóm KHÔNG mang tên ai (spec §4). Tên
       tệp gốc cũng không ra trang — nó là chữ của kho, không phải của khách. */
    return '<div class="o"><a class="xem" href="' + g + '/xem" target="_blank" rel="noopener"'
      + ' aria-label="Ảnh ' + (i + 1) + ' trên ' + o.anh.length + '">'
      + '<img loading="lazy" decoding="async" alt="" src="' + g + '/thumb"></a>'
      /* Ảnh gốc là thứ khách thật sự muốn (để đăng lại), nhưng nó nặng 1–20 MB
         nên KHÔNG phải cú chạm mặc định: chạm vào tấm ra bản 1024, muốn gốc thì
         bấm thêm một nút nhỏ. */
      + '<a class="goc" href="' + g + '/goc" target="_blank" rel="noopener"'
      + ' aria-label="Tải ảnh gốc — ảnh ' + (i + 1) + '">⬇ gốc</a></div>';
  }).join('');

  const viec = o.viec.map((v) => '<li><span class="d">' + esc(ngay(v.luc)) + '</span>'
    + '<span class="t">' + esc(v.chu) + '</span></li>').join('');

  return '<!doctype html><html lang="vi"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<meta name="referrer" content="no-referrer">'
    + '<title>Album ảnh · ESUHAI 20 năm</title>'
    + '<style>'
    + ':root{--nen:#0b1a30;--the:#12263f;--chu:#e9e6df;--mo:#b9b096;--vang:#c8a664}'
    + '*{box-sizing:border-box}body{margin:0;background:var(--nen);color:var(--chu);'
    + 'font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.55}'
    + '.w{max-width:720px;margin:0 auto;padding:22px 16px 48px}'
    + 'header{text-align:center;padding:8px 0 18px;border-bottom:1px solid #1f3b5a}'
    + 'header img{height:38px;width:auto;opacity:.95}'
    + 'h1{font-size:1.22rem;margin:14px 0 4px;font-weight:700}'
    + '.sub{color:var(--mo);font-size:.9rem;margin:0}'
    + 'h2{font-size:1rem;margin:26px 0 10px;color:var(--vang);letter-spacing:.02em}'
    + '.luoi{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}'
    + '.o{position:relative;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:#0f2036}'
    + '.o .xem{display:block;width:100%;height:100%}'
    + '.o img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.o .goc{position:absolute;right:6px;bottom:6px;background:rgba(11,26,48,.74);color:#e9e6df;'
    + 'border-radius:8px;padding:3px 8px;font-size:.74rem;text-decoration:none;line-height:1.2}'
    + 'ul.viec{list-style:none;padding:0;margin:0}'
    + 'ul.viec li{display:flex;gap:12px;padding:10px 12px;background:var(--the);border-radius:10px;margin-bottom:8px}'
    + 'ul.viec .d{flex:0 0 92px;color:var(--mo);font-size:.84rem;font-variant-numeric:tabular-nums}'
    + 'ul.viec .t{flex:1;font-size:.94rem}'
    + '.hint{color:var(--mo);font-size:.86rem}'
    + 'footer{margin-top:34px;padding-top:16px;border-top:1px solid #1f3b5a;color:var(--mo);font-size:.8rem;text-align:center}'
    + '</style>'
    + '<div class="w"><header><img src="/logo-esuhai-mark.png" alt="ESUHAI">'
    + '<h1>Kính gửi ' + esc(o.ten) + '</h1>'
    + '<p class="sub">Album ảnh và những dịp chúng ta đã gặp nhau</p></header>'
    + '<h2>Album ảnh' + (o.anh.length ? ' · ' + o.anh.length + ' tấm' : '') + '</h2>'
    + (o.anh.length ? '<div class="luoi">' + anh + '</div>'
      : '<p class="hint">Album của anh/chị chưa có tấm nào. Khi ban tổ chức chọn xong ảnh, '
        + 'ảnh sẽ hiện ngay tại đây — anh/chị giữ đường dẫn này để xem lại.</p>')
    + '<h2>Dòng việc</h2>'
    + (o.viec.length ? '<ul class="viec">' + viec + '</ul>'
      : '<p class="hint">Chưa có mốc nào được ghi nhận.</p>')
    + '<footer>Đường dẫn riêng dành cho anh/chị, có hiệu lực đến ' + esc(ngay(o.hetHan)) + '.<br>'
    + 'Vui lòng không chuyển tiếp cho người khác.<br>ESUHAI Group · Kỷ niệm 20 năm</footer>'
    + '</div></html>';
}

/* Đọc token → hàng link CÒN SỐNG. Trả `null` (không thấy) hoặc `{het:true}`
   (có mà đã chết) để nơi gọi chọn đúng mã trạng thái. */
async function docLink(tok) {
  const r = await pool.query(
    `SELECT l.id, l.guest_id, l.het_han_luc, l.thu_hoi_luc, l.so_lan_mo, g.full_name, g.deleted_at
       FROM crm_album_links l
       JOIN crm_guests g ON g.id = l.guest_id
      WHERE l.token_hash = $1`, [bam(tok)]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.deleted_at) return { het: true };
  if (row.thu_hoi_luc) return { het: true };
  if (new Date(row.het_han_luc).getTime() <= Date.now()) return { het: true };
  return row;
}

function mount(app, requireCrmAuth, requireRole) {
  const btl = [requireCrmAuth, requireRole('btl')];

  /* ══ NHÁNH NHÂN VIÊN (btl) ═════════════════════════════════════════════════ */

  /* Sổ của một khách: link đang sống + những lần share trước (AC-6 · AC-8).
     KHÔNG trả token (chỉ có băm) và KHÔNG trả IP — «không hiện IP trên màn
     nhân viên» là luật §7 của spec, nên chỗ dễ vi phạm nhất là chính API này. */
  app.get('/crm/guests/:id/album-link', ...btl, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    try {
      const r = await pool.query(
        `SELECT id, created_by, created_at, het_han_luc, thu_hoi_luc, thu_hoi_boi,
                so_lan_mo, mo_lan_dau, mo_gan_nhat,
                (thu_hoi_luc IS NULL AND het_han_luc > now()) AS con_song
           FROM crm_album_links WHERE guest_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`, [id]);
      const song = r.rows.filter((x) => x.con_song)[0] || null;
      return res.json({ ok: true, link: song, lich_su: r.rows, ngay_mac_dinh: NGAY_MAC_DINH });
    } catch (err) {
      console.error('[album-link] sổ lỗi:', err.message);
      return res.status(500).json({ ok: false, error: 'lỗi' });
    }
  });

  /* Tạo link. TICK ĐỒNG Ý là điều kiện, không phải lời nhắc:
     thiếu tick ⇒ 400 và KHÔNG một dòng nào được ghi — không link, không audit,
     không sổ (AC-5). Vì thế phép kiểm nằm TRƯỚC mọi lượt chạm CSDL. */
  app.post('/crm/guests/:id/album-link', ...btl, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const dongY = (req.body && (req.body.dong_y === true || req.body.dong_y === 'true'));
    if (!dongY) {
      return res.status(400).json({ ok: false,
        error: 'Chưa tick ô «Khách đồng ý nhận đường dẫn này» — chưa tạo đường dẫn.' });
    }
    const tok = taoToken();
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const g = await cli.query('SELECT id, full_name FROM crm_guests WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!g.rows[0]) { await cli.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'Không thấy khách.' }); }

      /* MỘT NGƯỜI MỘT LINK ĐANG SỐNG (luật 1). Thu hồi cái cũ TRƯỚC trong CÙNG
         giao dịch: hoặc link cũ chết và link mới sống, hoặc không có gì đổi.
         Hàng cũ Ở LẠI bảng — đó là sổ, AC-8 đòi còn thấy lần share trước. */
      const cu = await cli.query(
        `UPDATE crm_album_links SET thu_hoi_luc = now(), thu_hoi_boi = $2
          WHERE guest_id = $1 AND thu_hoi_luc IS NULL RETURNING id`, [id, req.actor.email]);

      const ins = await cli.query(
        `INSERT INTO crm_album_links (guest_id, token_hash, created_by, dong_y, het_han_luc)
         VALUES ($1,$2,$3,true, now() + ($4 || ' days')::interval)
         RETURNING id, created_at, het_han_luc`, [id, bam(tok), req.actor.email, String(NGAY_MAC_DINH)]);
      const row = ins.rows[0];

      /* Audit ghi THẲNG trong giao dịch, KHÔNG qua logAudit: hàm ấy nuốt lỗi
         bằng console.error (bài học D036/D040). Ở đây sổ chia sẻ là bản ghi
         pháp lý của việc «ai đã gửi dữ liệu khách ra ngoài» — audit hỏng thì
         phải cuộn luôn cái link, đừng phát ra một đường dẫn không ai ghi nhận. */
      await cli.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'album_share','guest',$2,$3::jsonb,$4)`,
        [req.actor.email, String(id),
          JSON.stringify({ hanh_dong: 'tao', link_id: row.id, dong_y: true,
            het_han_luc: row.het_han_luc, thu_hoi_link_cu: cu.rowCount, ve: 'E08-D120' }),
          hashIp(ipOf(req))]);
      await cli.query('COMMIT');

      /* Bản THÔ của token đi ra đúng ở đây, một lần. Máy chủ không giữ lại nó,
         nên mở lại hồ sơ ngày mai sẽ KHÔNG copy lại được — phải tạo link mới,
         và tạo mới thì link cũ chết. Đó là luật 1, không phải thiếu sót. */
      return res.status(201).json({ ok: true, id: String(row.id),
        url: '/album/' + tok, created_at: row.created_at, created_by: req.actor.email,
        het_han_luc: row.het_han_luc, thu_hoi_link_cu: cu.rowCount });
    } catch (err) {
      await cli.query('ROLLBACK').catch(() => {});
      /* 23505 trên `uq_album_links_song` = hai lượt tạo cho CÙNG khách chạy song
         song (bấm hai lần, hoặc hai người cùng mở một hồ sơ). Ở READ COMMITTED,
         lượt sau không nhìn thấy hàng lượt trước vừa chèn nên nó không thu hồi
         được hàng ấy — CSDL chặn, đúng việc của CSDL. Trả 409 và bảo mở lại hồ
         sơ, thay vì một câu 500 khiến người ta bấm thêm lần nữa. */
      if (err.code === '23505') {
        return res.status(409).json({ ok: false,
          error: 'Khách này vừa có đường dẫn mới được tạo — mở lại hồ sơ để xem.' });
      }
      console.error('[album-link] tạo lỗi:', err.message);
      return res.status(500).json({ ok: false, error: 'Không tạo được đường dẫn.' });
    } finally { cli.release(); }
  });

  /* Thu hồi. CHỖ TÔI LÀM KHÁC PHIẾU — phiếu gộp «tạo / copy / thu hồi = btl + ô
     tick». Tick nghĩa là «khách đồng ý NHẬN đường dẫn»; bắt tick ấy mới cho THU
     HỒI là đòi một lời đồng ý về đúng việc mình đang huỷ bỏ, và hậu quả thực tế
     là một link lỡ gửi nhầm không tắt được cho tới khi có người tick vào một câu
     sai. Nên: thu hồi chỉ đòi `btl`. Vẫn ghi sổ đầy đủ ai thu hồi lúc nào. */
  app.post('/crm/guests/:id/album-link/thu-hoi', ...btl, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad id' });
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const r = await cli.query(
        `UPDATE crm_album_links SET thu_hoi_luc = now(), thu_hoi_boi = $2
          WHERE guest_id = $1 AND thu_hoi_luc IS NULL RETURNING id`, [id, req.actor.email]);
      if (!r.rowCount) { await cli.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'Khách này không có đường dẫn đang sống.' }); }
      await cli.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'album_share','guest',$2,$3::jsonb,$4)`,
        [req.actor.email, String(id),
          JSON.stringify({ hanh_dong: 'thu-hoi', link_id: r.rows[0].id, ve: 'E08-D120' }),
          hashIp(ipOf(req))]);
      await cli.query('COMMIT');
      return res.json({ ok: true, thu_hoi: r.rowCount });
    } catch (err) {
      await cli.query('ROLLBACK').catch(() => {});
      console.error('[album-link] thu hồi lỗi:', err.message);
      return res.status(500).json({ ok: false, error: 'Không thu hồi được.' });
    } finally { cli.release(); }
  });

  /* ══ NHÁNH KHÁCH (không đăng nhập) ═════════════════════════════════════════ */

  /* Gác chung cho cả trang lẫn ảnh: token hợp lệ → `req.lk`. Một chỗ duy nhất
     quyết định «token này còn sống không», nên không có tuyến nào lỡ quên. */
  async function gacToken(req, res, next) {
    const tok = String(req.params.token || '');
    const ip = ipOf(req);
    if (!TOKEN_RE.test(tok)) {
      quaNhip('lk-sai:' + ip, SAI_MAX, SAI_CUA_SO);
      return res.status(404).send(trangHong('Không tìm thấy', 'Đường dẫn không đúng hoặc đã bị thay bằng đường dẫn mới.'));
    }
    try {
      const lk = await docLink(tok);
      if (!lk) {
        /* Token KHÔNG khớp = dấu vết máy dò. 20 lần / 10 phút / IP rồi thôi —
           với không gian 256 bit thì hạn này không cản được ai trừ máy dò, và
           đúng máy dò mới là thứ cần cản. */
        if (quaNhip('lk-sai:' + ip, SAI_MAX, SAI_CUA_SO)) {
          return res.status(429).send(trangHong('Thử lại sau', 'Có quá nhiều lượt mở không hợp lệ từ máy này.'));
        }
        return res.status(404).send(trangHong('Không tìm thấy', 'Đường dẫn không đúng hoặc đã bị thay bằng đường dẫn mới.'));
      }
      if (lk.het) {
        return res.status(410).send(trangHong('Đường dẫn đã hết hiệu lực',
          'Đường dẫn này đã hết hạn hoặc đã được thay bằng đường dẫn mới. '
          + 'Anh/chị vui lòng liên hệ người đã gửi để nhận đường dẫn mới.'));
      }
      req.lk = lk; req.tok = tok;
      return next();
    } catch (e) {
      console.error('[album-link] gác token lỗi:', e.message);
      return res.status(500).send(trangHong('Có lỗi', 'Máy chủ đang bận, anh/chị thử lại sau ít phút.'));
    }
  }

  /* Trang khách. Đọc-mỗi-lần, KHÔNG cache ở proxy: `private, no-store` để một
     đường dẫn riêng không nằm lại trong bộ nhớ đệm dùng chung nào. */
  app.get('/album/:token', async (req, res, next) => {
    if (quaNhip('lk-mo:' + ipOf(req), MO_MAX, MO_CUA_SO)) {
      return res.status(429).send(trangHong('Thử lại sau', 'Anh/chị vừa mở trang nhiều lần liên tiếp. Vui lòng đợi ít phút.'));
    }
    return gacToken(req, res, next);
  }, async (req, res) => {
    const lk = req.lk;
    try {
      /* ① ALBUM = tấm ĐÃ XÁC NHẬN của đúng khách này (spec §4).
         DISTINCT ON (event_photo_id) — D115: một tấm chỉ nằm MỘT lần trong album
         của một khách. Ở đây gửi trùng không chỉ là con số xấu, nó là gửi cho
         người thật hai lần cùng một tấm. Dòng 'cho' KHÔNG lên trang: máy đoán
         chưa ai duyệt thì không được gửi ra khỏi công ty (CR-127). */
      const anh = await pool.query(`
        SELECT * FROM (
          SELECT DISTINCT ON (c.event_photo_id)
                 c.event_photo_id AS id, c.decided_at
            FROM crm_face_candidates c
            JOIN crm_event_photos e ON e.id = c.event_photo_id AND e.deleted_at IS NULL
           WHERE c.guest_id = $1 AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan'
           ORDER BY c.event_photo_id, (c.face_id IS NULL), c.id
        ) a ORDER BY a.decided_at DESC NULLS LAST, a.id DESC`, [lk.guest_id]);

      /* ② DÒNG VIỆC = CHIẾU từ ba nguồn đã có (I5). Không bảng mới, không ghi. */
      const ci = await pool.query(
        'SELECT session, checked_in_at FROM crm_check_ins WHERE guest_id = $1', [lk.guest_id]);
      /* Ảnh vào album gộp THEO NGÀY: khách 124 tấm mà kể từng tấm thì dòng việc
         dài 124 dòng và không còn là một dòng việc nữa. */
      const alb = await pool.query(`
        SELECT date_trunc('day', c.decided_at) AS ngay, count(DISTINCT c.event_photo_id)::int AS n
          FROM crm_face_candidates c
          JOIN crm_event_photos e ON e.id = c.event_photo_id AND e.deleted_at IS NULL
         WHERE c.guest_id = $1 AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan'
           AND c.decided_at IS NOT NULL
         GROUP BY 1`, [lk.guest_id]);
      const gh = await pool.query(
        `SELECT kind, created_at FROM crm_interactions
          WHERE guest_id = $1 AND kind = ANY($2::text[]) ORDER BY created_at DESC LIMIT 100`,
        [lk.guest_id, Object.keys(VIEC_TRANG)]);

      const viec = [];
      ci.rows.forEach((x) => viec.push({ luc: x.checked_in_at,
        chu: 'Đến dự ' + (BUOI_TEN[x.session] || 'chương trình') }));
      alb.rows.forEach((x) => viec.push({ luc: x.ngay,
        chu: x.n + ' tấm ảnh được đưa vào album của anh/chị' }));
      gh.rows.forEach((x) => viec.push({ luc: x.created_at, chu: VIEC_TRANG[x.kind] }));
      viec.sort((a, b) => new Date(b.luc) - new Date(a.luc));   // mới nhất trước

      /* ③ GHI SỔ MỞ. Ghi TRƯỚC khi trả trang và `await`: bắn-rồi-quên thì lượt
         mở cuối trước khi tiến trình chết là lượt không có trong sổ — mà đó
         đúng là lượt người ta cần tra. Cùng luật với `album_xem` của D107.
         Đếm ở ĐÂY, không ở tuyến ảnh: một lần mở trang = một lần khách xem. */
      const may = MAY_XEM_TRUOC.test(String(req.headers['user-agent'] || ''));
      const dem = may ? null : await pool.query(
        `UPDATE crm_album_links
            SET so_lan_mo = so_lan_mo + 1, mo_gan_nhat = now(),
                mo_lan_dau = coalesce(mo_lan_dau, now())
          WHERE id = $1 RETURNING so_lan_mo`, [lk.id]);
      await pool.query(
        `INSERT INTO crm_audit_events (actor_email, event_type, target_type, target_id, meta, ip_hash)
         VALUES ($1,'album_mo','guest',$2,$3::jsonb,$4)`,
        [may ? 'may-xem-truoc' : 'khach', String(lk.guest_id),
          JSON.stringify({ link_id: lk.id, lan_thu: dem && dem.rows[0] ? dem.rows[0].so_lan_mo : null,
            bot: may, so_tam: anh.rows.length, ve: 'E08-D120' }),
          hashIp(ipOf(req))]);

      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.type('html');
      return res.send(trangKhach({ token: req.tok, ten: lk.full_name, anh: anh.rows,
        viec: viec, hetHan: lk.het_han_luc }));
    } catch (err) {
      console.error('[album-link] trang khách lỗi:', err.message);
      return res.status(500).send(trangHong('Có lỗi', 'Máy chủ đang bận, anh/chị thử lại sau ít phút.'));
    }
  });

  /* Ảnh. HAI phép kiểm, cả hai bắt buộc: token còn sống (gacToken) VÀ tấm ấy
     thuộc album ĐÃ XÁC NHẬN của ĐÚNG khách của token. Thiếu phép thứ hai thì
     một khách đổi số trên URL là xem được album của người khác — đúng cái lỗ
     mà «URL không chứa guest_id» sinh ra để bịt. */
  async function tamCuaKhach(req, res, next) {
    if (quaNhip('lk-anh:' + ipOf(req), ANH_MAX, ANH_CUA_SO)) return res.status(429).end();
    const id = parseInt(req.params.pid, 10);
    if (!id) return res.status(400).end();
    try {
      const r = await pool.query(
        `SELECT e.object_key, e.thumb_key, e.preview_key
           FROM crm_event_photos e
           JOIN crm_face_candidates c ON c.event_photo_id = e.id
          WHERE e.id = $1 AND e.deleted_at IS NULL AND c.guest_id = $2
            AND c.deleted_at IS NULL AND c.trang_thai = 'xac-nhan' LIMIT 1`, [id, req.lk.guest_id]);
      if (!r.rows[0]) return res.status(404).end();
      req.tam = r.rows[0];
      return next();
    } catch (e) {
      console.error('[album-link] tấm lỗi:', e.message);
      return res.status(500).end();
    }
  }

  /* Bản dẫn xuất chảy QUA máy chủ, kho vẫn riêng tư: URL cố định nên trình
     duyệt cache được (lưới 60 tấm không tải lại mỗi lần cuộn), mà MinIO không
     lộ ra ngoài dù chỉ một chữ ký. Chưa có bản phụ thì lùi về bản 2048 —
     đúng cách event-photos.js đang làm. */
  async function chay(req, res, cot) {
    const key = req.tam[cot] || req.tam.object_key;
    try {
      const etag = '"' + key + '"';
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
      res.setHeader('ETag', etag);
      const s = await storage.getObjectStream(key);
      s.on('error', (e) => {
        console.error('[album-link] stream lỗi:', e.message);
        if (!res.headersSent) res.status(502).end(); else res.destroy();
      });
      s.pipe(res);
    } catch (e) {
      console.error('[album-link] ảnh lỗi:', e.message);
      if (!res.headersSent) res.status(500).end();
    }
  }
  app.get('/album/:token/anh/:pid/thumb', gacToken, tamCuaKhach, (req, res) => chay(req, res, 'thumb_key'));
  app.get('/album/:token/anh/:pid/xem', gacToken, tamCuaKhach, (req, res) => chay(req, res, 'preview_key'));

  /* Tấm GỐC — đường DUY NHẤT chạm thẳng MinIO, và chạm bằng URL KÝ NGẮN HẠN
     (MINIO_PRESIGN_TTL, mặc định 5 phút) chứ không bằng bucket công khai: chữ
     ký hết hạn thì đường dẫn ấy chết, kể cả khi ai đó chép được nó. */
  app.get('/album/:token/anh/:pid/goc', gacToken, tamCuaKhach, async (req, res) => {
    try {
      return res.redirect(302, await storage.presignGet(req.tam.object_key));
    } catch (e) {
      console.error('[album-link] ký ảnh gốc lỗi:', e.message);
      return res.status(503).end();
    }
  });
}

module.exports = { mount, bam, TOKEN_RE, NGAY_MAC_DINH };
