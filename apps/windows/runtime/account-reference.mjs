// Runnable loopback reference for protocol integration. Authentication is an
// injected boundary: this module does not turn a claimed accountScope into login.
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
import {openHistory} from './history.mjs';
import {normalizeBundle,importAccountBundle,exportAccountBundle,ledgerManifest,canonical,MAX_BYTES} from './account-ledger.mjs';
import {publicError} from './account-client.mjs';
export async function startAccountReference({dataDir,authenticate,authHandlers={},port=0}={}){
 if(!dataDir||typeof authenticate!=='function')throw Error('An authentication adapter is required');
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});const stores=new Map();
 function store(scope){if(!stores.has(scope)){const db=openHistory(path.join(dataDir,scope));db.exec('CREATE TABLE IF NOT EXISTS account_devices(id TEXT PRIMARY KEY,label TEXT,platform TEXT,revision INTEGER,digest TEXT,last_seen TEXT)');stores.set(scope,db)}return stores.get(scope)}
 const server=http.createServer(async(req,res)=>{
  function send(status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))}
  if(req.method!=='POST'||req.headers.origin){send(403,{error:'AUTH_DENIED'});return}
  try{
   // Authenticate before reading ledger requests, and derive ownership from the
   // validated token. Do not use body.accountScope to select the tenant.
   let identity=null;
   if(!req.url?.startsWith('/v2/auth/')){identity=await authenticate(req.headers.authorization);if(!identity||!/^[a-f0-9]{64}$/.test(identity.accountScope??'')||typeof identity.deviceId!=='string'||!identity.subject){send(401,{error:'LOGIN_EXPIRED'});return}}
   let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_BYTES){send(413,{error:'LEDGER_TOO_LARGE'});return}chunks.push(chunk)}
   let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{send(400,{error:'INVALID_RESPONSE'});return}
   if(req.url?.startsWith('/v2/auth/')){
    const fn=authHandlers[req.url];if(!fn){send(501,{error:'AUTH_UNAVAILABLE'});return}const r=await fn(b,req.headers.authorization);send(200,r);return;
   }
   if(b.accountScope!==identity.accountScope)throw Error('ACCOUNT_MISMATCH');
   const scope=identity.accountScope,db=store(scope);
   function revision(bundle){const manifest=ledgerManifest(bundle);const prior=db.prepare("SELECT value FROM account_sync_meta WHERE key='revision'").get();const old=prior?JSON.parse(prior.value):{revision:0,digest:null};const next={revision:old.revision+(old.digest===manifest.digest?0:1),digest:manifest.digest};db.prepare("INSERT OR REPLACE INTO account_sync_meta VALUES('revision',?)").run(JSON.stringify(next));return {...next,manifest}}
   if(req.url==='/v2/ledger/exchange'){
    if(b.protocol!==2||!b.device||b.device.id!==identity.deviceId||typeof b.device.label!=='string'||b.device.label.length>80||typeof b.device.platform!=='string'||b.device.platform.length>20)throw Error('INVALID_RESPONSE');
    const incoming=normalizeBundle(b.bundle,scope);if(canonical(ledgerManifest(incoming))!==canonical(b.manifest))throw Error('INVALID_RESPONSE');
    importAccountBundle(db,incoming,scope);const bundle=exportAccountBundle(db,scope),r=revision(bundle);
    db.prepare('INSERT INTO account_devices VALUES(?,?,?,-1,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,platform=excluded.platform,last_seen=excluded.last_seen').run(b.device.id,b.device.label,b.device.platform,'',new Date().toISOString());
    const value={protocol:2,accountScope:scope,revision:r.revision,snapshotAt:new Date().toISOString(),bundle,manifest:r.manifest};
    if(Buffer.byteLength(JSON.stringify(value))>MAX_BYTES){send(413,{error:'LEDGER_TOO_LARGE'});return}send(200,value);
   }else if(req.url==='/v2/ledger/ack'){
    if(b.protocol!==2||b.deviceId!==identity.deviceId)throw Error('AUTH_DENIED');
    const r=revision(exportAccountBundle(db,scope));
    if(b.revision===r.revision&&b.digest===r.digest)db.prepare('UPDATE account_devices SET revision=?,digest=?,last_seen=? WHERE id=?').run(r.revision,r.digest,new Date().toISOString(),b.deviceId);
    send(200,{protocol:2,accountScope:scope,revision:r.revision,digest:r.digest,devices:db.prepare('SELECT id,label,platform,revision,digest FROM account_devices ORDER BY id').all()});
   }else send(404,{error:'INVALID_RESPONSE'});
  }catch(e){const code=publicError(e);send(code==='ACCOUNT_MISMATCH'||code==='AUTH_DENIED'?403:code==='RECORD_CONFLICT'?409:400,{error:code})}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
 return {origin:'http://127.0.0.1:'+server.address().port,stores,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));for(const db of stores.values())db.close()}};
}
