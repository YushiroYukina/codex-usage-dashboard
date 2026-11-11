import {recentThreadUsage} from './thread-usage.mjs';
import {reportHistory} from './history.mjs';
import {bindLocalRecords,ensureAccountSchema,exportAccountBundle,ledgerManifest} from './account-ledger.mjs';
import {currentScope} from './device-sync.mjs';
import {cachedLedger,invalidateLedgerCache} from './cached-ledger.mjs';
export function accountHistory(db,config,range,now=new Date(),scopeOverride){
 const scope=scopeOverride===undefined?currentScope(config):scopeOverride;ensureAccountSchema(db);const owns=!db.isTransaction;if(owns)db.exec('BEGIN IMMEDIATE');
 try{if(scope)bindLocalRecords(db,scope);const report=reportHistory(db,range,now,scope);
  const result={...report,coverage:'当前账号下本机与同步设备的去重明细；原生账号总量单列，不重复累加',accountVerified:!!scope,ledger:scope?cachedLedger(db,scope).manifest:null};
  if(owns)db.exec('COMMIT');return result;
 }catch(e){invalidateLedgerCache(db);if(owns)db.exec('ROLLBACK');throw e}
}
export function publicSyncStatus(value){const {accountScope,...safe}=value;return safe;}

export function accountThreadUsage(db,config,session,scopeOverride){const scope=scopeOverride===undefined?currentScope(config):scopeOverride;ensureAccountSchema(db);if(scope)bindLocalRecords(db,scope);return recentThreadUsage(db,session,scope);}
