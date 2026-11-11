import {ensureAccountSchema} from './account-ledger.mjs';
// Latest complete observation is account-wide, not summed across devices.
export function mergedQuota(db,scope,fallback){
 if(!scope)return null;ensureAccountSchema(db);
 const latest=db.prepare("SELECT s.at FROM snapshots s JOIN account_snapshot_scopes a ON a.id=s.id WHERE a.scope=? AND s.source='live' ORDER BY s.at DESC LIMIT 1").get(scope);
 if(!latest||fallback?.accountKey===scope&&(fallback.observedAt??0)>Date.parse(latest.at))return fallback?.accountKey===scope?fallback:null;
 const rows=db.prepare("SELECT s.* FROM snapshots s JOIN account_snapshot_scopes a ON a.id=s.id WHERE a.scope=? AND s.source='live' AND s.at=? ORDER BY s.minutes,s.window").all(scope,latest.at);
 return {ok:true,queryOk:true,plan:rows[0]?.plan,planKnown:false,accountKey:scope,observedAt:Date.parse(latest.at),windows:rows.map(r=>({label:r.minutes===10080?'每周':r.minutes&&r.minutes%60===0?r.minutes/60+' 小时':r.minutes?r.minutes+' 分钟':r.window,minutes:r.minutes,used:r.used,remaining:Math.max(0,100-r.used),resetsAt:r.reset})),source:'merged-account-observation'};
}
