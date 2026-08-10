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
module.exports = { moPhien, phatHien, docAnh };
