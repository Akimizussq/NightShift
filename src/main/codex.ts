import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { RpcClient } from './rpc.js';
import { locateCodex } from './codex-locator.js';
import { normalizeQuota } from '../shared/policy.js';
import type { Settings, QuotaSnapshot, Task } from '../shared/types.js';

export function findCodex(configured = ''): string | null {
  if (configured) {
    if (!path.isAbsolute(configured) || !configured.toLowerCase().endsWith('.exe') || !existsSync(configured)) throw new Error('请选择真实的 Codex .exe 文件');
    return configured;
  }
  const candidates: string[] = [];
  if (process.env.CODEX_TASK_WORKSPACE_NODE) candidates.push(path.resolve(path.dirname(process.env.CODEX_TASK_WORKSPACE_NODE), '../..', 'codex.exe'));
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'codex.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'resources', 'codex.exe'));
  if (process.env.ProgramFiles) {
    const apps = path.join(process.env.ProgramFiles, 'WindowsApps');
    try { for (const dir of readdirSync(apps).filter(x => /^OpenAI\.Codex_.*_x64__/.test(x)).sort().reverse()) candidates.push(path.join(apps, dir, 'app/resources/codex.exe')); } catch { /* user can choose manually */ }
  }
  return candidates.find(file => { try { return existsSync(file) && statSync(file).isFile(); } catch { return false; } }) ?? null;
}
export const STAGE_SCHEMA = {
  type: 'object', properties: {
    status: { type: 'string', enum: ['continue', 'completed', 'blocked'] },
    summary: { type: 'string' }, nextStep: { type: 'string' }, verification: { type: 'string' },
    madeProgress: { type: 'boolean' }
  }, required: ['status', 'summary', 'nextStep', 'verification', 'madeProgress'], additionalProperties: false
};
export class CodexService extends EventEmitter {
  rpc = new RpcClient();
  connected = false;
  connecting: Promise<void> | null = null;
  executable: string | null = null;
  account: { type: string; planType?: string } | null = null;
  quota: QuotaSnapshot | null = null;
  models: { id: string; displayName: string }[] = [];
  private readyThreads = new Set<string>();
  constructor(private runtimeDirectory?: string) {
    super();
    this.rpc.on('notification', event => {
      if (event.method === 'account/rateLimits/updated') { this.quota = normalizeQuota(event.params); this.emit('quota', this.quota); }
      if (event.method === 'account/login/completed' && event.params.success) this.refresh().catch(error => this.emit('problem', error.message));
      this.emit('event', event);
    });
    this.rpc.on('request', event => this.emit('approval', event));
    this.rpc.on('disconnected', reason => { this.connected = false; this.readyThreads.clear(); this.emit('disconnected', reason); });
  }
  async connect(settings: Settings) {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.executable = await locateCodex(settings.codexPath, { fast: findCodex });
      if (!this.executable) throw new Error('未找到 Codex。请在设置中选择 codex.exe，或先安装 Codex 桌面端。');
      const args = ['app-server', '--listen', 'stdio://'];
      if (this.runtimeDirectory) {
        mkdirSync(this.runtimeDirectory, { recursive: true });
        args.push('-c', `sqlite_home=${JSON.stringify(this.runtimeDirectory)}`, '-c', `log_dir=${JSON.stringify(path.join(this.runtimeDirectory, 'logs'))}`);
      }
      await this.rpc.connect(this.executable, args);
      this.connected = true;
      await this.refresh().catch(error => this.emit('problem', `额度暂不可读：${error.message}`));
      try { const response = await this.rpc.call('model/list', {}); this.models = (response.data ?? []).filter((x: any) => !x.hidden).map((x: any) => ({ id: x.id ?? x.model, displayName: x.displayName ?? x.model })); } catch { /* default model can still work */ }
    })();
    try { await this.connecting; } catch (error) { this.close(); throw error; } finally { this.connecting = null; }
  }
  async refresh() {
    const response = await this.rpc.call('account/read', { refreshToken: false });
    this.account = response.account ? { type: response.account.type, planType: response.account.planType } : null;
    if (this.account?.type !== 'chatgpt') { this.quota = null; this.emit('quota', null); return; }
    const data = await this.rpc.call('account/rateLimits/read', {});
    this.quota = normalizeQuota(data);
    this.emit('quota', this.quota);
  }
  async login() {
    if (!this.connected) throw new Error('请先连接 Codex');
    return this.rpc.call('account/login/start', { type: 'chatgpt' });
  }
  async startStage(task: Task, prompt: string, s: Settings) {
    await this.ensureThread(task, s);
    const response = await this.rpc.call('turn/start', {
      threadId: task.threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [task.projectPath], networkAccess: s.networkAccess },
      outputSchema: STAGE_SCHEMA,
      ...(s.model ? { model: s.model } : {})
    });
    return response.turn.id as string;
  }
  private async ensureThread(task: Task, s: Settings) {
    const common: any = { cwd: task.projectPath, approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    if (s.model) common.model = s.model;
    if (!task.threadId) {
      const response = await this.rpc.call('thread/start', common);
      task.threadId = response.thread.id;
      this.readyThreads.add(task.threadId!);
      // Persist the newly assigned thread before starting a model request.
      this.emit('thread', task.threadId);
      await this.rpc.call('thread/name/set', { threadId: task.threadId, name: task.title }).catch(() => {});
    } else if (!this.readyThreads.has(task.threadId)) {
      await this.rpc.call('thread/resume', { ...common, threadId: task.threadId, excludeTurns: true });
      this.readyThreads.add(task.threadId);
    }
  }
  async startReply(task: Task, message: string, s: Settings) {
    await this.ensureThread(task, s);
    const response = await this.rpc.call('turn/start', {
      threadId: task.threadId,
      input: [{ type: 'text', text: message }],
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [task.projectPath], networkAccess: s.networkAccess },
      ...(s.model ? { model: s.model } : {})
    });
    return response.turn.id as string;
  }
  async history(threadId: string) {
    const turns: any[] = [];
    let cursor: string | null = null;
    const visited = new Set<string>();
    do {
      const result = await this.rpc.call('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      turns.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
      if (cursor && visited.has(cursor)) throw new Error('Codex 会话分页游标重复，已停止读取');
      if (cursor) visited.add(cursor);
    } while (cursor);
    return turns.reverse();
  }
  async steer(task: Task, text: string) {
    if (task.threadId && task.turnId) await this.rpc.call('turn/steer', { threadId: task.threadId, expectedTurnId: task.turnId, input: [{ type: 'text', text }] });
  }
  async interrupt(task: Task) {
    if (task.threadId && task.turnId) await this.rpc.call('turn/interrupt', { threadId: task.threadId, turnId: task.turnId });
  }
  close() { this.rpc.close(); this.connected = false; this.readyThreads.clear(); }
}
