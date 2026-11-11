// Paired-device transport. Authentication is possession of an OS-protected
// pairing secret, never accountScope. The ledger inside remains protocol v2.
import './network.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {exportAccountBundle,importAccountBundle,normalizeBundle,ledgerManifest,canonical,MAX_BYTES} from './account-ledger.mjs';
import {atomicJson} from './usage.mjs';
import {currentScope} from './device-sync.mjs';
import {windowsSecrets} from './windows-secrets.mjs';
import {keychainStore} from './account-client.mjs';
import {cachedLedger} from './cached-ledger.mjs';

const AAD=Buffer.from('UsageLedger-paired-v2');
const uuid=s=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
export function peerURL(value,{allowLocal=false}={}){
 const u=new URL(value);
 if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!(u.protocol==='https:'||allowLocal&&u.protocol==='http:'&&u.hostname==='127.0.0.1'))throw Error('INVALID_SERVICE');
 return u.origin;
}
export function encryptPeer(value,key){
 const raw=Buffer.from(JSON.stringify(value));if(raw.length>MAX_BYTES)throw Error('LEDGER_TOO_LARGE');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'base64url'),iv);cipher.setAAD(AAD);
 return Buffer.concat([iv,cipher.update(gzipSync(raw)),cipher.final(),cipher.getAuthTag()]);
}
export function decryptPeer(bytes,key){
 if(bytes.length<28||bytes.length>MAX_BYTES)throw Error('INVALID_RESPONSE');
 try{const decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64url'),bytes.subarray(0,12));decipher.setAAD(AAD);decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]),{maxOutputLength:MAX_BYTES}));
 }catch{throw Error('INVALID_RESPONSE');}
}
async function boundedBody(stream){let n=0;const parts=[];for await(const part of stream){n+=part.length;if(n>MAX_BYTES)throw Error('LEDGER_TOO_LARGE');parts.push(Buffer.from(part));}return Buffer.concat(parts);}

