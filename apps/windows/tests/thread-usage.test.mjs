import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {routeMetadata,readActiveSession,recentThreadUsage,selectedSession} from '../runtime/thread-usage.mjs';import {openHistory} from '../runtime/history.mjs';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const line=(route,t=0)=>`2026-11-09T04:00:0${t}.000Z info [electron-message-handler] IAB_LIFECYCLE received browser sidebar owner sync conversationId=unrelated ownerRoutePath=${route} windowId=2\n`;
test('route follows viewed thread, clears non-work pages and rejects ambiguous windows',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-route-'));try{
  const file=path.join(dir,'codex-desktop-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-123-t0-i1-000000-0.log'),state=path.join(dir,'cursor.json');
  fs.writeFileSync(file,line('/local/'+a));assert.equal(readActiveSession(dir,123,state),a);assert.equal(readActiveSession(dir,123,state),a);
  fs.appendFileSync(file,line('/local/'+b,1));assert.equal(readActiveSession(dir,123,state),b);
  fs.appendFileSync(file,line('/c/'+a,2));assert.equal(readActiveSession(dir,123,state),null);
  assert.equal(routeMetadata('random conversationId='+a),null);assert.equal(selectedSession({1:{session:a},2:{session:b}}),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('recent usage is isolated to current session and limited to completed main turns',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-thread-')),db=openHistory(dir);try{
  for(let i=0;i<8;i++)db.prepare('INSERT INTO turns VALUES(?,?,?,?,?,?,?,?,?)').run('t'+i,i===7?b:a,'t'+i,'t'+i,'2026-11-09T01:00:00Z','2026-11-09T02:00:0'+i+'Z','complete',0,1);
  assert.equal(recentThreadUsage(db,a).rows.length,5);assert.equal(recentThreadUsage(db,b).rows.length,1);assert.equal(recentThreadUsage(db,null).rows.length,0);
  assert.ok(recentThreadUsage(db,a).rows.every(row=>row.id!=='t7'));
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}
});
