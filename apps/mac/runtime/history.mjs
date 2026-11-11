import {ensureSupplementSchema,nativeReport} from './sync-store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const keys=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const beijingDay=t=>new Date(new Date(t).getTime()+28800000).toISOString().slice(0,10);
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const clean=o=>o&&Object.fromEntries(keys.filter(k=>valid(o[k])).map(k=>[k,o[k]]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function usageDelta(previous,total,last){
  if(!total || !valid(total.input_tokens)||!valid(total.output_tokens))return {issue:'missing_cumulative'};
  if(previous && same(previous,total))return {duplicate:true};
  if(!previous){
    if(last && valid(last.input_tokens)&&valid(last.output_tokens))return {usage:last,issue:same(last,total)?null:'initial_baseline_gap'};
    return {issue:'initial_baseline_missing'};
  }
  const delta=Object.fromEntries(keys.filter(k=>valid(total[k])&&valid(previous[k])).map(k=>[k,total[k]-previous[k]]));
  if(Object.values(delta).some(n=>n<0))return {issue:'counter_reset_baseline'};
  if(!valid(delta.input_tokens)||!valid(delta.output_tokens))return {issue:'incomplete_delta'};
  return {usage:delta,issue:last&&!same(delta,last)?'cumulative_interval_model_uncertain':null};
}
export function normalizeTokens(u){
  const input=u.input_tokens,rawOutput=u.output_tokens,reason=u.reasoning_output_tokens??null;
  let output=rawOutput,semantics='unknown';
  if(valid(u.total_tokens)&&u.total_tokens===input+rawOutput)semantics='reasoning_in_output';
  else if(reason!==null&&u.total_tokens===input+rawOutput+reason){output+=reason;semantics='reasoning_added_to_output';}
  const cached=valid(u.cached_input_tokens)&&u.cached_input_tokens<=input?u.cached_input_tokens:null;
  return {input,cached,uncached:cached===null?null:input-cached,cacheWrite:u.cache_write_input_tokens??null,output:semantics==='unknown'?null:output,reasoning:reason,total:u.total_tokens??(input+output),semantics};
}
export function openHistory(dataDir){
  fs.mkdirSync(dataDir,{recursive:true});
  const db=new DatabaseSync(path.join(dataDir,'usage-history.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,offset INTEGER,state TEXT,size INTEGER,mtime REAL);
    CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,at TEXT,day TEXT,model TEXT,usage TEXT);
    CREATE INDEX IF NOT EXISTS tokens_day ON tokens(day);
    CREATE INDEX IF NOT EXISTS tokens_at ON tokens(at);
    CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY,at TEXT,kind TEXT);
    CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,at TEXT,day TEXT,source TEXT,scope TEXT,plan TEXT,window TEXT,minutes REAL,used REAL,reset REAL);
    CREATE INDEX IF NOT EXISTS snapshots_day ON snapshots(day);
    CREATE TABLE IF NOT EXISTS history_schema(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,session TEXT,turn TEXT,root TEXT,started TEXT,ended TEXT,status TEXT,child INTEGER,start_observed INTEGER);
    CREATE INDEX IF NOT EXISTS turns_root ON turns(root);
    CREATE INDEX IF NOT EXISTS turns_ended ON turns(ended);
    CREATE TABLE IF NOT EXISTS token_turns(token TEXT PRIMARY KEY,session TEXT,turn TEXT,root TEXT);
    CREATE INDEX IF NOT EXISTS token_turns_root ON token_turns(root);
    CREATE TABLE IF NOT EXISTS turn_notifications(id TEXT PRIMARY KEY,at TEXT,payload TEXT);
    CREATE TABLE IF NOT EXISTS live_meta(key TEXT PRIMARY KEY,value TEXT);`);
  db.exec('BEGIN IMMEDIATE');
  try{if(!db.prepare("SELECT value FROM history_schema WHERE key='turns-v2'").get()){
    // Replay metadata only; retain token IDs, original quantities and all quota snapshots.
    if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turn_usage'").get())db.exec('DELETE FROM turn_usage');
    db.exec("UPDATE files SET offset=0,state='{}',size=-1; DELETE FROM turns; DELETE FROM token_turns; DELETE FROM turn_notifications; INSERT INTO history_schema VALUES('turns-v2','1');");
  }db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');db.close();throw e;}
  ensureSupplementSchema(db);
  return db;
}
function issue(db,id,at,kind){db.prepare('INSERT OR IGNORE INTO issues VALUES(?,?,?)').run(hash([id,kind]),at,kind);}
export function saveSnapshot(db,r,source='live',scopeOverride){
  if(source==='live'&&(!r.ok||!r.queryOk||r.accountVerified===false))return;
  const date=new Date(r.observedAt);if(!Number.isFinite(date.getTime()))return;
  const at=date.toISOString(),scope=scopeOverride??r.accountKey??'live-account-unknown';
  for(const w of r.windows??[]){
    if(typeof w.used!=='number'||w.used<0||w.used>100)continue;
    const window=String(w.kind??w.minutes??w.label??'unknown'),reset=Number.isFinite(w.resetsAt)?w.resetsAt:null;
    const id=hash([at,scope,r.plan??'unknown',window,w.used,reset]);
    db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,at,beijingDay(at),source,scope,r.plan??'unknown',window,w.minutes??null,w.used,reset);
  }
}
// Completion records may embed the final answer. Extract only the scalar metadata
// fields without JSON-parsing or retaining last_agent_message/chat contents.
export function readTurnMetadata(line){
  const text=Buffer.isBuffer(line)?line.toString('utf8'):line;
  const scalar=key=>{const m=text.match(new RegExp('"'+key+'"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|null|true|false)'));if(!m)return undefined;try{return JSON.parse(m[1]);}catch{return undefined;}};
  const match=text.slice(0,220).match(/"payload"\s*:\s*\{\s*"type"\s*:\s*"(task_started|task_complete|turn_complete|turn_aborted)"/);
  if(!match)return null;
  const payload={type:match[1]};for(const key of ['turn_id','root_turn_id','started_at','completed_at','status']){const v=scalar(key);if(v!==undefined)payload[key]=v;}
  payload.error= /"error"\s*:\s*(?!null\b|false\b)[^\s]/.test(text);
  return {type:'event_msg',timestamp:scalar('timestamp'),payload};
}
function rememberTurn(db,state,p,at){
  const turn=p.turn_id??state.turn;if(!state.sid||typeof turn!=='string'||turn.length>256)return;
  state.turn=turn;state.rootTurn=p.root_turn_id??state.rootTurn??turn;
  const ending=['task_complete','turn_complete','turn_aborted'].includes(p.type);
  const provided=typeof p.started_at==='string'&&Number.isFinite(Date.parse(p.started_at))?new Date(p.started_at).toISOString():null;
  const started=provided??(!ending?at:null),observed=p.type==='task_started'||provided?1:0;
  const status=ending?(p.type==='turn_aborted'?'aborted':p.error||['failed','cancelled','canceled','aborted','interrupted'].includes(p.status)?'failed':'complete'):'running';
  db.prepare(`INSERT INTO turns VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    root=excluded.root,started=CASE WHEN turns.start_observed=0 AND excluded.start_observed=1 THEN excluded.started ELSE COALESCE(turns.started,excluded.started) END,
    ended=COALESCE(excluded.ended,turns.ended),status=CASE WHEN excluded.ended IS NOT NULL THEN excluded.status ELSE turns.status END,
    child=excluded.child,start_observed=MAX(turns.start_observed,excluded.start_observed)`).run(hash(turn),state.sid,turn,state.rootTurn,started,ending?at:null,status,(state.child||turn!==state.rootTurn)?1:0,observed);
}
function* filesUnder(root){if(!fs.existsSync(root))return;for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isDirectory())yield* filesUnder(p);else if(e.isFile()&&e.name.endsWith('.jsonl'))yield p;}}
export function scanHistory(db,root=path.join(os.homedir(),'.codex','sessions')){
  const stats={files:0,changed:0,bytes:0,newEvents:0};
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const file of filesUnder(root)){
      stats.files++;const stat=fs.statSync(file),saved=db.prepare('SELECT * FROM files WHERE path=?').get(file);
      if(saved&&saved.size===stat.size&&saved.mtime===stat.mtimeMs)continue;
      stats.changed++;
      let offset=saved?.offset??0,state=saved?JSON.parse(saved.state):{};
      if(stat.size<offset || (saved&&stat.size===saved.size&&stat.mtimeMs!==saved.mtime)){offset=0;state={};}
      const fd=fs.openSync(file,'r');let pending=Buffer.alloc(0),readAt=offset,committed=offset;
      try{
        const chunk=Buffer.alloc(1024*1024);
        while(readAt<stat.size){
          const n=fs.readSync(fd,chunk,0,Math.min(chunk.length,stat.size-readAt),readAt);if(!n)break;
          stats.bytes+=n;readAt+=n;pending=Buffer.concat([pending,chunk.subarray(0,n)]);
          let start=0,end;
          while((end=pending.indexOf(10,start))>=0){
            const line=pending.subarray(start,end);committed+=end-start+1;start=end+1;
            // Never decode or persist response/chat bodies. Only metadata record kinds enter JSON parsing.
            const prefix=line.subarray(0,180).toString('utf8');
            if(!/"type"\s*:\s*"(?:session_meta|turn_context|event_msg)"/.test(prefix))continue;
            if(prefix.includes('event_msg')&&!/"(?:token_count|task_started|task_complete|turn_complete|turn_aborted)"/.test(prefix))continue;
            let e;try{e=prefix.includes('event_msg')&&!prefix.includes('token_count')?readTurnMetadata(line):JSON.parse(line);if(!e)continue;}catch{issue(db,[file,committed],null,'malformed_metadata');continue;}
            const p=e.payload??{};
            if(e.type==='session_meta'){
              const sid=p.id??p.session_id;
              if(state.sid&&sid!==state.sid){state.total=null;state.model='未知';state.turn=null;state.rootTurn=null;}
              state.child=p.source==='subagent'||Boolean(p.source?.subagent);state.sid=sid;state.fork=p.forked_from_id??null;state.metaAt=e.timestamp;continue;
            }
            if(e.type==='turn_context'){state.model=typeof p.model==='string'?p.model:'未知';
              if(p.turn_id){state.turn=p.turn_id;state.rootTurn=p.root_turn_id??p.turn_id;if(Number.isFinite(Date.parse(e.timestamp)))rememberTurn(db,state,{turn_id:p.turn_id,root_turn_id:state.rootTurn,type:'context'},new Date(e.timestamp).toISOString());}continue;}
            if(e.type==='event_msg'&&['task_started','task_complete','turn_complete','turn_aborted'].includes(p.type)&&Number.isFinite(Date.parse(e.timestamp))){
              if(p.type==='task_started'){state.turn=p.turn_id;state.rootTurn=p.root_turn_id??p.turn_id;}
              rememberTurn(db,state,p,new Date(e.timestamp).toISOString());continue;
            }
            if(e.type!=='event_msg'||p.type!=='token_count'||!Number.isFinite(Date.parse(e.timestamp)))continue;
            const at=new Date(e.timestamp).toISOString(),info=p.info??{},total=clean(info.total_token_usage),last=clean(info.last_token_usage);
            const id=hash([at,total,last]);
            const limits=p.rate_limits;
            if(limits){saveSnapshot(db,{observedAt:at,plan:limits.plan_type,windows:['primary','secondary'].flatMap(k=>{const w=limits[k];return w?[{minutes:w.window_minutes,used:w.used_percent,resetsAt:w.resets_at}]:[];})},'log','historical-account-unverified');}
            const result=(!total&&!last)?{duplicate:true}:usageDelta(state.total,total,last);
            // Copied branch history is globally deduplicated by timestamp and exact usage payload.
            // The first inherited cumulative value is never charged in full.
            if(result.usage){
              const usage=normalizeTokens(result.usage);usage.lastUsageIncludesReasoning=typeof info.last_usage_includes_reasoning==='boolean'?info.last_usage_includes_reasoning:null;
              const model=result.issue==='cumulative_interval_model_uncertain'?'未知':state.model??'未知';
              const inserted=db.prepare('INSERT OR IGNORE INTO tokens VALUES(?,?,?,?,?)').run(id,at,beijingDay(at),model,JSON.stringify(usage));
              stats.newEvents+=Number(inserted.changes);
              if(state.sid&&state.turn)db.prepare('INSERT OR IGNORE INTO token_turns VALUES(?,?,?,?)').run(id,state.sid,state.turn,state.rootTurn??state.turn);
              if(usage.semantics==='unknown')issue(db,id,at,'output_semantics_unknown');
            }
            if(result.issue)issue(db,id,at,result.issue);
            if(total&&valid(total.input_tokens)&&valid(total.output_tokens))state.total=total;
          }
          pending=pending.subarray(start);
        }
      }finally{fs.closeSync(fd);}
      db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)').run(file,committed,JSON.stringify(state),stat.size,stat.mtimeMs);
    }
    db.exec('COMMIT');return stats;
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function quotaIntervals(rows){
  const prev=new Map(),high=new Map(),result=[];
  for(const r of rows){
    const key=JSON.stringify([r.scope,r.window]),p=prev.get(key);prev.set(key,r);
    let reason=null,points=null;
    if(!p)reason='缺少前次读数';
    else if(p.plan!==r.plan)reason='套餐变更';
    else if(p.reset!==r.reset)reason='窗口重置或重置时间变更';
    else if(r.reset===null||Date.parse(r.at)>=r.reset*1000)reason='重置时间缺失或读数过期';
    else if(r.used<p.used)reason='读数回退：可能人工重置或延迟';
    else if(p.day!==r.day)reason='跨北京时间零点，无法分配每日差值';
    else if(high.has(key)&&r.used<high.get(key))reason='回退后的读数仍低于此前高点，差值待核实';
    else {points=r.used-Math.max(p.used,high.get(key)??p.used);reason='同日采样差值，非完整日消耗；可能存在取整和读数延迟';}
    if(!p||p.plan!==r.plan||p.reset!==r.reset)high.set(key,r.used);else high.set(key,Math.max(high.get(key)??0,r.used));
    result.push({...r,from:p?.at??null,points,reason});
  }
  return result;
}
// Temporal association only, never a Token-to-quota conversion or exact billing attribution.
export function quotaModelShares(db,intervals){
  const result=new Map();
  const query=db.prepare('SELECT DISTINCT model FROM tokens WHERE at>? AND at<=?');
  for(const r of intervals){
    const key=JSON.stringify([r.day,r.scope,r.plan,r.window]);
    if(!result.has(key))result.set(key,{day:r.day,scope:r.scope,source:r.source,plan:r.plan,window:r.window,minutes:r.minutes,total:0,gaps:0,comparableIntervals:0,models:{}});
    const group=result.get(key);
    if(r.points===null){group.gaps++;continue;}
    group.comparableIntervals++;
    if(r.points<=0)continue;
    let model='未归属';
    if(r.from&&Date.parse(r.at)-Date.parse(r.from)<=120000){
      const found=query.all(r.from,r.at);
      if(found.length===1&&found[0].model!=='未知')model=found[0].model;
    }
    group.total+=r.points;group.models[model]=(group.models[model]??0)+r.points;
  }
  return [...result.values()].map(g=>({...g,models:Object.entries(g.models).map(([model,points])=>({model,points}))}));
}
export function reportHistory(db,days=7,now=new Date(),scope=undefined){
  let today,start;
  if(typeof days==='object'){
    ({start,end:today}=days);
    for(const value of [start,today])if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new Error('Invalid date range');
    days=Math.round((Date.parse(today)-Date.parse(start))/86400000)+1;
    if(days<1||days>3660)throw new Error('Date range must contain 1 to 3660 days');
  }else{
    if(![1,7,30].includes(days))throw new Error('days must be 1, 7 or 30');
    today=beijingDay(now);start=beijingDay(new Date(new Date(today+'T00:00:00+08:00').getTime()-(days-1)*86400000));
  }
  const columns=['input','cached','uncached','cacheWrite','output','reasoning','total'];
  const empty=()=>({...Object.fromEntries(columns.map(k=>[k,0])),missing:{},events:0});
  const sum=empty(),daily=new Map(),models=new Map(),dayModels=new Map();
  for(let i=0;i<days;i++){const d=beijingDay(new Date(new Date(start+'T00:00:00+08:00').getTime()+i*86400000));daily.set(d,empty());}
  const tokenRows=scope===undefined?db.prepare('SELECT * FROM tokens WHERE day>=? AND day<=? ORDER BY at,id').all(start,today):scope?db.prepare('SELECT t.* FROM tokens t JOIN sync_token_scopes s ON s.token=t.id WHERE s.scope=? AND t.day>=? AND t.day<=? ORDER BY t.at,t.id').all(scope,start,today):[];
  for(const r of tokenRows){
    const u=JSON.parse(r.usage);if(!models.has(r.model))models.set(r.model,empty());
    if(!dayModels.has(r.day))dayModels.set(r.day,new Map());const dm=dayModels.get(r.day);if(!dm.has(r.model))dm.set(r.model,empty());
    for(const target of [sum,daily.get(r.day),models.get(r.model),dm.get(r.model)]){target.events++;for(const k of columns){if(u[k]===null){target.missing[k]=(target.missing[k]??0)+1;}else target[k]+=u[k];}}
  }
  const snapshotRows=scope===undefined?db.prepare('SELECT * FROM snapshots ORDER BY at,id').all():scope?db.prepare('SELECT t.* FROM snapshots t JOIN account_snapshot_scopes s ON s.id=t.id WHERE s.scope=? ORDER BY t.at,t.id').all(scope):[];
  const intervals=quotaIntervals(snapshotRows).filter(r=>r.day>=start&&r.day<=today);
  const quota=new Map();
  for(const r of intervals){const key=JSON.stringify([r.day,r.scope,r.plan,r.window]);if(!quota.has(key))quota.set(key,{day:r.day,source:r.source,scope:r.scope,plan:r.plan,window:r.window,minutes:r.minutes,observedPoints:0,comparableIntervals:0,gaps:0,notes:[],remaining:null,reset:null});const q=quota.get(key);if(r.points!==null){q.observedPoints+=r.points;q.comparableIntervals++;}else {q.gaps++;if(!q.notes.includes(r.reason))q.notes.push(r.reason);}q.remaining=100-r.used;q.reset=r.reset;q.lastAt=r.at;}
  return {nativeUsage:nativeReport(db,scope===undefined?db.prepare("SELECT value FROM sync_meta WHERE key='current_scope'").get()?.value:scope),syncDevices:db.prepare('SELECT label,platform,last_seen AS lastSeen FROM sync_devices').all(),days,start,today,timeZone:'Asia/Shanghai',coverage:'本机及已配对设备提供的 sessions 用量；导入按事件去重。原生账号汇总单列，不与本地记录相加；不代表全部云端任务或普通 Chat。',sum,daily:[...daily].map(([day,u])=>({day,...u})),models:[...models].map(([model,u])=>({model,...u})),dailyModels:Object.fromEntries([...dayModels].map(([day,ms])=>[day,[...ms].map(([model,u])=>({model,...u}))])),quota:[...quota.values()],quotaModels:quotaModelShares(db,intervals),issues:db.prepare('SELECT kind,count(*) AS count FROM issues WHERE at>=? AND at<? GROUP BY kind').all(new Date(start+'T00:00:00+08:00').toISOString(),new Date(new Date(today+'T00:00:00+08:00').getTime()+86400000).toISOString()),history:scope===undefined?db.prepare('SELECT min(day) AS firstDay,max(day) AS lastDay,count(*) AS events FROM tokens').get():{firstDay:tokenRows[0]?.day??null,lastDay:tokenRows.at(-1)?.day??null,events:tokenRows.length},snapshotCount:snapshotRows.length,notes:['输入包含缓存输入；未缓存输入=输入−缓存输入。','输出按 total_tokens 校验：必要时包含推理输出；推理单列展示，不再次累加。','缺字段为未知，不等于零；无记录日代表无本机记录。','额度是采样百分点变化，不换算 Token；所有每日额度均非完整日账单。历史账户身份无法核实，与当前账户快照隔离。']};
}
