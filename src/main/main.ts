import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, powerSaveBlocker, powerMonitor } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from './store.js';
import { CodexService } from './codex.js';
import { Scheduler } from './scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const smoke = process.argv.includes('--smoke');
const demo = process.argv.includes('--demo') || smoke;
if (demo) app.setPath('userData', path.join(root, '.data', smoke ? 'smoke' : 'demo'));
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let scheduler: Scheduler;
let quitting = false;
let powerId: number | null = null;
let changeTimer: NodeJS.Timeout | null = null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId('local.nightshift.codex');
    const store = new Store(app.getPath('userData'));
    const codex = new CodexService(path.join(app.getPath('userData'), 'codex-runtime'));
    scheduler = new Scheduler(store, codex);
    const icon = nativeImage.createFromPath(path.join(here, '../assets/icon.png'));
    win = new BrowserWindow({
      width: 1320, height: 900, minWidth: 1060, minHeight: 720,
      title: '长程任务助手 · Nightshift', icon,
      backgroundColor: '#101317', show: false,
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
    });
    Menu.setApplicationMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.on('close', event => { if (!quitting) { event.preventDefault(); win?.hide(); } });
    win.once('ready-to-show', () => win?.show());
    tray = new Tray(icon.resize({ width: 32, height: 32 }));
    tray.setToolTip('长程任务助手 · 等待任务');
    tray.on('double-click', () => win?.show());
    const updateTray = () => {
      tray?.setToolTip(`长程任务助手 · ${scheduler.task?.reason ?? '等待任务'}`.slice(0, 120));
      tray?.setContextMenu(Menu.buildFromTemplate([
        { label: '打开长程任务助手', click: () => win?.show() },
        { type: 'separator' },
        { label: '暂停并交还额度', enabled: !!scheduler.task, click: () => { void scheduler.halt().catch(showError); } },
        { label: '停止任务并保存总结', enabled: !!scheduler.task, click: () => { void scheduler.stopWithSummary().catch(showError); } },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() }
      ]));
      const active = scheduler.task && ['armed', 'running', 'waiting', 'protecting'].includes(scheduler.task.status);
      if (active && scheduler.settings.preventSleep && powerId === null) powerId = powerSaveBlocker.start('prevent-app-suspension');
      if ((!active || !scheduler.settings.preventSleep) && powerId !== null) { powerSaveBlocker.stop(powerId); powerId = null; }
    };
    scheduler.on('change', () => {
      if (changeTimer) return;
      changeTimer = setTimeout(() => { changeTimer = null; updateTray(); if (!win?.isDestroyed()) win?.webContents.send('app:change', scheduler.snapshot()); }, 150);
    });
    function handle(channel: string, fn: (...args: any[]) => any) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的调用来源');
        return fn(...args);
      });
    }
    handle('app:snapshot', () => scheduler.snapshot());
    handle('app:settings', settings => {
      const before = scheduler.settings;
      scheduler.saveSettings(settings);
      if (before.codexPath !== settings.codexPath) codex.close();
      if (before.autoStart !== settings.autoStart && process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: settings.autoStart, path: process.execPath, args: app.isPackaged ? [] : [root] });
      updateTray(); return scheduler.snapshot();
    });
    handle('app:create-task', task => scheduler.createTask(task));
    handle('app:arm', () => scheduler.arm());
    handle('app:pause', () => scheduler.halt());
    handle('app:stop', () => scheduler.stopWithSummary());
    handle('app:conversation', () => scheduler.conversation());
    handle('app:send-message', message => scheduler.sendMessage(message));
    handle('app:answer-approval', (decision, answers) => scheduler.answerApproval(decision, answers));
    handle('app:acknowledge-block', () => scheduler.acknowledgeBlock());
    handle('app:connect', async () => { await codex.connect(scheduler.settings); return scheduler.snapshot(); });
    handle('app:refresh', async () => { await codex.refresh(); return scheduler.snapshot(); });
    handle('app:login', async () => {
      await codex.connect(scheduler.settings);
      const response = await codex.login();
      if (response.authUrl) {
        const url = new URL(response.authUrl);
        if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) throw new Error('登录地址未通过校验');
        await shell.openExternal(response.authUrl);
      }
      return { pending: true };
    });
    handle('app:select-project', async () => (await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择夜间任务的项目目录' })).filePaths[0] ?? null);
    handle('app:select-codex', async () => (await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Codex executable', extensions: ['exe'] }] })).filePaths[0] ?? null);
    handle('app:open-project', async () => { if (scheduler.task?.projectPath && scheduler.task.mode === 'live') { const error = await shell.openPath(scheduler.task.projectPath); if (error) throw new Error(error); } });
    handle('app:export-report', async () => {
      const result = await dialog.showSaveDialog(win!, { title: '保存任务报告', defaultPath: 'nightshift-report.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (!result.canceled && result.filePath) { writeFileSync(result.filePath, scheduler.report(), 'utf8'); return result.filePath; }
      return null;
    });
    if (demo && !scheduler.task) scheduler.createTask({ title: '体验一次夜间任务', goal: '演示阶段执行、进度保存和上午额度保护的完整流程。', acceptance: '完成阶段模拟；触及额度保护线后自动暂停；不修改真实项目。', projectPath: '', mode: 'demo' });
    await win.loadFile(path.join(here, '../renderer/index.html'));
    updateTray(); scheduler.startTimer();
    powerMonitor.on('resume', () => { if (scheduler.task?.mode === 'live') { codex.quota = null; void codex.refresh().catch(() => {}); } void scheduler.tick(); });
    if (smoke) await runSmoke();
  }).catch(error => { console.error(error); app.exit(1); });
}
function showError(error: any) { dialog.showErrorBox('长程任务助手', error.message ?? String(error)); }
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  void scheduler?.shutdown().finally(() => { if (powerId !== null) powerSaveBlocker.stop(powerId); app.quit(); });
});
async function runSmoke() {
  const errors: string[] = [];
  win!.webContents.on('console-message', (_event: any, ...args: any[]) => {
    // Electron 42 provides a details object; retain errors without changing user UI.
    const details = args[0]; if (details?.level === 'error' || details?.level === 3) errors.push(details.message);
  });
  const smokeDir = path.join(root, 'artifacts'); mkdirSync(smokeDir, { recursive: true });
  await new Promise(resolve => setTimeout(resolve, 900));
  const checks = await win!.webContents.executeJavaScript(`(async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    check(document.querySelector('#app-title')?.textContent.includes('夜晚'), 'Dashboard missing');
    document.querySelector('[data-nav="settings"]').click();
    check(!document.querySelector('#settings-view').hidden, 'Settings navigation failed');
    check(document.querySelector('#fontSize').value === '16', 'Reading font preference missing');
    document.querySelector('[data-nav="conversation"]').click();
    check(!document.querySelector('#conversation-view').hidden, 'Conversation navigation failed');
    document.querySelector('[data-nav="overview"]').click();
    await window.nightshift.arm();
    return { title: document.title, bridge: !!window.nightshift, demoStarted: true };
  })()`);
  await new Promise(resolve => setTimeout(resolve, 900));
  writeFileSync(path.join(smokeDir, 'dashboard.png'), (await win!.webContents.capturePage()).toPNG());
  await scheduler.halt();
  await win!.webContents.executeJavaScript(`document.querySelector('[data-nav="conversation"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 200));
  writeFileSync(path.join(smokeDir, 'conversation.png'), (await win!.webContents.capturePage()).toPNG());
  writeFileSync(path.join(smokeDir, 'smoke.json'), JSON.stringify({ ...checks, errors, status: scheduler.task?.status }, null, 2));
  console.log(JSON.stringify({ smoke: checks, errors }));
  if (errors.length) process.exitCode = 1;
  app.quit();
}