export function createPeerLedger(config,db,{
 secrets=process.platform==='win32'?windowsSecrets(config):keychainStore(config),
 scopeProvider=()=>{const q=read(path.join(config.dataDir,'status.json'));return Date.now()-(q?.checkedAt??q?.observedAt??0)<180000?currentScope(config):null;},
 scan=()=>{},refresh=async()=>{},fetcher=fetch,now=()=>Date.now(),allowLocal=false,
}={}){
 const file=path.join(config.dataDir,'paired-device.json');let p=read(file),key=null,server=null,origin=null,endpoint=null,closed=false,busy=null,epoch=0,receipt=null,lastSeen=0,error=null,queue=Promise.resolve(),refreshTicket=0,seenTicket=0;
 const replay=new Map(),requests=new Set();
 db.exec('CREATE TABLE IF NOT EXISTS peer_revisions (pair TEXT PRIMARY KEY, digest TEXT, revision INTEGER)');
 function context(){if(closed)throw Error('SYNC_DISABLED');const scope=scopeProvider();if(!scope)throw Error('ACCOUNT_REQUIRED');if(!p||p.scope!==scope)throw Error(p?'ACCOUNT_MISMATCH':'PAIR_REQUIRED');
  key??=secrets.read('usage-ledger-pair|'+p.group)?.key;if(!/^[A-Za-z0-9_-]{43}$/.test(key??''))throw Error('CREDENTIAL_STORE_UNAVAILABLE');return {scope,group:p.group,epoch};}
 function guard(c){if(closed||epoch!==c.epoch||p?.group!==c.group||p?.scope!==c.scope||scopeProvider()!==c.scope)throw Error('ACCOUNT_CHANGED');}
 function persist(){atomicJson(file,p);}
 function snapshot(){const c=context();scan();guard(c);return cachedLedger(db,c.scope);}
 function revision(manifest){const row=db.prepare('SELECT * FROM peer_revisions WHERE pair=?').get(p.group);if(row?.digest===manifest.digest)return row.revision;const rev=(row?.revision??0)+1;db.prepare('INSERT OR REPLACE INTO peer_revisions VALUES(?,?,?)').run(p.group,manifest.digest,rev);return rev;}
 function status(){
  if(!p)return {state:'not_paired',paired:false};
  let local;try{local=snapshot().manifest;}catch(e){return {state:e.message==='ACCOUNT_MISMATCH'?'account_changed':'account_required',paired:true,role:p.role};}
  const fresh=now()-lastSeen<20000,match=receipt?.manifest?.digest===local.digest;
  const state=busy?'syncing':error?'offline':fresh&&match&&receipt?.converged?'converged':p.remote?(match&&fresh?'uploaded':'pending'):'waiting';
  return {state,paired:true,role:p.role,connected:!!p.remote&&fresh,manifest:local,revision:receipt?.revision??null,devices:p.remote?2:1,lastSuccess:lastSeen?new Date(lastSeen).toISOString():null,error,needsConnection:p.role==='host'&&!endpoint,temporary:true};
 }
 function merge(bundle,c){const normalized=normalizeBundle(bundle,c.scope);guard(c);db.exec('BEGIN IMMEDIATE');try{const imported=importAccountBundle(db,normalized,c.scope);guard(c);db.exec('COMMIT');return imported;}catch(e){db.exec('ROLLBACK');throw e;}}
 async function handle(message){
  const c=context();if(message.group!==p.group||message.scope!==c.scope||message.protocol!==2)throw Error('ACCOUNT_MISMATCH');
  if(!uuid(message.device)||message.device===p.device||p.remote&&p.remote!==message.device)throw Error('DEVICE_MISMATCH');
  if(!uuid(message.nonce)||!Number.isFinite(message.at)||Math.abs(now()-message.at)>180000)throw Error('INVALID_RESPONSE');
  for(const [id,t] of replay)if(now()-t>180000)replay.delete(id);if(replay.has(message.nonce)||replay.size>4096)throw Error('INVALID_RESPONSE');replay.set(message.nonce,now());
  if(message.force){await refresh();guard(c);refreshTicket++;}
  let s=snapshot();
  if(message.action==='exchange'){
   const verified=ledgerManifest(normalizeBundle(message.bundle,c.scope));if(canonical(verified)!==canonical(message.manifest))throw Error('INVALID_RESPONSE');
   merge(message.bundle,c);s=snapshot();
  }else if(!['hello','ack'].includes(message.action))throw Error('INVALID_RESPONSE');
  const rev=revision(s.manifest),same=message.manifest?.digest===s.manifest.digest;
  if(message.action==='ack'&&message.revision===rev&&same){receipt={manifest:s.manifest,revision:rev,converged:true};}
  else if(!same||receipt?.revision!==rev)receipt={manifest:s.manifest,revision:rev,converged:false};
  if(!p.remote){p.remote=message.device;persist();}
  guard(c);lastSeen=now();error=null;
  return {protocol:2,group:p.group,scope:c.scope,nonce:message.nonce,device:p.device,manifest:s.manifest,revision:rev,converged:!!receipt?.converged&&receipt.revision===rev,refreshTicket,...(message.action==='exchange'?{bundle:s.bundle}:{})};
 }
 async function listen(){if(server)return origin;server=http.createServer((req,res)=>{
   req.setTimeout(120000,()=>req.destroy());
   if(req.method!=='POST'||req.url!=='/paired/v2/exchange'){res.writeHead(404);res.end();return;}
   if(req.headers.origin){res.writeHead(403);res.end();return;}
   queue=queue.then(async()=>{try{context();const captured=key,message=decryptPeer(await boundedBody(req),captured),result=await handle(message);res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});res.end(encryptPeer(result,captured));}catch{res.writeHead(403,{'Cache-Control':'no-store'});res.end();}}).catch(()=>{res.destroy();});
  });server.requestTimeout=120000;server.headersTimeout=15000;server.maxConnections=16;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;return origin;
 }
 async function startHost(){const scope=scopeProvider();if(!scope)throw Error('ACCOUNT_REQUIRED');if(p&&p.scope!==scope)throw Error('ACCOUNT_MISMATCH');
  if(p&&p.role!=='host')throw Error('ALREADY_PAIRED');
  if(!p){p={protocol:2,role:'host',scope,device:randomUUID(),group:randomUUID(),remote:null};key=randomBytes(32).toString('base64url');secrets.write('usage-ledger-pair|'+p.group,{key});persist();}
  context();return listen();
 }
 function setEndpoint(url){endpoint=peerURL(url,{allowLocal});}
 function code(){context();if(p.role!=='host'||!endpoint)throw Error('CONNECTION_STARTING');return 'UL2.'+Buffer.from(JSON.stringify({protocol:2,group:p.group,host:p.device,endpoint,key})).toString('base64url');}
 async function join(value){
  if(p)throw Error('ALREADY_PAIRED');const scope=scopeProvider();if(!scope)throw Error('ACCOUNT_REQUIRED');
  let v;try{if(typeof value!=='string'||value.length>4096||!value.startsWith('UL2.'))throw Error();v=JSON.parse(Buffer.from(value.slice(4),'base64url'));if(v.protocol!==2||!uuid(v.group)||!uuid(v.host)||!/^[A-Za-z0-9_-]{43}$/.test(v.key))throw Error();v.endpoint=peerURL(v.endpoint,{allowLocal});}catch{throw Error('INVALID_PAIR_CODE');}
  p={protocol:2,role:'client',scope,device:randomUUID(),group:v.group,remote:v.host,endpoint:v.endpoint};key=v.key;
  secrets.write('usage-ledger-pair|'+p.group,{key});persist();return tick(true);
 }
 async function reconnect(value){context();if(!p||p.role!=='client')throw Error('PAIR_REQUIRED');let v;try{v=JSON.parse(Buffer.from(value.slice(4),'base64url'));if(!value.startsWith('UL2.')||value.length>4096||v.group!==p.group||v.host!==p.remote||v.key!==key)throw Error();v.endpoint=peerURL(v.endpoint,{allowLocal});}catch{throw Error('INVALID_PAIR_CODE');}p.endpoint=v.endpoint;epoch++;persist();return tick(true);}
 async function post(body,c){
  const nonce=randomUUID(),controller=new AbortController();requests.add(controller);
  try{guard(c);const response=await fetcher(p.endpoint+'/paired/v2/exchange',{method:'POST',redirect:'error',headers:{'Content-Type':'application/octet-stream'},body:encryptPeer({protocol:2,group:p.group,scope:c.scope,device:p.device,nonce,at:now(),...body},key),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});guard(c);
   if(!response.ok)throw Error('PEER_UNAVAILABLE');const reply=decryptPeer(await boundedBody(response.body),key);guard(c);
   if(reply.nonce!==nonce||reply.device!==p.remote||reply.scope!==c.scope||reply.group!==p.group||reply.protocol!==2||!Number.isSafeInteger(reply.revision)||reply.revision<1)throw Error('INVALID_RESPONSE');return reply;
  }finally{requests.delete(controller);}
 }
 async function run(force){
  const c=context();if(p.role==='host'){if(force)refreshTicket++;snapshot();return;}
  let local=snapshot();let r=await post({action:'hello',manifest:local.manifest,force},c);
  if(r.refreshTicket!==seenTicket){await refresh();guard(c);seenTicket=r.refreshTicket;local=snapshot();}
  if(r.manifest?.digest!==local.manifest.digest){
   r=await post({action:'exchange',bundle:local.bundle,manifest:local.manifest},c);
   const normalized=normalizeBundle(r.bundle,c.scope),verified=ledgerManifest(normalized);if(canonical(verified)!==canonical(r.manifest))throw Error('INVALID_RESPONSE');
   for(const kind of ['tokens','snapshots','native']){const ids=new Set(normalized[kind].map(x=>x.id));if(local.bundle[kind].some(x=>!ids.has(x.id)))throw Error('INVALID_RESPONSE');}
   merge(normalized,c);local=snapshot();
  }
  guard(c);
  if(local.manifest.digest===r.manifest?.digest)r=await post({action:'ack',manifest:local.manifest,revision:r.revision},c);
  guard(c);receipt={manifest:r.manifest,revision:r.revision,converged:r.converged===true&&r.manifest?.digest===snapshot().manifest.digest};lastSeen=now();error=null;
 }
 async function tick(force=false){if(closed||!p)return status();if(busy){await busy;if(force)return tick(true);return status();}
  busy=run(force).catch(e=>{error=['ACCOUNT_CHANGED','ACCOUNT_REQUIRED','ACCOUNT_MISMATCH','RECORD_CONFLICT','INVALID_RESPONSE','LEDGER_TOO_LARGE','CREDENTIAL_STORE_UNAVAILABLE'].includes(e.message)?e.message:'PEER_UNAVAILABLE';receipt=null;}).finally(()=>busy=null);await busy;return status();
 }
 async function disconnect(){epoch++;for(const r of requests)r.abort();if(busy)await busy;await queue;if(p)secrets.remove('usage-ledger-pair|'+p.group);p=null;key=null;receipt=null;lastSeen=0;error=null;endpoint=null;try{fs.unlinkSync(file);}catch{};if(server){server.closeAllConnections();await new Promise(r=>server.close(r));server=null;origin=null;}}
 async function close(){closed=true;epoch++;for(const r of requests)r.abort();if(busy)await busy;await queue;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));server=null;}}
 return {status,tick,startHost,setEndpoint,code,join,reconnect,disconnect,close,role:()=>p?.role??null};
}
