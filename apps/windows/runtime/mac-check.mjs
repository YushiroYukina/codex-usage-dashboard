import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {openHistory,scanHistory} from './history.mjs';import {requestRefresh} from './refresh-client.mjs';import {refreshNativeUsage} from './native-usage.mjs';
import {accountHistory,publicSyncStatus} from './account-view.mjs';import {createAccountSync} from './account-client.mjs';import {pluginVersion} from './metadata.mjs';
const configPath=process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:path.join(os.homedir(),'Library','Application Support','UsageLedger','development','app-'+pluginVersion,'installation.json');
const result={at:new Date().toISOString(),version:pluginVersion,platform:process.platform,arch:os.arch(),node:process.version,checks:{}};
let db;
try{
 if(process.platform!=='darwin')throw Error('请在目标 Mac 上运行');const config=JSON.parse(fs.readFileSync(configPath));
 const app=path.join(os.homedir(),'Applications','Codex 用量看板开发版.app');
 for(const [name,file]of[['nativeSignature',app],['keychainHelperSignature',config.secretHelper]]){try{execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',file],{stdio:'ignore'});result.checks[name]=true}catch{result.checks[name]=false}}
 result.legacyDeviceSyncEnabled=config.crossDeviceSync;result.accountSyncEnabled=config.accountSync;
 const quota=await requestRefresh(config,configPath);result.quota={ok:quota.ok,queryOk:quota.queryOk,plan:quota.plan,windows:quota.windows,error:quota.error??null};
 db=openHistory(config.dataDir);const first=scanHistory(db,path.join(config.codexHome,'sessions')),second=scanHistory(db,path.join(config.codexHome,'sessions'));
 result.scan={firstNewEvents:first.newEvents,secondNewEvents:second.newEvents,secondBytes:second.bytes};result.integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
 result.tokenTotals=[1,7,30].map(days=>({days,total:accountHistory(db,config,days).sum.total}));
 const native=await refreshNativeUsage(config,db,{force:true});result.native={profileOk:native.profileOk,nativeDays:native.nativeDays,quotaOk:native.quotaOk};
 const sync=createAccountSync(config,db);result.account=publicSyncStatus(sync.status());sync.close();
 result.manualChecks=['已登记设备同时新增后再次比较修订和摘要','Windows 原生界面及真实跨网络服务联调','原生通知与菜单栏关闭后提醒'];
}catch(e){result.error=e.code??e.message;}finally{db?.close()}
const idx=process.argv.indexOf('--output'),output=idx>=0?path.resolve(process.argv[idx+1]):path.join(os.homedir(),'Desktop','UsageLedger-0.4-Mac-check-'+Date.now()+'.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));console.log('检查报告：'+output);if(result.error)process.exitCode=1;
