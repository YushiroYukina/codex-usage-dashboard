import {accountHistory} from './account-view.mjs';
import {refreshNativeUsage} from './native-usage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openHistory,scanHistory,saveSnapshot,reportHistory} from './history.mjs';
import {requestRefresh} from './refresh-client.mjs';
import {groupHistory} from './history-range.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const configPath=path.join(root,'installation.json');
const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
const db=openHistory(config.dataDir);
try{
  if(config.nativeUsage)await refreshNativeUsage(config,db);
  const scan=scanHistory(db,path.join(config.codexHome,'sessions'));
  let current=null;
  if(process.argv.includes('--refresh')){current=await requestRefresh(config,configPath);saveSnapshot(db,current);}
  else {try{current=JSON.parse(fs.readFileSync(path.join(config.dataDir,'status.json'),'utf8'));saveSnapshot(db,current);}catch{}}
  // Return only quota metadata, never account identifiers or authentication data.
  const result={scan,current:current?{ok:current.ok,queryOk:current.queryOk,plan:current.plan,planKnown:current.planKnown,observedAt:current.observedAt,error:current.error,windows:current.windows}:null,reports:Object.fromEntries([1,7,30].map(d=>[d,accountHistory(db,config,d)]))};
  const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
  if(arg('--start')||arg('--end'))result.reports.custom=groupHistory(accountHistory(db,config,{start:arg('--start'),end:arg('--end')}),arg('--span')??'day');
  const output=process.argv.indexOf('--output');
  if(output>=0){const file=process.argv[output+1];fs.writeFileSync(file+'.tmp',JSON.stringify(result));fs.renameSync(file+'.tmp',file);}else console.log(JSON.stringify(result));
}finally{db.close();}
