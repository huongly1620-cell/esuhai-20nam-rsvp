'use strict';
/* E08-D077 · Engine nhận diện — YuNet (phát hiện) + SFace (đặc trưng).
   Chạy hoàn toàn cục bộ. Không có OpenCV trong Node nên phần giải mã đầu ra của
   YuNet (priors + NMS) và phép căn mặt viết tay ở đây. */
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const path = require('path');

const STRIDE = [8, 16, 32];
const M = path.join(__dirname, 'model');

async function moPhien(){
  return {
    dò: await ort.InferenceSession.create(path.join(M, 'yunet.onnx')),
    nhung: await ort.InferenceSession.create(path.join(M, 'sface.onnx')),
  };
}

/* YuNet nhận ảnh BGR thô (0–255), không chuẩn hoá, và bản ONNX này có đầu vào
   CỐ ĐỊNH 640×640 — không phải kích thước động. Nên phải lồng khung: thu theo
   cạnh dài rồi đệm cho vuông, giữ nguyên tỉ lệ. Kéo méo cho vừa ô vuông sẽ làm
   mặt bẹt đi và điểm số tụt, mà không có lỗi nào báo. */
const CANH = 640;
async function docAnh(buf){
  const meta = await sharp(buf).metadata();
  const k = Math.min(CANH / meta.width, CANH / meta.height);
  const w = Math.max(1, Math.round(meta.width * k));
  const h = Math.max(1, Math.round(meta.height * k));
  const raw = await sharp(buf)
    .resize(w, h, { fit: 'fill' })
    .extend({ top: 0, left: 0, bottom: CANH - h, right: CANH - w,
              background: { r: 0, g: 0, b: 0 } })
    .removeAlpha().raw().toBuffer();
  return { raw, w: CANH, h: CANH, ti: k, wGoc: meta.width, hGoc: meta.height };
}

function sangTensorBGR(raw, w, h){
  const t = new Float32Array(3 * w * h);
  const mp = w * h;
  for (let i = 0, p = 0; i < mp; i++, p += 3){
    t[i]          = raw[p + 2];   // B
    t[mp + i]     = raw[p + 1];   // G
    t[2 * mp + i] = raw[p];       // R
  }
  return new ort.Tensor('float32', t, [1, 3, h, w]);
}

function iou(a, b){
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const g = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return g / (a.w * a.h + b.w * b.h - g);
}
function nms(ds, nguong){
  ds.sort((p, q) => q.diem - p.diem);
  const giu = [];
  for (const d of ds){ if (!giu.some(g => iou(g, d) > nguong)) giu.push(d); }
  return giu;
}

/* Giải mã ba tầng. Công thức theo đúng bản dựng của OpenCV Zoo:
   điểm = sqrt(cls · obj) — hai đầu ra riêng, nhân rồi lấy căn để về thang xác suất. */
function giaiMa(out, w, h, nguongDiem){
  const ra = [];
  for (const s of STRIDE){
    const cls = out['cls_' + s].data, obj = out['obj_' + s].data;
    const bb  = out['bbox_' + s].data, kp = out['kps_' + s].data;
    const cw = Math.floor(w / s), ch = Math.floor(h / s);
    for (let r = 0; r < ch; r++){
      for (let c = 0; c < cw; c++){
        const i = r * cw + c;
        const diem = Math.sqrt(Math.max(0, cls[i]) * Math.max(0, obj[i]));
        if (diem < nguongDiem) continue;
        const cx = (c + bb[i * 4])     * s;
        const cy = (r + bb[i * 4 + 1]) * s;
        const bw = Math.exp(bb[i * 4 + 2]) * s;
        const bh = Math.exp(bb[i * 4 + 3]) * s;
        const moc = [];
        for (let k = 0; k < 5; k++)
          moc.push([(c + kp[i * 10 + k * 2]) * s, (r + kp[i * 10 + k * 2 + 1]) * s]);
        ra.push({ x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, diem, moc });
      }
    }
  }
  return nms(ra, 0.3);
}

async function phatHien(phien, buf, { nguongDiem = 0.6 } = {}){
  const a = await docAnh(buf);
  const out = await phien.dò.run({ input: sangTensorBGR(a.raw, a.w, a.h) });
  const mat = giaiMa(out, a.w, a.h, nguongDiem);
  /* Trả về toạ độ theo ẢNH GỐC: mọi ngưỡng kích thước (FR-8) phải nói về ảnh
     thật, không nói về bản đã thu nhỏ để chạy model. */
  const kx = 1 / a.ti, ky = 1 / a.ti;   // đệm nằm ở phải/dưới nên không phải trừ lệch
  return mat.map(m => ({
    x: m.x * kx, y: m.y * ky, w: m.w * kx, h: m.h * ky, diem: m.diem,
    moc: m.moc.map(p => [p[0] * kx, p[1] * ky]),
  }));
}

/* ── Căn mặt ───────────────────────────────────────────────────────────────
   SFace nhận mặt đã căn về khuôn 112×112: hai mắt nằm đúng chỗ, mặt xoay thẳng.
   Không căn mà cắt thẳng hộp thì cùng một người nghiêng đầu hai kiểu sẽ ra hai
   vector khác nhau — đó là lỗi im lặng, không ai báo, chỉ thấy điểm khớp tụt.
   Khuôn ArcFace tiêu chuẩn; thứ tự mốc của YuNet trùng thứ tự khuôn này
   (mắt phải chủ thể trước — tức là điểm nằm bên TRÁI ảnh). */
