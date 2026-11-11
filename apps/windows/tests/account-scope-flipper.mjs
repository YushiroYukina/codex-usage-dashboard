import fs from 'node:fs';
const file=process.argv[2];let n=0;
const timer=setInterval(()=>{const scope=(++n%2?'a':'b').repeat(64),tmp=file+'.switch';try{fs.writeFileSync(tmp,JSON.stringify({ok:true,queryOk:true,accountKey:scope,observedAt:Date.now()}));fs.renameSync(tmp,file);}catch{}},2);
process.stdout.write('switching\n');
