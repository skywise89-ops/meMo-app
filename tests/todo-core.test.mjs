import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TODO_COUNTRIES,todoCountry,partitionTodos,validateTodoText,buildTodoEditPatch,isTodoEditStale } from '../todo-core.js';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

test('bucket has exactly two countries and legacy defaults to Korea',()=>{
  assert.deepEqual(TODO_COUNTRIES.map(c=>c.value),['kr','jp']);
  assert.equal(todoCountry({country:'jp'}),'jp');
  assert.equal(todoCountry({country:'kr'}),'kr');
  assert.equal(todoCountry({}),'kr');
  assert.equal(todoCountry({country:'other'}),'kr');
});
test('country filters preserve all original fields and completion ordering',()=>{
  const data={a:{text:'first',createdAt:1},b:{text:'second',country:'kr',createdAt:2},c:{text:'done',country:'jp',isDone:true,completedAt:3,proofUrl:'private-proof',proofType:'image'},d:{text:'latest done',country:'jp',isDone:true,completedAt:4}};
  const backup=JSON.stringify(data);
  const kr=partitionTodos(data,'kr');const jp=partitionTodos(data,'jp');
  assert.deepEqual(kr.counts,{kr:2,jp:2});
  assert.deepEqual(kr.active.map(t=>t.key),['b','a']);
  assert.deepEqual(jp.done.map(t=>t.key),['d','c']);
  assert.equal(jp.done[1].proofUrl,'private-proof');
  assert.equal(JSON.stringify(data),backup);
  assert.equal(kr.total+jp.total,4);
});
test('invalid records do not crash bucket rendering',()=>{
  assert.deepEqual(partitionTodos({a:null,b:'bad'},'kr'),{active:[],done:[],total:0,counts:{kr:0,jp:0}});
});
test('edit patch changes only text country and audit fields',()=>{
  const original={text:'old',country:'kr',isDone:true,completedAt:10,proofUrl:'private-proof',creator:'Kevin',createdAt:2};
  const patch=buildTodoEditPatch(original,{text:' new ',country:'jp'},'Kevin',20);
  assert.deepEqual(patch,{text:'new',country:'jp',updatedAt:20,updatedBy:'Kevin'});
  const merged={...original,...patch};
  assert.equal(merged.isDone,true);assert.equal(merged.completedAt,10);assert.equal(merged.proofUrl,'private-proof');assert.equal(merged.createdAt,2);
});
test('edit validation rejects blank too-long invalid-country and missing rows',()=>{
  assert.throws(()=>validateTodoText('  '));assert.throws(()=>validateTodoText('x'.repeat(501)));
  assert.throws(()=>buildTodoEditPatch({}, {text:'valid',country:'xx'},'Kevin'));
  assert.throws(()=>buildTodoEditPatch(null,{text:'valid',country:'kr'},'Kevin'));
  assert.equal(validateTodoText(' safe text '),'safe text');
});
test('concurrent editable changes and missing rows are detected',()=>{
  const base={text:'a',country:'kr',updatedAt:1};
  assert.equal(isTodoEditStale(base,{...base,isDone:true,completedAt:3,proofUrl:'proof'}),false);
  assert.equal(isTodoEditStale(base,{...base,text:'b'}),true);
  assert.equal(isTodoEditStale(base,{...base,country:'jp'}),true);
  assert.equal(isTodoEditStale(base,{...base,updatedAt:2}),true);
  assert.equal(isTodoEditStale(base,null),true);
  assert.equal(isTodoEditStale({text:'a'},{text:'a',country:'kr'}),false);
});
test('bucket UI includes categories editor and per-item actions',()=>{
  assert.match(html,/todo-core\.js\?v=4\.6\.1/);
  assert.match(html,/data-todo-key|dataset\.todoKey/);
  assert.match(html,/role="dialog"/);
  assert.match(html,/runTransaction/);
  assert.match(html,/buildTodoEditPatch/);
  assert.match(html,/isTodoEditStale/);
});
