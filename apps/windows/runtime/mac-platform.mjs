import os from 'node:os';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
export function macPaths(home=os.homedir(),env=process.env){return {dataDir:path.join(home,'Library','Application Support','UsageLedger','state'),codexHome:env.CODEX_HOME??path.join(home,'.codex'),logRoots:[path.join(home,'Library','Logs','Codex'),path.join(home,'Library','Logs','com.openai.codex'),path.join(home,'Library','Application Support','Codex','logs')]};}
export function mainAppPid(processList){
 const matches=processList.split('\n').map(line=>line.match(/^\s*(\d+)\s+(.+?)\s*$/)).filter(Boolean).filter(m=>/\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(m[2]));
 return matches.length===1?Number(matches[0][1]):null;
}
export function detectMacHost(){if(process.platform!=='darwin')return null;try{return mainAppPid(execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8',timeout:2000}));}catch{return null;}}
export function findLogRoot(config){const roots=config.logRoot?[config.logRoot]:macPaths().logRoots;return roots.find(p=>{try{return fs.statSync(p).isDirectory()}catch{return false}})??null;}
