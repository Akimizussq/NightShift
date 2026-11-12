declare global { interface Window { nightshift: any } }
const api = window.nightshift;
let state: any;
let busy = false;
let settingsLoaded = false;
let conversation: any[] = [];
let conversationThread = '';
let loadingConversation = false;
let toastTimer: ReturnType<typeof setTimeout>;
const $ = (id: string) => document.getElementById(id)!;
const text = (id: string, value: any) => { $(id).textContent = String(value); };
const escape = (value: any) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (value: number | null) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—:—';
const statusNames: Record<string,string> = { draft:'待开始',armed:'已开启',running:'执行中',waiting:'等待中',protecting:'额度保护',paused:'已暂停',blocked:'等待处理',completed:'已完成',stopped:'已停止' };
function toast(message: string, error = false) { clearTimeout(toastTimer); text('toast', message); $('toast').className = `toast${error ? ' error' : ''}`; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 3500); }
async function action(fn: () => Promise<any>, success?: string) {
  if (busy) return;
  busy = true;
  try { const result = await fn(); if (result?.settings) render(result); if (success) toast(success); return result; }
  catch (error: any) { toast(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
  finally { busy = false; }
}
function nav(page: string) {
  document.querySelectorAll<HTMLElement>('.view').forEach(el => { el.hidden = el.id !== `${page}-view`; });
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(el => el.classList.toggle('active', el.dataset.nav === page));
  text('page-label', ({ overview:'运行概览',task:'当前任务',conversation:'任务对话',checkpoints:'阶段记录',settings:'运行策略' } as any)[page]);
  window.scrollTo(0, 0);
  if (page === 'conversation') void loadConversation();
}
document.querySelectorAll<HTMLElement>('[data-nav]').forEach(el => el.addEventListener('click', () => nav(el.dataset.nav!)));
async function loadConversation() {
  if (loadingConversation || !state?.task?.threadId || state.task.mode !== 'live') return;
  loadingConversation = true;
  text('conversation-status', '正在读取本地 Codex 会话…');
  try { conversation = await api.conversation(); conversationThread = state.task.threadId; renderConversation(); }
  catch (error: any) { text('conversation-status', `读取会话失败：${error.message}`); }
  finally { loadingConversation = false; }
}
function renderConversation() {
  const task = state?.task;
  if (!task?.threadId || task.mode !== 'live') {
    text('conversation-status', '创建真实任务并开始阶段后，可以查看完整会话。');
    $('conversation-list').innerHTML = '<div class="empty-state">暂无会话内容</div>';
    return;
  }
  text('conversation-status', `${task.title} · ${task.projectPath} · 会话 ${task.threadId} · ${task.reason}`);
  const all: any[] = [];
  for (const turn of conversation) for (const item of (turn.items ?? [])) all.push(item.item ?? item);
  for (const item of state.liveItems ?? []) all.push(item);
  const seen = new Map<string, any>();
  all.forEach((item, i) => seen.set(item.id ?? `item-${i}`, item));
  const cards = [...seen.values()].map(item => {
    let title = '', body = '';
    if (item.type === 'userMessage') { title = '发送给 Codex'; body = (item.content ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n'); }
    else if (item.type === 'agentMessage') { title = 'Codex 回复'; body = item.text ?? ''; }
    else if (item.type === 'commandExecution') { title = `命令 · 退出码 ${item.exitCode ?? '运行中'}`; body = `${item.command ?? ''}\n${item.aggregatedOutput ?? ''}`; }
    else if (item.type === 'fileChange') { title = '文件变更'; body = (item.changes ?? []).map((x: any) => `${x.kind ?? ''} ${x.path ?? ''}\n${x.diff ?? ''}`).join('\n'); }
    else return '';
    return `<article class="conversation-item"><h3>${escape(title)}</h3><pre>${escape(body)}</pre></article>`;
  }).filter(Boolean);
  if (task.turnId && state.liveOutput && ![...seen.values()].some(x => x.type === 'agentMessage' && x.text === state.liveOutput)) cards.push(`<article class="conversation-item streaming"><h3>Codex 正在回复</h3><pre>${escape(state.liveOutput)}</pre></article>`);
  $('conversation-list').innerHTML = cards.join('') || '<div class="empty-state">会话已创建，等待第一条消息。</div>';
}
function renderApproval() {
  const request = state.pendingApproval;
  $('approval-card').hidden = !request;
  if (!request) return;
  const p = request.params ?? {};
  const questions = request.method === 'item/tool/requestUserInput' ? p.questions ?? [] : [];
  const detail = request.method === 'item/permissions/requestApproval' ? JSON.stringify(p.permissions ?? p.requestedPermissions ?? {}, null, 2) :
    request.method === 'item/commandExecution/requestApproval' ? `${p.command ?? ''}\n${p.cwd ?? ''}` :
    request.method === 'item/fileChange/requestApproval' ? `文件写入：${p.grantRoot ?? ''}` : '';
  text('approval-description', `${p.reason ?? ''}${detail ? '\n' + detail : ''}`.trim() || 'Codex 等待你的选择');
  $('approval-options').innerHTML = questions.map((q: any, i: number) => `<fieldset class="choice-card"><legend>${escape(q.header || q.question)}</legend><p>${escape(q.question)}</p>${(q.options ?? []).map((o: any) => `<label><input type="radio" name="question-${i}" value="${escape(o.label)}"><span>${escape(o.label)} · ${escape(o.description)}</span></label>`).join('')}${q.isOther || !q.options?.length ? `<label><input type="radio" name="question-${i}" value="__other__"><span>自行回答</span></label><input class="other-answer" type="${q.isSecret ? 'password' : 'text'}" id="answer-${i}" placeholder="输入你的回答">` : ''}</fieldset>`).join('');
  text('approval-accept-btn', questions.length ? '提交回答' : '允许本次');
  $('approval-decline-btn').hidden = !!questions.length;
}
function render(s: any) {
  const oldTurnId = state?.task?.turnId;
  state = s;
  if (conversationThread && s.task?.threadId !== conversationThread) { conversation = []; conversationThread = ''; }
  const task = s.task, q = s.quota, settings = s.settings;
  const active = task && ['armed','running','waiting','protecting'].includes(task.status);
  const demo = task?.mode === 'demo';
  $('demo-banner').hidden = !demo;
  text('connection-label', s.connection.connected ? (s.connection.account?.type === 'chatgpt' ? `Codex · ${s.connection.account.planType ?? '已登录'}` : '已连接 · 请登录') : '尚未连接 Codex');
  $('connection-dot').classList.toggle('connected', s.connection.connected);
  text('connect-btn', s.connection.connected ? '已连接' : '连接');
  const short = q?.short, weekly = q?.weekly;
  text('short-value', short ? Math.max(0,100-short.usedPercent) : '—');
  text('weekly-value', weekly ? Math.max(0,100-weekly.usedPercent) : '—');
  $('short-fill').style.width = `${short ? 100-short.usedPercent : 0}%`;
  $('weekly-fill').style.width = `${weekly ? 100-weekly.usedPercent : 0}%`;
  $('reserve-mark').style.left = `${settings.morningReserve}%`;
  $('weekly-mark').style.left = `${settings.weeklyReserve}%`;
  text('short-badge', demo ? '模拟额度' : short ? '实时额度' : '待连接');
  text('quota-source', q ? `${demo ? '模拟数据' : '服务器额度'} · ${time(q.fetchedAt)} 更新` : '等待真实额度');
  text('short-reserve', `上午保留 ${settings.morningReserve}%`);
  text('weekly-reserve', `保留 ${settings.weeklyReserve}%`);
  text('short-foot', short ? '标线为上午保留目标' : '读取后显示实际剩余');
  text('weekly-foot', weekly ? `${time(weekly.resetsAt)} · ${new Date(weekly.resetsAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})} 刷新` : '接近保护线时提前收尾');
  text('reset-value', time(short?.resetsAt));
  text('wake-label', `${settings.wakeTime} 起床交接`);
  text('alignment-label', short ? `目标 ${time(s.schedule.desiredReset)} · 以实际窗口为准` : `目标 ${time(s.schedule.desiredReset)} 刷新`);
  text('hero-reserve', `约 ${settings.morningReserve}% 可用额度`);
  text('hero-kicker', task ? statusNames[task.status] + ' · ' + (task.status === 'running' ? '一个阶段，一份进展' : task.reason) : '准备好，再开始今晚的任务');
  text('hero-description', task?.status === 'protecting' ? '后台已经暂停。上午额度留给你，已有进度已保存。' : '设置一个明确目标。阶段保存、额度保护和等待刷新，交给助手。');
  text('task-status', task ? statusNames[task.status] : '尚未创建');
  text('detail-status', task ? statusNames[task.status] : '等待开始');
  for (const id of ['task-status','detail-status']) $(id).className = `badge${task?.status === 'running' ? ' active' : ['protecting','blocked','waiting'].includes(task?.status) ? ' warn' : ''}`;
  text('task-title', task?.title ?? '给今晚安排一个明确目标');
  text('task-path', task ? (demo ? '演示项目 · 不修改真实文件' : task.projectPath) : '选择本地项目，写下验收条件');
  text('task-reason', task?.reason ?? '任务将分阶段执行，每次继续前重新检查额度。');
  text('stage-count', task?.stages ?? 0);
  text('thread-label', task?.turnId ? '阶段运行中' : task?.threadId ? '可恢复' : task?.stages ? '已保存' : '尚未开始');
  text('mode-label', demo ? '演示体验' : '真实运行');
  text('protection-morning', `上午保留约 ${settings.morningReserve}%`);
  text('protection-weekly', `周额度保留 ${settings.weeklyReserve}%`);
  text('buffer-description', `剩余 ${settings.morningReserve + settings.buffer}% 时触发保护，留出 ${settings.buffer} 点缓冲`);
  text('detail-title', task?.title ?? '尚未创建任务');
  text('detail-path', task?.projectPath || (demo ? '演示项目' : '—'));
  text('detail-thread', task?.threadId ?? '尚未创建会话');
  text('detail-goal', task?.goal ?? '创建任务后显示');
  text('detail-acceptance', task?.acceptance ?? '请使用可以验证的具体条件。');
  text('detail-reason', task?.reason ?? '每个阶段结束后，助手都会保存进度并重新检查额度。');
  document.documentElement.style.setProperty('--read-size', `${settings.fontSize || 16}px`);
  text('live-output', s.liveOutput || task?.lastSummary || '等待任务执行。你可以先创建演示任务，体验完整流程。');
  for (const id of ['pause-btn','task-pause-btn']) ($ (id) as HTMLButtonElement).disabled = !active;
  for (const id of ['new-task-btn','task-new-btn']) ($(id) as HTMLButtonElement).disabled = !!active || !!task?.turnId;
  for (const id of ['start-btn','task-start-btn']) ($(id) as HTMLButtonElement).disabled = !!active || task?.status === 'completed' || !!task?.turnId || (task?.status === 'blocked' && !task.blockAcknowledged);
  text('start-btn', !task ? '创建今晚的任务 ↗' : active ? '夜间调度已开启' : task.status === 'completed' ? '任务已完成 ✓' : task.status === 'draft' ? '开启夜间任务 ↗' : '继续夜间任务 ↗');
  ($('stop-btn') as HTMLButtonElement).disabled = !task || ['stopped','completed'].includes(task?.status);
  ($('export-btn') as HTMLButtonElement).disabled = !task;
  ($('open-project-btn') as HTMLButtonElement).disabled = !task || demo;
  ($('refresh-btn') as HTMLButtonElement).disabled = !s.connection.connected || demo;
  $('task-dot').hidden = !active;
  ($('reply-btn') as HTMLButtonElement).disabled = !task?.threadId || demo || !!active || !!task?.turnId;
  ($('acknowledge-btn') as HTMLButtonElement).disabled = task?.status !== 'blocked' || !!task?.turnId || !!task?.blockAcknowledged;
  text('reply-hint', task?.turnId ? '当前阶段仍在运行；请先处理请求或暂停。' : '回复完成后，手动继续夜间调度。');
  renderApproval();
  if (!$('conversation-view').hidden) renderConversation();
  if (oldTurnId && !task?.turnId && !$('conversation-view').hidden) void loadConversation();
  text('checkpoint-count', s.checkpoints.length);
  $('logs').innerHTML = s.logs.length ? s.logs.map((log: any) => `<div class="log ${escape(log.level)}"><time>${escape(time(log.at))}</time><span>${escape(log.message)}</span></div>`).join('') : '<div class="empty-small">暂无运行记录</div>';
  if (s.checkpoints.length) $('checkpoints').innerHTML = s.checkpoints.map((cp: any) => `<article class="checkpoint"><div class="checkpoint-top"><strong>${cp.status === 'local' ? '恢复检查点' : `阶段 ${cp.stage}`}</strong><time>${escape(new Date(cp.at).toLocaleString('zh-CN'))}</time></div><h4>${escape(cp.summary)}</h4><div class="checkpoint-detail"><b>验证结果</b>${escape(cp.verification)}</div><div class="checkpoint-detail"><b>下一步</b>${escape(cp.nextStep)}</div>${cp.diff ? `<details><summary>查看本阶段差异</summary><pre>${escape(cp.diff)}</pre></details>` : ''}</article>`).join('');
  else $('checkpoints').innerHTML = '<div class="empty-state"><span>◷</span><h3>每一步，都会留在这里</h3><p>完成阶段或暂停任务后，进度、验证结果和下一步会自动保存。</p></div>';
  if (!settingsLoaded) { fillSettings(settings); settingsLoaded = true; }
  text('detected-codex', s.connection.executable ?? '自动检测已安装的 Codex，也可手动指定 .exe');
  text('account-label', s.connection.account?.type === 'chatgpt' ? `ChatGPT · ${s.connection.account.planType ?? '已登录'}` : s.connection.account ? '当前登录方式不支持套餐额度监控，请使用 ChatGPT 登录' : '尚未登录');
  const modelSelect = $('model') as HTMLSelectElement;
  if (s.connection.models?.length && modelSelect.options.length <= 1) {
    for (const model of s.connection.models) modelSelect.add(new Option(model.displayName, model.id));
    modelSelect.value = settings.model;
  }
  updateClock();
}
function fillSettings(s: any) {
  const form = $('settings-form') as HTMLFormElement;
  for (const [key,value] of Object.entries(s)) {
    const el = form.elements.namedItem(key) as HTMLInputElement | null;
    if (!el) continue;
    if (typeof value === 'boolean') el.checked = value;
    else el.value = String(value);
  }
  previewSettings();
}
function previewSettings() {
  for (const key of ['morningReserve','weeklyReserve']) text(`${key}-output`, `${($ (key) as HTMLInputElement).value}%`);
  const wake = ($('wakeTime') as HTMLInputElement).value;
  if (!wake) return;
  const [h,m] = wake.split(':').map(Number);
  const desired = h*60 + m + Number(($('refreshAfterWakeMinutes') as HTMLInputElement).value);
  const fmt = (minutes: number) => { const n = ((minutes%1440)+1440)%1440; return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; };
  text('schedule-preview', `目标开启 ${fmt(desired-300)} → 起床 ${wake} → 目标刷新 ${fmt(desired)}`);
}
function updateClock() {
  text('clock', new Date().toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}));
  const reset = state?.quota?.short?.resetsAt;
  if (!reset) text('reset-countdown', '等待读取');
  else { const mins = Math.max(0,Math.ceil((reset-Date.now())/60000)); text('reset-countdown', mins ? `${Math.floor(mins/60)}h ${mins%60}m 后` : '等待核实刷新'); }
}
setInterval(updateClock, 1000);
function openTask() { ($('task-dialog') as HTMLDialogElement).showModal(); }
for (const id of ['new-task-btn','task-new-btn','demo-new-live']) $(id).addEventListener('click', openTask);
for (const id of ['close-dialog','cancel-dialog']) $(id).addEventListener('click', () => ($('task-dialog') as HTMLDialogElement).close());
for (const id of ['strategy-btn','edit-settings-btn']) $(id).addEventListener('click', () => nav('settings'));
$('detail-btn').addEventListener('click', () => nav('task'));
$('task-conversation-btn').addEventListener('click', () => nav('conversation'));
$('reload-conversation-btn').addEventListener('click', () => { void loadConversation(); });
$('reply-form').addEventListener('submit', event => {
  event.preventDefault();
  const field = $('reply-text') as HTMLTextAreaElement;
  const value = field.value.trim();
  if (!value) return;
  void action(async () => { const result = await api.sendMessage(value); field.value = ''; void loadConversation(); return result; }, '回复已发送到同一 Codex 会话');
});
$('acknowledge-btn').addEventListener('click', () => { void action(() => api.acknowledgeBlock(), '阻塞已标记为处理完毕，可手动继续'); });
$('approval-accept-btn').addEventListener('click', () => {
  const request = state?.pendingApproval;
  if (!request) return;
  let answers: Record<string, string[]> | undefined;
  if (request.method === 'item/tool/requestUserInput') {
    answers = {};
    for (const [i, q] of (request.params?.questions ?? []).entries()) {
      const selected = document.querySelector<HTMLInputElement>(`input[name="question-${i}"]:checked`);
      const value = selected?.value === '__other__' ? ($(`answer-${i}`) as HTMLInputElement).value.trim() : selected?.value;
      if (!value) { toast(`请回答：${q.question}`, true); return; }
      answers[q.id] = [value];
    }
  }
  void action(() => api.answerApproval(answers ? 'answer' : 'accept', answers), '选择已提交，当前阶段继续');
});
$('approval-decline-btn').addEventListener('click', () => { void action(() => api.answerApproval('decline'), '已拒绝本次请求'); });
for (const id of ['start-btn','task-start-btn']) $(id).addEventListener('click', () => { if (!state?.task) openTask(); else void action(() => api.arm(), '夜间调度已开启'); });
for (const id of ['pause-btn','task-pause-btn']) $(id).addEventListener('click', () => { void action(() => api.pause(), '已暂停，额度留给你'); });
$('stop-btn').addEventListener('click', () => { void action(() => api.stop(), '任务已停止，检查点和已有总结已保存'); });
for (const id of ['connect-btn','settings-connect-btn']) $(id).addEventListener('click', () => { void action(() => api.connect(), 'Codex 已连接'); });
$('login-btn').addEventListener('click', () => { void action(() => api.login(), '请在浏览器中完成 ChatGPT 登录'); });
$('refresh-btn').addEventListener('click', () => { void action(() => api.refresh(), '额度已更新'); });
$('export-btn').addEventListener('click', () => { void action(async () => { const file = await api.exportReport(); if (file) toast('任务报告已保存'); }); });
$('open-project-btn').addEventListener('click', () => { void action(() => api.openProject()); });
$('choose-project-btn').addEventListener('click', () => { void action(async () => { const selected = await api.selectProject(); if (selected) ($('project-path') as HTMLInputElement).value = selected; }); });
$('choose-codex-btn').addEventListener('click', () => { void action(async () => { const selected = await api.selectCodex(); if (selected) ($('codexPath') as HTMLInputElement).value = selected; }); });
$('task-form').addEventListener('change', () => {
  const data = new FormData($('task-form') as HTMLFormElement);
  const demo = data.get('mode') === 'demo';
  ($('project-path') as HTMLInputElement).disabled = demo; ($('choose-project-btn') as HTMLButtonElement).disabled = demo;
  if (demo && !($('task-name') as HTMLInputElement).value) {
    ($('task-name') as HTMLInputElement).value = '体验一次夜间任务';
    ($('task-goal') as HTMLInputElement).value = '演示阶段执行、进度保存和上午额度保护。';
    ($('task-acceptance') as HTMLInputElement).value = '触及额度保护线后自动暂停；不调用模型，不修改项目。';
  }
});
$('task-form').addEventListener('submit', event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData($('task-form') as HTMLFormElement));
  data.projectPath ??= '';
  void action(async () => { const result = await api.createTask(data); ($('task-dialog') as HTMLDialogElement).close(); nav('overview'); return result; }, '任务已保存');
});
$('settings-form').addEventListener('submit', event => event.preventDefault());
$('settings-form').addEventListener('input', previewSettings);
$('save-settings-btn').addEventListener('click', () => {
  const form = $('settings-form') as HTMLFormElement;
  if (!form.reportValidity()) return;
  const data = { ...state.settings };
  for (const [key, value] of Object.entries(state.settings)) {
    const el = form.elements.namedItem(key) as HTMLInputElement;
    if (el) data[key] = typeof value === 'boolean' ? el.checked : typeof value === 'number' ? Number(el.value) : el.value;
  }
  void action(async () => { const result = await api.saveSettings(data); fillSettings(result.settings); return result; }, '运行策略已保存');
});
api.onChange(render);
void action(async () => api.snapshot());
