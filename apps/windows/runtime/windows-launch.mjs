import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';import readline from 'node:readline';import {fileURLToPath} from 'node:url';
import {startMacServer as startDesktop} from './desktop-server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),configPath=process.argv[2]??path.join(root,'installation.json');
const config=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
const endpoint='\\\\.\\pipe\\usage-ledger-v2-ui-'+createHash('sha256').update(path.resolve(config.dataDir).toLowerCase()).digest('hex').slice(0,24);
let app,tray,stopping=false;
function show(){if(!app)return;const choices=[config.browserPath,path.join(process.env['ProgramFiles(x86)']??'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe'),path.join(process.env.ProgramFiles??'C:\\Program Files','Microsoft','Edge','Application','msedge.exe')].filter(Boolean),edge=choices.find(x=>fs.existsSync(x));const child=edge?spawn(edge,['--app='+app.url,'--user-data-dir='+path.join(config.dataDir,'desktop-profile'),'--no-first-run'],{windowsHide:true,stdio:'ignore'}):spawn('rundll32.exe',['url.dll,FileProtocolHandler',app.url],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();}
const owner=net.createServer(socket=>{socket.once('data',data=>{if(data.toString().trim()==='show')show();});socket.end();});
const claimed=await new Promise((resolve,reject)=>{owner.once('error',e=>e.code==='EADDRINUSE'?resolve(false):reject(e));owner.listen(endpoint,()=>resolve(true));});
if(!claimed){const client=net.connect(endpoint,()=>client.end('show'));client.on('error',()=>{});}else{
 app=await startDesktop({config,configPath,keepAlive:true,onClosed:()=>{tray?.kill();owner.close();setTimeout(()=>process.exit(0),10);}});
 fs.writeFileSync(path.join(config.dataDir,'desktop-session.json'),JSON.stringify({pid:process.pid,origin:app.origin,token:app.token}),{mode:0o600});show();
 if(!process.argv.includes('--no-tray')){
  const shell=path.join(process.env.WINDIR??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  tray=spawn(shell,['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(root,'runtime/windows-tray.ps1'),'-DataDir',config.dataDir,'-ParentPid',String(process.pid)],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  tray.on('error',()=>{});readline.createInterface({input:tray.stdout}).on('line',line=>{if(line==='show')show();if(line==='quit')void stop();});
 }
 async function stop(){if(stopping)return;stopping=true;tray?.kill();await app.close();owner.close();process.exit(0);}
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop());
}
