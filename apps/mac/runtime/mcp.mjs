import {refreshNativeUsage} from './native-usage.mjs';
import {accountHistory,accountThreadUsage} from './account-view.mjs';
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {fileURLToPath} from 'node:url';
import {openHistory,scanHistory,saveSnapshot,reportHistory} from './history.mjs';import {groupHistory} from './history-range.mjs';import {requestRefresh} from './refresh-client.mjs';import {recentThreadUsage} from './thread-usage.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const configPath=path.join(root,'installation.json');
const names=['get_usage','get_usage_history','get_thread_usage'];
const schemas=[{}, {days:{type:'integer',enum:[1,7,30]},start:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},end:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},span:{enum:['day','week','month']},refresh:{type:'boolean'}},{session:{type:'string',pattern:'^[0-9a-f-]{36}$'}}];
async function handle(m){if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.method!=='string'){send({id:null,error:{code:-32600,message:'Invalid request'}});return;}if(m.id===undefined)return;let result;try{
 if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'usage-ledger',version:'0.5.0-rc.2'}};
 else if(m.method==='ping')result={};
 else if(m.method==='tools/list')result={tools:names.map((name,i)=>({name,description:['读取实际额度窗口','按北京时间查询当前账号合并账本和额度采样历史','查询指定工作对话最近五轮用量'][i],inputSchema:{type:'object',properties:schemas[i],...(i===2?{required:['session']}:{}),additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}}))};
 else if(m.method==='tools/call'){
  const name=m.params?.name,a=m.params?.arguments??{};if(!names.includes(name))throw Error('Unknown tool');
  const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,'')),db=openHistory(config.dataDir);
  try{if(config.nativeUsage&&name==='get_usage_history')await refreshNativeUsage(config,db);scanHistory(db,path.join(config.codexHome,'sessions'));let current=null;
   if(name==='get_usage'||a.refresh){const r=await requestRefresh(config,configPath);saveSnapshot(db,r);current={ok:r.ok,queryOk:r.queryOk,plan:r.plan,planKnown:r.planKnown,windows:r.windows,observedAt:r.observedAt,error:r.error};}
   let data=current;
   if(name==='get_usage_history')data={current,...groupHistory(config.accountSync?accountHistory(db,config,a.start||a.end?{start:a.start,end:a.end}:a.days??7):reportHistory(db,a.start||a.end?{start:a.start,end:a.end}:a.days??7),a.span??'day')};
   if(name==='get_thread_usage'){if(!/^[0-9a-f-]{36}$/i.test(a.session??''))throw Error('Invalid session');data=config.accountSync?accountThreadUsage(db,config,a.session):recentThreadUsage(db,a.session);}
   result={content:[{type:'text',text:JSON.stringify(data)}]};
  }finally{db.close();}
 }else{send({id:m.id,error:{code:-32601,message:'Unknown method'}});return;}
 send({id:m.id,result});
}catch(e){send({id:m.id,error:{code:-32602,message:['Invalid date range','Date range must contain 1 to 3660 days','Invalid span','Invalid session','Unknown tool'].includes(e.message)?e.message:'Usage Ledger request failed; check installation and arguments'}});}}
function send(o){process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\n')}
let queue=Promise.resolve();readline.createInterface({input:process.stdin}).on('line',line=>{if(line.length>1048576)return;try{const m=JSON.parse(line);queue=queue.then(()=>handle(m));}catch{send({id:null,error:{code:-32700,message:'Invalid JSON'}})}});
