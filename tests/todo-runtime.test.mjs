import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../todo-core.js';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('function canUseTodoSession('),html.indexOf('const todoEditForm ='));
function harness(record={text:'old',country:'kr',isDone:true,completedAt:3,proofUrl:'proof',createdAt:1}) {
  const elements=new Map();
  function element(id){if(!elements.has(id))elements.set(id,{value:id==='todoEditText'?'edited':id==='todoEditCountry'?'jp':'',disabled:false,classList:{remove(){},add(){}},setAttribute(){}});return elements.get(id);}
  const records={key:record};const messages=[];const notices=[];const writes=[];
  const context={...core,window:{},document:{getElementById:element},console:{warn(){}},ROOM_ID:'room',db:{},me:{name:'Kevin',authUid:'u1'},activeRoomSession:1,activeRoomUserId:'u1',todoDataCache:{key:record},selectedTodoCountry:'kr',todoDeleteKeys:new Set(),todoEditSaving:false,todoEditState:{key:'key',base:{...record},sessionId:1,userId:'u1'},confirm:()=>true,isCurrentRoomSession:(s,u)=>s===context.activeRoomSession&&u===context.activeRoomUserId,ref:(_,path)=>path,showToast:m=>notices.push(m),renderTodos(){},push:async(path,value)=>{messages.push({path,value});},runTransaction:async(path,fn)=>{const key=path.split('/').at(-1);const next=fn(records[key]??null);if(next===undefined)return{committed:false};writes.push({path,next});if(next===null)delete records[key];else records[key]=next;return{committed:true,snapshot:{val:()=>next}};}};
  vm.createContext(context);vm.runInContext(code,context);
  return{context,elements,element,records,messages,notices,writes};
}
test('runtime save preserves proof completion and creator metadata',async()=>{
  const h=harness();await h.context.window.saveTodoEditor();
  assert.equal(h.records.key.text,'edited');assert.equal(h.records.key.country,'jp');
  assert.equal(h.records.key.proofUrl,'proof');assert.equal(h.records.key.completedAt,3);assert.equal(h.records.key.createdAt,1);
});
test('runtime edit cannot resurrect deleted or overwrite changed row',async()=>{
  for(const absent of [true,false]){const h=harness();if(absent)delete h.records.key;else h.records.key={...h.records.key,text:'partner changed'};
    await h.context.window.saveTodoEditor();assert.equal(h.writes.length,0);assert.ok(h.notices.length);
  }
});
test('cancelled delete never writes and confirmed delete only targets bucket record',async()=>{
  const h=harness();h.context.confirm=()=>false;await h.context.window.deleteTodo('key',{});assert.equal(h.writes.length,0);
  h.context.confirm=()=>true;await h.context.window.deleteTodo('key',{});
  assert.deepEqual(h.writes.map(w=>({path:w.path,next:w.next})),[{path:'room/todos/key',next:null}]);
  assert.equal(h.messages.length,0);
});
test('session changes block edit and delete transaction callbacks',async()=>{
  for(const action of ['saveTodoEditor','deleteTodo']){const h=harness();const native=h.context.runTransaction;h.context.runTransaction=async(path,fn)=>{h.context.activeRoomSession=2;return native(path,fn);};
    await h.context.window[action](...(action==='deleteTodo'?['key',{}]:[]));assert.equal(h.writes.length,0);
  }
});
test('editor cannot be cancelled while a save is in flight',()=>{
  const h=harness();h.context.todoEditSaving=true;h.context.closeTodoEditor();assert.ok(h.context.todoEditState);
  h.context.closeTodoEditor({force:true});assert.equal(h.context.todoEditState,null);
});
test('failed add keeps user input',async()=>{
  const h=harness();h.element('todoInput').value='new bucket';h.context.push=async()=>{throw new Error('offline');};
  await h.context.window.addTodo();assert.equal(h.element('todoInput').value,'new bucket');assert.equal(h.element('todoAddBtn').disabled,false);
});
test('completion does not resurrect missing bucket or send a false notification',async()=>{
  const h=harness({text:'old',country:'kr',isDone:false});delete h.records.key;
  await h.context.window.toggleTodo('key',false,'old');assert.equal(h.writes.length,0);assert.equal(h.messages.length,0);
});
test('successful completion preserves fields and sends the existing system event once',async()=>{
  const h=harness({text:'old',country:'kr',isDone:false,proofUrl:'proof'});
  await h.context.window.toggleTodo('key',false,'old');assert.equal(h.records.key.isDone,true);assert.equal(h.records.key.proofUrl,'proof');assert.equal(h.messages.length,1);
  await h.context.window.toggleTodo('key',false,'old');assert.equal(h.messages.length,1);
});

test('add completion never clears a newly typed draft or another session input',async()=>{
  for(const switchSession of [false,true]){
    const h=harness();h.element('todoInput').value='submitted';
    let finish;h.context.push=()=>new Promise(resolve=>{finish=resolve;});
    const adding=h.context.window.addTodo();h.element('todoInput').value='next draft';
    if(switchSession)h.context.activeRoomSession=2;
    finish();await adding;assert.equal(h.element('todoInput').value,'next draft');
  }
});
test('duplicate save is ignored while pending and stale response cannot close a new editor',async()=>{
  const h=harness();let finish;let calls=0;const native=h.context.runTransaction;
  h.context.runTransaction=(path,fn)=>{calls++;return new Promise(resolve=>{finish=async()=>resolve(await native(path,fn));});};
  const saving=h.context.window.saveTodoEditor();await h.context.window.saveTodoEditor();assert.equal(calls,1);
  h.context.closeTodoEditor({force:true});const other={key:'other'};h.context.todoEditState=other;
  await finish();await saving;assert.equal(h.context.todoEditState,other);
});
