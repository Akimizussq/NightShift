import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export class RpcClient extends EventEmitter {
  child: ChildProcessWithoutNullStreams | null = null;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  nextId = 1;
  closed = false;
  lastDiagnostic = '';
  constructor(private timeout = 30000) { super(); }
  async connect(command: string, args: string[], env = process.env) {
    if (this.child) this.close();
    this.closed = false;
    this.lastDiagnostic = '';
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.child = child;
    const rl = createInterface({ input: child.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      let message: any;
      try { message = JSON.parse(line); } catch { this.emit('diagnostic', '忽略一条非协议输出'); return; }
      if (message.method && message.id !== undefined) this.emit('request', message);
      else if (message.method) this.emit('notification', message);
      else if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) request.reject(Object.assign(new Error(message.error.message ?? 'Codex 请求失败'), { data: message.error }));
        else request.resolve(message.result);
      }
    });
    child.stderr.on('data', data => { this.lastDiagnostic = (this.lastDiagnostic + String(data)).slice(-4000); this.emit('diagnostic', String(data).slice(-4000)); });
    child.stdin.on('error', error => { if (this.child === child) this.fail(error); });
    child.on('error', error => { if (this.child === child) this.fail(error); });
    child.on('exit', (code, signal) => { rl.close(); if (this.child !== child) return; this.child = null; this.fail(new Error(`Codex 进程退出 (${code ?? signal})${this.lastDiagnostic ? '：' + this.lastDiagnostic.slice(-1500) : ''}`)); });
    await this.call('initialize', { clientInfo: { name: 'nightshift_local', title: '长程任务助手', version: '0.2.0' } });
    this.notify('initialized', {});
  }
  call(method: string, params: any = {}): Promise<any> {
    if (!this.child || this.closed) return Promise.reject(new Error('Codex 尚未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  notify(method: string, params: any) { this.child?.stdin.write(JSON.stringify({ method, params }) + '\n'); }
  respond(id: number | string, result: any) { this.child?.stdin.write(JSON.stringify({ id, result }) + '\n'); }
  rejectRequest(id: number | string, message: string) { this.child?.stdin.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n'); }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (!this.closed) { this.closed = true; this.emit('disconnected', error.message); }
  }
  close() { this.closed = true; const child = this.child; this.child = null; child?.stdin.end(); child?.kill(); this.fail(new Error('连接已关闭')); }
}
