import {spawn} from 'node:child_process';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {startMacServer} from './mac-server.mjs';
const configPath=process.argv[2]??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../installation.json');
const app=await startMacServer({configPath});
const url=app.url+'?settings';
const child=process.platform==='darwin'?spawn('/usr/bin/open',[url],{stdio:'ignore'}):spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true});child.on('error',()=>{});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
