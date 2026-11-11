import fs from 'node:fs';import path from 'node:path';
import {turnTokenUsage,turnWeeklyUsage} from './history-live.mjs';
export function routeMetadata(line){
 if(!line.includes('[electron-message-handler] IAB_LIFECYCLE received browser sidebar owner sync '))return null;
 const route=line.match(/\bownerRoutePath=(\S+)/)?.[1],windowId=line.match(/\bwindowId=(\d+)/)?.[1];
 if(!route||!windowId)return null;
 const session=route.match(/^\/local\/([0-9a-f]{8}-[0-9a-f-]{27})(?:[?#]|$)/i)?.[1]??null;
 return {windowId,session,at:line.slice(0,24)};
}
export function selectedSession(windows){
 const values=Object.values(windows);
 // Never choose "most recently generating" or infer a native window from a title.
 return values.length===1?values[0].session:null;
}
function* files(root,depth=0){if(!fs.existsSync(root)||depth>4)return;for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isDirectory())yield* files(p,depth+1);else if(e.name.endsWith('.log'))yield p;}}
export function readActiveSession(logRoot,hostPid,stateFile){
 if(!/^\d+$/.test(String(hostPid)))return null;
 const matching=[...files(logRoot)].filter(p=>path.basename(p).includes('-'+hostPid+'-t0-')).sort((a,b)=>fs.statSync(a).mtimeMs-fs.statSync(b).mtimeMs);
 if(!matching.length)return null;
 const latest=path.basename(matching.at(-1)).match(/^codex-desktop-([0-9a-f-]{36})-/)?.[1];if(!latest)return null;
 const active=matching.filter(p=>path.basename(p).startsWith('codex-desktop-'+latest+'-'));
 let state={boot:latest,files:{},windows:{}};try{const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(saved.boot===latest)state=saved;}catch{}
 for(const file of active){const size=fs.statSync(file).size;let offset=state.files[file]??0;if(size<offset){offset=0;state.windows={};}if(size===offset)continue;
  const fd=fs.openSync(file,'r');try{const bytes=Buffer.alloc(size-offset);fs.readSync(fd,bytes,0,bytes.length,offset);const end=bytes.lastIndexOf(10);if(end<0)continue;
   for(const line of bytes.subarray(0,end).toString('utf8').split('\n')){const meta=routeMetadata(line);if(meta&&(!state.windows[meta.windowId]||meta.at>=state.windows[meta.windowId].at))state.windows[meta.windowId]=meta;}
   state.files[file]=offset+end+1;
  }finally{fs.closeSync(fd);}
 }
 fs.writeFileSync(stateFile,JSON.stringify(state));return selectedSession(state.windows);
}
export function recentThreadUsage(db,session,scope=undefined){
 if(!session)return {session:null,rows:[],status:'未检测到当前工作对话'};
 const turns=scope===undefined?db.prepare("SELECT * FROM turns WHERE session=? AND child=0 AND status='complete' ORDER BY ended DESC,id DESC LIMIT 5").all(session):scope?db.prepare("SELECT t.* FROM turns t JOIN account_turn_scopes s ON s.id=t.id WHERE t.session=? AND t.child=0 AND t.status='complete' AND s.scope=? ORDER BY t.ended DESC,t.id DESC LIMIT 5").all(session,scope):[];
 return {session,status:turns.length?'':'当前对话暂无已完成记录',rows:turns.map(turn=>({id:turn.id,ended:turn.ended,usage:turnTokenUsage(db,turn,scope),weekly:turnWeeklyUsage(db,turn,scope)}))};
}
