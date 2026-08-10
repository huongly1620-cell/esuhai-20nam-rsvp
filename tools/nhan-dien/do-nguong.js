'use strict';
/* BƯỚC 0 · chọn ngưỡng — KHÔNG phải AC-5.
   Gom gợi ý ≥0,30 trên phóng sự thật, rồi xuất cặp «mặt sự kiện ↔ mặt mẫu» dán
   cạnh nhau để soi mắt. Các tập gợi ý theo ngưỡng LỒNG nhau (gợi ý ≥0,45 cũng là
   gợi ý ≥0,30), nên chỉ cần chấm MỘT tập rồi tính precision cho từng ngưỡng —
   không phải chấm bốn lần. */
const fs = require('fs'), path = require('path');
const { Pool } = require('pg'); const Minio = require('minio'); const sharp = require('sharp');
const E = require('./engine');
const db = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl:{rejectUnauthorized:false} });
const mc = new Minio.Client({ endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT||443),
  useSSL: String(process.env.MINIO_USE_SSL)==='true', accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY });
const B = process.env.MINIO_BUCKET;
const lay = k => new Promise((r,j)=>{ const c=[]; mc.getObject(B,k,(e,s)=>e?j(e):
  (s.on('data',d=>c.push(d)), s.on('end',()=>r(Buffer.concat(c))), s.on('error',j))); });
const OUT = process.argv[2], SO_ANH = Number(process.argv[3] || 400);
const anh112 = b => sharp(Buffer.from(b), { raw:{width:112,height:112,channels:3} }).toColourspace('srgb');

(async()=>{
 const phien = await E.moPhien();

 /* Mẫu — cùng cửa FR-2 đã siết, để bảng này nói về hệ thống thật chứ không phải
    một cấu hình dễ hơn. */
 const rs = (await db.query(`SELECT p.id, p.guest_id, g.full_name, coalesce(p.preview_key,p.object_key) k
   FROM crm_photos p JOIN crm_guests g ON g.id = p.guest_id ORDER BY p.guest_id`)).rows;
 const mau = [];
 for (const x of rs){ try {
   const b = await lay(x.k); const m = await E.phatHien(phien, b, { nguongDiem: 0.9 }); if (!m.length) continue;
   m.sort((a,c)=>(c.w*c.h)-(a.w*a.h)); const g = await E.anhGoc(b);
   if (Math.max(m[0].w,m[0].h)/Math.max(g.w,g.h) < 0.10) continue;
   if (m.length>1 && (m[1].w*m[1].h) > 0.5*(m[0].w*m[0].h)) continue;
   const c112 = E.catCan(g.raw,g.w,g.h,m[0].moc);
   mau.push({ guest:String(x.guest_id), ten:x.full_name, v: await E.nhung(phien,c112), c:c112 });
 } catch(e){} }
 console.log('  mẫu dùng được: ' + mau.length + ' vector · ' + new Set(mau.map(m=>m.guest)).size + ' khách');

 const re = (await db.query(`SELECT id, orig_name, coalesce(preview_key,object_key) k
   FROM crm_event_photos WHERE deleted_at IS NULL AND rel_path LIKE 'Máy%'
   ORDER BY id LIMIT $1 OFFSET 200`, [SO_ANH])).rows;
 console.log('  ảnh phóng sự xét: ' + re.length);

 const goi = [];
 let soMat = 0;
 for (const a of re){ try {
   const buf = await lay(a.k);
   const mat = await E.phatHien(phien, buf, { nguongDiem: 0.6 }); if (!mat.length) continue;
   const g = await E.anhGoc(buf);
   for (const m of mat){
     const c112 = E.catCan(g.raw,g.w,g.h,m.moc);
     const v = await E.nhung(phien, c112); soMat++;
     const theo = new Map();
     for (const s of mau){ const d = E.giongNhau(v, s.v);
       if (d < 0.30) continue;
       const cu = theo.get(s.guest); if (!cu || d > cu.d) theo.set(s.guest, { d, s }); }
     [...theo.values()].sort((x,y)=>y.d-x.d).slice(0,5).forEach(t =>
       goi.push({ d:t.d, anh:a.id, ten:t.s.ten, matSK:c112, matMau:t.s.c,
                  canh:Math.max(m.w,m.h), net:E.doNet(c112) }));
   }
 } catch(e){} }
 console.log('  mặt: ' + soMat + ' · gợi ý ≥0,30: ' + goi.length);

 const dai = [[0.30,0.35],[0.35,0.40],[0.40,0.45],[0.45,1.01]];
 for (const [lo,hi] of dai){
   const t = goi.filter(x => x.d>=lo && x.d<hi).sort((a,b)=>b.d-a.d);
   const buoc = Math.max(1, Math.floor(t.length/12));
   const chon = t.filter((_,i)=> i%buoc===0).slice(0,12);
   console.log('  dải ' + lo.toFixed(2) + '–' + hi.toFixed(2) + ': ' + t.length + ' gợi ý · xuất ' + chon.length);
   for (let i=0;i<chon.length;i++){ const c = chon[i];
     const canh = await Promise.all([anh112(c.matSK).png().toBuffer(), anh112(c.matMau).png().toBuffer()]);
     await sharp({ create:{ width:230, height:112, channels:3, background:'#101820' } })
       .composite([{input:canh[0],left:0,top:0},{input:canh[1],left:118,top:0}])
       .jpeg({quality:88})
       .toFile(path.join(OUT, lo.toFixed(2)+'_'+String(i+1).padStart(2,'0')+'_'+c.d.toFixed(3)
         +'_anh'+c.anh+'_'+String(c.ten).replace(/[^\w]/g,'_').slice(0,16)+'.jpg'));
   }
 }
 fs.writeFileSync(path.join(OUT,'_tong.json'), JSON.stringify(
   goi.map(x=>({d:+x.d.toFixed(4), anh:x.anh, ten:x.ten, canh:Math.round(x.canh), net:+x.net.toFixed(3)}))));
 for (const t of [0.30,0.35,0.40,0.45])
   console.log('    ≥' + t.toFixed(2) + ': ' + goi.filter(x=>x.d>=t).length + ' gợi ý');
 await db.end();
})().catch(e=>{console.error('LOI '+e.message);process.exit(1);});
