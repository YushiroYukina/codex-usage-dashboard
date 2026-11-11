import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {gzipSync} from 'node:zlib';
import {openHistory} from '../runtime/history.mjs';import {bindLocalRecords,digest,exportAccountBundle,ledgerManifest} from '../runtime/account-ledger.mjs';import {encodeLedger,decodeLedger,writeLedger,mergeLedgerFile} from '../runtime/portable-ledger.mjs';
const scope='a'.repeat(64);
test('portable bidirectional union: 100+50-20=130; retry, offline refill, scope isolation, corrupt file and atomic conflicts',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ul-files-')),a=openHistory(path.join(root,'mac')),b=openHistory(path.join(root,'windows'));
 const seed=(db,id,n)=>{db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?)').run(digest(id),'2026-11-10T00:00:00.000Z','2026-11-10','model',JSON.stringify({input:n,cached:0,uncached:n,cacheWrite:null,output:0,reasoning:0,total:n}));bindLocalRecords(db,scope);};
 const sum=db=>exportAccountBundle(db,scope).tokens.reduce((n,r)=>n+r.usage.total,0),file=path.join(root,'transfer.ulledger');
 try{
  seed(a,'shared',20);seed(b,'shared',20);seed(a,'mac',80);seed(b,'win',30);
  writeLedger(file,b,scope);mergeLedgerFile(file,a,scope);writeLedger(file,a,scope);mergeLedgerFile(file,b,scope);assert.equal(sum(a),130);assert.equal(sum(b),130);
  for(let i=0;i<3;i++)mergeLedgerFile(file,b,scope);assert.equal(sum(b),130);
  seed(a,'offline-mac',7);seed(b,'offline-win',11);writeLedger(file,b,scope);mergeLedgerFile(file,a,scope);writeLedger(file,a,scope);mergeLedgerFile(file,b,scope);assert.equal(sum(a),148);assert.equal(sum(b),148);assert.deepEqual(ledgerManifest(exportAccountBundle(a,scope)),ledgerManifest(exportAccountBundle(b,scope)));
  assert.throws(()=>decodeLedger(encodeLedger(a,scope).bytes,'b'.repeat(64)),/ACCOUNT_MISMATCH/);assert.throws(()=>decodeLedger(Buffer.from('bad'),scope),/INVALID_FILE/);
  const original=ledgerManifest(exportAccountBundle(b,scope));const bundle=exportAccountBundle(a,scope);bundle.tokens.push({...bundle.tokens[0],id:'0'.repeat(64)});bundle.tokens[0].usage.input++;bundle.tokens[0].usage.total++;
  fs.writeFileSync(file,gzipSync(JSON.stringify({format:'UsageLedger-file-v2',bundle,manifest:ledgerManifest(bundle)})));assert.throws(()=>mergeLedgerFile(file,b,scope),/RECORD_CONFLICT/);assert.deepEqual(ledgerManifest(exportAccountBundle(b,scope)),original);
  writeLedger(file,a,scope);assert.throws(()=>mergeLedgerFile(file,b,scope,{scopeProvider:()=>null}),/ACCOUNT_CHANGED/);
 }finally{a.close();b.close();fs.rmSync(root,{recursive:true,force:true});}
});
