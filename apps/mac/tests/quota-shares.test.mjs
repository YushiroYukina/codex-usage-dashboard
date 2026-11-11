import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {quotaModelShares} from '../runtime/history.mjs';
test('quota shares preserve actual points, day and account; ambiguous intervals stay unassigned',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE tokens(at TEXT,model TEXT)');
 const at=n=>new Date(Date.UTC(2026,10,9,1,0,n)).toISOString();
 for(const [n,model] of [[10,'A'],[70,'A'],[80,'B'],[150,'未知']])db.prepare('INSERT INTO tokens VALUES(?,?)').run(at(n),model);
 const row=(from,to,points,extra={})=>({day:'2026-11-09',scope:'account',source:'live',plan:'prolite',window:'10080',minutes:10080,from:at(from),at:at(to),points,...extra});
 const result=quotaModelShares(db,[row(0,30,1),row(30,90,2),row(90,180,3),row(180,400,4),row(400,410,null),row(0,30,5,{scope:'other'}),row(0,30,6,{day:'2026-11-10'})]);
 assert.equal(result.length,3);assert.equal(result[0].total,10);assert.equal(result[0].gaps,1);
 assert.deepEqual(result[0].models,[{model:'A',points:1},{model:'未归属',points:9}]);
 assert.equal(result[1].total,5);assert.equal(result[2].total,6);db.close();
});
