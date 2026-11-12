// Local UI QA only. Uses the real scheduler with a simulated task, never Codex.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../build/main/store.js';
import { Scheduler } from '../build/main/scheduler.js';
const root=path.resolve(import.meta.dirname,'..');
const codex=new EventEmitter();Object.assign(codex,{connected:false,account:null,quota:null,models:[],executable:null,close(){},rpc:{respond(){},rejectRequest(){}}});
const scheduler=new Scheduler(new Store(path.join(root,'.data/preview')),codex);
if(!scheduler.task)scheduler.createTask({title:'体验一次夜间任务',goal:'演示阶段执行、进度保存和上午额度保护的完整流程。',acceptance:'触及保护线时自动暂停，不调用模型、不修改真实项目。',projectPath:'',mode:'demo'});
scheduler.startTimer();
const bridge=`const call=async(method,data)=>{const r=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data??{})});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;};let last='';const listeners=[];window.nightshift={snapshot:()=>call('snapshot'),saveSettings:s=>call('settings',s),createTask:t=>call('task',t),arm:()=>call('arm'),pause:()=>call('pause'),stop:()=>call('stop'),connect:()=>call('unavailable'),login:()=>call('unavailable'),refresh:()=>call('snapshot'),selectProject:()=>call('unavailable'),selectCodex:()=>call('unavailable'),exportReport:()=>call('unavailable'),openProject:()=>call('unavailable'),onChange:cb=>{listeners.push(cb);return()=>{};}};setInterval(async()=>{try{const s=await call('snapshot');const key=JSON.stringify({...s,now:0});if(key!==last){last=key;listeners.forEach(f=>f(s));}}catch{}},700);`;
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1:4318');
    if(req.method==='POST'&&url.pathname.startsWith('/api/')){
      if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:4318'){res.writeHead(403).end();return;}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw new Error('Request too large');}
      const data=JSON.parse(body||'{}');let value;
      switch(url.pathname.slice(5)){
        case'snapshot':value=scheduler.snapshot();break;
        case'settings':value=scheduler.saveSettings(data);break;
        case'task':if(data.mode!=='demo')throw new Error('界面预览仅支持演示任务，请在桌面应用中创建真实任务');value=scheduler.createTask(data);break;
        case'arm':value=await scheduler.arm();break;
        case'pause':value=await scheduler.halt();break;
        case'stop':value=await scheduler.stopWithSummary();break;
        default:throw new Error('此操作请在桌面应用中使用');
      }
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
    }
    if(url.pathname==='/bridge.js'){res.setHeader('Content-Type','text/javascript');res.end(bridge);return;}
    const filename=url.pathname==='/'?'renderer/index.html':decodeURIComponent(url.pathname.slice(1));
    const file=path.resolve(root,'build',filename);
    if(!file.startsWith(path.join(root,'build')+path.sep)){res.writeHead(403).end();return;}
    let bytes=await readFile(file);
    if(filename.endsWith('.html'))bytes=Buffer.from(bytes.toString().replace("connect-src 'none'","connect-src 'self'").replace('<script type="module"','<script src="/bridge.js"></script><script type="module"'));
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png'})[path.extname(file)]??'application/octet-stream');res.end(bytes);
  }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
server.listen(4318,'127.0.0.1',()=>console.log('UI preview: http://127.0.0.1:4318/renderer/index.html'));
process.on('SIGINT',()=>{void scheduler.shutdown().finally(()=>{server.close();scheduler.store.close();process.exit();});});
