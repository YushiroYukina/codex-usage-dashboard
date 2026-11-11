import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
export function windowsSecrets(config){
 const root=path.join(config.dataDir,'credentials-dpapi'),cache=new Map();
 function file(key){if(typeof key!=='string'||key.length>4096)throw Error('CREDENTIAL_STORE_UNAVAILABLE');return path.join(root,createHash('sha256').update(key).digest('hex')+'.dpapi');}
 function call(request){if(process.platform!=='win32')throw Error('CREDENTIAL_STORE_UNAVAILABLE');const shell=path.join(process.env.WINDIR??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');const r=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows-secrets.ps1',import.meta.url))],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});if(r.status!==0)throw Error('CREDENTIAL_STORE_UNAVAILABLE');try{return JSON.parse(r.stdout.replace(/^\uFEFF/,''));}catch{throw Error('CREDENTIAL_STORE_UNAVAILABLE');}}
 return {
  read(key){const name=file(key);if(!fs.existsSync(name)){cache.delete(key);return null;}const stat=fs.statSync(name),signature=stat.size+'|'+stat.mtimeMs+'|'+stat.ctimeMs,prior=cache.get(key);if(prior&&prior.signature===signature&&Date.now()-prior.at<60000)return structuredClone(prior.value);let blob;try{blob=fs.readFileSync(name,'utf8');}catch{throw Error('CREDENTIAL_STORE_UNAVAILABLE');}const value=call({action:'unprotect',key,blob}).value;cache.set(key,{signature,at:Date.now(),value});return structuredClone(value);},
  write(key,value){cache.delete(key);const blob=call({action:'protect',key,value}).blob;if(typeof blob!=='string')throw Error('CREDENTIAL_STORE_UNAVAILABLE');fs.mkdirSync(root,{recursive:true});const name=file(key),tmp=name+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(tmp,blob,{flag:'wx',mode:0o600});fs.renameSync(tmp,name);}finally{try{fs.unlinkSync(tmp);}catch{}}},
  remove(key){cache.delete(key);try{fs.unlinkSync(file(key));}catch(e){if(e.code!=='ENOENT')throw Error('CREDENTIAL_STORE_UNAVAILABLE');}}
 };
}
