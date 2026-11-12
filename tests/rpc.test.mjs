import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient } from '../build/main/rpc.js';
const server=`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method==='fail'){process.stdout.write(JSON.stringify({id:m.id,error:{message:'expected failure'}})+'\\n');return;}if(m.method==='hang')return;process.stdout.write(JSON.stringify({id:m.id,result:{ok:true,method:m.method}})+'\\n');});`;
test('stdio JSON-RPC initializes, returns errors and times out without leaking pending calls',async()=>{
  const rpc=new RpcClient(1200);
  try{await rpc.connect(process.execPath,['-e',server]);assert.equal((await rpc.call('echo')).method,'echo');await assert.rejects(rpc.call('fail'),/expected failure/);await assert.rejects(rpc.call('hang'),/超时/);assert.equal(rpc.pending.size,0);}finally{rpc.close();}
});
