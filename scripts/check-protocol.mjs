// Validate actual outbound messages against a schema exported by the installed CLI.
import { readFileSync,writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CodexService } from '../build/main/codex.js';
import { DEFAULT_SETTINGS } from '../build/shared/types.js';
const messages=[];const service=new CodexService();
service.rpc.call=async(method,params)=>{messages.push({method,params});return method==='thread/start'?{thread:{id:'schema-thread'}}:method==='turn/start'?{turn:{id:'schema-turn'}}:method==='thread/turns/list'?{data:[],nextCursor:null}:{};};
const task={title:'Protocol check',projectPath:path.resolve('.'),threadId:null,turnId:null};
task.turnId=await service.startStage(task,'Complete one small verified stage',DEFAULT_SETTINGS);
await service.steer(task,'Save progress and end this stage');await service.interrupt(task);
await service.startStage({...task,threadId:'restored-thread'},'Continue the saved task',DEFAULT_SETTINGS);
await service.startReply(task,'A user reply',DEFAULT_SETTINGS);
await service.history(task.threadId);
const schemas={'thread/start':'ThreadStartParams','thread/resume':'ThreadResumeParams','thread/name/set':'ThreadSetNameParams','thread/turns/list':'ThreadTurnsListParams','turn/start':'TurnStartParams','turn/steer':'TurnSteerParams','turn/interrupt':'TurnInterruptParams'};
const payload=messages.map(m=>({method:m.method,params:m.params,schema:JSON.parse(readFileSync(`artifacts/protocol/v2/${schemas[m.method]}.json`,'utf8'))}));
const result=spawnSync('python',['-c',`import json,sys,jsonschema
items=json.load(sys.stdin)
for item in items: jsonschema.validate(item['params'],item['schema'])
print(json.dumps({'messagesValidated':len(items),'methods':sorted(set(i['method'] for i in items))}))
`],{input:JSON.stringify(payload),encoding:'utf8',windowsHide:true});
if(result.status!==0){console.error(result.stderr);process.exit(1);}console.log(result.stdout.trim());
writeFileSync('artifacts/protocol-check.json',result.stdout);
