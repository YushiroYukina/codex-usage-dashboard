import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

// Only the dedicated encrypted peer listener is forwarded. Never the UI server.
export function createPeerTunnel(root,peer,{platform=process.platform}={}){
 let child=null,pending=null,url=null,lastError=null;
 async function start(){
  if(platform!=='win32')throw Error('HOST_WINDOWS_REQUIRED');
  if(url&&child&&child.exitCode===null)return {code:peer.code()};
  if(pending)return pending;
  pending=(async()=>{
   const exe=path.join(root,'tools','cloudflared.exe');
   // The release manifest pins the separately bundled vendor executable.
   const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools','cloudflared.json'),'utf8'));
   if(!fs.existsSync(exe)||manifest.sha256!=='2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343'||createHash('sha256').update(fs.readFileSync(exe)).digest('hex')!==manifest.sha256)throw Error('TUNNEL_UNAVAILABLE');
   const origin=await peer.startHost();lastError=null;
   return new Promise((resolve,reject)=>{
    let settled=false,tail='';
    child=spawn(exe,['tunnel','--no-autoupdate','--protocol','http2','--edge-ip-version','4','--url',origin,'--metrics','127.0.0.1:0'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env}});
    const timer=setTimeout(()=>{if(!settled){settled=true;child?.kill();lastError='TUNNEL_UNAVAILABLE';reject(Error(lastError));}},45000);
    const fail=()=>{url=null;lastError='TUNNEL_UNAVAILABLE';clearTimeout(timer);if(!settled){settled=true;reject(Error(lastError));}};
    child.once('error',fail);child.once('exit',fail);
    const receive=data=>{tail=(tail+data.toString()).slice(-16000);const m=tail.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);if(m&&!settled){settled=true;clearTimeout(timer);url=m[0];peer.setEndpoint(url);resolve({code:peer.code()});}};
    child.stdout.on('data',receive);child.stderr.on('data',receive);
   });
  })().finally(()=>pending=null);return pending;
 }
 function stop(){child?.kill();child=null;url=null;}
 return {start,stop,status:()=>({running:!!url&&child?.exitCode===null,error:lastError,canHost:platform==='win32'})};
}
