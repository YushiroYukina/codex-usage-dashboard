import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startMacServer} from '../runtime/mac-server.mjs';import {macPaths,mainAppPid} from '../runtime/mac-platform.mjs';import {tokenParts,modelParts,compact} from '../web/app.js';
test('macOS paths respect home/CODEX_HOME and process selection fails closed',()=>{
 const p=macPaths('/Users/Test Person',{CODEX_HOME:'/Volumes/Local Codex'});assert.equal(p.dataDir,path.join('/Users/Test Person','Library','Application Support','UsageLedger','state'));assert.equal(p.codexHome,'/Volumes/Local Codex');
 assert.equal(mainAppPid(' 123 /Applications/Codex.app/Contents/MacOS/Codex\n 456 /Applications/Codex.app/Contents/Frameworks/Helper'),123);
 assert.equal(mainAppPid('123 /Applications/Codex.app/Contents/MacOS/Codex\n456 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),null);
 assert.equal(mainAppPid('123 /tmp/pretend-Codex'),null);
});
test('web stacks are disjoint; model components equal measured total',()=>{
 const row={input:100,cached:80,uncached:20,output:20,reasoning:5,total:120,missing:{}};
 assert.equal(tokenParts(row).reduce((a,p)=>a+p.value,0),120);assert.equal(tokenParts(row).find(p=>p.label==='输出（非推理）').value,15);
 assert.equal(modelParts([{model:'a',total:80},{model:'b',total:40}]).reduce((a,p)=>a+p.value,0),120);assert.equal(compact(10000),'1万');assert.equal(compact(100000000),'1亿');
});
test('loopback API authentication, ranges, refresh and incremental scans',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-mac-api-'));fs.mkdirSync(path.join(dir,'sessions'));
 const at='2026-11-09T01:00:00Z';fs.writeFileSync(path.join(dir,'sessions','test.jsonl'),[
 {type:'session_meta',timestamp:at,payload:{id:'test-session'}},{type:'turn_context',timestamp:at,payload:{model:'test-model'}},{type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:20,reasoning_output_tokens:5,total_tokens:120},last_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:20,reasoning_output_tokens:5,total_tokens:120}}}}
 ].map(JSON.stringify).join('\n')+'\n');
 let reads=0;const app=await startMacServer({config:{dataDir:path.join(dir,'state'),codexHome:dir},monitor:false,hostPid:()=>null,readQuota:async()=>{reads++;return {ok:true,queryOk:true,plan:'unknown',accountKey:'synthetic',observedAt:Date.parse(at),windows:[{label:'每周',minutes:10080,used:5,remaining:95,resetsAt:Date.parse(at)/1000+604800}]}}});
 const headers={'X-Ledger-Token':app.token};
 try{
  assert.equal((await fetch(app.origin+'/api/live')).status,403);
  assert.equal((await fetch(app.origin+'/api/live',{headers:{...headers,Origin:'https://example.test'}})).status,403);
  assert.equal((await fetch(app.origin+'/api/live',{headers:{'X-Ledger-Token':'x'.repeat(64)}})).status,403);
  assert.equal((await fetch(app.origin+'/installation.json',{headers})).status,404);
  const url=app.origin+'/api/report?start=2026-11-01&end=2026-11-09&span=week';const a=await(await fetch(url,{headers})).json(),b=await(await fetch(url,{headers})).json();assert.equal(a.sum.total,120);assert.equal(b.sum.total,120);assert.equal(a.daily.length,3);
  assert.equal((await fetch(app.origin+'/api/report?start=2026-11-10&end=2026-11-09',{headers})).status,400);
  assert.equal((await fetch(app.origin+'/api/refresh',{method:'POST',headers})).status,200);assert.equal(reads,1);
  const live=await(await fetch(app.origin+'/api/live',{headers})).json();assert.equal(live.thread.session,null);assert.ok(!JSON.stringify(live).includes('synthetic'));
 }finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});
