'use strict';
/* Đo SFace tách được người này với người kia tới đâu — TRƯỚC khi dựng batch lên
   trên nó. Chuẩn đối chiếu không phải do mình gán: khách có ≥2 ảnh chân dung
   trong crm_photos thì hai ảnh đó chắc chắn cùng người. */
const { Pool } = require('pg'); const Minio = require('minio');
const { moPhien, phatHien, anhGoc, catCan, nhung, giongNhau } = require('./engine');
const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl:{rejectUnauthorized:false} });
const mc = new Minio.Client({ endPoint: process.env.MINIO_ENDPOINT, port: Number(process.env.MINIO_PORT||443),
  useSSL: String(process.env.MINIO_USE_SSL)==='true', accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY });
const B = process.env.MINIO_BUCKET;
const tai = k => new Promise((res,rej)=>{ const c=[]; mc.getObject(B,k,(e,s)=>e?rej(e):
  (s.on('data',d=>c.push(d)), s.on('end',()=>res(Buffer.concat(c))), s.on('error',rej))); });
(async()=>{
 const N = Number(process.argv[2]||30);
 const r = (await pool.query(`
   WITH nhieu AS (SELECT guest_id FROM crm_photos GROUP BY 1 HAVING count(*)>=2 LIMIT $1)
   SELECT p.guest_id, p.id, coalesce(p.preview_key,p.object_key) k
   FROM crm_photos p JOIN nhieu n ON n.guest_id=p.guest_id ORDER BY p.guest_id, p.id`, [N])).rows;
 console.log('  ' + new Set(r.map(x=>x.guest_id)).size + ' khách · ' + r.length + ' ảnh chân dung');
 const phien = await moPhien();
 const vec = [];
 let khongThayMat = 0;
 const loaiMau = { diem:0, nho:0, dongNguoi:0 };
 for (const x of r){
   try {
     const buf = await tai(x.k);
     const mat = await phatHien(phien, buf, { nguongDiem: 0.5 });
     if (!mat.length){ khongThayMat++; continue; }
     mat.sort((a,b)=> (b.w*b.h)-(a.w*a.h));          // ảnh chân dung: lấy mặt to nhất
     /* CỬA ẢNH MẪU. crm_photos không phải tập tham chiếu sạch: đo thật thì có ảnh
        lẵng hoa nằm dưới một guest_id, và YuNet vẫn bắt "một mặt" ở ngưỡng 0,5.
        Một ảnh mẫu sai đầu độc MỌI khớp của khách đó, nên cửa vào phải chặt hơn
        cửa dò trên ảnh sự kiện: điểm cao, mặt đủ to so với khung, và phải là mặt
        rõ ràng trội nhất — chân dung thật thì mặt chiếm phần đáng kể. */
     if (mat[0].diem < 0.9){ loaiMau.diem++; continue; }
     const g = await anhGoc(buf);
     const tiLe = Math.max(mat[0].w, mat[0].h) / Math.max(g.w, g.h);
     if (tiLe < 0.10){ loaiMau.nho++; continue; }              // mặt quá nhỏ so với khung
     if (mat.length > 1 && (mat[1].w*mat[1].h) > 0.5*(mat[0].w*mat[0].h)){ loaiMau.dongNguoi++; continue; }
     vec.push({ guest: String(x.guest_id), anh: String(x.id), key: x.k, v: await nhung(phien, catCan(g.raw,g.w,g.h,mat[0].moc)) });
   } catch(e){ khongThayMat++; }
 }
 console.log('  nhúng được ' + vec.length + ' · không thấy mặt / lỗi: ' + khongThayMat);
 console.log('  loại khỏi tập mẫu: điểm thấp ' + loaiMau.diem + ' · mặt quá nhỏ ' + loaiMau.nho +
             ' · nhiều người ' + loaiMau.dongNguoi);
 const cung = [], khac = [], capCung = [], capKhac = [];
 for (let i=0;i<vec.length;i++) for (let j=i+1;j<vec.length;j++){
   const s = giongNhau(vec[i].v, vec[j].v);
   if (vec[i].guest===vec[j].guest){ cung.push(s); capCung.push({s,a:vec[i],b:vec[j]}); }
   else { khac.push(s); capKhac.push({s,a:vec[i],b:vec[j]}); }
 }
 /* Xuất các ca LỆCH để soi mắt: điểm số một mình không nói được chuẩn đối chiếu
    có đúng không. */
 const fs=require('fs');
 const xuat = async (danh, ten) => { let i=0;
   for (const c of danh){ i++;
     for (const [nhan,o] of [['A',c.a],['B',c.b]]){
       fs.writeFileSync(process.argv[3]+'/'+ten+i+'_'+c.s.toFixed(3)+'_'+nhan+'_khach'+o.guest+'.jpg', await tai(o.key)); }
   } };
 /* Ca "khác người mà điểm cao": hỏi thẳng DB xem hai bản ghi đó có phải cùng
    một người thật không. Danh sách khách có bộ lọc "Trùng" nên trùng là chuyện
    đã biết là có. */
 const cao = capKhac.filter(c=>c.s>0.5).sort((x,y)=>y.s-x.s);
 if (cao.length){
   console.log('  ── các cặp KHÁC guest_id mà điểm cao ──');
   for (const c of cao){
     const g = (await pool.query(
       `SELECT id, full_name, phone_norm, org FROM crm_guests WHERE id = ANY($1::bigint[]) ORDER BY id`,
       [[c.a.guest, c.b.guest]])).rows;
     console.log('    ' + c.s.toFixed(3) + '  ' + g.map(x=>'#'+x.id+' '+x.full_name+
       ' ['+(x.phone_norm||'—')+'] '+(x.org||'—')).join('   vs   '));
   }
 }
 const tk = a => { a=a.slice().sort((x,y)=>x-y);
   return { n:a.length, min:a[0]?.toFixed(3), p05:a[Math.floor(a.length*0.05)]?.toFixed(3),
     tv:a[Math.floor(a.length*0.5)]?.toFixed(3), p95:a[Math.floor(a.length*0.95)]?.toFixed(3),
     max:a[a.length-1]?.toFixed(3) }; };
 console.log('  CÙNG người : ' + JSON.stringify(tk(cung)));
 console.log('  KHÁC người : ' + JSON.stringify(tk(khac)));
 /* Ngưỡng nào cho precision 100% trên tập này = ngưỡng nào vượt hẳn mọi cặp khác người */
 const maxKhac = Math.max(...khac), minCung = Math.min(...cung);
 console.log('  cặp khác người CAO nhất : ' + maxKhac.toFixed(3));
 console.log('  cặp cùng người THẤP nhất: ' + minCung.toFixed(3));
 console.log('  → ' + (minCung > maxKhac
   ? 'TÁCH HẲN: mọi ngưỡng trong (' + maxKhac.toFixed(3) + ', ' + minCung.toFixed(3) + ') cho 100% cả hai chiều'
   : 'CHỒNG LẤN — phải chọn ngưỡng đánh đổi, xem bảng dưới'));
 for (const t of [0.30,0.35,0.40,0.45,0.50,0.55,0.60]){
   const tp = cung.filter(s=>s>=t).length, fp = khac.filter(s=>s>=t).length;
   console.log('    ngưỡng ' + t.toFixed(2) + ' · nhận đúng ' + tp + '/' + cung.length +
     ' · nhận NHẦM ' + fp + '/' + khac.length +
     ' · precision ' + (tp+fp ? (tp/(tp+fp)*100).toFixed(1)+'%' : '—'));
 }
 await pool.end();
})().catch(e=>{console.error('LOI '+e.message);process.exit(1);});
