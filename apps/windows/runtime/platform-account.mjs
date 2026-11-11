import {createAccountSync as core,keychainStore} from './account-client.mjs';
import {windowsSecrets} from './windows-secrets.mjs';
export function createAccountSync(config,db,options={}){return core(config,db,{secrets:process.platform==='win32'?windowsSecrets(config):keychainStore(config),...options});}
