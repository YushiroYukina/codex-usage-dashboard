import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {spawn} from 'node:child_process';
import {accountFingerprint,resolveCodexExecutable,atomicJson} from './usage.mjs';
import {saveNativeRecord,importNativeDocument,nativeReport} from './sync-store.mjs';

export function readNativeProfile(cli,{timeoutMs=25000,spawnProcess=spawn}={}){
 return new Promise(resolve=>{
  let child,lines,scope=null,finished=false,expected=1;
  const stop=()=>{try{child?.stdin.end();child?.kill();}catch{}};
  const end=result=>{if(finished)return;finished=true;clearTimeout(timer);process.removeListener('exit',stop);lines?.close();try{child?.stdin.end();child?.kill();}catch{}resolve(result);};
  const timer=setTimeout(()=>end({ok:false,error:'原生用量读取超时'}),timeoutMs);
  try{child=spawnProcess(resolveCodexExecutable(cli),['app-server','--stdio'],{windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{return end({ok:false,error:'无法启动原生用量接口'});}
  process.once('exit',stop);
  child.on('error',()=>end({ok:false,error:'原生用量接口不可用'}));child.on('close',()=>end({ok:false,error:'原生用量接口已退出'}));child.stderr.resume();child.stdin.on('error',()=>end({ok:false,error:'原生用量连接失败'}));
  const send=value=>{try{child.stdin.write(JSON.stringify(value)+'\n');}catch{end({ok:false,error:'原生用量连接失败'});}};
  lines=readline.createInterface({input:child.stdout});lines.on('line',line=>{
   if(line.length>8*1024*1024)return;let m;try{m=JSON.parse(line);}catch{return;}if(m?.id!==expected)return;
   if(m.error)return end({ok:false,error:expected===3?'当前客户端未提供原生 Token 查询':'无法核实原生用量所属账号'});
   if(expected===1){send({method:'initialized',params:{}});expected=2;send({id:2,method:'account/read',params:{refreshToken:false}});}
   else if(expected===2){scope=accountFingerprint(m.result?.account);if(!scope)return end({ok:false,error:'原生用量账号未核实'});expected=3;send({id:3,method:'account/usage/read',params:{}});}
   else end({ok:true,scope,profile:m.result});
  });send({id:1,method:'initialize',params:{clientInfo:{name:'usage_ledger_native_usage',version:'0.3.0'},capabilities:{experimentalApi:true}}});
 });
}
export async function refreshNativeUsage(config,db,{force=false,reader=readNativeProfile}={}){
 const file=path.join(config.dataDir,'native-status.json');let prior;try{prior=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 let active;try{active=JSON.parse(fs.readFileSync(path.join(config.dataDir,'status.json'),'utf8')).accountKey;}catch{}
 if(!force&&prior?.profileOk&&prior.scope===active&&Date.now()-prior.at<21600000)return prior;
 const result=await reader(config.codexPath);const status={at:Date.now(),profileOk:result.ok,scope:result.scope??null,profileError:result.error??null,quotaOk:false,quotaStatus:'原生历史额度尚未导入；当前 CLI 只开放 Token 查询'};
 if(result.ok){saveNativeRecord(db,result.scope,'profile',result.profile);status.nativeDays=result.profile.dailyUsageBuckets?.length??0;status.quotaOk=nativeReport(db,result.scope).periods.length>0;}
 // Native export inbox contains usage metadata only. Nothing reads auth.json, cookies or browser credential stores.
 const inbox=path.join(config.dataDir,'native-import.json');if(result.ok&&fs.existsSync(inbox)){
  try{if(fs.statSync(inbox).size>8*1024*1024)throw Error('large');const doc=JSON.parse(fs.readFileSync(inbox,'utf8'));if(doc.scope&&doc.scope!==result.scope)throw Error('account');status.imported=importNativeDocument(db,result.scope,doc).imported;status.quotaOk=nativeReport(db,result.scope).periods.length>0;}catch{status.quotaStatus='原生额度文件未通过检查，未导入';}
 }
 if(status.quotaOk)status.quotaStatus='已导入原生周期额度';atomicJson(file,status);return status;
}
