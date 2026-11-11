import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openHistory,reportHistory} from '../runtime/history.mjs';import {groupHistory} from '../runtime/history-range.mjs';
test('inclusive custom dates and calendar groups preserve quantities and model totals',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'range-test-')),db=openHistory(dir);
 try{
  for(const [day,n] of [['2026-10-30',10],['2026-10-31',20],['2026-11-01',30],['2026-11-02',40],['2026-11-03',999]])db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?)').run(day,day+'T08:00:00Z',day,'test',JSON.stringify({input:n,cached:0,uncached:n,output:0,reasoning:0,cacheWrite:0,total:n}));
  const report=reportHistory(db,{start:'2026-10-30',end:'2026-11-02'});assert.equal(report.sum.total,100);assert.equal(report.daily.length,4);
  const week=groupHistory(report,'week');assert.deepEqual(week.daily.map(r=>[r.day,r.end,r.total]),[['2026-10-30','2026-11-01',60],['2026-11-02','2026-11-02',40]]);
  const month=groupHistory(report,'month');assert.deepEqual(month.daily.map(r=>r.total),[30,70]);assert.equal(month.dailyModels['2026-11-01'][0].total,70);
  assert.equal(reportHistory(db,{start:'2026-11-02',end:'2026-11-02'}).sum.total,40);
  for(const range of [{start:'2026-11-03',end:'2026-11-02'},{start:'2026-02-30',end:'2026-03-01'}])assert.throws(()=>reportHistory(db,range));
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}
});
