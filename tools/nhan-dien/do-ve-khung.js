'use strict';
const fs=require('fs'), path=require('path'), sharp=require('sharp');
const { moPhien, phatHien } = require('./engine');
(async()=>{
 const p=await moPhien();
 for (const f of process.argv.slice(3)){
   const buf=fs.readFileSync(path.join(process.argv[2],f));
   const mat=await phatHien(p,buf);
   const m=await sharp(buf).metadata();
   const oo=mat.map(function(d,i){
     const c=Math.max(d.w,d.h)>=64?'#28e06d':'#ffb347';   // xanh = đạt ngưỡng FR-8 khởi điểm
     return '<rect x="'+d.x.toFixed(0)+'" y="'+d.y.toFixed(0)+'" width="'+d.w.toFixed(0)+'" height="'+d.h.toFixed(0)+
       '" fill="none" stroke="'+c+'" stroke-width="4"/>'+
       '<text x="'+d.x.toFixed(0)+'" y="'+(d.y-6).toFixed(0)+'" fill="'+c+'" font-size="26" font-family="sans-serif">'+
       Math.round(Math.max(d.w,d.h))+'px '+d.diem.toFixed(2)+'</text>'+
       d.moc.map(function(q){return '<circle cx="'+q[0].toFixed(0)+'" cy="'+q[1].toFixed(0)+'" r="3" fill="#ff3b3b"/>';}).join('');
   }).join('');
   const svg='<svg width="'+m.width+'" height="'+m.height+'">'+oo+'</svg>';
   const ra=path.join(process.argv[2],'khung_'+f);
   await sharp(buf).composite([{input:Buffer.from(svg),top:0,left:0}]).jpeg({quality:82}).toFile(ra);
   console.log('  vẽ '+mat.length+' khung → '+path.basename(ra));
 }
})().catch(e=>{console.error('LOI '+e.message);process.exit(1);});
