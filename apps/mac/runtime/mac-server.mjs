import {startMacServer as start} from './desktop-server.mjs';
import {detectMacHost} from './mac-platform.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawn} from 'node:child_process';
export const startMacServer=options=>start({hostPid:detectMacHost,...options});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),configPath=process.argv[2]??path.join(root,'installation.json'),i=process.argv.indexOf('--parent-pid');
 const app=await startMacServer({configPath,keepAlive:process.argv.includes('--native'),parentPid:i>=0?Number(process.argv[i+1]):null});console.log(JSON.stringify({url:app.url}));
 if(process.argv.includes('--open-browser'))spawn('/usr/bin/open',[app.url],{stdio:'ignore'});
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