const KHUON = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
               [41.5493, 92.3655], [70.7299, 92.2041]];

/* Biến đổi tương tự (xoay + phóng + tịnh tiến) bình phương tối thiểu, viết bằng
   số phức: q = a·p + t. Nghiệm đóng, không cần SVD. */
function uocLuongBienDoi(nguon, dich){
  const n = nguon.length;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < n; i++){ px += nguon[i][0]; py += nguon[i][1]; qx += dich[i][0]; qy += dich[i][1]; }
  px /= n; py /= n; qx /= n; qy /= n;
  let sr = 0, si = 0, sp = 0;
  for (let i = 0; i < n; i++){
    const ax = nguon[i][0] - px, ay = nguon[i][1] - py;
    const bx = dich[i][0]  - qx, by = dich[i][1]  - qy;
    sr += ax * bx + ay * by;          // Re(conj(a)·b)
    si += ax * by - ay * bx;          // Im(conj(a)·b)
    sp += ax * ax + ay * ay;
  }
  if (sp === 0) throw new Error('năm mốc trùng nhau — không dựng được phép căn');
  const ar = sr / sp, ai = si / sp;   // a = ar + i·ai
  return { ar, ai, tx: qx - (ar * px - ai * py), ty: qy - (ai * px + ar * py) };
}

/* Lấy mẫu ngược + nội suy song tuyến: duyệt từng điểm ảnh ĐẦU RA rồi tìm nguồn.
   Duyệt xuôi sẽ để lại lỗ khi phóng to. */
function catCan(rgb, w, h, moc){
  const T = uocLuongBienDoi(moc, KHUON);
  const d = T.ar * T.ar + T.ai * T.ai;
  if (d === 0) throw new Error('phép căn suy biến');
  const ra = Buffer.alloc(112 * 112 * 3);
  for (let v = 0; v < 112; v++){
    for (let u = 0; u < 112; u++){
      const ux = u - T.tx, uy = v - T.ty;
      const x = (T.ar * ux + T.ai * uy) / d;      // nhân với nghịch đảo của a
      const y = (T.ar * uy - T.ai * ux) / d;
      const o = (v * 112 + u) * 3;
      if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) continue;   // ngoài ảnh → đen
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      for (let c = 0; c < 3; c++){
        const p00 = rgb[(y0 * w + x0) * 3 + c],       p10 = rgb[(y0 * w + x0 + 1) * 3 + c];
        const p01 = rgb[((y0 + 1) * w + x0) * 3 + c], p11 = rgb[((y0 + 1) * w + x0 + 1) * 3 + c];
        ra[o + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return ra;
}

/* SFace: 1×3×112×112 BGR thô, ra vector 128 chiều. Chuẩn hoá L2 để so bằng
   cosine — không chuẩn hoá thì độ dài vector lẫn vào điểm giống nhau. */
async function nhung(phien, mat112){
  const t = new Float32Array(3 * 112 * 112), mp = 112 * 112;
  for (let i = 0, p = 0; i < mp; i++, p += 3){
    t[i] = mat112[p + 2]; t[mp + i] = mat112[p + 1]; t[2 * mp + i] = mat112[p];
  }
  const out = await phien.nhung.run({ data: new ort.Tensor('float32', t, [1, 3, 112, 112]) });
  const v = Array.from(out.fc1.data);
  let n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}
/* Độ nét = phương sai của Laplacian trên bản xám của mặt ĐÃ CĂN. Đo trên mặt đã
   căn chứ không trên cả ảnh: một khung nét căng vẫn có thể chứa một người mờ ở
   hậu cảnh, và đó đúng là ca FR-8 cần tách. Chia cho phương sai độ sáng để ảnh
   tối không bị phạt oan — số ra là độ nét TƯƠNG ĐỐI, không phụ thuộc phơi sáng. */
function doNet(mat112){
  const n = 112, xam = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++){
    const p = i * 3;
    xam[i] = 0.114 * mat112[p] + 0.587 * mat112[p + 1] + 0.299 * mat112[p + 2];  // BGR
  }
  let tong = 0, tong2 = 0, m = 0;
  for (let y = 1; y < n - 1; y++){
    for (let x = 1; x < n - 1; x++){
      const i = y * n + x;
      const l = xam[i - n] + xam[i + n] + xam[i - 1] + xam[i + 1] - 4 * xam[i];
      tong += l; tong2 += l * l; m++;
    }
  }
  const pv = tong2 / m - (tong / m) * (tong / m);
  let s = 0, s2 = 0;
  for (let i = 0; i < n * n; i++){ s += xam[i]; s2 += xam[i] * xam[i]; }
  const pvSang = Math.max(1, s2 / (n * n) - (s / (n * n)) ** 2);
  return pv / pvSang;
}
function giongNhau(a, b){ let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/* Đọc ảnh ở độ phân giải THẬT để cắt mặt: cắt từ bản 640px đã lồng khung sẽ mất
   chi tiết đúng lúc cần nó nhất. */
async function anhGoc(buf){
  const m = await sharp(buf).metadata();
  const raw = await sharp(buf).removeAlpha().raw().toBuffer();
  return { raw, w: m.width, h: m.height };
}

module.exports = { moPhien, phatHien, docAnh, anhGoc, catCan, nhung, giongNhau, doNet, KHUON };
