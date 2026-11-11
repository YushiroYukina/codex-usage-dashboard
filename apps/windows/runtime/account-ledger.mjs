// Portable ledger protocol. Windows and the account service must use this module
// or pass the same canonical fixtures. No paths, chat text or credentials travel.
import {createHash} from 'node:crypto';
import {cleanNativeRecord,saveNativeRecord} from './sync-store.mjs';
export const PROTOCOL=2, MAX_BYTES=64*1024*1024, MAX_RECORDS=500000;
export const kinds=['tokens','snapshots','native','turns','tokenTurns'];
export function canonical(value){
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 throw Error('INVALID_RECORD');
}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const str=(s,n=256)=>typeof s==='string'&&s.length>0&&s.length<=n&&!/[\u0000-\u001f]/.test(s);
const iso=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const day=s=>new Date(Date.parse(s)+28800000).toISOString().slice(0,10);
const nums=['input','cached','uncached','cacheWrite','output','reasoning','total'];
const fail=()=>{throw Error('INVALID_RECORD')};
export function ensureAccountSchema(db){db.exec(`
 CREATE TABLE IF NOT EXISTS account_native_observations(id TEXT PRIMARY KEY,scope TEXT,kind TEXT,payload TEXT,updated TEXT);
 CREATE TABLE IF NOT EXISTS account_native_heads(id TEXT PRIMARY KEY,signature TEXT);
 CREATE TABLE IF NOT EXISTS account_snapshot_scopes(id TEXT PRIMARY KEY,scope TEXT);
 CREATE TABLE IF NOT EXISTS account_turn_scopes(id TEXT PRIMARY KEY,scope TEXT);
 CREATE TABLE IF NOT EXISTS account_sync_meta(key TEXT PRIMARY KEY,value TEXT);
`);}
export function bindLocalRecords(db,scope){
 if(!hex(scope))throw Error('ACCOUNT_REQUIRED');ensureAccountSchema(db);
 db.prepare('INSERT OR IGNORE INTO sync_token_scopes SELECT id,? FROM tokens').run(scope);
 db.prepare("INSERT OR IGNORE INTO account_snapshot_scopes SELECT id,CASE WHEN source='log' AND scope='historical-account-unverified' THEN ? ELSE scope END FROM snapshots WHERE (source='log' AND scope='historical-account-unverified') OR (length(scope)=64 AND scope NOT GLOB '*[^0-9a-f]*')").run(scope);
 db.prepare(`INSERT OR IGNORE INTO account_turn_scopes SELECT DISTINCT t.id,? FROM turns t JOIN token_turns x ON x.turn=t.turn JOIN sync_token_scopes s ON s.token=x.token WHERE s.scope=?`).run(scope,scope);
}
export function normalizeBundle(b,scope){
 if(!hex(scope)||b?.protocol!==PROTOCOL||b.accountScope!==scope)throw Error('ACCOUNT_MISMATCH');
 for(const k of kinds){if(!Array.isArray(b[k]))fail();if(b[k].length>MAX_RECORDS)throw Error('LEDGER_TOO_LARGE');}
 const out={protocol:PROTOCOL,accountScope:scope};
 out.tokens=b.tokens.map(r=>{
  if(!hex(r.id)||!iso(r.at)||r.day!==day(r.at)||!str(r.model))fail();
  const usage={};for(const k of nums){const v=r.usage?.[k];if(v!==null&&(!Number.isSafeInteger(v)||v<0))fail();usage[k]=v;}
  if(usage.total===null||usage.total<Math.max(usage.input??0,usage.output??0)||(usage.cached!==null&&usage.input!==null&&usage.cached>usage.input)||(usage.reasoning!==null&&usage.output!==null&&usage.reasoning>usage.output))fail();
  return {id:r.id,at:r.at,day:r.day,model:r.model,usage};
 });
 out.snapshots=b.snapshots.map(r=>{
  if(!hex(r.id)||!iso(r.at)||r.day!==day(r.at)||!['log','live','native'].includes(r.source)||!str(r.plan)||!str(r.window)||!(r.scope===scope||r.source==='log'&&r.scope==='historical-account-unverified')||!Number.isFinite(r.used)||r.used<0||r.used>100||(r.reset!==null&&(!Number.isFinite(r.reset)||r.reset<=0))||(r.minutes!==null&&(!Number.isFinite(r.minutes)||r.minutes<=0)))fail();
  return Object.fromEntries(['id','at','day','source','scope','plan','window','minutes','used','reset'].map(k=>[k,r[k]]));
 });
 out.native=b.native.map(r=>{
  if(!hex(r.id)||r.scope!==scope||!['profile','period','balance'].includes(r.kind)||!iso(r.updated))fail();
  const value=cleanNativeRecord(r.kind,r.value);const row={scope,kind:r.kind,value,updated:r.updated};
  if(digest(row)!==r.id)fail();return {id:r.id,...row};
 });
 out.turns=b.turns.map(r=>{
  if(!hex(r.id)||!str(r.session)||!str(r.turn)||!str(r.root)||!(r.started===null||iso(r.started))||!(r.ended===null||iso(r.ended))||!['running','complete','failed','aborted'].includes(r.status)||![0,1].includes(r.child)||![0,1].includes(r.start_observed))fail();
  return Object.fromEntries(['id','session','turn','root','started','ended','status','child','start_observed'].map(k=>[k,r[k]]));
 });
 out.tokenTurns=b.tokenTurns.map(r=>{if(!hex(r.token)||!str(r.session)||!str(r.turn)||!str(r.root))fail();return {token:r.token,session:r.session,turn:r.turn,root:r.root}});
 for(const k of kinds){const key=k==='tokenTurns'?'token':'id';out[k].sort((a,b)=>a[key]<b[key]?-1:a[key]>b[key]?1:0);const seen=new Set();for(const r of out[k]){if(seen.has(r[key]))fail();seen.add(r[key]);}}
 const tokens=new Set(out.tokens.map(r=>r.id)),turns=new Set(out.turns.map(r=>r.turn));
 for(const r of out.tokenTurns)if(!tokens.has(r.token)||!turns.has(r.turn))fail();
 if(Buffer.byteLength(canonical(out))>MAX_BYTES)throw Error('LEDGER_TOO_LARGE');
 return out;
}
function captureNative(db,scope){
 for(const r of db.prepare('SELECT * FROM native_usage WHERE scope=?').all(scope)){
  const signature=digest([r.payload,r.updated]);
  if(db.prepare('SELECT signature FROM account_native_heads WHERE id=?').get(r.id)?.signature===signature)continue;
  const value=cleanNativeRecord(r.kind,JSON.parse(r.payload)),o={scope,kind:r.kind,value,updated:r.updated};
  db.prepare('INSERT OR IGNORE INTO account_native_observations VALUES(?,?,?,?,?)').run(digest(o),scope,r.kind,JSON.stringify(value),r.updated);
  db.prepare('INSERT OR REPLACE INTO account_native_heads VALUES(?,?)').run(r.id,signature);
 }
}
function materializeNative(db,scope){
 db.prepare('DELETE FROM native_usage WHERE scope=?').run(scope);
 for(const r of db.prepare('SELECT * FROM account_native_observations WHERE scope=? ORDER BY updated,id').all(scope))saveNativeRecord(db,scope,r.kind,JSON.parse(r.payload),r.updated);
 for(const r of db.prepare('SELECT * FROM native_usage WHERE scope=?').all(scope))db.prepare('INSERT OR REPLACE INTO account_native_heads VALUES(?,?)').run(r.id,digest([r.payload,r.updated]));
}
function accountBundle(db,scope){
 bindLocalRecords(db,scope);captureNative(db,scope);
 const tokens=db.prepare('SELECT t.* FROM tokens t JOIN sync_token_scopes s ON s.token=t.id WHERE s.scope=?').all(scope).map(r=>({...r,usage:Object.fromEntries(nums.map(k=>[k,JSON.parse(r.usage)[k]??null]))}));
 const tokenIds=new Set(tokens.map(t=>t.id));
 const turns=db.prepare('SELECT t.* FROM turns t JOIN account_turn_scopes s ON s.id=t.id WHERE s.scope=?').all(scope),turnIds=new Set(turns.map(t=>t.turn));
 return normalizeBundle({protocol:PROTOCOL,accountScope:scope,tokens,
  snapshots:db.prepare('SELECT t.* FROM snapshots t JOIN account_snapshot_scopes s ON s.id=t.id WHERE s.scope=?').all(scope),
  native:db.prepare('SELECT * FROM account_native_observations WHERE scope=?').all(scope).map(r=>({id:r.id,scope,kind:r.kind,value:JSON.parse(r.payload),updated:r.updated})),turns,
  tokenTurns:db.prepare('SELECT * FROM token_turns').all().filter(r=>tokenIds.has(r.token)&&turnIds.has(r.turn))},scope);
}
export function exportAccountBundle(db,scope){
 const owns=!db.isTransaction;if(owns)db.exec('BEGIN IMMEDIATE');
 try{const value=accountBundle(db,scope);if(owns)db.exec('COMMIT');return value}catch(e){if(owns)db.exec('ROLLBACK');throw e}
}
const turnRank=r=>[r.ended??'',r.start_observed,String(['running','aborted','failed','complete'].indexOf(r.status)),canonical(r)].join('|');
export function importAccountBundle(db,raw,scope){
 const b=normalizeBundle(raw,scope);ensureAccountSchema(db);const added=Object.fromEntries(kinds.map(k=>[k,0]));
 const nested=db.isTransaction;db.exec(nested?'SAVEPOINT account_import':'BEGIN IMMEDIATE');try{
  // Capture local observations before reconstructing the native materialized view.
  captureNative(db,scope);
  for(const r of b.tokens){
   const old=db.prepare('SELECT t.*,s.scope AS owner FROM tokens t LEFT JOIN sync_token_scopes s ON s.token=t.id WHERE t.id=?').get(r.id);
   if(old){if(old.owner&&old.owner!==scope)throw Error('ACCOUNT_MISMATCH');const u=JSON.parse(old.usage);const prior={id:old.id,at:old.at,day:old.day,model:old.model,usage:Object.fromEntries(nums.map(k=>[k,u[k]??null]))};if(canonical(prior)!==canonical(r))throw Error('RECORD_CONFLICT');}
   added.tokens+=Number(db.prepare('INSERT OR IGNORE INTO tokens VALUES(?,?,?,?,?)').run(r.id,r.at,r.day,r.model,JSON.stringify(r.usage)).changes);
   db.prepare('INSERT OR IGNORE INTO sync_token_scopes VALUES(?,?)').run(r.id,scope);
  }
  for(const r of b.snapshots){
   const old=db.prepare('SELECT * FROM snapshots WHERE id=?').get(r.id),owner=db.prepare('SELECT scope FROM account_snapshot_scopes WHERE id=?').get(r.id)?.scope;
   if(owner&&owner!==scope)throw Error('ACCOUNT_MISMATCH');if(old&&canonical(old)!==canonical(r))throw Error('RECORD_CONFLICT');
   added.snapshots+=Number(db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(...['id','at','day','source','scope','plan','window','minutes','used','reset'].map(k=>r[k])).changes);
   db.prepare('INSERT OR IGNORE INTO account_snapshot_scopes VALUES(?,?)').run(r.id,scope);
  }
  for(const r of b.native)added.native+=Number(db.prepare('INSERT OR IGNORE INTO account_native_observations VALUES(?,?,?,?,?)').run(r.id,scope,r.kind,JSON.stringify(r.value),r.updated).changes);
  for(const r of b.turns){
   const owner=db.prepare('SELECT scope FROM account_turn_scopes WHERE id=?').get(r.id)?.scope;if(owner&&owner!==scope)throw Error('ACCOUNT_MISMATCH');
   const old=db.prepare('SELECT * FROM turns WHERE id=?').get(r.id);
   if(old&&(old.session!==r.session||old.turn!==r.turn))throw Error('RECORD_CONFLICT');
   if(!old||turnRank(r)>turnRank(old)){db.prepare('INSERT OR REPLACE INTO turns VALUES(?,?,?,?,?,?,?,?,?)').run(...['id','session','turn','root','started','ended','status','child','start_observed'].map(k=>r[k]));added.turns++;}
   db.prepare('INSERT OR IGNORE INTO account_turn_scopes VALUES(?,?)').run(r.id,scope);
  }
  for(const r of b.tokenTurns){const old=db.prepare('SELECT * FROM token_turns WHERE token=?').get(r.token);if(!old||canonical(r)<canonical(old)){db.prepare('INSERT OR REPLACE INTO token_turns VALUES(?,?,?,?)').run(r.token,r.session,r.turn,r.root);added.tokenTurns++;}}
  materializeNative(db,scope);db.exec(nested?'RELEASE account_import':'COMMIT');return added;
 }catch(e){db.exec(nested?'ROLLBACK TO account_import; RELEASE account_import':'ROLLBACK');throw e;}
}
export function ledgerManifest(bundle){const b=normalizeBundle(bundle,bundle.accountScope);return {protocol:PROTOCOL,timeZone:'Asia/Shanghai',digest:digest(b),counts:Object.fromEntries(kinds.map(k=>[k,b[k].length]))};}
