import {backupLedger} from './backup-ledger.mjs';
import {healthyWorker} from './worker-state.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {resolveCodexExecutable} from './usage.mjs';import {macPaths} from './mac-platform.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),version='0.5.0-rc.2';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
if(process.platform!=='darwin')throw Error('此安装器仅用于 macOS；Windows 版无需修改。');
if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24 或更高版本。');
const edition=JSON.parse(fs.readFileSync(path.join(source,'edition.json'),'utf8')),single=edition.mode==='single';
const home=os.homedir(),defaults=macPaths(home),root=path.resolve(arg('--install-dir')??path.join(home,'Library','Application Support','UsageLedger','development','app-'+version+(single?'-single':'')));
let previous={};try{previous=JSON.parse(fs.readFileSync(path.join(home,'Library','Application Support','UsageLedger','development','app-0.4.0-dev.1','installation.json'),'utf8'));}catch{}
const codexPath=resolveCodexExecutable(arg('--codex-path')??process.env.USAGE_LEDGER_CODEX_PATH??previous.codexPath);
if(!codexPath||!fs.existsSync(codexPath))throw Error('找不到 Codex CLI。先安装 Codex 桌面版，或传 --codex-path /完整路径/codex。');
if(fs.existsSync(path.join(root,'installation.json')))throw Error('此版本目录已经安装。请先退出并使用 --install-dir 指定新的独立目录。');
const dataDir=path.resolve(arg('--data-dir')??(single?path.join(home,'Library','Application Support','UsageLedgerSingle','state'):previous.dataDir)??(fs.existsSync(path.join(path.dirname(defaults.dataDir),'state-0.4.0-dev.1','usage-history.sqlite'))?path.join(path.dirname(defaults.dataDir),'state-0.4.0-dev.1'):path.join(path.dirname(defaults.dataDir),'state-0.5.0'))),codexHome=path.resolve(arg('--codex-home')??previous.codexHome??defaults.codexHome);
if(root===codexHome||root===dataDir)throw Error('程序、数据和 Codex 记录目录必须分开。');
if(healthyWorker(dataDir))throw Error('旧版Codex 用量看板仍在运行。请在准备切换时退出Codex 用量看板后重试；无需退出 Codex，也无需重启 Mac。');
try{if(!single)execFileSync('/usr/bin/xcode-select',['-p'],{stdio:'ignore',timeout:5000});}catch{throw Error('配对密钥需要钥匙串辅助程序。请先安装 Xcode 命令行工具，再重新运行安装。');}
await backupLedger(dataDir);
const app=path.join(home,'Applications',(single?'Codex 用量看板单设备版.app':'Codex 用量看板.app')),contents=path.join(app,'Contents'),macos=path.join(contents,'MacOS');
if(fs.existsSync(app))throw Error('~/Applications/Codex 用量看板.app 已存在，未覆盖；请退出旧应用并另存旧入口后重试。');
fs.mkdirSync(root,{recursive:true});fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
for(const entry of fs.readdirSync(source)){if(['installation.json','.DS_Store','.git','node_modules','bin'].includes(entry))continue;const from=path.join(source,entry),to=path.join(root,entry);if(from!==to)fs.cpSync(from,to,{recursive:true,errorOnExist:false});}
const config={version,syncMode:edition.mode,nodePath:process.execPath,codexPath,dataDir,codexHome,historyTurnUsage:true,crossDeviceSync:false,pairedSync:!single,syncRoot:path.join(dataDir,'legacy-sync'),nativeUsage:true,accountSync:true,secretHelper:path.join(root,'bin','UsageLedgerSecrets'),...((arg('--log-root')??previous.logRoot)?{logRoot:path.resolve(arg('--log-root')??previous.logRoot)}:{})};
fs.writeFileSync(path.join(root,'installation.json'),JSON.stringify(config,null,2),{mode:0o600});
fs.writeFileSync(path.join(root,'.mcp.json'),JSON.stringify({mcpServers:{usage_ledger:{command:process.execPath,args:[path.join(root,'runtime/mcp.mjs')]}}},null,2));


fs.mkdirSync(macos,{recursive:true});
const resources=path.join(contents,'Resources');fs.mkdirSync(resources,{recursive:true});
fs.writeFileSync(path.join(resources,'launcher.json'),JSON.stringify({nodePath:process.execPath,serverPath:path.join(root,'runtime/mac-server.mjs'),configPath:path.join(root,'installation.json')}));
fs.copyFileSync(path.join(root,'macos/Info.plist'),path.join(contents,'Info.plist'));
fs.copyFileSync(path.join(root,'assets/icon.icns'),path.join(resources,'AppIcon.icns'));
let native=false;
fs.mkdirSync(path.join(root,'bin'),{recursive:true});
{
 try{execFileSync('/usr/bin/xcode-select',['-p'],{stdio:'ignore',timeout:5000});const swift=execFileSync('/usr/bin/xcrun',['--find','swiftc'],{encoding:'utf8',timeout:5000}).trim();const sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8',timeout:5000}).trim();if(!single)execFileSync(swift,['-sdk',sdk,'-target',(os.arch()==='arm64'?'arm64':'x86_64')+'-apple-macos13.0','-O',path.join(root,'macos/AccountSecrets.swift'),'-o',config.secretHelper],{stdio:'inherit',timeout:180000});if(!single)execFileSync('/usr/bin/codesign',['--force','--sign','-',config.secretHelper],{stdio:'ignore',timeout:10000});if(!process.argv.includes('--browser-only')){execFileSync(swift,['-sdk',sdk,'-target',(os.arch()==='arm64'?'arm64':'x86_64')+'-apple-macos13.0','-swift-version','5','-O','-framework','Cocoa','-framework','WebKit','-framework','UserNotifications',path.join(root,'macos/UsageLedger.swift'),'-o',path.join(macos,'UsageLedger')],{stdio:'inherit',timeout:180000});native=true;}}
 catch{console.error('原生窗口未编译成功；已改用本地浏览器入口。可在安装命令行开发工具后重新构建。');}
}
if(!single&&!fs.existsSync(config.secretHelper))throw Error('钥匙串辅助程序未编译完成，不能安全保存连接密钥。本次安装未完成，请保留旧版使用。');
if(!native){const quote=x=>"'"+x.replaceAll("'","'\\''")+"'";fs.writeFileSync(path.join(macos,'UsageLedger'),'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(path.join(root,'runtime/mac-server.mjs'))+' '+quote(path.join(root,'installation.json'))+' --open-browser\n',{mode:0o755});}
try{execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app],{stdio:'ignore',timeout:30000});}catch{console.error('本机临时签名未完成；此包未公证。');}
if(process.argv.includes('--register-plugin')){
 const market=path.dirname(root),meta=path.join(market,'.agents','plugins');fs.mkdirSync(meta,{recursive:true});fs.writeFileSync(path.join(meta,'marketplace.json'),JSON.stringify({name:'usage-ledger-mac-development',plugins:[{name:'usage-ledger',source:{source:'local',path:'./'+path.basename(root)},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]},null,2));
 execFileSync(codexPath,['plugin','marketplace','add',market,'--json'],{stdio:'inherit',timeout:60000});execFileSync(codexPath,['plugin','add','usage-ledger@usage-ledger-mac-development','--json'],{stdio:'inherit',timeout:60000});
}
console.log(JSON.stringify({installed:true,app,root,dataDir,nativeWindow:native,architecture:os.arch(),version},null,2));
