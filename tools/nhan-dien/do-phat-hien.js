'use strict';
const fs = require('fs'), path = require('path');
const { moPhien, phatHien } = require('./engine');
(async()=>{
 const p = await moPhien();
 const d = process.argv[2];
 for (const f of fs.readdirSync(d).filter(x=>/\.(jpe?g|png)$/i.test(x)).sort()){
   const buf = fs.readFileSync(path.join(d, f));
   const t0 = Date.now();
   const mat = await phatHien(p, buf);
   const co = mat.map(m => Math.round(Math.max(m.w, m.h)));
   console.log('  ' + f.padEnd(26) + String(mat.length).padStart(2) + ' mặt · ' +
     (Date.now()-t0) + 'ms · cạnh: ' + (co.length?co.sort((a,b)=>b-a).join(','):'—'));
 }
})().catch(e=>{console.error('LOI '+e.message);process.exit(1);});
