import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startMacServer} from '../runtime/desktop-server.mjs';
import {openHistory} from '../runtime/history.mjs';import {bindLocalRecords,digest} from '../runtime/account-ledger.mjs';
const scope='a'.repeat(64),pause=ms=>new Promise(r=>setTimeout(r,ms));
test('refresh UI endpoint merges both ways, background peer refresh updates other UI, quota and all views share ledger',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ul-ui-pair-')),apps=[];
 const seed=(dir,id,n)=>{const db=openHistory(dir);try{db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?)').run(digest(id),'2026-11-10T00:00:00.000Z','2026-11-10','model',JSON.stringify({input:n,cached:0,uncached:n,cacheWrite:null,output:0,reasoning:0,total:n}));bindLocalRecords(db,scope);}finally{db.close();}};
 t.after(async()=>{for(const app of apps)await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const fakeTunnel=(_root,peer)=>({start:async()=>{peer.setEndpoint(await peer.startHost());return {code:peer.code()};},stop:()=>{},status:()=>({canHost:true})});
 for(const [label,n] of [['windows',50],['mac',100]]){
  const dir=path.join(root,label);fs.mkdirSync(path.join(dir,'sessions'),{recursive:true});seed(dir,label,n);
  const quota={ok:true,queryOk:true,accountKey:scope,accountVerified:true,checkedAt:Date.now(),observedAt:Date.parse('2026-11-10T02:00:00.000Z'),plan:'prolite',windows:[{label:'每周',minutes:10080,used:20,remaining:80,resetsAt:1794605159}]};fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(quota));
  const memory=new Map(),secrets={read:k=>memory.get(k),write:(k,v)=>memory.set(k,v),remove:k=>memory.delete(k)};
  apps.push(await startMacServer({config:{dataDir:dir,codexHome:dir,syncRoot:path.join(dir,'legacy-sync'),accountSync:true},monitor:false,hostPid:()=>null,readQuota:async()=>quota,peerOptions:{secrets,allowLocal:true},accountOptions:{secrets},tunnelFactory:fakeTunnel}));
 }
 const call=(index,route,body)=>fetch(apps[index].origin+route,{method:body?'POST':'GET',headers:{'X-Ledger-Token':apps[index].token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}).then(async r=>{const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;});
 const created=await call(0,'/api/settings',{action:'peer-host'});await call(1,'/api/settings',{action:'peer-join',code:created.code});
 const route='/api/report?start=2026-11-10&end=2026-11-10';let a=await call(0,route),b=await call(1,route);assert.equal(a.sum.total,150);assert.deepEqual(a.ledger,b.ledger);
 seed(path.join(root,'windows'),'win-later',7);seed(path.join(root,'mac'),'mac-later',11);
 await call(0,'/api/refresh',{});let ready=false;
 for(let i=0;i<18;i++){await pause(500);a=await call(0,route);b=await call(1,route);if(a.sum.total===168&&b.sum.total===168&&a.ledger.digest===b.ledger.digest){ready=true;break;}}
 assert.ok(ready,'Windows refresh and automatic client poll update both without second manual refresh');assert.deepEqual(a.daily,b.daily);assert.deepEqual(a.models,b.models);
 const la=await call(0,'/api/live'),lb=await call(1,'/api/live');assert.deepEqual(la.quota,lb.quota);assert.equal(la.quota.windows[0].remaining,80);assert.equal(la.peerSync.state,'converged');assert.equal(lb.peerSync.state,'converged');
 const settings=await call(0,'/api/settings');assert.ok(!JSON.stringify(settings.peerSync).includes(scope));assert.ok(!JSON.stringify(settings).includes('UL2.'));
});
