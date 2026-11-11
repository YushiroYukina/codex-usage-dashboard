import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import os from 'node:os';import {randomUUID,createHash} from 'node:crypto';
import {syncSettings,updateSyncSettings,exportBundle,importBundle,seal,unseal} from './sync-store.mjs';
import {atomicJson} from './usage.mjs';
const MAX=64*1024*1024;
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
export function currentScope(config){const s=read(path.join(config.dataDir,'status.json'));return s?.accountVerified!==false&&/^[a-f0-9]{64}$/.test(s?.accountKey??'')?s.accountKey:null;}
function peerURL(value){const u=new URL(value);if(u.protocol!=='http:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!u.port||!/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname))throw Error('设备地址无效');return u.origin;}
export function pairCode(config){const s=syncSettings(config),ips=Object.values(os.networkInterfaces()).flat().filter(n=>n.family==='IPv4'&&!n.internal).map(n=>n.address);return 'UL1.'+Buffer.from(JSON.stringify({group:s.group,key:s.key,urls:(ips.length?ips:['127.0.0.1']).map(ip=>'http://'+ip+':'+s.port)})).toString('base64url');}
export function joinPair(config,code){
 if(typeof code!=='string'||code.length>4096||!code.startsWith('UL1.'))throw Error('配对码无效');let value;try{value=JSON.parse(Buffer.from(code.slice(4),'base64url').toString('utf8'));}catch{throw Error('配对码无效');}
 if(!/^[A-Za-z0-9_-]{43}$/.test(value.key??'')||typeof value.group!=='string'||!Array.isArray(value.urls)||!value.urls.length||value.urls.length>20)throw Error('配对码无效');
 const peers=value.urls.map(peerURL);updateSyncSettings(config,{key:value.key,group:value.group,peers});return {paired:true};
}
export async function readBody(req,max=MAX){let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>max)throw Error('文件过大');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function createDeviceSync(config,db,{listen=true,host='0.0.0.0'}={}){
 let state=syncSettings(config),busy=false,stopped=false,server=null,networkBusy=false,lastHash=null;
 let status={enabled:true,paired:state.peers.length>0,device:state.label,devices:[],lastSync:null,error:null,network:false};const replay=new Map();
 const saveStatus=()=>atomicJson(path.join(config.dataDir,'sync-status.json'),status);
 async function tick(force=false){
  if(busy||stopped)return status;busy=true;
  try{
   const latest=syncSettings(config);if(latest.group!==state.group||latest.folder!==state.folder)lastHash=null;state=latest;status.paired=state.peers.length>0;
   const scope=currentScope(config);if(!scope){status.error='等待核实当前登录账号';saveStatus();return status;}
   fs.mkdirSync(state.folder,{recursive:true,mode:0o700});let imported=0;
   for(const file of fs.readdirSync(state.folder).filter(n=>/^[a-f0-9-]{36}\.ulsync$/.test(n))){
    try{const full=path.join(state.folder,file),stat=fs.statSync(full);if(stat.size>MAX)continue;const envelope=read(full);if(envelope?.group!==state.group)continue;const b=unseal(envelope.packet,state.key);if(b.scope!==scope)continue;const r=importBundle(db,b,scope);imported+=r.tokensAdded;}catch{status.error='有同步包无法验证，已跳过';}
   }
   const bundle=exportBundle(db,scope,state),hash=createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
   if(force||hash!==lastHash){atomicJson(path.join(state.folder,state.device+'.ulsync'),{group:state.group,packet:seal(bundle,state.key)});lastHash=hash;}
   if(state.peers.length&&!networkBusy){networkBusy=true;try{
    let reached=false;for(const url of state.peers){try{
     const nonce=randomUUID(),res=await fetch(peerURL(url)+'/v1/exchange',{method:'POST',headers:{'Content-Type':'application/json','X-UL-Group':state.group},body:JSON.stringify(seal({nonce,at:Date.now(),bundle},state.key)),signal:AbortSignal.timeout(15000),redirect:'error'});
     if(!res.ok)throw Error('Peer rejected');const reply=unseal(await res.json(),state.key);if(reply.nonce!==nonce)throw Error('Invalid response');importBundle(db,reply.bundle,scope);reached=true;break;
    }catch{}}
    status.error=reached?null:'另一设备暂未连接；本地记录已保留';status.network=reached;
   }finally{networkBusy=false;}}
   else if(!state.peers.length)status.error=null;
   status.lastSync=new Date().toISOString();status.localMergedTokens=imported;status.devices=db.prepare('SELECT label,platform,last_seen AS lastSeen FROM sync_devices').all();saveStatus();
  }catch{status.error='同步暂不可用，原有记录已保留';saveStatus();}finally{busy=false;}return status;
 }
 async function start(){
  if(!listen)return;server=http.createServer(async(req,res)=>{
   const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
   if(req.method!=='POST'||req.url!=='/v1/exchange'||req.headers.origin){json(403,{error:'Forbidden'});return;}
   try{
    state=syncSettings(config);if(req.headers['x-ul-group']!==state.group){json(403,{error:'Unpaired'});return;}
    const value=unseal(await readBody(req),state.key);if(typeof value.nonce!=='string'||Math.abs(Date.now()-value.at)>120000||replay.has(value.nonce))throw Error('Replay');
    replay.set(value.nonce,Date.now());for(const [k,v]of replay)if(Date.now()-v>120000)replay.delete(k);
    const scope=currentScope(config);importBundle(db,value.bundle,scope);const bundle=exportBundle(db,scope,state);json(200,seal({nonce:value.nonce,bundle},state.key));status.lastSync=new Date().toISOString();status.network=true;saveStatus();
   }catch{json(403,{error:'Invalid or different account'});}
  });
  await new Promise(resolve=>{server.once('error',()=>{status.listener='本机已有同步入口或端口不可用';resolve();});server.listen(state.port,host,()=>{status.listener='就绪';resolve();});});
 }
 return {start,tick,status:()=>status,async close(){stopped=true;if(server?.listening)await new Promise(r=>server.close(r));}};
}
