// SQLite through Node's built-in `node:sqlite` (no native add-on to compile, which matters on Termux).
// WAL journaling, foreign keys, a busy timeout, ordered migrations and nestable transactions.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations.js";

type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

const require = createRequire(import.meta.url);

/** Load node:sqlite, silencing only its one-time ExperimentalWarning. */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (error) {
    throw new Error(
      `node:sqlite is unavailable in this Node.js (${process.version}). QuantForge needs Node.js 22.13 or newer. ${(error as Error).message}`,
    );
  } finally {
    process.emitWarning = original;
  }
}

export class Database {
  readonly raw: DatabaseSyncType;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = loadSqlite();
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.raw.exec("PRAGMA journal_mode = WAL");
      this.raw.exec("PRAGMA synchronous = NORMAL");
    }
  }

  static open(path: string, migrations: readonly Migration[] = MIGRATIONS): Database {
    const db = new Database(path);
    db.migrate(migrations);
    return db;
  }

  prepare(sql: string): StatementSync {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      if (this.cache.size > 300) this.cache.clear();
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastId: number } {
    const r = this.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Run `fn` in a transaction (a savepoint when nested). Rolls back on any throw. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const name = `sp${this.depth}`;
    this.raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(outer ? "COMMIT" : `RELEASE ${name}`);
      return result;
    } catch (error) {
      this.depth--;
      try {
        this.raw.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
      } catch {
        // Already rolled back by SQLite.
      }
      throw error;
    }
  }

  migrate(migrations: readonly Migration[]): number[] {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const applied = new Set(
      this.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => Number(r.version)),
    );
    const done: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          m.version,
          m.name,
          Date.now(),
        );
      });
      done.push(m.version);
    }
    return done;
  }

  schemaVersion(): number {
    const r = this.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_migrations");
    return Number(r?.v ?? 0);
  }

  integrityCheck(): string {
    const r = this.get<{ integrity_check: string }>("PRAGMA integrity_check");
    return String(r?.integrity_check ?? "unknown");
  }

  /** Consistent online copy into a new file (SQLite VACUUM INTO). */
  backupTo(file: string): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.prepare("VACUUM INTO ?").run(file);
  }

  checkpoint(): void {
    try {
      this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // In-memory databases have no WAL.
    }
  }

  close(): void {
    this.cache.clear();
    try {
      this.checkpoint();
      this.raw.close();
    } catch {
      // Already closed.
    }
  }
}
