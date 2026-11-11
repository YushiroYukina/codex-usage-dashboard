import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openHistory,scanHistory,saveSnapshot,reportHistory,readTurnMetadata} from '../runtime/history.mjs';
import {createLiveHistory,turnTokenUsage,turnWeeklyUsage,todayWeeklyUsage} from '../runtime/history-live.mjs';
const base=Date.parse('2026-11-09T03:00:00Z'),stamp=n=>new Date(base+n).toISOString();
const usage=n=>({input_tokens:100*n,cached_input_tokens:80*n,output_tokens:20*n,reasoning_output_tokens:5*n,total_tokens:120*n});
const line=(type,payload,ms=0)=>JSON.stringify({type,timestamp:stamp(ms),payload})+'\n';
const snap=(ms,used,extra={})=>({ok:true,queryOk:true,accountKey:'test-account',plan:'prolite',observedAt:base+ms,windows:[{minutes:10080,used,remaining:100-used,resetsAt:(base+604800000)/1000}],...extra});
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-turn-test-'));const sessions=path.join(dir,'sessions');fs.mkdirSync(sessions);return {dir,sessions,file:path.join(sessions,'a.jsonl')};}
test('completion metadata never returns answer content or embedded instructions',()=>{
 const value=readTurnMetadata(line('event_msg',{type:'task_complete',turn_id:'t',started_at:stamp(0),last_agent_message:'PRIVATE "turn_id":"bad" "error":true'}));
 assert.equal(value.payload.turn_id,'t');assert.equal(value.payload.error,false);assert.ok(!JSON.stringify(value).includes('PRIVATE'));
});
test('turn completion ledger, daily model linkage and live notices are idempotent',()=>{
 const t=setup();let clock=base;let live,db;
 try{
  fs.writeFileSync(t.file,line('session_meta',{id:'s',source:'vscode'})+line('event_msg',{type:'task_started',turn_id:'t',root_turn_id:'t'})+line('turn_context',{turn_id:'t',root_turn_id:'t',model:'model-a'}));
  db=openHistory(t.dir);saveSnapshot(db,snap(-1000,18));db.close();db=null;
  live=createLiveHistory({dataDir:t.dir},{sessions:t.sessions,now:()=>clock});assert.equal(live.tick(snap(-1000,18)).needsRefresh,true);
  clock+=5000;fs.appendFileSync(t.file,line('event_msg',{type:'token_count',info:{total_token_usage:usage(1),last_token_usage:usage(1)}},1000)+line('event_msg',{type:'token_count',info:{total_token_usage:usage(2),last_token_usage:usage(1)}},4000)+line('event_msg',{type:'task_complete',turn_id:'t',started_at:stamp(0),last_agent_message:'PRIVATE'},5000));
  db=openHistory(t.dir);saveSnapshot(db,snap(6000,19));db.close();db=null;
  clock+=3000;assert.equal(live.tick(snap(6000,19)).notified,true);
  clock+=1000;assert.equal(live.tick(snap(6000,19)).notified,false);live.close();live=null;
  db=openHistory(t.dir);assert.equal(db.prepare('SELECT count(*) AS n FROM turns').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM turn_usage').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM turn_notifications').get().n,1);
  const archived=JSON.parse(db.prepare('SELECT payload FROM turn_usage').get().payload);assert.equal(archived.usage.total,240);assert.equal(archived.weekly.observedPoints,1);assert.equal(archived.weekly.exact,false);assert.equal(archived.weekly.precision,'integer');
  const report=reportHistory(db,7,new Date(clock));assert.equal(report.sum.total,240);assert.equal(report.dailyModels['2026-11-09'][0].total,240);assert.equal(scanHistory(db,t.sessions).newEvents,0);
  assert.equal(todayWeeklyUsage(db,snap(6000,19),new Date(clock)).observedPoints,1);db.close();db=null;
  live=createLiveHistory({dataDir:t.dir},{sessions:t.sessions,now:()=>clock+2000});assert.equal(live.tick(snap(6000,19)).notified,false);
 }finally{if(live)live.close();if(db)db.close();fs.rmSync(t.dir,{recursive:true,force:true});}
});
test('overlapping turns, plan switches, reset and absent baselines do not fabricate turn quota',()=>{
 const t=setup();const db=openHistory(t.dir);
 try{
  const turn={root:'t',started:stamp(0),ended:stamp(10000),start_observed:1};
  assert.equal(turnWeeklyUsage(db,turn).observedPoints,null);
  saveSnapshot(db,snap(-1000,18));saveSnapshot(db,snap(11000,18.25));assert.equal(turnWeeklyUsage(db,turn).observedPoints,0.25);
  db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?)').run('other',stamp(5000),'2026-11-09','other',JSON.stringify({total:10}));db.prepare('INSERT INTO token_turns VALUES(?,?,?,?)').run('other','s2','other','other');assert.equal(turnWeeklyUsage(db,turn).observedPoints,null);
  db.exec('DELETE FROM token_turns;DELETE FROM tokens;DELETE FROM snapshots;');saveSnapshot(db,snap(-1000,18));saveSnapshot(db,snap(11000,1,{plan:'different'}));assert.equal(turnWeeklyUsage(db,turn).observedPoints,null);
  db.exec('DELETE FROM snapshots;');saveSnapshot(db,snap(-1000,18));saveSnapshot(db,snap(11000,1,{windows:[{minutes:10080,used:1,resetsAt:(base+1200000)/1000}]}));assert.equal(turnWeeklyUsage(db,turn).observedPoints,null);
 }finally{db.close();fs.rmSync(t.dir,{recursive:true,force:true});}
});
test('copied fork completions and internal steps retain a single main turn',()=>{
 const t=setup();const db=openHistory(t.dir);
 try{
  const events=line('event_msg',{type:'task_started',turn_id:'parent'})+line('turn_context',{turn_id:'parent',root_turn_id:'parent',model:'a'})+line('event_msg',{type:'token_count',info:{total_token_usage:usage(1),last_token_usage:usage(1)}},1000)+line('event_msg',{type:'task_started',turn_id:'internal'},2000)+line('turn_context',{turn_id:'internal',root_turn_id:'parent',model:'b'},2000)+line('event_msg',{type:'token_count',info:{total_token_usage:usage(2),last_token_usage:usage(1)}},3000)+line('event_msg',{type:'task_complete',turn_id:'internal'},4000)+line('turn_context',{turn_id:'parent',root_turn_id:'parent',model:'a'},4500)+line('event_msg',{type:'task_complete',turn_id:'parent'},5000);
  fs.writeFileSync(t.file,line('session_meta',{id:'root',source:'vscode'})+events);
  fs.writeFileSync(path.join(t.sessions,'fork.jsonl'),line('session_meta',{id:'fork',forked_from_id:'root',source:'vscode'})+events);
  scanHistory(db,t.sessions);
  const main=db.prepare('SELECT * FROM turns WHERE child=0').all();assert.equal(main.length,1);assert.equal(main[0].status,'complete');
  assert.equal(db.prepare('SELECT count(*) AS n FROM turns WHERE child=1').get().n,1);
  assert.equal(turnTokenUsage(db,main[0]).total,240);assert.equal(reportHistory(db,1,new Date(base+6000)).sum.total,240);
  assert.equal(scanHistory(db,t.sessions).newEvents,0);
 }finally{db.close();fs.rmSync(t.dir,{recursive:true,force:true});}
});
test('explicit child root links aggregate once; failed rounds do not publish completion notices',()=>{
 const t=setup();const db=openHistory(t.dir);
 try{
  fs.writeFileSync(t.file,line('session_meta',{id:'root',source:'vscode'})+line('event_msg',{type:'task_started',turn_id:'parent'})+line('turn_context',{turn_id:'parent',root_turn_id:'parent',model:'a'})+line('event_msg',{type:'token_count',info:{total_token_usage:usage(1),last_token_usage:usage(1)}},1000)+line('event_msg',{type:'task_complete',turn_id:'parent',error:'failed'},5000));
  fs.writeFileSync(path.join(t.sessions,'child.jsonl'),line('session_meta',{id:'child',source:{subagent:{}}})+line('turn_context',{turn_id:'child-turn',root_turn_id:'parent',model:'b'})+line('event_msg',{type:'token_count',info:{total_token_usage:usage(2),last_token_usage:usage(2)}},2000));
  scanHistory(db,t.sessions);const turn=db.prepare("SELECT * FROM turns WHERE session='root'").get();assert.equal(turn.status,'failed');assert.equal(turnTokenUsage(db,turn).total,360);assert.equal(db.prepare("SELECT count(*) AS n FROM turns WHERE status='complete'").get().n,0);
 }finally{db.close();fs.rmSync(t.dir,{recursive:true,force:true});}
});
