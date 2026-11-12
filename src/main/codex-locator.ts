import { existsSync, statSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const runFile = promisify(execFile);

export function executableAtInstallation(location: string): string | null {
  const candidates = [
    path.join(location, 'app', 'resources', 'codex.exe'),
    path.join(location, 'resources', 'codex.exe')
  ];
  return candidates.find(file => { try { return statSync(file).isFile(); } catch { return false; } }) ?? null;
}

// Reading an exact known file works even when WindowsApps cannot be enumerated.
export function packagedCodexHint(): string | null {
  try {
    const hintPath = fileURLToPath(new URL('../../codex-location.json', import.meta.url));
    const hint = JSON.parse(readFileSync(hintPath, 'utf8')).executable;
    if (typeof hint === 'string' && path.isAbsolute(hint) && path.basename(hint).toLowerCase() === 'codex.exe' && statSync(hint).isFile()) return hint;
  } catch { /* A portable build may not have a valid hint on this computer. */ }
  return null;
}

export async function windowsStoreInstallations(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershell)) return [];
  // Use the per-user package inventory; it does not require enumerating the
  // protected WindowsApps directory or requesting administrative access.
  const command = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference = 'Stop'; $locations = @(Get-AppxPackage -Name 'OpenAI.Codex*' | Where-Object { $_.InstallLocation } | Sort-Object Version -Descending | Select-Object -ExpandProperty InstallLocation); ConvertTo-Json -InputObject $locations -Compress`;
  try {
    const { stdout } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8'
    });
    return parseInstallations(stdout);
  } catch { return []; }
}

export function parseInstallations(stdout: string): string[] {
  try {
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    return (Array.isArray(result) ? result : [result]).filter(value => typeof value === 'string' && path.isAbsolute(value));
  } catch { return []; }
}

export async function locateCodex(configured: string, providers: {
  fast: (configured: string) => string | null;
  hint?: () => string | null;
  installed?: () => Promise<string[]>;
}): Promise<string | null> {
  const direct = providers.fast(configured);
  if (direct) return direct;
  const hint = (providers.hint ?? packagedCodexHint)();
  if (hint) return hint;
  const locations = await (providers.installed ?? windowsStoreInstallations)();
  for (const location of locations) {
    const executable = executableAtInstallation(location);
    if (executable) return executable;
  }
  return null;
}
