import type { Settings, QuotaSnapshot, QuotaWindow, Decision } from './types.js';

export function atTime(day: Date, time: string): number {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(day); d.setHours(h, m, 0, 0); return d.getTime();
}
// A night belongs to the coming morning, including its early-evening wait period.
export function schedule(now: number, s: Settings) {
  let wakeAt = atTime(new Date(now), s.wakeTime);
  if (now >= wakeAt) { const d = new Date(wakeAt); d.setDate(d.getDate() + 1); wakeAt = d.getTime(); }
  const morningDate = new Date(wakeAt);
  let startAt = atTime(morningDate, s.nightStart);
  if (startAt >= wakeAt) { const d = new Date(startAt); d.setDate(d.getDate() - 1); startAt = d.getTime(); }
  const desiredReset = wakeAt + s.refreshAfterWakeMinutes * 60000;
  const anchorAt = desiredReset - 5 * 60 * 60000;
  return { wakeAt, startAt, desiredReset, anchorAt };
}
export function normalizeQuota(payload: any, now = Date.now(), source: 'live' | 'demo' = 'live'): QuotaSnapshot {
  const buckets = payload?.rateLimitsByLimitId;
  const raw = buckets?.codex ?? payload?.rateLimits;
  // Do not guess which unrelated model bucket belongs to Codex.
  const windows = [raw?.primary, raw?.secondary].filter(Boolean);
  function find(duration: number): QuotaWindow | null {
    const w = windows.find(w => w.windowDurationMins === duration);
    if (!w || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 || !Number.isFinite(w.resetsAt)) return null;
    return { usedPercent: w.usedPercent, windowDurationMins: duration, resetsAt: w.resetsAt * 1000 };
  }
  return { short: find(300), weekly: find(10080), fetchedAt: now, source, accountId: payload?.accountId };
}
export function decide(now: number, s: Settings, q: QuotaSnapshot | null): Decision {
  const times = schedule(now, s);
  const base = { anchorAt: times.anchorAt, wakeAt: times.wakeAt, refreshAt: q?.short?.resetsAt ?? null };
  const result = (action: Decision['action'], reason: string, nextAt: number | null = null): Decision => ({ ...base, action, reason, nextAt });
  if (!q || !q.short || !q.weekly || now - q.fetchedAt > Math.max(s.pollSeconds * 3, 180) * 1000 || q.fetchedAt > now + 5000)
    return result('block', '额度数据缺失或过期，暂停执行并等待重新读取');
  // A reset timestamp is only a hint: always obtain a fresh server snapshot.
  if (q.weekly.resetsAt <= now)
    return result('wait', '已到刷新时间，重新核实额度后再决定是否运行', now + 15000);
  if (100 - q.weekly.usedPercent <= s.weeklyReserve + s.buffer)
    return result('stop', '周额度已进入保护缓冲区，停止夜间任务');
  if (now < times.startAt) return result('wait', '等待今晚的运行时段', times.startAt);
  if (q.short.resetsAt <= now) {
    if (q.fetchedAt < q.short.resetsAt + 5000) return result('wait', '等待刷新后读取新的额度状态', q.short.resetsAt + 5000);
    // Some backends retain the expired window until the next request. Align that
    // first request to the morning anchor, rather than opening a 04:00—09:00 window.
    if (now < times.anchorAt && now + 5 * 3600000 > times.anchorAt)
      return result('wait', '旧窗口已结束，等待早晨目标时间开启下一轮', times.anchorAt);
    return result('run', '已在刷新后重新读取额度，尝试恢复一个小阶段');
  }
  const remaining = 100 - q.short.usedPercent;
  // Once the desired morning refresh is reached, leave the next window to the user.
  // The controller separately latches morning handoff so it cannot auto-run next night.
  const morningWindow = now >= times.anchorAt || q.short.resetsAt > times.anchorAt;
  if (morningWindow && remaining <= s.morningReserve + s.buffer)
    return result('protect', '已为上午保留额度，后台暂停', times.wakeAt);
  if (!morningWindow && remaining <= s.shortWindowReserve + s.buffer)
    return result('wait', '本轮额度接近收尾线，保存进度并等待刷新', q.short.resetsAt + 5000);
  // Drain no work past the target anchor if doing so would push the morning reset later.
  // Existing windows are never forcibly restarted or represented as realigned.
  if (now < times.anchorAt && q.short.resetsAt <= times.anchorAt && q.short.resetsAt > now && now + s.stageMinutes * 60000 >= q.short.resetsAt)
    return result('wait', '临近窗口结束，等待后按实际时间安排早晨窗口', q.short.resetsAt + 5000);
  return result('run', morningWindow ? '在上午保留线以上推进一个阶段' : '夜间额度充足，推进一个阶段');
}

export function validateSettings(input: any): Settings {
  const s = { ...input };
  for (const key of ['wakeTime', 'nightStart']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s[key])) throw new Error('时间格式应为 HH:mm');
  const ranges: Record<string, [number, number]> = {
    refreshAfterWakeMinutes: [0, 180], morningReserve: [10, 90], weeklyReserve: [10, 90], buffer: [3, 15],
    shortWindowReserve: [3, 30], stageMinutes: [1, 20], pollSeconds: [15, 300]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`${key} 超出允许范围 ${min}—${max}`);
  if (![14, 16, 18, 20].includes(s.fontSize)) throw new Error('字体大小无效');
  if (s.morningReserve + s.buffer >= 100 || s.weeklyReserve + s.buffer >= 100) throw new Error('保留比例加缓冲必须小于 100%');
  for (const key of ['preventSleep', 'autoStart', 'networkAccess']) if (typeof s[key] !== 'boolean') throw new Error('开关配置无效');
  for (const key of ['codexPath', 'model']) if (typeof s[key] !== 'string' || s[key].length > 1000) throw new Error('执行配置无效');
  return s;
}
