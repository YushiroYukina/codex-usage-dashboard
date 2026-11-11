import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startMacServer} from '../runtime/mac-server.mjs';
import {openHistory} from '../runtime/history.mjs';
import {exportAccountBundle,digest} from '../runtime/account-ledger.mjs';
test('Mac settings API configures service, shows login challenge, and keeps credentials server-side',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ul-account-api-')),scope='a'.repeat(64);fs.mkdirSync(path.join(dir,'sessions'));const config={dataDir:dir,codexHome:dir,syncRoot:path.join(dir,'sync'),accountSync:true};fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({ok:true,queryOk:true,accountKey:scope,observedAt:Date.now()}));
 const memory=new Map(),secrets={read:k=>memory.get(k),write:(k,v)=>memory.set(k,v),remove:k=>memory.delete(k)};
 const app=await startMacServer({config,monitor:false,hostPid:()=>null,accountOptions:{secrets,scopeProvider:()=>scope,fetcher:async(url)=>new Response(JSON.stringify(url.endsWith('/start')?{deviceCode:'private-device-code'.repeat(3),userCode:'1234-5678',verificationUri:'http://127.0.0.1:54321/authorize',expiresIn:600,interval:1}:{accountScope:scope,accessToken:'private-access-token'.repeat(3),refreshToken:'private-refresh-token'.repeat(3),expiresIn:3600}),{status:200})}});
 const headers={'X-Ledger-Token':app.token,'Content-Type':'application/json'};
 const action=body=>fetch(app.origin+'/api/settings',{method:'POST',headers,body:JSON.stringify(body)});
 try{
  assert.equal((await action({action:'account-configure',service:'http://192.168.0.1'})).status,400);
  assert.equal((await action({action:'account-configure',service:'http://127.0.0.1:54321'})).status,200);
  const login=await(await action({action:'account-login'})).json();assert.equal(login.userCode,'1234-5678');assert.ok(!JSON.stringify(login).includes('private-device-code'));
  assert.equal((await(await action({action:'account-poll'})).json()).loggedIn,true);
  const settings=await(await fetch(app.origin+'/api/settings',{headers})).json();assert.equal(settings.accountSync.loggedIn,true);assert.ok(!JSON.stringify(settings).includes('private-access-token'));assert.ok(!JSON.stringify(settings.accountSync).includes(scope));
  assert.equal((await fetch(app.origin+'/api/settings',{method:'POST',headers:{...headers,Origin:'https://attacker.example'},body:JSON.stringify({action:'account-poll'})})).status,403);
 }finally{await app.close();fs.rmSync(dir,{recursive:true,force:true})}
});
test('GUI account report does not include a previous account ledger',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ul-view-api-')),scope='a'.repeat(64),other='b'.repeat(64);fs.mkdirSync(path.join(dir,'sessions'));const config={dataDir:dir,codexHome:dir,syncRoot:path.join(dir,'sync'),accountSync:true};
 const db=openHistory(dir);db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?)').run(digest('old'),'2026-11-10T00:00:00.000Z','2026-11-10','old-model',JSON.stringify({input:100,cached:80,uncached:20,cacheWrite:null,output:20,reasoning:5,total:120}));exportAccountBundle(db,other);db.close();fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({ok:true,queryOk:true,accountKey:scope,observedAt:Date.now()}));
 const app=await startMacServer({config,monitor:false,hostPid:()=>null,accountOptions:{secrets:{read:()=>null}}});
 try{const report=await(await fetch(app.origin+'/api/report?start=2026-11-10&end=2026-11-10',{headers:{'X-Ledger-Token':app.token}})).json();assert.equal(report.sum.total,0);assert.equal(report.models.length,0);assert.equal(report.ledger.counts.tokens,0)}finally{await app.close();fs.rmSync(dir,{recursive:true,force:true})}
});
test('live account tags trigger a safe view refresh after startup and account changes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ul-startup-api-'));fs.mkdirSync(path.join(dir,'sessions'));const config={dataDir:dir,codexHome:dir,syncRoot:path.join(dir,'sync'),accountSync:true};const app=await startMacServer({config,monitor:false,hostPid:()=>null,accountOptions:{secrets:{read:()=>null}}});const headers={'X-Ledger-Token':app.token};const read=url=>fetch(app.origin+url,{headers}).then(r=>r.json());
 try{const first=await read('/api/report?days=1');assert.equal(first.accountTag,null);const scope='a'.repeat(64);fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({ok:true,queryOk:true,accountKey:scope}));const live=await read('/api/live');assert.equal(typeof live.accountTag,'string');assert.ok(!JSON.stringify(live).includes(scope));assert.notEqual(first.accountTag,live.accountTag);assert.equal((await read('/api/report?days=1')).accountTag,live.accountTag);fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({ok:true,queryOk:true,accountKey:'b'.repeat(64)}));assert.notEqual((await read('/api/live')).accountTag,live.accountTag)}finally{await app.close();fs.rmSync(dir,{recursive:true,force:true})}
});
