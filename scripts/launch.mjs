import './build.mjs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const cached = path.join(root, '.runtime', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');
let executable = cached;
if (!existsSync(cached)) {
  try { executable = (await import('electron')).default; }
  catch { console.error('Electron runtime missing. Run npm install, or scripts/setup-offline.ps1 with a cached Electron ZIP.'); process.exit(1); }
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [root, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('exit', code => process.exit(code ?? 1));
child.on('error', error => { console.error(error.message); process.exit(1); });
