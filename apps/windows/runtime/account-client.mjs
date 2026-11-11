import net from 'node:net';
import {createHash} from 'node:crypto';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {currentScope} from './device-sync.mjs';
import {syncSettings} from './sync-store.mjs';
import {exportAccountBundle,importAccountBundle,ledgerManifest,normalizeBundle,MAX_BYTES,canonical} from './account-ledger.mjs';
export function serviceURL(value){
 const u=new URL(value);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname))))throw Error('INVALID_SERVICE');return u.origin;
}
const safeCodes=new Set(['PAIR_REQUIRED','DEVICE_MISMATCH','ALREADY_PAIRED','INVALID_PAIR_CODE','CONNECTION_STARTING','HOST_WINDOWS_REQUIRED','TUNNEL_UNAVAILABLE','PEER_UNAVAILABLE','ACCOUNT_REQUIRED','ACCOUNT_CHANGED','ACCOUNT_MISMATCH','SYNC_DISABLED','INVALID_SERVICE','INVALID_RECORD','LOGIN_REQUIRED','LOGIN_EXPIRED','AUTH_DENIED','AUTH_UNAVAILABLE','SERVICE_UNAVAILABLE','RECORD_CONFLICT','LEDGER_TOO_LARGE','INVALID_RESPONSE','CREDENTIAL_STORE_UNAVAILABLE']);
export const publicError=e=>safeCodes.has(e?.message)?e.message:'SYNC_FAILED';
const messages={PAIR_REQUIRED:'请先连接另一设备',DEVICE_MISMATCH:'已连接其他设备，请先断开旧连接',ALREADY_PAIRED:'已连接设备，请先断开后重新连接',INVALID_PAIR_CODE:'连接码不正确，请重新复制',CONNECTION_STARTING:'正在建立跨网络连接',HOST_WINDOWS_REQUIRED:'请在 Windows 端创建连接码',TUNNEL_UNAVAILABLE:'临时连接未建立，请稍后重试',PEER_UNAVAILABLE:'另一端暂未连接，本地记录已保存',ACCOUNT_REQUIRED:'请先刷新并核实当前 Codex 账号',ACCOUNT_CHANGED:'账号已切换，请重新登录同步服务',ACCOUNT_MISMATCH:'同步账号不匹配，未导入',INVALID_SERVICE:'服务地址须为 HTTPS，联调仅允许本机 HTTP',LOGIN_REQUIRED:'请登录同步账号',LOGIN_EXPIRED:'登录已过期，请重新登录',AUTH_DENIED:'同步授权被拒绝',AUTH_UNAVAILABLE:'同步服务尚未提供账号登录',SERVICE_UNAVAILABLE:'同步服务暂不可达，记录已保留',RECORD_CONFLICT:'发现同编号但内容不同的记录，未覆盖原记录',LEDGER_TOO_LARGE:'账本超过本版单次传输上限，尚未同步',INVALID_RESPONSE:'服务返回数据未通过校验',CREDENTIAL_STORE_UNAVAILABLE:'系统凭据存储不可用',SYNC_FAILED:'同步未完成，原记录已保留'};
export const errorMessage=code=>code==='SYNC_DISABLED'?'账号同步已停用，原账本已保留':code==='INVALID_RECORD'?'同步记录未通过检查，原账本已保留':messages[code]??messages.SYNC_FAILED;
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function privateJSON(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file)}finally{try{fs.unlinkSync(tmp)}catch{}}}
export function accountSettings(config){const s=read(path.join(config.dataDir,'account-sync.json'))??{};let service=null;try{service=s.service?serviceURL(s.service):null}catch{}return {enabled:s.enabled===true,service,generation:Number.isSafeInteger(s.generation)?s.generation:0};}
export function configureAccountSync(config,value){const prior=accountSettings(config);const service=value.service===undefined?prior.service:value.service?serviceURL(value.service):null;const next={enabled:value.enabled===undefined?prior.enabled:value.enabled===true,service,generation:prior.generation+1};privateJSON(path.join(config.dataDir,'account-sync.json'),next);return next;}
export function keychainStore(config){
 function run(action,key,value){
  if(process.platform!=='darwin'||!config.secretHelper||!fs.existsSync(config.secretHelper))throw Error('CREDENTIAL_STORE_UNAVAILABLE');
  const result=spawnSync(config.secretHelper,[],{input:JSON.stringify({action,key,...(value?{value}:{})}),encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  if(result.status!==0)throw Error('CREDENTIAL_STORE_UNAVAILABLE');try{return JSON.parse(result.stdout).value??null}catch{throw Error('CREDENTIAL_STORE_UNAVAILABLE')}
 }
 return {read:key=>run('read',key),write:(key,value)=>run('write',key,value),remove:key=>run('delete',key)};
}
export async function fetchJSON(url,{token,body,fetcher=fetch,timeout=120000,signal}={}){
 const raw=JSON.stringify(body??{});
 let res;try{res=await fetcher(url,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:raw});}catch{throw Error('SERVICE_UNAVAILABLE')}
 if(res.status===401)throw Error('LOGIN_EXPIRED');
 let bytes=0,chunks=[];for await(const chunk of res.body??[]){bytes+=chunk.length;if(bytes>MAX_BYTES)throw Error('LEDGER_TOO_LARGE');chunks.push(Buffer.from(chunk))}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('INVALID_RESPONSE')}
 if(!res.ok){const code=value?.error;if(safeCodes.has(code))throw Error(code);throw Error(res.status===403?'AUTH_DENIED':'SERVICE_UNAVAILABLE')}
 return value;
}
export function createAccountSync(config,db,{secrets=keychainStore(config),fetcher=fetch,scopeProvider=()=>{
 const q=read(path.join(config.dataDir,'status.json'));return q&&Date.now()-(q.observedAt??0)<180000?currentScope(config):null;
},now=()=>Date.now()}={}){
 const statusPath=path.join(config.dataDir,'account-sync-status.json');let busy=false,pending=null,stopped=false,epoch=0,observedScope=scopeProvider(),observedGeneration=accountSettings(config).generation;const requests=new Set();const cancel=()=>{for(const c of requests)c.abort();requests.clear();};function observe(){const scope=scopeProvider(),generation=accountSettings(config).generation;if(scope!==observedScope||generation!==observedGeneration){observedScope=scope;observedGeneration=generation;epoch++;pending=null;cancel();}}const observer=setInterval(observe,1000);observer.unref();
 async function lease(){if(process.platform==='win32'){const endpoint='\\\\.\\pipe\\usage-ledger-v2-sync-'+createHash('sha256').update(fs.realpathSync(config.dataDir).toLowerCase()).digest('hex').slice(0,24),server=net.createServer(socket=>socket.destroy());const acquired=await new Promise((resolve,reject)=>{server.once('error',e=>e.code==='EADDRINUSE'?resolve(false):reject(e));server.listen(endpoint,()=>resolve(true));});return acquired?()=>new Promise(r=>server.close(r)):null;}const file=path.join(config.dataDir,'account-sync.lock'),owner={pid:process.pid,token:randomUUID()};
  for(let i=0;i<2;i++){try{fs.writeFileSync(file,JSON.stringify(owner),{flag:'wx',mode:0o600});return ()=>{if(read(file)?.token===owner.token)try{fs.unlinkSync(file)}catch{}}}catch(e){if(e.code!=='EEXIST')throw e;const old=read(file);if(!old?.pid)return null;try{process.kill(old.pid,0);return null}catch(err){if(err.code!=='ESRCH')return null;if(read(file)?.token===old.token)try{fs.unlinkSync(file)}catch{}}}}return null;
 }
 const key=(service,scope)=>service+'|'+scope;
 const post=async(service,route,body,token)=>{const controller=new AbortController();requests.add(controller);try{return await fetchJSON(service+route,{body,token,fetcher,signal:controller.signal});}finally{requests.delete(controller);}};
 function save(value){const status={at:new Date(now()).toISOString(),...value};privateJSON(statusPath,status);return status;}
 function context(){observe();const settings=accountSettings(config),scope=scopeProvider();if(!scope)throw Error('ACCOUNT_REQUIRED');if(!settings.service)throw Error('INVALID_SERVICE');return {...settings,scope,epoch,key:key(settings.service,scope)}}
 function guard(c){if(stopped)throw Error('SYNC_DISABLED');const s=accountSettings(config);if(c.syncing&&s.enabled!==c.enabled)throw Error('SYNC_DISABLED');if(s.generation!==c.generation||c.epoch!==epoch)throw Error('ACCOUNT_CHANGED');if(scopeProvider()!==c.scope||s.service!==c.service)throw Error('ACCOUNT_CHANGED');if(c.syncing&&s.enabled!==c.enabled)throw Error('SYNC_DISABLED')}
 function status({credentials=true}={}){const settings=accountSettings(config),scope=scopeProvider();let login=false;try{login=!!(credentials&&scope&&settings.service&&secrets.read(key(settings.service,scope)))}catch{}
  const saved=read(statusPath);const value={enabled:settings.enabled,service:settings.service,configured:!!settings.service,loggedIn:login,...(saved&&saved.accountScope===scope&&saved.service===settings.service?saved:{state:settings.service?'login_required':'not_configured'}),...(busy?{state:'syncing'}:{})};if(value.state==='converged'&&scope){const manifest=ledgerManifest(exportAccountBundle(db,scope));if(manifest.digest!==value.manifest?.digest){value.state='pending';value.converged=false;value.manifest=manifest;}}return value;
 }
 async function startLogin(){
  const c=context();const r=await post(c.service,'/v2/auth/device/start',{protocol:2,accountScope:c.scope,client:process.platform==='win32'?'usage-ledger-windows':'usage-ledger-mac',device:syncSettings(config).device});guard(c);
  if(typeof r.deviceCode!=='string'||r.deviceCode.length<16||r.deviceCode.length>4096||typeof r.userCode!=='string'||r.userCode.length>64||!Number.isSafeInteger(r.expiresIn)||r.expiresIn<1||r.expiresIn>1800||!Number.isSafeInteger(r.interval)||r.interval<1||r.interval>60)throw Error('INVALID_RESPONSE');
  let verify;try{verify=new URL(r.verificationUri);if(verify.origin!==c.service||verify.protocol!==new URL(c.service).protocol||verify.username||verify.password)throw Error()}catch{throw Error('INVALID_RESPONSE')}
  pending={...c,deviceCode:r.deviceCode,expiresAt:now()+r.expiresIn*1000,nextPoll:0,interval:r.interval};
  return {userCode:r.userCode,verificationUri:verify.href,expiresIn:r.expiresIn,interval:r.interval};
 }
 async function pollLogin(){
  if(!pending||now()>=pending.expiresAt){pending=null;throw Error('LOGIN_EXPIRED')}
  const c=pending;guard(c);if(now()<c.nextPoll)return {pending:true};c.nextPoll=now()+c.interval*1000;
  const r=await post(c.service,'/v2/auth/device/poll',{deviceCode:c.deviceCode});guard(c);
  if(r.pending===true){if(r.slowDown===true)c.interval=Math.min(60,c.interval+5);return {pending:true,interval:c.interval}}
  if(r.accountScope!==c.scope)throw Error('ACCOUNT_MISMATCH');
  if(typeof r.accessToken!=='string'||r.accessToken.length<16||r.accessToken.length>16384||typeof r.refreshToken!=='string'||r.refreshToken.length<16||r.refreshToken.length>16384||!Number.isSafeInteger(r.expiresIn)||r.expiresIn<1)throw Error('INVALID_RESPONSE');
  secrets.write(c.key,{accessToken:r.accessToken,refreshToken:r.refreshToken,expiresAt:now()+r.expiresIn*1000,accountScope:c.scope});pending=null;configureAccountSync(config,{enabled:true});save({state:'ready',accountScope:c.scope,service:c.service});return {loggedIn:true};
 }
 async function credentials(c){
  let auth=secrets.read(c.key);if(!auth)throw Error('LOGIN_REQUIRED');if(auth.accountScope!==c.scope)throw Error('ACCOUNT_MISMATCH');
  if(auth.expiresAt<=now()+30000){
   let r;try{r=await post(c.service,'/v2/auth/refresh',{refreshToken:auth.refreshToken})}catch(e){if(['LOGIN_EXPIRED','AUTH_DENIED'].includes(e.message))secrets.remove(c.key);throw e}
   guard(c);if(r.accountScope!==c.scope)throw Error('ACCOUNT_MISMATCH');
   if(typeof r.accessToken!=='string'||r.accessToken.length<16||typeof r.refreshToken!=='string'||r.refreshToken.length<16||!Number.isSafeInteger(r.expiresIn)||r.expiresIn<1)throw Error('INVALID_RESPONSE');
   auth={accessToken:r.accessToken,refreshToken:r.refreshToken,expiresAt:now()+r.expiresIn*1000,accountScope:c.scope};secrets.write(c.key,auth);
  }return auth;
 }
 async function signOut(){const c=context(),auth=secrets.read(c.key);pending=null;epoch++;cancel();configureAccountSync(config,{enabled:false});observe();secrets.remove(c.key);try{if(auth)await post(c.service,'/v2/auth/logout',{refreshToken:auth.refreshToken},auth.accessToken)}catch{}return save({state:'signed_out',accountScope:c.scope,service:c.service})}
 async function tick(force=false){
  if(stopped||busy)return status();if(!accountSettings(config).enabled&&!force)return status();let c,release;busy=true;
  try{
   const settings=accountSettings(config);if(!settings.enabled&&!force)return status();release=await lease();if(!release)return {...status(),state:'syncing'};c={...context(),syncing:true};const auth=await credentials(c);guard(c);
   const deviceSettings=syncSettings(config),device={id:deviceSettings.device,label:deviceSettings.label,platform:process.platform};
   const bundle=exportAccountBundle(db,c.scope),manifest=ledgerManifest(bundle);
   const r=await post(c.service,'/v2/ledger/exchange',{protocol:2,requestId:randomUUID(),accountScope:c.scope,device,bundle,manifest},auth.accessToken);guard(c);
   if(r.protocol!==2||r.accountScope!==c.scope||!Number.isSafeInteger(r.revision)||r.revision<0||typeof r.snapshotAt!=='string'||!Number.isFinite(Date.parse(r.snapshotAt)))throw Error('INVALID_RESPONSE');
   const remote=normalizeBundle(r.bundle,c.scope),verified=ledgerManifest(remote);
   if(canonical(verified)!==canonical(r.manifest))throw Error('INVALID_RESPONSE');
   // An authenticated but incomplete response must never acknowledge our upload.
   for(const kind of ['tokens','snapshots','native']){const ids=new Set(remote[kind].map(x=>x.id));if(bundle[kind].some(x=>!ids.has(x.id)))throw Error('INVALID_RESPONSE')}
   guard(c);const imported=importAccountBundle(db,remote,c.scope),local=ledgerManifest(exportAccountBundle(db,c.scope));
   const same=local.digest===verified.digest;
   let ack=null;if(same){ack=await post(c.service,'/v2/ledger/ack',{protocol:2,accountScope:c.scope,deviceId:device.id,revision:r.revision,digest:local.digest},auth.accessToken);guard(c);if(ack.accountScope!==c.scope||!Number.isSafeInteger(ack.revision)||typeof ack.digest!=='string'||!Array.isArray(ack.devices)||ack.devices.length>1000)throw Error('INVALID_RESPONSE')}
   const devices=(ack?.devices??[]).map(d=>{if(typeof d.id!=='string'||typeof d.label!=='string'||typeof d.platform!=='string'||!Number.isSafeInteger(d.revision)||typeof d.digest!=='string')throw Error('INVALID_RESPONSE');return {id:d.id,label:d.label,platform:d.platform,revision:d.revision,digest:d.digest}});
   if(ack&&(new Set(devices.map(d=>d.id)).size!==devices.length||!devices.some(d=>d.id===device.id)))throw Error('INVALID_RESPONSE');
   // A scan may add events while the acknowledgement is in flight.
   guard(c);const latestLocal=ledgerManifest(exportAccountBundle(db,c.scope));
   const serverCurrent=same&&latestLocal.digest===local.digest&&ack?.protocol===2&&ack?.revision===r.revision&&ack?.digest===local.digest;
   const converged=serverCurrent&&devices.length>=2&&devices.every(d=>d.revision===r.revision&&d.digest===local.digest);
   return save({state:converged?'converged':serverCurrent?'uploaded':'pending',accountScope:c.scope,service:c.service,lastSuccess:new Date(now()).toISOString(),revision:r.revision,manifest:latestLocal,serverManifest:verified,devices,imported,converged,error:null});
  }catch(e){const code=publicError(e);return save({state:'error',accountScope:c?.scope??scopeProvider(),service:c?.service??accountSettings(config).service,error:code,message:errorMessage(code),converged:false});}
  finally{await release?.();busy=false;}
 }
 return {status,startLogin,pollLogin,signOut,tick,close(){stopped=true;pending=null;epoch++;cancel();clearInterval(observer)}};
}
