import {exportAccountBundle,ledgerManifest} from './account-ledger.mjs';
const cache=new WeakMap();
export const invalidateLedgerCache=db=>cache.delete(db);
// SQLite's data_version observes other connections; total_changes observes this
// connection. Capture both while holding the same transaction as the snapshot.
export function cachedLedger(db,scope){
 const owns=!db.isTransaction;if(owns)db.exec('BEGIN IMMEDIATE');
 try{
  const signature=()=>String(db.prepare('PRAGMA data_version').get().data_version)+'|'+db.prepare('SELECT total_changes() AS n').get().n;
  const previous=cache.get(db);let value=previous;
  if(!previous||previous.scope!==scope||previous.signature!==signature()){
   const bundle=exportAccountBundle(db,scope);value={scope,signature:signature(),bundle,manifest:ledgerManifest(bundle)};
  }
  if(owns)db.exec('COMMIT');cache.set(db,value);return value;
 }catch(e){cache.delete(db);if(owns)db.exec('ROLLBACK');throw e;}
}
