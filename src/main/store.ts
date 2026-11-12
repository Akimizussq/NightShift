import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import type { Task, Settings, Checkpoint, LogEntry } from '../shared/types.js';

export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'nightshift.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);`);
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as any;
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key: string, value: any) { this.db.prepare('INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings(): Settings { return { ...DEFAULT_SETTINGS, ...this.get('settings', {}) }; }
  task(): Task | null { return this.get('task', null); }
  saveTask(task: Task) { task.updatedAt = Date.now(); this.set('task', task); }
  checkpoint(cp: Checkpoint) { this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?)').run(cp.id, cp.taskId, cp.at, JSON.stringify(cp)); }
  // Commit the task state and checkpoint together; no stage can be silently lost on a crash.
  finishStage(task: Task, cp: Checkpoint) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.checkpoint(cp); this.saveTask(task); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  checkpoints(taskId?: string): Checkpoint[] {
    const rows = taskId ? this.db.prepare('SELECT data FROM checkpoints WHERE task_id=? ORDER BY at DESC LIMIT 100').all(taskId) : [];
    return rows.map((row: any) => JSON.parse(row.data));
  }
  log(level: string, message: string) {
    this.db.prepare('INSERT INTO logs(at,level,message) VALUES (?,?,?)').run(Date.now(), level, message.slice(0, 8000));
    this.db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 2000)');
  }
  logs(): LogEntry[] { return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 100').all() as unknown as LogEntry[]; }
  close() { this.db.close(); }
}
