import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executableAtInstallation, locateCodex, parseInstallations } from '../build/main/codex-locator.js';

test('finds a Store Codex installation without enumerating the WindowsApps parent',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'nightshift-store-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const resources=path.join(root,'app','resources');mkdirSync(resources,{recursive:true});
  const executable=path.join(resources,'codex.exe');writeFileSync(executable,'test fixture');
  let queried=false;
  const result=await locateCodex('',{fast:()=>null,hint:()=>null,installed:async()=>{queried=true;return [path.join(root,'missing'),root];}});
  assert.equal(result,executable);assert.equal(queried,true);
});
test('explicit or PATH executable takes priority over package queries',async()=>{
  let called=false;
  assert.equal(await locateCodex('chosen',{fast:()=>'/chosen/codex.exe',hint:()=>{called=true;return null;},installed:async()=>{called=true;return [];}}),'/chosen/codex.exe');
  assert.equal(called,false);
});
test('a verified build hint works without ChatGPT environment variables or Store access',async()=>{
  assert.equal(await locateCodex('',{fast:()=>null,hint:()=>'/verified/codex.exe',installed:async()=>{throw new Error('must not query');}}),'/verified/codex.exe');
});
test('parses empty, single and multiple package locations and ignores relative paths',()=>{
  const absolute=path.resolve('fixture');
  assert.deepEqual(parseInstallations(JSON.stringify([absolute,'relative',null])),[absolute]);
  assert.deepEqual(parseInstallations('\uFEFF'+JSON.stringify(absolute)),[absolute]);
  assert.deepEqual(parseInstallations('[]'),[]);assert.deepEqual(parseInstallations('not JSON'),[]);
});
test('ordinary desktop resources are supported and missing paths return null',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'nightshift-desktop-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.equal(executableAtInstallation(root),null);mkdirSync(path.join(root,'resources'));writeFileSync(path.join(root,'resources/codex.exe'),'fixture');
  assert.equal(executableAtInstallation(root),path.join(root,'resources/codex.exe'));
});
