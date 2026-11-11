import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startMacServer} from '../runtime/desktop-server.mjs';

test('single-device entry points keep local reports and reject every sync route with stale pairing settings',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-single-'));
 fs.mkdirSync(path.join(root,'sessions'));
 const scope='a'.repeat(64);
 fs.writeFileSync(path.join(root,'status.json'),JSON.stringify({accountKey:scope,accountVerified:true,observedAt:Date.now()}));
 fs.writeFileSync(path.join(root,'account-sync.json'),JSON.stringify({enabled:true,service:'https://invalid.example'}));
 fs.writeFileSync(path.join(root,'paired-device.json'),JSON.stringify({role:'host'}));
 let refreshed=0;
 const app=await startMacServer({config:{dataDir:root,codexHome:root,syncRoot:path.join(root,'sync'),accountSync:true,syncMode:'single'},monitor:false,hostPid:()=>null,tunnelFactory:()=>{throw Error('single mode constructed a tunnel');},accountOptions:{secrets:{read:()=>{throw Error('single mode read a sync credential');}}},readQuota:async()=>{refreshed++;return {ok:true,queryOk:true,accountKey:scope,observedAt:Date.now(),windows:[]};}});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const headers={'X-Ledger-Token':app.token,'Content-Type':'application/json'};
 for(const action of ['peer-host','peer-join','peer-sync','peer-disconnect','pair','join','sync','folder','account-configure','account-login','account-poll','account-logout','account-sync','ledger-import']){
  const r=await fetch(app.origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({action})});assert.equal(r.status,403,action);
 }
 assert.equal(refreshed,0);
 const settings=await fetch(app.origin+'/api/settings',{headers}).then(r=>r.json());assert.equal(settings.syncMode,'single');assert.equal(settings.peerSync.state,'single_device');
 assert.equal((await fetch(app.origin+'/api/refresh',{method:'POST',headers})).status,200);assert.equal(refreshed,1);
 const report=await fetch(app.origin+'/api/report?days=7',{headers}).then(r=>r.json());assert.equal(report.accountVerified,true);assert.equal(report.daily.length,7);
 assert.ok(!fs.existsSync(path.join(root,'credentials-dpapi')));assert.ok(!fs.existsSync(path.join(root,'sync')));
});
