import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';

export type SqliteDb = Database.Database;

let db: SqliteDb | null = null;

export function getDb(): SqliteDb {
  if (!db) {
    ensureDirs();
    db = new Database(config.databaseFile);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    // 新打开（含备份还原后重连）的库也要追到当前 schema，
    // 否则代码依赖的新表（如 file_cleanup）在旧快照上可能不存在。
    applyMigrations();
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** 按文件名顺序应用 sql/*.sql，已应用过的记录在 _migration 表 */
export function migrate(): string[] {
  return applyMigrations();
}

function applyMigrations(): string[] {
  const database = getInitializedDb();
  database.exec(
    'CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    database.prepare('SELECT name FROM _migration').all().map((r) => (r as { name: string }).name),
  );
  const files = fs
    .readdirSync(config.sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(config.sqlDir, file), 'utf8');
    const run = database.transaction(() => {
      database.exec(sql);
      database
        .prepare('INSERT INTO _migration (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    });
    run();
    ran.push(file);
  }
  return ran;
}

function getInitializedDb(): SqliteDb {
  if (!db) {
    // 仅迁移内部使用：正常路径下 getDb() 已创建连接
    ensureDirs();
    db = new Database(config.databaseFile);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function rowToBool(value: unknown): boolean {
  return value === 1 || value === true;
}
