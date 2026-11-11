import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {atomicJson} from './usage.mjs';

const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const SYNC_VERSION=1;
export function ensureSupplementSchema(db){db.exec(`
 CREATE TABLE IF NOT EXISTS native_usage(id TEXT PRIMARY KEY,scope TEXT,kind TEXT,payload TEXT,updated TEXT);
 CREATE TABLE IF NOT EXISTS sync_devices(id TEXT PRIMARY KEY,label TEXT,platform TEXT,last_seen TEXT);
 CREATE TABLE IF NOT EXISTS sync_token_scopes(token TEXT PRIMARY KEY,scope TEXT);
 CREATE TABLE IF NOT EXISTS sync_meta(key TEXT PRIMARY KEY,value TEXT);
`);}
export function defaultSyncRoot(){return process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support','UsageLedger','sync'):path.join(process.env.LOCALAPPDATA??os.homedir(),'UsageLedger','sync');}
export function syncSettings(config){
 const root=config.syncRoot??defaultSyncRoot();fs.mkdirSync(root,{recursive:true,mode:0o700});
 const file=path.join(root,'private.json');let state;
 try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{
  const next={schema:1,device:randomUUID(),label:process.platform==='darwin'?'Mac 设备':'Windows 设备',platform:process.platform,key:randomBytes(32).toString('base64url'),group:randomUUID(),peers:[],port:39173};
  try{fs.writeFileSync(file,JSON.stringify(next),{flag:'wx',mode:0o600});state=next;}catch(error){if(error.code!=='EEXIST')throw error;state=JSON.parse(fs.readFileSync(file,'utf8'));}
 }
 if(!/^[A-Za-z0-9_-]{43}$/.test(state.key)||!Array.isArray(state.peers))throw Error('同步设置无效');
 return {...state,root,folder:state.folder??path.join(root,'exchange')};
}
export function updateSyncSettings(config,changes){const old=syncSettings(config);const {root,folder,...saved}=old;atomicJson(path.join(root,'private.json'),{...saved,...changes});return syncSettings(config);}
export function seal(value,key){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'base64url'),iv);cipher.setAAD(Buffer.from('usage-ledger-sync-v1'));const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return {schema:1,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')};}
export function unseal(packet,key){
 if(packet?.schema!==1||typeof packet.data!=='string'||packet.data.length>90000000)throw Error('同步包无效');
 const iv=Buffer.from(packet.iv??'','base64url'),tag=Buffer.from(packet.tag??'','base64url');if(iv.length!==12||tag.length!==16)throw Error('同步包无效');
 const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64url'),iv);cipher.setAAD(Buffer.from('usage-ledger-sync-v1'));cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(Buffer.from(packet.data,'base64url')),cipher.final()]).toString('utf8'));
}
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v,n=256)=>typeof v==='string'&&v.length<=n&&!/[\x00-\x1f]/.test(v);
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const tokenKeys=['input','cached','uncached','cacheWrite','output','reasoning','total'];
export function exportBundle(db,scope,device){
 if(!hex(scope))throw Error('请先刷新并核实当前登录账号');ensureSupplementSchema(db);
 db.prepare("INSERT OR REPLACE INTO sync_meta VALUES('current_scope',?)").run(scope);
 // Explicit allowlists: no paths, chat text, raw account identity or credentials.
 db.prepare('INSERT OR IGNORE INTO sync_token_scopes SELECT id,? FROM tokens').run(scope);
 const tokens=db.prepare('SELECT t.id,t.at,t.day,t.model,t.usage FROM tokens t JOIN sync_token_scopes s ON s.token=t.id WHERE s.scope=? ORDER BY t.id').all(scope).map(r=>{const u=JSON.parse(r.usage);return {...r,usage:Object.fromEntries(tokenKeys.map(k=>[k,u[k]??null]))};});
 const snapshots=db.prepare('SELECT * FROM snapshots WHERE scope=? OR source=\'log\' ORDER BY id').all(scope);
 const native=db.prepare('SELECT * FROM native_usage WHERE scope=? ORDER BY id').all(scope);
 return {schema:1,scope,device:{id:device.device,label:device.label,platform:device.platform},tokens,snapshots,native};
}
export function importBundle(db,bundle,scope){
 if(!hex(scope)||bundle?.schema!==1||bundle.scope!==scope)throw Error('同步账号不匹配，未导入');
 if(!text(bundle.device?.id)||!text(bundle.device?.label,80)||!text(bundle.device?.platform,20))throw Error('设备信息无效');
 for(const k of ['tokens','snapshots','native'])if(!Array.isArray(bundle[k])||bundle[k].length>500000)throw Error('同步记录无效');
 const tokens=bundle.tokens.map(r=>{
  if(!hex(r.id)||!stamp(r.at)||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||r.day!==new Date(Date.parse(r.at)+28800000).toISOString().slice(0,10)||!text(r.model))throw Error('Token 记录无效');
  const u={};for(const k of tokenKeys){if(r.usage?.[k]!==null&&(!Number.isSafeInteger(r.usage?.[k])||r.usage[k]<0))throw Error('Token 数量无效');u[k]=r.usage[k];}
  if(u.total===null||u.total<Math.max(u.input??0,u.output??0)||(u.cached!==null&&u.input!==null&&u.cached>u.input))throw Error('Token 分类无效');
  return [r.id,r.at,r.day,r.model,JSON.stringify(u)];
 });
 const snaps=bundle.snapshots.map(r=>{
  if(!hex(r.id)||!stamp(r.at)||!text(r.plan)||!text(r.window)||!['log','live','native'].includes(r.source)||!Number.isFinite(r.used)||r.used<0||r.used>100||(r.reset!==null&&(!Number.isFinite(r.reset)||r.reset<=0))||(r.minutes!==null&&(!Number.isFinite(r.minutes)||r.minutes<=0))||!(r.scope===scope||r.source==='log'&&r.scope==='historical-account-unverified'))throw Error('额度记录无效');
  const day=new Date(Date.parse(r.at)+28800000).toISOString().slice(0,10);return [r.id,r.at,day,r.source,r.scope,r.plan,r.window,r.minutes,r.used,r.reset];
 });
 // Native payloads have their own strict metadata normalizer; arbitrary JSON never enters the DB.
 const native=bundle.native.map(r=>{if(r.scope!==scope||!hex(r.id)||!['profile','period','balance'].includes(r.kind)||!stamp(r.updated))throw Error('原生记录无效');const value=JSON.parse(r.payload);return {...r,value};});
 ensureSupplementSchema(db);db.exec('BEGIN IMMEDIATE');let added=0,quotaAdded=0;
 try{
  for(const row of tokens){const bound=db.prepare('SELECT scope FROM sync_token_scopes WHERE token=?').get(row[0]);if(bound&&bound.scope!==scope)throw Error('Token 所属账号不符');added+=Number(db.prepare('INSERT OR IGNORE INTO tokens VALUES(?,?,?,?,?)').run(...row).changes);db.prepare('INSERT OR IGNORE INTO sync_token_scopes VALUES(?,?)').run(row[0],scope);}
  for(const row of snaps)quotaAdded+=Number(db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(...row).changes);
  for(const r of native){let clean=cleanNativeRecord(r.kind,r.value);if(digest([r.scope,r.kind,clean.key])!==r.id)throw Error('原生记录标识不符');const previous=db.prepare('SELECT payload FROM native_usage WHERE id=?').get(r.id);if(r.kind==='profile'&&previous)clean=mergeProfile(JSON.parse(previous.payload),clean);db.prepare('INSERT INTO native_usage VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated WHERE excluded.updated>native_usage.updated').run(r.id,r.scope,r.kind,JSON.stringify(clean),r.updated);}
  db.prepare('INSERT OR REPLACE INTO sync_devices VALUES(?,?,?,?)').run(bundle.device.id,bundle.device.label,bundle.device.platform,new Date().toISOString());
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return {tokensAdded:added,snapshotsAdded:quotaAdded};
}
function number(v){return typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;}
function iso(v){if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))throw Error('原生记录日期无效');return new Date(v).toISOString();}
export function cleanNativeRecord(kind,r){
 if(kind==='profile')return {key:'profile',summary:Object.fromEntries(['lifetimeTokens','peakDailyTokens','longestRunningTurnSec','currentStreakDays','longestStreakDays'].map(k=>[k,number(r.summary?.[k])])),dailyUsageBuckets:(r.dailyUsageBuckets??[]).map(x=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(x.startDate)||!Number.isSafeInteger(x.tokens)||x.tokens<0)throw Error('原生每日 Token 无效');return {startDate:x.startDate,tokens:x.tokens};}),dateBasis:'原生日期桶；时区未提供，不转换为北京时间日账'};
 if(kind==='period'){
  if(!text(r.key??r.id))throw Error('周期标识无效');const minutes=number(r.window_minutes),points=number(r.used_basis_points);if(!minutes||points!==null&&points>10000)throw Error('原生周期数量无效');
  return {key:r.key??r.id,window_minutes:minutes,plan_type:text(r.plan_type)?r.plan_type:'unknown',starts_at:iso(r.starts_at),ends_at:iso(r.ends_at),accounting_complete:r.accounting_complete===true,used_basis_points:points,breakdowns:(r.breakdowns??[]).filter(x=>['thread_source','turn_trigger','model','surface'].includes(x.dimension)).map(x=>({dimension:x.dimension,rows:(x.rows??[]).map(y=>{if(!text(y.key)||number(y.basis_points)===null)throw Error('原生占比无效');return {key:y.key,basis_points:y.basis_points};})})),approximate:r.approximate!==false,data_as_of:r.data_as_of?iso(r.data_as_of):null};
 }
 if(kind==='balance'){
  const observed_at=iso(r.observed_at),minutes=number(r.window_minutes);const remaining=number(r.remaining_percent??r.remainingPercent);if(!minutes||remaining===null||remaining>100)throw Error('原生余额记录无效');
  return {key:minutes+'|'+observed_at,window_minutes:minutes,observed_at,remaining_percent:remaining,reset_at:r.reset_at?iso(r.reset_at):null};
 }
 throw Error('原生数据类型无效');
}
export function saveNativeRecord(db,scope,kind,value,at=new Date().toISOString()){
 if(!hex(scope))throw Error('当前账号未核实');ensureSupplementSchema(db);db.prepare("INSERT OR REPLACE INTO sync_meta VALUES('current_scope',?)").run(scope);let clean=cleanNativeRecord(kind,value);const id=digest([scope,kind,clean.key]);const previous=db.prepare('SELECT payload FROM native_usage WHERE id=?').get(id);if(kind==='profile'&&previous)clean=mergeProfile(JSON.parse(previous.payload),clean);
 db.prepare('INSERT INTO native_usage VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated WHERE excluded.updated>=native_usage.updated').run(id,scope,kind,JSON.stringify(clean),at);return id;
}
function mergeProfile(previous,next){const days=new Map((previous.dailyUsageBuckets??[]).map(r=>[r.startDate,r]));for(const r of next.dailyUsageBuckets)days.set(r.startDate,r);return {...next,summary:Object.fromEntries(Object.entries(next.summary).map(([k,v])=>[k,v??previous.summary?.[k]??null])),dailyUsageBuckets:[...days.values()].sort((a,b)=>a.startDate.localeCompare(b.startDate))};}
export function nativeReport(db,scope){ensureSupplementSchema(db);return db.prepare('SELECT kind,payload,updated FROM native_usage WHERE scope=? ORDER BY updated').all(scope??'').reduce((r,x)=>{const value=JSON.parse(x.payload);if(x.kind==='profile')r.profile={...value,updated:x.updated};else r[x.kind==='period'?'periods':'balances'].push(value);return r;},{profile:null,periods:[],balances:[]});}
export function importNativeDocument(db,scope,doc){
 if(!doc||typeof doc!=='object')throw Error('原生用量文件无效');let count=0;
 db.exec('BEGIN IMMEDIATE');try{
  if(doc.profile){saveNativeRecord(db,scope,'profile',doc.profile);count++;}
  const history=doc.planLimitHistory??(Array.isArray(doc.periods)?doc:null);
  for(const period of history?.periods??[]){saveNativeRecord(db,scope,'period',{...period,approximate:history.approximate,data_as_of:history.data_as_of});count++;}
  // Balance records require explicit window and percentage, never infer percentage from tokens or credit units.
  for(const r of doc.balances??[]){saveNativeRecord(db,scope,'balance',r);count++;}
  if(!count)throw Error('没有识别到原生用量字段');db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}return {imported:count};
}
