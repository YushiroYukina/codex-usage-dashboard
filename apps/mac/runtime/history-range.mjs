const fields=['input','cached','uncached','cacheWrite','output','reasoning','total','events'];
function add(a,b){for(const k of fields)a[k]=(a[k]??0)+(b[k]??0);a.missing??={};for(const [k,n] of Object.entries(b.missing??{}))a.missing[k]=(a.missing[k]??0)+n;return a;}
export function groupHistory(report,span='day'){
 if(!['day','week','month'].includes(span))throw new Error('Invalid span');
 if(span==='day')return {...report,span};
 const buckets=new Map(),dayKeys=new Map();
 for(const row of report.daily){
  const date=new Date(row.day+'T00:00:00Z');
  if(span==='week')date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));else date.setUTCDate(1);
  const key=date.toISOString().slice(0,10);
  if(!buckets.has(key))buckets.set(key,{day:row.day,end:row.day,missing:{}});
  const bucket=buckets.get(key);bucket.end=row.day;add(bucket,row);dayKeys.set(row.day,bucket.day);
 }
 const dailyModels={};
 for(const [day,models] of Object.entries(report.dailyModels)){
  const key=dayKeys.get(day);dailyModels[key]??=new Map();
  for(const model of models){if(!dailyModels[key].has(model.model))dailyModels[key].set(model.model,{model:model.model});add(dailyModels[key].get(model.model),model);}
 }
 const quotas=new Map();
 for(const row of report.quota){const day=dayKeys.get(row.day),key=JSON.stringify([day,row.scope,row.plan,row.window]);
  if(!quotas.has(key))quotas.set(key,{...row,day,observedPoints:0,comparableIntervals:0,gaps:0,notes:[]});
  const q=quotas.get(key);for(const field of ['observedPoints','comparableIntervals','gaps'])q[field]+=row[field];q.notes=[...new Set([...q.notes,...row.notes])];
  if(row.lastAt>=q.lastAt){q.remaining=row.remaining;q.reset=row.reset;q.lastAt=row.lastAt;}
 }
 return {...report,span,daily:[...buckets.values()],dailyModels:Object.fromEntries(Object.entries(dailyModels).map(([day,map])=>[day,[...map.values()]])),quota:[...quotas.values()],quotaModels:report.quotaModels.map(row=>({...row,day:dayKeys.get(row.day)}))};
}
