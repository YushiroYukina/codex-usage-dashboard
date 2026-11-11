import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openHistory,scanHistory,reportHistory,usageDelta,normalizeTokens,beijingDay,quotaIntervals,saveSnapshot} from '../runtime/history.mjs';
const u=n=>({input_tokens:10*n,cached_input_tokens:4*n,cache_write_input_tokens:0,output_tokens:2*n,reasoning_output_tokens:n,total_tokens:12*n});
const event=(at,total,last)=>({timestamp:at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:total,last_token_usage:last,last_usage_includes_reasoning:true}}});
const at='2026-11-08T15:59:59Z',after='2026-11-08T16:00:01Z';
test('Beijing midnight and inclusive/exclusive reasoning',()=>{
 assert.equal(beijingDay(at),'2026-11-08');assert.equal(beijingDay(after),'2026-11-09');
 assert.equal(normalizeTokens(u(1)).output,2);
 assert.equal(normalizeTokens({...u(1),total_tokens:13}).output,3);
 assert.equal(normalizeTokens(u(1)).uncached,6);
 assert.equal(normalizeTokens({input_tokens:10,output_tokens:2,total_tokens:12}).cached,null);
});
test('cumulative duplicate, rollback, missing total and first inherited baseline',()=>{
 assert.deepEqual(usageDelta(u(1),u(2),u(1)).usage,u(1));
 assert.equal(usageDelta(u(2),u(2),u(1)).duplicate,true);
 assert.equal(usageDelta(u(2),u(1),u(1)).usage,undefined);
 assert.equal(usageDelta(u(2),null,u(1)).usage,undefined);
 assert.deepEqual(usageDelta(null,u(100),u(1)).usage,u(1));
});
test('incremental scan, copied branch, partial append, restart, missing fields, midnight',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-history-test-'));const sessions=path.join(temp,'sessions');fs.mkdirSync(sessions);
 let db=openHistory(temp);
 try{
  const meta={timestamp:at,type:'session_meta',payload:{id:'original'}};
  const model={timestamp:at,type:'turn_context',payload:{model:'test-model'}};
  const first=[meta,model,event(at,u(1),u(1)),event(at,u(1),u(1))];
  const file=path.join(sessions,'a.jsonl');fs.writeFileSync(file,first.map(JSON.stringify).join('\n')+'\n');
  assert.equal(scanHistory(db,sessions).newEvents,1);assert.equal(scanHistory(db,sessions).bytes,0);
  fs.writeFileSync(path.join(sessions,'branch.jsonl'),first.map(JSON.stringify).join('\n')+'\n'+JSON.stringify({type:'session_meta',payload:{id:'branch',forked_from_id:'original'}})+'\n');
  assert.equal(scanHistory(db,sessions).newEvents,0);
  const next=JSON.stringify(event(after,u(2),u(1)));fs.appendFileSync(file,next.slice(0,40));
  assert.equal(scanHistory(db,sessions).newEvents,0);
  db.close();db=openHistory(temp);fs.appendFileSync(file,next.slice(40)+'\n');assert.equal(scanHistory(db,sessions).newEvents,1);
  const report=reportHistory(db,7,new Date(after));assert.equal(report.sum.total,24);assert.equal(report.daily.at(-1).total,12);assert.equal(report.models[0].model,'test-model');
  assert.equal(scanHistory(db,sessions).bytes,0);
 }finally{db.close();fs.rmSync(temp,{recursive:true,force:true});}
});
test('quota reset, rollback, plan change, cross-day and duplicate snapshots',()=>{
 const base={scope:'account',window:'10080',plan:'prolite',reset:1794605159,source:'live'};
 const rows=[{...base,at,day:'2026-11-08',used:10},{...base,at:after,day:'2026-11-09',used:12},{...base,at:'2026-11-09T02:00:00Z',day:'2026-11-09',used:14},{...base,at:'2026-11-09T02:01:00Z',day:'2026-11-09',used:2},{...base,at:'2026-11-09T02:02:00Z',day:'2026-11-09',used:3,reset:1794606000},{...base,at:'2026-11-09T02:03:00Z',day:'2026-11-09',used:5,plan:'other',reset:1794606000}];
 const r=quotaIntervals(rows);assert.deepEqual(r.map(x=>x.points),[null,null,2,null,null,null]);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-history-test-'));const db=openHistory(temp);
 try{const snap={ok:true,queryOk:true,observedAt:after,plan:'prolite',windows:[{minutes:10080,used:17,resetsAt:1794605159}]};saveSnapshot(db,snap);saveSnapshot(db,snap);assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get().n,1);}finally{db.close();fs.rmSync(temp,{recursive:true,force:true});}
});
