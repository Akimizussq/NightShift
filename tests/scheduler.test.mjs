import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Scheduler } from '../build/main/scheduler.js';
import { Store } from '../build/main/store.js';
const at = h => new Date(2026,10,12,h).getTime();
class MockCodex extends EventEmitter {
  connected=true; account={type:'chatgpt',planType:'plus'}; models=[]; executable='mock'; starts=0; interrupts=0;
  rpc={respond(){},rejectRequest(){}};
  quota={source:'live',fetchedAt:at(8),short:{usedPercent:10,windowDurationMins:300,resetsAt:at(11)},weekly:{usedPercent:20,windowDurationMins:10080,resetsAt:at(11)+86400000*3}};
  async connect(){} async refresh(){}
  async startStage(task){this.starts++;task.threadId??='test-thread';this.emit('thread',task.threadId);return `turn-${this.starts}`;}
  async startReply(task,message){this.reply=message;return 'reply-1';}
  async history(){return [{id:'turn-1',items:[{type:'userMessage',id:'user-1',content:[{type:'text',text:'Original request'}]}]}];}
  async interrupt(){this.interrupts++;}
  async steer(){} close(){this.connected=false;}
}
function setup(t){
  const dir=mkdtempSync(path.join(tmpdir(),'nightshift-test-'));const store=new Store(dir);const codex=new MockCodex();let now=at(8);
  const scheduler=new Scheduler(store,codex,()=>now);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  scheduler.createTask({title:'Test',goal:'Implement a verified change',acceptance:'Tests pass',projectPath:dir,mode:'live'});
  return {dir,store,codex,scheduler,setNow:n=>{now=n;codex.quota.fetchedAt=n;}};
}
function finish(codex,turn,status='continue',madeProgress=true){
  codex.emit('event',{method:'item/completed',params:{threadId:'test-thread',turnId:turn,item:{type:'agentMessage',text:JSON.stringify({status,summary:'Implemented stage',nextStep:'Run next check',verification:'Test passed',madeProgress})}}});
  codex.emit('event',{method:'turn/completed',params:{threadId:'test-thread',turn:{id:turn,status:'completed'}}});
}
test('a stage saves its checkpoint and resumes the same task, not the most recent conversation',async t=>{
  const {scheduler,codex,store,setNow}=setup(t);await scheduler.arm();
  assert.equal(codex.starts,1);assert.equal(store.task().threadId,'test-thread');
  finish(codex,'turn-1');assert.equal(store.checkpoints(scheduler.task.id).length,1);
  assert.equal(store.task().stages,1);setNow(at(8)+4000);await scheduler.tick();
  assert.equal(codex.starts,2);assert.equal(scheduler.task.threadId,'test-thread');
});
test('morning reserve interrupts a running stage and never starts another stage',async t=>{
  const {scheduler,codex}=setup(t);await scheduler.arm();codex.quota.short.usedPercent=43;
  await scheduler.tick();assert.equal(scheduler.task.status,'protecting');assert.equal(codex.interrupts,1);
  finish(codex,'turn-1');await scheduler.tick();assert.equal(codex.starts,1);assert.equal(scheduler.task.status,'protecting');
});
test('weekly reserve stops automation and remains stopped after weekly usage changes',async t=>{
  const {scheduler,codex}=setup(t);codex.quota.weekly.usedPercent=63;await scheduler.arm();
  assert.equal(scheduler.task.status,'stopped');assert.equal(codex.starts,0);
  codex.quota.weekly.usedPercent=0;await scheduler.tick();assert.equal(codex.starts,0);
});
test('wake-time handoff stays paused even when a fresh quota window appears',async t=>{
  const {scheduler,codex,setNow}=setup(t);await scheduler.arm();setNow(at(10));await scheduler.tick();
  assert.equal(scheduler.task.status,'paused');assert.equal(codex.interrupts,1);
  finish(codex,'turn-1');setNow(at(11));codex.quota.short.resetsAt=at(16);await scheduler.tick();assert.equal(codex.starts,1);
});
test('manual pause preserves the final checkpoint without accidentally continuing',async t=>{
  const {scheduler,codex,store}=setup(t);await scheduler.arm();await scheduler.halt();finish(codex,'turn-1');
  assert.equal(scheduler.task.status,'paused');assert.equal(scheduler.task.turnId,null);assert.ok(store.checkpoints(scheduler.task.id).length>=2);
});
test('restart restores active work as paused and retains its thread and checkpoints',async t=>{
  const {scheduler,codex,store}=setup(t);await scheduler.arm();finish(codex,'turn-1');
  const restored=new Scheduler(store,new MockCodex(),()=>at(8));assert.equal(restored.task.status,'paused');assert.equal(restored.task.threadId,'test-thread');assert.equal(store.checkpoints(restored.task.id).length,2);
});
test('approval waits for a user decision and stops unattended stages',async t=>{
  const {scheduler,codex}=setup(t);const replies=[];codex.rpc.respond=(id,result)=>replies.push({id,result});await scheduler.arm();
  codex.emit('approval',{id:1,method:'item/commandExecution/requestApproval',params:{threadId:'test-thread',turnId:'turn-1',command:'git add public',reason:'index write'}});
  assert.equal(scheduler.task.status,'blocked');assert.equal(scheduler.pendingApproval.params.command,'git add public');assert.equal(codex.interrupts,0);
  assert.equal(replies.length,0);scheduler.answerApproval('decline');
  assert.deepEqual(replies,[{id:1,result:{decision:'decline'}}]);
  finish(codex,'turn-1');await scheduler.tick();assert.equal(codex.starts,1);
});
test('first stage without progress stops the loop until the user handles the blocker',async t=>{
  const {scheduler,codex,setNow}=setup(t);await scheduler.arm();finish(codex,'turn-1','continue',false);
  setNow(at(8)+4000);await scheduler.tick();assert.equal(scheduler.task.status,'blocked');assert.equal(codex.starts,1);
  await assert.rejects(scheduler.arm(),/已处理阻塞/);scheduler.acknowledgeBlock();await scheduler.arm();assert.equal(codex.starts,2);
});
test('unrelated thread completion is ignored',async t=>{
  const {scheduler,codex}=setup(t);await scheduler.arm();codex.emit('event',{method:'turn/completed',params:{threadId:'other',turn:{id:'turn-1',status:'completed'}}});
  assert.equal(scheduler.task.status,'running');assert.equal(scheduler.task.stages,0);
});
test('permissions requests require an explicit response and grant only requested permissions',async t=>{
  const {scheduler,codex}=setup(t);const replies=[];codex.rpc.respond=(id,result)=>replies.push({id,result});await scheduler.arm();
  codex.emit('approval',{id:8,method:'item/permissions/requestApproval',params:{threadId:'test-thread',turnId:'turn-1',permissions:{network:{enabled:true}}}});
  assert.equal(replies.length,0);assert.equal(scheduler.task.status,'blocked');scheduler.answerApproval('accept');
  assert.deepEqual(replies,[{id:8,result:{permissions:{network:{enabled:true}},scope:'turn'}}]);
});
test('a manual reply uses the existing thread and does not start a new unattended stage',async t=>{
  const {scheduler,codex}=setup(t);await scheduler.arm();await scheduler.halt();finish(codex,'turn-1');
  await scheduler.sendMessage('Fluid package has been installed');
  assert.equal(codex.reply,'Fluid package has been installed');assert.equal(scheduler.task.turnId,'reply-1');
  codex.emit('event',{method:'item/completed',params:{threadId:'test-thread',turnId:'reply-1',item:{id:'answer-1',type:'agentMessage',text:'I will check it.'}}});
  codex.emit('event',{method:'turn/completed',params:{threadId:'test-thread',turn:{id:'reply-1',status:'completed'}}});
  assert.equal(scheduler.task.stages,1);assert.equal(scheduler.task.turnId,null);assert.equal(scheduler.task.status,'paused');
  assert.equal((await scheduler.conversation())[0].items[0].type,'userMessage');
});
test('question cards send the selected answer only to their matching request',async t=>{
  const {scheduler,codex}=setup(t);const replies=[];codex.rpc.respond=(id,result)=>replies.push({id,result});await scheduler.arm();
  codex.emit('approval',{id:12,method:'item/tool/requestUserInput',params:{threadId:'test-thread',turnId:'turn-1',questions:[{id:'theme',question:'Which theme?',options:[{label:'Fluid'}]}]}});
  assert.equal(scheduler.task.status,'blocked');scheduler.answerApproval('answer',{theme:['Fluid']});
  assert.deepEqual(replies,[{id:12,result:{answers:{theme:{answers:['Fluid']}}}}]);
});
test('restart clears an interrupted approval turn so the task can be inspected',async t=>{
  const {scheduler,codex,store}=setup(t);await scheduler.arm();
  codex.emit('approval',{id:12,method:'item/commandExecution/requestApproval',params:{threadId:'test-thread',turnId:'turn-1',command:'git add .'}});
  const restored=new Scheduler(store,new MockCodex(),()=>at(8));
  assert.equal(restored.task.status,'paused');assert.equal(restored.task.turnId,null);
  assert.equal(restored.pendingApproval,null);
});
