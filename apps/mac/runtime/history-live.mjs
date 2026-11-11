import {ensureAccountSchema,bindLocalRecords} from './account-ledger.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {openHistory,scanHistory,reportHistory,beijingDay,quotaIntervals} from './history.mjs';

function writeJson(file,value){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);}
export function turnTokenUsage(db,turn,scope=undefined){
  const sum={input:0,cached:0,uncached:0,output:0,reasoning:0,total:0,events:0,missing:{}};
  const models=new Map();
  const rows=scope===undefined?db.prepare(`SELECT t.model,t.usage FROM tokens t JOIN token_turns a ON a.token=t.id WHERE a.root=?`).all(turn.root):scope?db.prepare(`SELECT t.model,t.usage FROM tokens t JOIN token_turns a ON a.token=t.id JOIN sync_token_scopes s ON s.token=t.id WHERE a.root=? AND s.scope=?`).all(turn.root,scope):[];
  for(const row of rows){const u=JSON.parse(row.usage);sum.events++;models.set(row.model,(models.get(row.model)??0)+(u.total??0));
    for(const k of ['input','cached','uncached','output','reasoning','total']){if(u[k]===null||u[k]===undefined)sum.missing[k]=(sum.missing[k]??0)+1;else sum[k]+=u[k];}}
  return {...sum,models:[...models].map(([model,total])=>({model,total})),coverage:'按明确 root_turn_id 汇总本机用量；不推测未关联的子任务'};
}
export function turnWeeklyUsage(db,turn,scope=undefined){
  const unknown=reason=>({observedPoints:null,reason,exact:false,precision:'unknown'});
  if(scope===null)return unknown('当前账号尚未核实');
  if(!turn.started||!turn.ended||!turn.start_observed)return unknown('缺少已确认的轮次起止时间');
  const before=scope===undefined?db.prepare("SELECT * FROM snapshots WHERE source='live' AND minutes=10080 AND at<=? ORDER BY at DESC LIMIT 1").get(turn.started):db.prepare("SELECT * FROM snapshots WHERE source='live' AND minutes=10080 AND scope=? AND at<=? ORDER BY at DESC LIMIT 1").get(scope,turn.started);
  const after=scope===undefined?db.prepare("SELECT * FROM snapshots WHERE source='live' AND minutes=10080 AND at>=? ORDER BY at LIMIT 1").get(turn.ended):db.prepare("SELECT * FROM snapshots WHERE source='live' AND minutes=10080 AND scope=? AND at>=? ORDER BY at LIMIT 1").get(scope,turn.ended);
  if(!before||!after)return unknown('缺少轮次前后实际额度读数');
  if(Date.parse(turn.started)-Date.parse(before.at)>120000||Date.parse(after.at)-Date.parse(turn.ended)>120000)return unknown('前后采样离轮次边界过远');
  if(before.scope!==after.scope||before.scope==='live-account-unknown')return unknown('账户发生变化或无法核实');
  if(before.plan!==after.plan)return unknown('轮次期间套餐变更');
  if(before.reset!==after.reset||!after.reset||Date.parse(after.at)>=after.reset*1000)return unknown('轮次跨额度重置或读数过期');
  if(after.used<before.used)return unknown('额度读数回退，可能重置或延迟');
  const overlap=db.prepare(`SELECT count(DISTINCT a.root) AS n FROM tokens t JOIN token_turns a ON a.token=t.id
    WHERE t.at>=? AND t.at<=? AND a.root<>?`).get(before.at,after.at,turn.root).n;
  if(overlap>0)return unknown('采样区间有其他轮次用量，无法单独归因');
  const integer=Number.isInteger(before.used)&&Number.isInteger(after.used);
  return {observedPoints:Math.round((after.used-before.used)*1e8)/1e8,exact:false,precision:integer?'integer':'fractional',
    from:before.at,to:after.at,reason:integer?'接口为整数采样；两位小数仅为显示，非单轮精确消耗。零差值不代表零消耗。':'账户采样差值；可能含读数延迟或其他设备用量，不保证单轮精确归因。'};
}
export function todayWeeklyUsage(db,current,now=new Date()){
  const day=beijingDay(now),scope=current?.accountKey;
  if(!scope)return {observedPoints:null,exact:false,reason:'当前账户身份未确认'};
  const rows=db.prepare("SELECT * FROM snapshots WHERE source='live' AND minutes=10080 AND scope=? ORDER BY at,id").all(scope);
  const intervals=quotaIntervals(rows).filter(r=>r.day===day&&r.plan===(current.plan??'unknown'));
  const comparable=intervals.filter(r=>r.points!==null),gaps=intervals.filter(r=>r.points===null);
  return {observedPoints:comparable.length?Math.round(comparable.reduce((a,r)=>a+r.points,0)*1e8)/1e8:null,
    exact:false,precision:intervals.every(r=>Number.isInteger(r.used))?'integer':'fractional',gaps:gaps.length,
    reason:'今日已观测的周额度变化，非完整日消耗；接口可能取整或延迟。'+[...new Set(gaps.map(r=>r.reason))].join('；')};
}
export function createLiveHistory(config,{now=()=>Date.now(),sessions=path.join(config.codexHome??path.join(os.homedir(),'.codex'),'sessions')}={}){
  const db=openHistory(config.dataDir);if(config.accountSync)ensureAccountSchema(db);
  db.exec('CREATE TABLE IF NOT EXISTS turn_usage(id TEXT PRIMARY KEY,at TEXT,payload TEXT);');
  const saved=Number(db.prepare("SELECT value FROM live_meta WHERE key='last_tick'").get()?.value);
  const since=Math.max(now()-120000,Number.isFinite(saved)&&saved>0?saved:now());
  let lastTick=0,lastSummary=0,lastObserved=null,lastDay=null;
  const discovered=new Set();
  return {
    tick(current){
      const time=now();if(time-lastTick<1000)return {needsRefresh:false};lastTick=time;
      const scan=scanHistory(db,sessions);const scope=config.accountSync?(current?.ok&&current?.queryOk&&/^[a-f0-9]{64}$/.test(current?.accountKey??'')?current.accountKey:null):undefined;if(scope)bindLocalRecords(db,scope);const owns=turn=>scope===undefined||!!(scope&&db.prepare('SELECT 1 FROM account_turn_scopes WHERE id=? AND scope=?').get(turn.id,scope));let needsRefresh=false,notified=false;
      const recent=db.prepare('SELECT * FROM turns WHERE child=0 AND (started>=? OR ended>=?) ORDER BY ended').all(new Date(since).toISOString(),new Date(since).toISOString()).filter(owns);
      for(const turn of recent){const key=turn.id+':'+turn.status;if(!discovered.has(key)){discovered.add(key);needsRefresh=true;}}
      // One durable row per completed root turn. Totals come from deduplicated token events,
      // and are never added back into the daily token ledger.
      const missing=db.prepare("SELECT t.* FROM turns t LEFT JOIN turn_usage u ON u.id=t.id WHERE t.child=0 AND t.status='complete' AND u.id IS NULL").all().filter(owns);
      for(const turn of missing){const payload={accountScope:scope??null,id:turn.id,sessionId:turn.session,turnId:turn.turn,endedAt:Date.parse(turn.ended),startedAt:turn.started,usage:turnTokenUsage(db,turn,scope),weekly:turnWeeklyUsage(db,turn,scope)};
        db.prepare('INSERT OR IGNORE INTO turn_usage VALUES(?,?,?)').run(turn.id,turn.ended,JSON.stringify(payload));}
      const pending=db.prepare("SELECT t.* FROM turns t LEFT JOIN turn_notifications n ON n.id=t.id WHERE t.child=0 AND t.status='complete' AND t.ended>=? AND n.id IS NULL ORDER BY t.ended").all(new Date(since).toISOString()).filter(owns);
      for(const turn of pending){
        const age=time-Date.parse(turn.ended);if(age<1800)continue;
        const weekly=turnWeeklyUsage(db,turn,scope);
        const after=db.prepare("SELECT at FROM snapshots WHERE source='live' AND at>=? LIMIT 1").get(turn.ended);
        if(!after&&age<45000)continue; // let the existing quota worker finish its completion refresh
        const payload={accountScope:scope??null,id:turn.id,type:'completion',sessionId:turn.session,turnId:turn.turn,endedAt:Date.parse(turn.ended),startedAt:turn.started,usage:turnTokenUsage(db,turn,scope),weekly};
        db.prepare('INSERT OR REPLACE INTO turn_usage VALUES(?,?,?)').run(turn.id,turn.ended,JSON.stringify(payload));
        db.prepare('INSERT OR IGNORE INTO turn_notifications VALUES(?,?,?)').run(turn.id,turn.ended,JSON.stringify(payload));notified=true;
      }
      const today=beijingDay(time);
      if(scan.changed||notified||current?.observedAt!==lastObserved||today!==lastDay||time-lastSummary>=15000){
        const report=reportHistory(db,1,new Date(time),scope);
        const complete=db.prepare("SELECT count(*) AS n FROM turns WHERE status='complete' AND child=0 AND ended>=? AND ended<?").get(new Date(today+'T00:00:00+08:00').toISOString(),new Date(new Date(today+'T00:00:00+08:00').getTime()+86400000).toISOString()).n;
        writeJson(path.join(config.dataDir,'usage-summary.json'),{schema:2,accountScope:scope??null,day:today,updatedAt:time,today:report.sum,completedTurns:complete,weekly:todayWeeklyUsage(db,current,new Date(time)),precisionNote:'两位小数是显示格式；不提高接口精度'});
        const notices=db.prepare('SELECT payload FROM turn_notifications ORDER BY at DESC LIMIT 64').all().reverse().map(r=>JSON.parse(r.payload)).filter(n=>scope===undefined||n.accountScope===scope);
        writeJson(path.join(config.dataDir,'usage-notices.json'),{schema:1,updatedAt:time,notices});
        lastSummary=time;lastObserved=current?.observedAt;lastDay=today;
      }
      db.prepare("INSERT OR REPLACE INTO live_meta VALUES('last_tick',?)").run(String(time));
      return {needsRefresh,scan,notified};
    },close(){db.close();}
  };
}
