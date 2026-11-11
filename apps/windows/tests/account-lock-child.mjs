import fs from 'node:fs';import path from 'node:path';import {openHistory} from '../runtime/history.mjs';import {createAccountSync} from '../runtime/account-client.mjs';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),scope='a'.repeat(64),db=openHistory(config.dataDir);
const client=createAccountSync(config,db,{scopeProvider:()=>scope,secrets:{read:()=>({accountScope:scope,accessToken:'fictional-access-token-only',refreshToken:'fictional-refresh-token-only',expiresAt:Date.now()+600000})},fetcher:async()=>{process.stdout.write('owned\n');await new Promise(()=>{});}});
await client.tick();
