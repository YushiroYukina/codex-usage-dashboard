import {createPeerLedger} from './peer-ledger.mjs';
import {createPeerTunnel} from './peer-tunnel.mjs';
import {mergedQuota} from './merged-quota.mjs';
import {decodeLedger} from './portable-ledger.mjs';
import {importAccountBundle} from './account-ledger.mjs';
import {detectWindowsHost,windowsLogRoot} from './windows-platform.mjs';
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {openHistory,scanHistory,reportHistory,saveSnapshot} from './history.mjs';import {groupHistory} from './history-range.mjs';import {requestRefresh} from './refresh-client.mjs';import {atomicJson} from './usage.mjs';import {readActiveSession,recentThreadUsage} from './thread-usage.mjs';import {detectMacHost,findLogRoot} from './mac-platform.mjs';
import {healthyWorker,processAlive} from './worker-state.mjs';
import {createDeviceSync,currentScope,pairCode,joinPair,readBody} from './device-sync.mjs';
import {syncSettings,updateSyncSettings,nativeReport,importNativeDocument} from './sync-store.mjs';
import {refreshNativeUsage} from './native-usage.mjs';
import {createAccountSync} from './platform-account.mjs';
import {configureAccountSync,publicError,errorMessage} from './account-client.mjs';
import {accountHistory,accountThreadUsage,publicSyncStatus} from './account-view.mjs';
const ownRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function startMacServer({root=ownRoot,config,configPath=path.join(root,'installation.json'),monitor=true,readQuota=requestRefresh,hostPid=detectWindowsHost,keepAlive=false,parentPid=null,accountOptions={},peerOptions={},tunnelFactory=createPeerTunnel,onClosed=()=>{}}={}){
 config??=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));fs.mkdirSync(config.dataDir,{recursive:true});
 const token=randomBytes(32).toString('hex'),db=openHistory(config.dataDir);let origin='',queue=Promise.resolve(),closed=false,child=null,lastClient=Date.now(),deviceSync=null;
 const sync=()=>deviceSync??=createDeviceSync(config,db,{listen:false});
 const single=config.syncMode==='single';
 const localState=()=>({state:'single_device',paired:false});
 const account=single?{status:localState,close(){}}:createAccountSync(config,db,accountOptions);
 const refreshLocal=async()=>{const r=await readQuota(config,configPath);saveSnapshot(db,r);return r;};
 const peer=single?null:createPeerLedger(config,db,{scan:()=>scanHistory(db,path.join(config.codexHome,'sessions')),refresh:refreshLocal,...peerOptions});
 const tunnel=single?null:tunnelFactory(root,peer);let peerTimerBusy=false;
 const peerTimer=single?null:setInterval(()=>{if(!peerTimerBusy){peerTimerBusy=true;void peer.tick().finally(()=>peerTimerBusy=false);}},5000);
 if(peer?.role()==='host'&&process.platform==='win32')void tunnel.start().catch(()=>{});
 const accountTag=(scope=currentScope(config))=>{return scope?createHash('sha256').update(token+scope).digest('hex'):null};
 const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(config.dataDir,name),'utf8'))}catch{return null}};
 function send(res,code,value){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
 const allowed=new Map([['/icon.png',['assets/icon.png','image/png']],['/',['web/index.html','text/html']],['/app.js',['web/app.js','text/javascript']],['/style.css',['web/style.css','text/css']]]);
 const server=http.createServer((req,res)=>{
  if(req.headers.host!==new URL(origin).host){send(res,403,{error:'Forbidden host'});return;}
  let u;try{u=new URL(req.url,origin)}catch{send(res,400,{error:'Invalid URL'});return;}
  if(allowed.has(u.pathname)&&req.method==='GET'){
   const [file,mime]=allowed.get(u.pathname);res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"});res.end(fs.readFileSync(path.join(root,file)));return;
  }
  const supplied=req.headers['x-ledger-token'];
  if(typeof supplied!=='string'||!/^[0-9a-f]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))||(req.headers.origin&&req.headers.origin!==origin)){send(res,403,{error:'Unauthorized'});return;}
  if(!['GET','POST'].includes(req.method)){send(res,405,{error:'Method not allowed'});return;}
  lastClient=Date.now();
  queue=queue.then(async()=>{if(closed){send(res,503,{error:'Closed'});return;}try{
   if(u.pathname==='/api/report'&&req.method==='GET'){
    const viewScope=currentScope(config),args=u.searchParams;const range=args.has('start')||args.has('end')?{start:args.get('start'),end:args.get('end')}:Number(args.get('days')??7);
    scanHistory(db,path.join(config.codexHome,'sessions'));const r=groupHistory(config.accountSync?accountHistory(db,config,range,new Date(),viewScope):reportHistory(db,range),args.get('span')??'day');if(config.accountSync&&currentScope(config)!==viewScope)throw Error('ACCOUNT_CHANGED');send(res,200,{...r,...(config.accountSync?{accountTag:accountTag(viewScope)}:{})});
   }else if(u.pathname==='/api/refresh'&&req.method==='POST'){
    const r=await refreshLocal();scanHistory(db,path.join(config.codexHome,'sessions'));const peerSync=peer?await peer.tick(true):localState();send(res,200,{ok:r.ok,queryOk:r.queryOk,plan:r.plan,windows:r.windows,error:r.error,peerSync});
   }else if(u.pathname==='/api/live'&&req.method==='GET'){
    const viewScope=currentScope(config),summary=read('usage-summary.json'),q0=read('status.json'),q=config.accountSync?mergedQuota(db,viewScope,q0):q0,logRoot=process.platform==='win32'?windowsLogRoot(config):findLogRoot(config),pid=hostPid();let session=null;
    if(logRoot&&pid)session=readActiveSession(logRoot,pid,path.join(config.dataDir,'mac-active-thread-'+pid+'.json'));
    const activeReport=config.accountSync?accountHistory(db,config,1,new Date(),viewScope):null;
    const currentSync=publicSyncStatus(account.status({credentials:false}));const thread=config.accountSync?accountThreadUsage(db,config,session,viewScope):recentThreadUsage(db,session);if(config.accountSync&&currentScope(config)!==viewScope)throw Error('ACCOUNT_CHANGED');send(res,200,{ledger:activeReport?.ledger??null,accountTag:config.accountSync?accountTag(viewScope):null,quota:q?{ok:q.ok,queryOk:q.queryOk,plan:q.plan,windows:q.windows,observedAt:q.observedAt,error:q.error}:null,summary:config.accountSync?{today:activeReport.sum,weekly:summary?.accountScope===viewScope?summary.weekly:null}:read('usage-summary.json'),notices:config.accountSync?(read('usage-notices.json')?.notices??[]).filter(n=>viewScope&&n.accountScope===viewScope):(read('usage-notices.json')?.notices??[]),accountSync:currentSync,syncMode:single?'single':'sync',peerSync:peer?.status()??localState(),thread});
   }else if(u.pathname==='/api/settings'&&req.method==='GET'){
    const viewScope=currentScope(config),s=single?{label:'本机设备',peers:[],folder:null}:syncSettings(config),native=nativeReport(db,viewScope),accountState=publicSyncStatus(account.status());if(config.accountSync&&currentScope(config)!==viewScope)throw Error('ACCOUNT_CHANGED');send(res,200,{accountTag:config.accountSync?accountTag(viewScope):null,device:s.label,paired:s.peers.length>0,folder:s.folder,status:read('sync-status.json'),nativeStatus:read('native-status.json'),native,syncMode:single?'single':'sync',peerSync:{...(peer?.status()??localState()),...tunnel?.status()},accountSync:accountState});
   }else if(u.pathname==='/api/settings'&&req.method==='POST'){
    const action=await readBody(req,16*1024*1024);let result;
    if(single&&(!['native','import'].includes(action.action))){send(res,403,{error:'单设备版支持本机用量与原生数据操作',code:'SINGLE_DEVICE_MODE'});return;}
    if(action.action==='peer-host'){await refreshLocal();result=await tunnel.start();}
    else if(action.action==='peer-join'){await refreshLocal();result=peer.role()==='client'?await peer.reconnect(action.code):await peer.join(action.code);}
    else if(action.action==='peer-sync'){await refreshLocal();result=await peer.tick(true);}
    else if(action.action==='peer-disconnect'){tunnel.stop();await peer.disconnect();result={ok:true};}
    else if(action.action==='ledger-import'){
     const scope=currentScope(config);if(!scope)throw Error('ACCOUNT_REQUIRED');if(typeof action.bytes!=='string'||action.bytes.length>15*1024*1024)throw Error('LEDGER_TOO_LARGE');
     const {bundle}=decodeLedger(Buffer.from(action.bytes,'base64'),scope);if(currentScope(config)!==scope)throw Error('ACCOUNT_CHANGED');
     result=importAccountBundle(db,bundle,scope);await peer.tick(true);
    }
    else if(action.action==='account-configure')result=configureAccountSync(config,{service:action.service,enabled:action.enabled});
    else if(action.action==='account-login')result=await account.startLogin();
    else if(action.action==='account-poll')result=await account.pollLogin();
    else if(action.action==='account-logout')result=publicSyncStatus(await account.signOut());
    else if(action.action==='account-sync')result=publicSyncStatus(await account.tick(true));
    else if(action.action==='pair')result={code:pairCode(config)};
    else if(action.action==='join')result=joinPair(config,action.code);
    else if(action.action==='sync')result=await sync().tick(true);
    else if(action.action==='native')result=await refreshNativeUsage(config,db,{force:true});
    else if(action.action==='import')result=importNativeDocument(db,currentScope(config),action.document);
    else if(action.action==='folder'){if(typeof action.folder!=='string'||!path.isAbsolute(action.folder))throw Error('Invalid folder');updateSyncSettings(config,{folder:path.resolve(action.folder)});result={saved:true};}
    else throw Error('Unknown action');send(res,200,result);
   }else if(u.pathname==='/api/quit'&&req.method==='POST'){send(res,200,{ok:true});setTimeout(()=>close(),50);}
   else send(res,404,{error:'Not found'});
  }catch(e){const code=publicError(e);send(res,400,{error:errorMessage(code),code});}}).catch(()=>{if(!res.writableEnded)send(res,500,{error:'Internal error'})});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});origin='http://127.0.0.1:'+server.address().port;
 const timer=setInterval(()=>{
  if(monitor)atomicJson(path.join(config.dataDir,'presence.json'),{pid:process.pid,visible:Date.now()-lastClient<120000,at:Date.now()});
  if(monitor&&(!child||child.exitCode!==null)&&!healthyWorker(config.dataDir)){child=spawn(config.nodePath??process.execPath,[path.join(root,'runtime/watch.mjs'),configPath,String(process.pid),'--inherit-stop'],{stdio:'ignore',windowsHide:true});child.on('error',()=>{});}
  if((parentPid&&!processAlive(parentPid))||(!keepAlive&&Date.now()-lastClient>300000))void close();
 },1000);
 async function close(){if(closed)return;closed=true;clearInterval(timer);clearInterval(peerTimer);tunnel?.stop();await peer?.close();if(child&&child.exitCode===null)child.kill();await queue;await deviceSync?.close();account.close();db.close();await new Promise(resolve=>server.close(resolve));onClosed();}
 return {origin,url:origin+'/#'+token,token,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const configPath=process.argv[2]??path.join(ownRoot,'installation.json');const i=process.argv.indexOf('--parent-pid');const parentPid=i>=0?Number(process.argv[i+1]):null;if(parentPid!==null&&(!Number.isSafeInteger(parentPid)||parentPid<=0))throw Error('Invalid parent PID');const app=await startMacServer({configPath,keepAlive:process.argv.includes('--native'),parentPid});console.log(JSON.stringify({url:app.url}));
 if(process.argv.includes('--open-browser')&&process.platform==='darwin')spawn('/usr/bin/open',[app.url],{stdio:'ignore'});
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
