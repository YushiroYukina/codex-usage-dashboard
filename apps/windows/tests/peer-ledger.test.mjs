import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openHistory,reportHistory,saveSnapshot} from '../runtime/history.mjs';
import {bindLocalRecords,digest,exportAccountBundle,ledgerManifest} from '../runtime/account-ledger.mjs';
import {createPeerLedger,encryptPeer,decryptPeer,peerURL} from '../runtime/peer-ledger.mjs';
import {mergedQuota} from '../runtime/merged-quota.mjs';
const account='a'.repeat(64),other='b'.repeat(64);
function seed(db,id,n,scope=account,at='2026-11-10T00:00:00.000Z',model='model-a'){
 db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?)').run(digest(id),at,new Date(Date.parse(at)+28800000).toISOString().slice(0,10),model,JSON.stringify({input:n,cached:0,uncached:n,cacheWrite:null,output:0,reasoning:0,total:n}));bindLocalRecords(db,scope);
}
const manifest=db=>ledgerManifest(exportAccountBundle(db,account));
const total=db=>exportAccountBundle(db,account).tokens.reduce((n,r)=>n+r.usage.total,0);
async function fixture(t,extra={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ul-peer-')),a=openHistory(path.join(root,'windows')),b=openHistory(path.join(root,'mac'));let scopeA=account,scopeB=account,offline=false,afterResponse=null,clock=Date.now();
 const secrets=()=>{const m=new Map();return {read:k=>m.get(k),write:(k,v)=>m.set(k,v),remove:k=>m.delete(k)};};let hostRefresh=0,clientRefresh=0;
 const host=createPeerLedger({dataDir:path.join(root,'windows')},a,{secrets:secrets(),scopeProvider:()=>scopeA,allowLocal:true,now:()=>clock,refresh:async()=>{hostRefresh++;},...extra.host});
 const client=createPeerLedger({dataDir:path.join(root,'mac')},b,{secrets:secrets(),scopeProvider:()=>scopeB,allowLocal:true,now:()=>clock,refresh:async()=>{clientRefresh++;},fetcher:async(url,opts)=>{if(offline)throw Error('offline');const r=await fetch(url,opts);if(afterResponse)await afterResponse(opts);return r;},...extra.client});
 t.after(async()=>{await client.close();await host.close();a.close();b.close();fs.rmSync(root,{recursive:true,force:true});});
 const url=await host.startHost();host.setEndpoint(url);
 return {a,b,host,client,root,url,connect:()=>client.join(host.code()),offline:value=>offline=value,after:fn=>afterResponse=fn,scopeA:v=>scopeA=v,scopeB:v=>scopeB=v,advance:n=>clock+=n,refreshes:()=>[hostRefresh,clientRefresh]};
}
test('encrypted paired HTTP: 100+50-20=130; three retries; offline union; all views and digests agree',async t=>{
 const f=await fixture(t);seed(f.a,'shared',20);seed(f.b,'shared',20);seed(f.a,'windows',30);seed(f.b,'mac',80);
 const result=await f.connect();assert.equal(result.state,'converged');assert.equal(f.host.status().state,'converged');assert.equal(total(f.a),130);assert.equal(total(f.b),130);
 for(let i=0;i<3;i++)await f.client.tick(true);assert.equal(total(f.a),130);assert.equal(total(f.b),130);assert.equal(manifest(f.a).counts.tokens,3);
 f.offline(true);seed(f.a,'offline-win',11,account,'2026-11-10T15:59:59.000Z','model-win');seed(f.b,'offline-mac',7,account,'2026-11-10T16:00:00.000Z','model-mac');assert.equal((await f.client.tick(true)).state,'offline');assert.notEqual(f.host.status().state,'converged');
 f.offline(false);assert.equal((await f.client.tick(true)).state,'converged');assert.equal(total(f.a),148);assert.equal(total(f.b),148);assert.deepEqual(manifest(f.a),manifest(f.b));
 for(const range of [{start:'2026-11-10',end:'2026-11-11'},7,30]){const a=reportHistory(f.a,range,new Date('2026-11-11T00:00:00Z'),account),b=reportHistory(f.b,range,new Date('2026-11-11T00:00:00Z'),account);assert.deepEqual(a.sum,b.sum);assert.deepEqual(a.daily,b.daily);assert.deepEqual(a.models,b.models);}
 const report=reportHistory(f.a,{start:'2026-11-10',end:'2026-11-11'},new Date('2026-11-11T00:00:00Z'),account);assert.equal(report.daily[1].total,7);
 await f.host.tick(true);await f.client.tick();assert.ok(f.refreshes()[1]>0,'host refresh requests client refresh');
 f.advance(21000);assert.notEqual(f.host.status().state,'converged');
 assert.ok(!fs.readFileSync(path.join(f.root,'windows','paired-device.json'),'utf8').includes('"key"'));
});
test('scope switch while HTTP response is in flight never imports it into the new account',async t=>{
 const f=await fixture(t);seed(f.a,'windows',50);seed(f.b,'mac',100);let hits=0;f.after(()=>{if(++hits===2)f.scopeB(other);});
 await f.connect();assert.equal(total(f.b),100);assert.equal(exportAccountBundle(f.b,other).tokens.length,0);assert.equal(f.client.status().state,'account_changed');
 f.scopeB(account);f.after(null);await f.client.tick();assert.equal(total(f.b),150);
 f.scopeA(other);seed(f.a,'other-account',9,other);assert.equal((await f.client.tick()).state,'offline');assert.equal(total(f.b),150);
});
test('same-ID conflict rolls back entire exchange including otherwise new rows',async t=>{
 const f=await fixture(t);seed(f.a,'conflict',30);seed(f.b,'conflict',99);seed(f.b,'new-row',7);const before=manifest(f.a);
 await f.connect();assert.deepEqual(manifest(f.a),before);assert.equal(total(f.a),30);assert.notEqual(f.host.status().state,'converged');
});
test('new local usage during acknowledgement withdraws convergence and catches up next pass',async t=>{
 const f=await fixture(t);seed(f.a,'win',50);seed(f.b,'mac',100);let n=0;f.after(()=>{if(++n===3)seed(f.b,'during-ack',3);});await f.connect();assert.notEqual(f.client.status().state,'converged');
 f.after(null);await f.client.tick();assert.equal(total(f.a),153);assert.equal(f.client.status().state,'converged');
 seed(f.a,'after-ack',2);assert.notEqual(f.host.status().state,'converged');await f.client.tick();assert.equal(total(f.b),155);
});
test('only encrypted requests accepted; scope text, wrong secret, replay, and browser origins do not authenticate',async t=>{
 const f=await fixture(t);const code=JSON.parse(Buffer.from(f.host.code().slice(4),'base64url'));
 const route=f.url+'/paired/v2/exchange',post=(body,headers={})=>fetch(route,{method:'POST',body,headers});
 assert.equal((await post(JSON.stringify({accountScope:account}))).status,403);
 const frame={protocol:2,group:code.group,scope:account,device:'11111111-1111-1111-1111-111111111111',nonce:'22222222-2222-2222-2222-222222222222',at:Date.now(),action:'hello',manifest:manifest(f.b)};
 assert.equal((await post(encryptPeer(frame,Buffer.alloc(32).toString('base64url')))).status,403);
 const body=encryptPeer(frame,code.key);assert.equal((await post(body,{Origin:'https://attacker.test'})).status,403);
 assert.equal((await post(body)).status,200);assert.equal((await post(body)).status,403);
 assert.throws(()=>peerURL('http://192.168.1.1'),/INVALID_SERVICE/);assert.throws(()=>peerURL('https://user:secret@example.com'),/INVALID_SERVICE/);
 assert.throws(()=>decryptPeer(Buffer.from('invalid'),code.key),/INVALID_RESPONSE/);
});
test('quota is latest account observation, not sum; reset observations retain original percentages',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ul-peer-quota-')),db=openHistory(root);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const q=(at,used,reset)=>({ok:true,queryOk:true,accountKey:account,observedAt:Date.parse(at),plan:'prolite',windows:[{label:'每周',minutes:10080,used,resetsAt:reset}]});
 saveSnapshot(db,q('2026-11-10T15:59:59.000Z',90,1794326400));saveSnapshot(db,q('2026-11-10T16:00:01.000Z',2,1794931200));bindLocalRecords(db,account);
 assert.equal(mergedQuota(db,account,null).windows[0].remaining,98);assert.equal(mergedQuota(db,other,null),null);
 const report=reportHistory(db,{start:'2026-11-10',end:'2026-11-11'},new Date('2026-11-11T01:00:00Z'),account);assert.ok(report.quota.every(x=>x.observedPoints>=0));
});
