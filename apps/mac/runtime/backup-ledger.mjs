import fs from 'node:fs';import path from 'node:path';import {DatabaseSync,backup} from 'node:sqlite';import {fileURLToPath} from 'node:url';
export async function backupLedger(dataDir){
 const file=path.join(dataDir,'usage-history.sqlite');if(!fs.existsSync(file))return null;
 const dir=path.join(dataDir,'backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});const target=path.join(dir,'before-0.5.0-'+new Date().toISOString().replaceAll(':','-')+'.sqlite');
 const db=new DatabaseSync(file,{readOnly:true});try{await backup(db,target);}finally{db.close();}return target;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify({backup:await backupLedger(process.argv[2])}));
