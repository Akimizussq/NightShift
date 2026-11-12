import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { decide, schedule, validateSettings } from '../shared/policy.js';
import type { Task, Settings, QuotaSnapshot, Checkpoint, Decision } from '../shared/types.js';
import type { Store } from './store.js';
import type { CodexService } from './codex.js';

const ACTIVE = new Set(['armed', 'running', 'waiting', 'protecting']);
export class Scheduler extends EventEmitter {
  task: Task | null;
  settings: Settings;
  demoQuota: QuotaSnapshot | null = null;
  decision: Decision | null = null;
  liveOutput = '';
  liveItems: any[] = [];
  pendingApproval: any = null;
  private manualTurn = false;
  busy = false;
  starting = false;
  private queuedCompletion: any = null;
  private timer: NodeJS.Timeout | null = null;
  private stageStartedAt = 0;
  private lastPollAt = 0;
  private closing = false;
  private graceAt: number | null = null;
  private pollInFlight = false;
  private demoEndsAt = 0;

  constructor(public store: Store, public codex: CodexService, private now = () => Date.now()) {
    super();
    this.settings = store.settings(); this.task = store.task();
    if (this.task && (ACTIVE.has(this.task.status) || this.task.turnId)) {
      store.checkpoint({ id: randomUUID(), taskId: this.task.id, at: this.now(), stage: this.task.stages,
        summary: `应用重启恢复。${this.task.lastSummary || '上次阶段未收到完整模型总结，请检查当前文件。'}`,
        nextStep: '检查项目当前修改与已保存阶段，再手动继续同一会话', verification: '未完成阶段的验证结果待核对', diff: this.task.lastDiff, status: 'local' });
      this.task.status = 'paused'; this.task.turnId = null;
      this.task.reason = '上次运行已中断。检查进度后，点击继续任务。';
      store.saveTask(this.task);
      store.log('warn', '检测到上次未结束的任务，已恢复为暂停状态，避免启动时重复执行。');
    }
    codex.on('quota', () => { this.changed(); if (this.task?.mode === 'live') void this.tick(); });
    codex.on('thread', id => { if (this.task) { this.task.threadId = id; this.persist(); } });
    codex.on('event', event => this.event(event));
    codex.on('approval', request => this.requestApproval(request));
    codex.on('disconnected', reason => {
      if (this.task?.mode === 'live' && (ACTIVE.has(this.task.status) || this.task.turnId)) {
        this.localCheckpoint('连接中断', reason); this.task.status = 'blocked'; this.task.reason = 'Codex 连接中断，请重新连接并检查对话'; this.task.turnId = null; this.pendingApproval = null; this.task.blockAcknowledged = false; this.persist();
      }
    });
    codex.on('problem', message => this.log('warn', message));
  }
  startTimer() { this.timer = setInterval(() => { void this.tick().catch(error => this.failSafe(error)); }, 1000); }
  private changed() { this.emit('change'); }
  private persist() { if (this.task) this.store.saveTask(this.task); this.changed(); }
  private log(level: string, message: string) { this.store.log(level, message); this.changed(); }
  private failSafe(error: any) {
    this.log('error', error.message ?? String(error));
    if (this.task && ACTIVE.has(this.task.status)) void this.halt('blocked', '发生错误，已停止自动执行，请检查运行记录');
  }
  snapshot() {
    return {
      settings: this.settings, task: this.task, quota: this.quota(), decision: this.decision,
      connection: { connected: this.codex.connected, account: this.codex.account, executable: this.codex.executable, models: this.codex.models },
      checkpoints: this.store.checkpoints(this.task?.id), logs: this.store.logs(), liveOutput: this.liveOutput,
      liveItems: this.liveItems, pendingApproval: this.pendingApproval && { method: this.pendingApproval.method, params: this.pendingApproval.params },
      now: this.now(), schedule: schedule(this.now(), this.settings)
    };
  }
  quota(): QuotaSnapshot | null { return this.task?.mode === 'demo' ? this.demoQuota : this.codex.quota; }
  saveSettings(input: any) {
    if (this.task && ACTIVE.has(this.task.status)) throw new Error('请先暂停任务，再修改运行策略');
    this.settings = validateSettings(input); this.store.set('settings', this.settings); this.changed(); return this.snapshot();
  }
  createTask(input: any) {
    if (this.task?.turnId || (this.task && ACTIVE.has(this.task.status))) throw new Error('请先停止当前任务');
    for (const key of ['title', 'goal', 'acceptance', 'projectPath']) if (typeof input[key] !== 'string' || input[key].length > 30000) throw new Error('任务内容无效');
    if (!input.title.trim() || !input.goal.trim() || !input.acceptance.trim()) throw new Error('请填写任务名称、目标和验收条件');
    const mode = input.mode === 'demo' ? 'demo' : 'live';
    if (mode === 'live' && (!path.isAbsolute(input.projectPath) || !existsSync(input.projectPath) || !statSync(input.projectPath).isDirectory())) throw new Error('请选择一个有效的本地项目目录');
    const now = this.now();
    this.task = {
      id: randomUUID(), title: input.title.trim(), goal: input.goal.trim(), acceptance: input.acceptance.trim(),
      projectPath: input.projectPath.trim(), mode, status: 'draft', reason: '任务已保存，等待开始',
      threadId: null, turnId: null, stages: 0, failures: 0, noProgress: 0,
      lastSummary: '', lastDiff: '', startedAt: null, nextRunAt: null, handoffAt: null, createdAt: now, updatedAt: now, blockAcknowledged: false
    };
    this.liveOutput = ''; this.liveItems = []; this.pendingApproval = null; this.decision = null;
    if (mode === 'demo') this.resetDemo();
    this.persist(); this.log('info', `已创建${mode === 'demo' ? '演示' : '真实'}任务：${this.task.title}`);
    return this.snapshot();
  }
  resetDemo() {
    const now = this.now();
    this.demoQuota = { source: 'demo', fetchedAt: now,
      short: { usedPercent: 15, windowDurationMins: 300, resetsAt: now + 90 * 60000 },
      weekly: { usedPercent: 36, windowDurationMins: 10080, resetsAt: now + 4 * 86400000 } };
  }
  async arm() {
    const task = this.task;
    if (!task) throw new Error('请先创建任务');
    if (task.turnId || this.starting) throw new Error('上一个阶段尚未结束，请稍候');
    if (task.status === 'blocked' && !task.blockAcknowledged) throw new Error('请先在任务对话中处理阻塞，并点击「已处理阻塞」');
    if (task.status === 'completed') throw new Error('任务已完成。请创建新任务。');
    if (task.mode === 'live') {
      await this.codex.connect(this.settings);
      if (this.codex.account?.type !== 'chatgpt') throw new Error('请先使用 ChatGPT 账户登录 Codex');
      await this.codex.refresh();
      if (!this.codex.quota?.short || !this.codex.quota?.weekly) throw new Error('未能读取完整的 5h 和周额度，暂不启动');
    } else if (!this.demoQuota) this.resetDemo();
    task.status = 'armed'; task.reason = '已开启夜间调度'; task.nextRunAt = null; task.blockAcknowledged = false;
    task.handoffAt = schedule(this.now(), this.settings).wakeAt;
    task.startedAt ??= this.now(); task.failures = 0; this.closing = false; this.graceAt = null;
    this.persist(); this.log('info', '夜间调度已开启；到起床时间自动交接，保护上午额度。');
    await this.tick(); return this.snapshot();
  }
  private prompt() {
    const task = this.task!;
    return `你在长程任务助手中执行一个有边界的开发阶段。\n项目：${task.projectPath}\n总目标：${task.goal}\n验收条件：${task.acceptance}\n` +
      `这是第 ${task.stages + 1} 阶段。仅完成一个可验证的小阶段，尽量在 ${this.settings.stageMinutes} 分钟内结束。完成后立即停止本轮，由外部调度器决定是否继续。\n` +
      `不要自行启动无人监管的后台开发进程、创建调度任务、发布或部署、推送或合并代码，也不要自行扩大权限。遇到需要用户决定或授权的问题，返回 blocked。\n` +
      `开始前检查当前文件状态，保留用户已有修改。用具体检查证明进展；不要为了完成而删测试或伪造结果。\n` +
      `上次摘要：${task.lastSummary || '首次执行，请先检查项目并选择最小可验证步骤。'}\n` +
      `结束时按要求返回 JSON：status 为 continue、completed 或 blocked；summary 写实际进展；nextStep 写下一步；verification 写真实验证结果；madeProgress 表示是否有实质进展。只有全部验收条件有证据满足时才返回 completed。`;
  }
  async tick() {
    if (this.busy || this.starting || !this.task || !ACTIVE.has(this.task.status)) return;
    this.busy = true;
    try {
      const task = this.task; const now = this.now();
      if (task.handoffAt && now >= task.handoffAt) { await this.halt('paused', '已到起床时间，后台让出控制，上午额度留给你'); return; }
      if (task.mode === 'live' && now - this.lastPollAt >= this.settings.pollSeconds * 1000 && !this.pollInFlight) {
        this.pollInFlight = true; this.lastPollAt = now;
        try { await this.codex.refresh(); }
        catch { this.codex.quota = null; }
        finally { this.pollInFlight = false; }
      }
      if (task.mode === 'demo' && this.demoQuota) this.demoQuota.fetchedAt = now;
      this.decision = decide(now, this.settings, this.quota());
      // Demo runs exercise stage orchestration immediately; the actual time policy stays visible.
      if (task.mode === 'demo' && this.decision.action === 'wait' && this.decision.reason.includes('今晚')) this.decision = { ...this.decision, action: 'run', reason: '演示模式：跳过夜间时段等待', nextAt: null };
      if (task.mode === 'demo' && this.demoQuota?.short && 100 - this.demoQuota.short.usedPercent <= this.settings.morningReserve + this.settings.buffer)
        this.decision = { ...this.decision, action: 'protect', reason: '演示：已触及上午保留线，后台暂停', nextAt: task.handoffAt };
      const d = this.decision;
      if (task.turnId) {
        if (task.mode === 'demo' && now >= this.demoEndsAt) { this.finishDemo(); return; }
        if (d.action !== 'run') {
          // Use the existing stage to wind down. No fresh model call is started for summarization.
          if (d.action === 'stop' || d.action === 'block' || d.action === 'protect') {
            await this.halt(d.action === 'stop' ? 'stopped' : d.action === 'block' ? 'blocked' : 'protecting', d.reason);
            return;
          }
          if (!this.graceAt) await this.requestWrap(d.reason);
        }
        if (now - this.stageStartedAt >= this.settings.stageMinutes * 60000 && !this.graceAt) await this.requestWrap('本阶段时间已到，请保存检查点并结束');
        if (this.graceAt && now >= this.graceAt) await this.halt('paused', '阶段未及时结束，已中断并保存本地进度，请检查后继续');
        return;
      }
      if (d.action === 'stop') { task.status = 'stopped'; task.reason = d.reason; task.nextRunAt = null; this.localCheckpoint('周额度保护', d.reason); this.persist(); return; }
      if (d.action === 'block') { task.status = 'blocked'; task.reason = d.reason; task.nextRunAt = null; this.persist(); return; }
      if (d.action === 'protect') { task.status = 'protecting'; task.reason = d.reason; task.nextRunAt = d.nextAt; this.persistIfChanged(); return; }
      if (d.action === 'wait' || (task.nextRunAt && task.nextRunAt > now)) {
        if (d.action === 'wait') { task.reason = d.reason; task.nextRunAt = d.nextAt; }
        task.status = 'waiting'; this.persistIfChanged(); return;
      }
      await this.beginStage();
    } finally { this.busy = false; }
  }
  private lastPersistedState = '';
  private persistIfChanged() {
    const key = JSON.stringify([this.task?.status, this.task?.reason, this.task?.nextRunAt]);
    if (key !== this.lastPersistedState) { this.lastPersistedState = key; this.persist(); }
  }
  private async beginStage() {
    const task = this.task!; this.starting = true; this.manualTurn = false; this.liveOutput = ''; this.liveItems = []; this.graceAt = null; this.closing = false;
    task.status = 'running'; task.reason = '正在执行一个可验证的小阶段'; task.nextRunAt = null;
    task.lastDiff = '';
    this.stageStartedAt = this.now(); this.persist();
    try {
      if (task.mode === 'demo') { task.turnId = `demo-${randomUUID()}`; this.demoEndsAt = this.now() + 5500; this.liveOutput = '正在演示检查点保存与额度保护流程。不会调用模型或修改项目文件。'; }
      else task.turnId = await this.codex.startStage(task, this.prompt(), this.settings);
      this.persist();
    } catch (error: any) { task.turnId = null; task.status = 'blocked'; task.reason = error.message; this.log('error', error.message); this.persist(); }
    finally { this.starting = false; if (this.queuedCompletion) { const event = this.queuedCompletion; this.queuedCompletion = null; this.event(event); } }
  }
  private async requestWrap(reason: string) {
    if (!this.task) return;
    this.graceAt = this.now() + 45000; this.task.reason = `${reason}，正在收尾`; this.persist();
    if (this.task.mode === 'live') await this.codex.steer(this.task, '请立即停止拓展工作，记录现有进展、验证结果和下一步，返回阶段 JSON 并结束本轮。').catch(() => {});
  }
  private requestApproval(request: any) {
    const task = this.task;
    if (!task || task.mode !== 'live' || !task.threadId || request.params?.threadId !== task.threadId ||
        (task.turnId && request.params?.turnId !== task.turnId) || (!task.turnId && !this.starting)) {
      this.codex.rpc.rejectRequest(request.id, '无匹配的活动任务'); return;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'].includes(request.method)) {
      this.codex.rpc.rejectRequest(request.id, '当前应用不支持此交互请求');
      task.status = 'blocked'; task.reason = `等待你处理：当前应用不支持 ${request.method}，请检查对话`;
      task.blockAcknowledged = false; task.nextRunAt = null; this.persist(); return;
    }
    if (this.pendingApproval) { this.codex.rpc.rejectRequest(request.id, '已有待处理请求'); return; }
    this.pendingApproval = request;
    task.status = 'blocked'; task.blockAcknowledged = false; task.nextRunAt = null;
    const p = request.params ?? {};
    task.reason = `等待你处理：${p.reason || p.command || (request.method === 'item/tool/requestUserInput' ? 'Codex 提出了选择题' : 'Codex 请求权限')}`.slice(0, 1000);
    this.persist(); this.log('warn', task.reason);
  }
  answerApproval(decision: string, answers?: Record<string, string[]>) {
    const request = this.pendingApproval;
    if (!request || !this.task?.turnId) throw new Error('当前没有待处理的权限或选择请求');
    if (request.method === 'item/tool/requestUserInput') {
      if (decision !== 'answer' || !answers) throw new Error('请回答选择题');
      this.codex.rpc.respond(request.id, { answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])) });
    } else if (request.method === 'item/permissions/requestApproval') {
      const requested = request.params?.permissions ?? {};
      this.codex.rpc.respond(request.id, { permissions: decision === 'accept' ? requested : {}, scope: 'turn' });
    } else if (/requestApproval$/.test(request.method)) {
      if (!['accept', 'decline'].includes(decision)) throw new Error('请选择允许或拒绝');
      this.codex.rpc.respond(request.id, { decision });
    } else throw new Error('不支持此请求类型');
    this.pendingApproval = null;
    this.task.reason = '已提交你的选择；当前阶段继续，结束后仍需手动开启夜间调度';
    this.persist(); return this.snapshot();
  }
  acknowledgeBlock() {
    if (!this.task || this.task.status !== 'blocked' || this.task.turnId || this.pendingApproval) throw new Error('请等待当前请求或阶段结束');
    this.task.blockAcknowledged = true; this.task.reason = '已确认阻塞条件得到处理；可手动继续夜间调度';
    this.persist(); return this.snapshot();
  }
  async sendMessage(message: string) {
    const task = this.task;
    if (!task || task.mode !== 'live' || !task.threadId) throw new Error('当前没有可回复的 Codex 会话');
    if (typeof message !== 'string' || !message.trim() || message.length > 30000) throw new Error('请输入 1 至 30000 字的回复');
    if (task.turnId || this.starting || ACTIVE.has(task.status)) throw new Error('请先暂停当前阶段，再发送回复');
    await this.codex.connect(this.settings);
    this.starting = true; this.manualTurn = true; this.liveOutput = ''; this.liveItems = [];
    task.reason = '你已回复，Codex 正在同一会话中处理'; this.persist();
    try { task.turnId = await this.codex.startReply(task, message.trim(), this.settings); this.persist(); }
    catch (error: any) { this.manualTurn = false; task.reason = `发送失败：${error.message}`; this.persist(); throw error; }
    finally { this.starting = false; if (this.queuedCompletion) { const event = this.queuedCompletion; this.queuedCompletion = null; this.event(event); } }
    return this.snapshot();
  }
  async conversation() {
    const task = this.task;
    if (!task?.threadId || task.mode !== 'live') return [];
    await this.codex.connect(this.settings);
    return this.codex.history(task.threadId);
  }
  private event(event: any) {
    const task = this.task; if (!task || task.mode !== 'live') return;
    const p = event.params ?? {};
    if (p.threadId && p.threadId !== task.threadId) return;
    if (!task.threadId || (!task.turnId && !this.starting)) return;
    if (p.turnId && task.turnId && p.turnId !== task.turnId) return;
    if (event.method === 'item/agentMessage/delta') { this.liveOutput = (this.liveOutput + (p.delta ?? '')).slice(-20000); this.changed(); }
    if (event.method === 'turn/diff/updated') { task.lastDiff = String(p.diff ?? '').slice(0, 200000); this.persist(); }
    if (event.method === 'item/completed') {
      const item = p.item ?? {};
      if (['userMessage','agentMessage','commandExecution','fileChange'].includes(item.type)) {
        this.liveItems = [...this.liveItems.filter(x => x.id !== item.id), item].slice(-200);
        this.changed();
      }
      if (item.type === 'agentMessage') { this.liveOutput = String(item.text ?? '').slice(-20000); task.lastSummary = this.liveOutput; this.persist(); }
      if (item.type === 'commandExecution') this.log('info', `命令结束，退出码 ${item.exitCode ?? '未知'}：${String(item.command).slice(0, 500)}`);
      if (item.type === 'fileChange') this.log('info', `文件变更：${(item.changes ?? []).map((x: any) => x.path).join('、').slice(0, 1000)}`);
    }
    if (event.method === 'turn/completed') {
      if (this.starting) { this.queuedCompletion = event; return; }
      if (task.turnId && p.turn?.id !== task.turnId) return;
      this.pendingApproval = null;
      if (this.manualTurn) {
        this.manualTurn = false; task.turnId = null;
        task.lastSummary = this.liveOutput || task.lastSummary;
        task.reason = '回复已完成；检查对话和阻塞条件后，可手动继续夜间调度';
        this.persist();
      } else this.finishStage(p.turn?.status ?? 'failed', p.turn?.error);
    }
  }
  private finishStage(turnStatus: string, error?: any) {
    const task = this.task!; const previously = task.status;
    task.turnId = null; this.graceAt = null;
    let result: any = null;
    try { result = JSON.parse(this.liveOutput.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { /* checkpoint retained, but no blind continuation */ }
    task.stages++;
    const summary = result?.summary || this.liveOutput || task.lastSummary || '阶段结束，未收到完整模型总结，请检查文件和日志。';
    task.lastSummary = summary;
    const cp: Checkpoint = { id: randomUUID(), taskId: task.id, at: this.now(), stage: task.stages,
      summary, nextStep: result?.nextStep ?? '检查当前文件、diff 和会话记录后继续', verification: result?.verification ?? '本阶段未提供完整验证结果', diff: task.lastDiff, status: turnStatus };
    task.blockAcknowledged = false;
    if (!ACTIVE.has(previously) || this.closing) { /* preserve manual pause, stop, or handoff */ }
    else if (turnStatus === 'completed' && result && ['continue', 'completed', 'blocked'].includes(result.status)) {
      task.failures = 0; task.noProgress = result.madeProgress ? 0 : task.noProgress + 1;
      if (result.status === 'completed') { task.status = 'completed'; task.reason = '任务已报告完成，请审查验收证据与代码修改'; task.nextRunAt = null; }
      else if (result.status === 'blocked' || !result.madeProgress) {
        task.status = 'blocked'; task.nextRunAt = null;
        task.reason = `等待你处理：${result.nextStep || result.summary || '本阶段没有实质进展'}`.slice(0, 1000);
      }
      else { task.status = 'waiting'; task.reason = '阶段已保存，重新检查额度后继续'; task.nextRunAt = this.now() + 3000; }
    } else if (turnStatus === 'failed') {
      task.failures++;
      const limit = /usage.?limit|rate.?limit|quota|额度/i.test(JSON.stringify(error ?? {}));
      if (limit && task.failures < 3) { task.status = 'waiting'; task.reason = '额度限制，已保存进度并等待实际刷新'; task.nextRunAt = Math.max(this.now() + 60000, (this.quota()?.short?.resetsAt ?? this.now()) + 5000); }
      else { task.status = 'blocked'; task.reason = error?.message ?? '执行失败，请检查记录后手动继续'; }
    } else { task.status = 'blocked'; task.reason = '阶段中断或返回格式不完整，已保存进度，等待检查'; }
    this.store.finishStage(task, cp); this.log(turnStatus === 'completed' ? 'info' : 'warn', `阶段 ${task.stages} 已保存：${task.reason}`); this.changed();
  }
  private finishDemo() {
    const task = this.task!; const q = this.demoQuota!;
    q.short!.usedPercent = Math.min(100, q.short!.usedPercent + 14); q.weekly!.usedPercent += 2; q.fetchedAt = this.now();
    this.liveOutput = JSON.stringify({ status: 'continue', summary: `演示阶段 ${task.stages + 1}：已模拟保存进度和验证记录，未执行真实开发。`, nextStep: '重新读取额度；触及上午保留线时暂停', verification: '演示状态流转完成；未运行真实项目测试', madeProgress: true });
    this.finishStage('completed');
  }
  private localCheckpoint(title: string, details: string) {
    if (!this.task) return;
    this.store.checkpoint({ id: randomUUID(), taskId: this.task.id, at: this.now(), stage: this.task.stages,
      summary: `${title}。${this.task.lastSummary || this.liveOutput || '尚无模型阶段总结'}`, nextStep: details,
      verification: '本地恢复检查点；验证结果以已完成阶段为准', diff: this.task.lastDiff, status: 'local' });
  }
  async halt(status: Task['status'] = 'paused', reason = '已暂停，额度留给你使用') {
    if (!this.task) return this.snapshot();
    if (this.starting) throw new Error('阶段正在启动，请稍后再暂停');
    const task = this.task; this.closing = true;
    if (this.pendingApproval) {
      const request = this.pendingApproval;
      if (request.method === 'item/permissions/requestApproval') this.codex.rpc.respond(request.id, { permissions: {}, scope: 'turn' });
      else if (/requestApproval$/.test(request.method)) this.codex.rpc.respond(request.id, { decision: 'cancel' });
      else this.codex.rpc.rejectRequest(request.id, '用户已暂停任务');
      this.pendingApproval = null;
    }
    task.status = status; task.reason = reason; task.nextRunAt = null; this.localCheckpoint('暂停检查点', reason); this.persist();
    if (task.turnId) {
      if (task.mode === 'live') {
        try { await this.codex.interrupt(task); }
        catch { this.codex.close(); task.turnId = null; }
      } else { task.turnId = null; }
    }
    this.persist(); this.log('info', reason); return this.snapshot();
  }
  async stopWithSummary() {
    // Report from durable evidence even with zero quota. Never require a final paid request.
    return this.halt('stopped', '任务已停止，阶段总结与本地检查点已保存');
  }
  report(): string {
    const task = this.task; if (!task) throw new Error('尚无任务可导出');
    const cps = this.store.checkpoints(task.id).reverse();
    return `# ${task.title} — 运行报告\n\n生成时间：${new Date(this.now()).toLocaleString()}\n\n模式：${task.mode === 'demo' ? '演示（未调用模型）' : '真实 Codex'}\n\n状态：${task.reason}\n\n项目：${task.projectPath || '演示项目'}\n\n会话：${task.threadId || '尚未创建'}\n\n## 目标\n\n${task.goal}\n\n## 验收条件\n\n${task.acceptance}\n\n## 阶段与恢复记录\n\n` +
      cps.map(cp => `### 阶段 ${cp.stage} · ${new Date(cp.at).toLocaleString()}\n\n${cp.summary}\n\n验证：${cp.verification}\n\n下一步：${cp.nextStep}\n`).join('\n') +
      `\n## 最近一次差异\n\n\`\`\`diff\n${task.lastDiff || '暂无差异记录'}\n\`\`\`\n`;
  }
  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    if (this.task && (ACTIVE.has(this.task.status) || this.task.turnId)) {
      await this.halt('paused', '应用已退出，检查点已保存，下次启动后手动继续');
      this.task.turnId = null; this.pendingApproval = null; this.persist();
    }
    this.codex.close();
  }
}
