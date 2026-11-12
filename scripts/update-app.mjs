import './build.mjs';
import { access, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findCodex } from '../build/main/codex.js';

// Patch application resources without replacing a running/locked Electron EXE.
const root=path.resolve(import.meta.dirname,'..');
const appDir=path.join(root,'release/Nightshift-Windows-x64/resources/app');
await access(path.join(appDir,'package.json'));
await cp(path.join(root,'build'),path.join(appDir,'build'),{recursive:true});
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
delete manifest.devDependencies;delete manifest.scripts;
await writeFile(path.join(appDir,'package.json'),JSON.stringify(manifest,null,2));
const executable=findCodex();
if(executable)await writeFile(path.join(appDir,'codex-location.json'),JSON.stringify({executable},null,2));
await cp(path.join(root,'README.md'),path.resolve(appDir,'../../README.md'));
console.log(JSON.stringify({updated:true,version:manifest.version,codexHintWritten:!!executable,restartRequired:true}));
