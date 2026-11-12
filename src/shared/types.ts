export interface Settings {
  wakeTime: string;
  refreshAfterWakeMinutes: number;
  nightStart: string;
  morningReserve: number;
  weeklyReserve: number;
  buffer: number;
  shortWindowReserve: number;
  stageMinutes: number;
  pollSeconds: number;
  preventSleep: boolean;
  autoStart: boolean;
  codexPath: string;
  model: string;
  networkAccess: boolean;
  fontSize: 14 | 16 | 18 | 20;
}
export interface QuotaWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}
export interface QuotaSnapshot {
  short: QuotaWindow | null;
  weekly: QuotaWindow | null;
  fetchedAt: number;
  source: 'live' | 'demo';
  accountId?: string;
}
export type TaskStatus = 'draft' | 'armed' | 'running' | 'waiting' | 'protecting' | 'paused' | 'blocked' | 'completed' | 'stopped';
export interface Task {
  id: string;
  title: string;
  projectPath: string;
  goal: string;
  acceptance: string;
  mode: 'live' | 'demo';
  status: TaskStatus;
  reason: string;
  threadId: string | null;
  turnId: string | null;
  stages: number;
  failures: number;
  noProgress: number;
  lastSummary: string;
  lastDiff: string;
  startedAt: number | null;
  nextRunAt: number | null;
  handoffAt: number | null;
  createdAt: number;
  updatedAt: number;
  blockAcknowledged?: boolean;
}
export interface Checkpoint {
  id: string;
  taskId: string;
  at: number;
  stage: number;
  summary: string;
  nextStep: string;
  verification: string;
  diff: string;
  status: string;
}
export interface LogEntry { id: number; at: number; level: string; message: string }
export interface Decision { action: 'run' | 'wait' | 'protect' | 'stop' | 'block'; reason: string; nextAt: number | null; anchorAt: number; wakeAt: number; refreshAt: number | null }
export const DEFAULT_SETTINGS: Settings = {
  wakeTime: '10:00', refreshAfterWakeMinutes: 60, nightStart: '23:00',
  morningReserve: 50, weeklyReserve: 30, buffer: 7,
  shortWindowReserve: 8, stageMinutes: 8, pollSeconds: 60,
  preventSleep: true, autoStart: false, codexPath: '', model: '', networkAccess: false, fontSize: 16
};
