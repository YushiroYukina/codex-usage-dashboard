import {detectMacHost,findLogRoot} from './mac-platform.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {openHistory} from './history.mjs';import {readActiveSession,recentThreadUsage} from './thread-usage.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8').replace(/^\uFEFF/,''));
const hostPid=process.argv[2]??String(detectMacHost()??0);
const packaged=path.join(process.env.LOCALAPPDATA??'','Packages','OpenAI.Codex_2p2nqsd0c76g0','LocalCache','Local','Codex','Logs');
const logRoot=process.platform==='darwin'?findLogRoot(config):(fs.existsSync(packaged)?packaged:path.join(process.env.LOCALAPPDATA??'','Codex','Logs'));
const session=logRoot?readActiveSession(logRoot,hostPid,path.join(config.dataDir,'active-thread-'+(/^[0-9]+$/.test(hostPid)?hostPid:'unknown')+'.json')):null;
const db=openHistory(config.dataDir);try{console.log(JSON.stringify(recentThreadUsage(db,session)));}finally{db.close();}
