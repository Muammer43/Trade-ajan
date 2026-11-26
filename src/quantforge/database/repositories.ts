// Repositories for market data, state, events and health. Trading ledgers live in execution/ledger.ts.

import { createHash } from "node:crypto";
import type { Candle, CandleQuality, StoredCandle, Timeframe } from "../core/types.js";
import type { Database } from "./db.js";

type CandleRow = {
  symbol: string;
  tf: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  provider: string;
  market_open: number;
  quality: string;
};

function toCandle(r: CandleRow): StoredCandle {
  return {
    symbol: r.symbol,
    tf: r.tf as Timeframe,
    ts: Number(r.ts),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    provider: r.provider,
    marketOpen: Number(r.market_open) === 1,
    quality: r.quality as CandleQuality,
  };
}

export class CandleRepo {
  constructor(private readonly db: Database) {}

  /** Insert or replace candles; returns how many rows were new. A replaced bar keeps the latest provider values. */
  upsert(candles: readonly StoredCandle[]): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;
    const now = Date.now();
    this.db.tx(() => {
      for (const c of candles) {
        const existing = this.db.get<{ close: number; high: number; low: number }>(
          "SELECT close, high, low FROM candles WHERE symbol=? AND tf=? AND ts=?",
          c.symbol,
          c.tf,
          c.ts,
        );
        if (!existing) {
          this.db.run(
            "INSERT INTO candles(symbol, tf, ts, open, high, low, close, volume, provider, market_open, quality, inserted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            c.symbol,
            c.tf,
            c.ts,
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume,
            c.provider,
            c.marketOpen ? 1 : 0,
            c.quality,
            now,
          );
          inserted++;
        } else if (existing.close !== c.close || existing.high !== c.high || existing.low !== c.low) {
          this.db.run(
            "UPDATE candles SET open=?, high=?, low=?, close=?, volume=?, provider=?, market_open=?, quality=? WHERE symbol=? AND tf=? AND ts=?",
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume,
            c.provider,
            c.marketOpen ? 1 : 0,
            c.quality,
            c.symbol,
            c.tf,
            c.ts,
          );
          updated++;
        }
      }
    });
    return { inserted, updated };
  }

  range(symbol: string, tf: Timeframe, from: number, to: number): StoredCandle[] {
    return this.db
      .all<CandleRow>(
        "SELECT * FROM candles WHERE symbol=? AND tf=? AND ts>=? AND ts<=? ORDER BY ts",
        symbol,
        tf,
        from,
        to,
      )
      .map(toCandle);
  }

  /** The last `limit` candles, oldest first. */
  latest(symbol: string, tf: Timeframe, limit: number): StoredCandle[] {
    return this.db
      .all<CandleRow>(
        "SELECT * FROM candles WHERE symbol=? AND tf=? ORDER BY ts DESC LIMIT ?",
        symbol,
        tf,
        limit,
      )
      .map(toCandle)
      .reverse();
  }

  last(symbol: string, tf: Timeframe): StoredCandle | undefined {
    const r = this.db.get<CandleRow>(
      "SELECT * FROM candles WHERE symbol=? AND tf=? ORDER BY ts DESC LIMIT 1",
      symbol,
      tf,
    );
    return r ? toCandle(r) : undefined;
  }

  first(symbol: string, tf: Timeframe): StoredCandle | undefined {
    const r = this.db.get<CandleRow>(
      "SELECT * FROM candles WHERE symbol=? AND tf=? ORDER BY ts ASC LIMIT 1",
      symbol,
      tf,
    );
    return r ? toCandle(r) : undefined;
  }

  count(symbol: string, tf: Timeframe): number {
    return Number(
      this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM candles WHERE symbol=? AND tf=?", symbol, tf)
        ?.n ?? 0,
    );
  }

  prune(symbol: string, tf: Timeframe, before: number): number {
    return this.db.run("DELETE FROM candles WHERE symbol=? AND tf=? AND ts<?", symbol, tf, before).changes;
  }
}

/** Plain candles of stored rows (dropping storage-only fields). */
export function plain(c: StoredCandle): Candle {
  return { ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

export class StateRepo {
  constructor(private readonly db: Database) {}
  get<T>(key: string): T | undefined {
    const r = this.db.get<{ value_json: string }>("SELECT value_json FROM kv_state WHERE key=?", key);
    return r ? (JSON.parse(r.value_json) as T) : undefined;
  }
  set(key: string, value: unknown): void {
    this.db.run(
      "INSERT INTO kv_state(key, value_json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
      key,
      JSON.stringify(value),
      Date.now(),
    );
  }
  delete(key: string): void {
    this.db.run("DELETE FROM kv_state WHERE key=?", key);
  }
}

export class EventRepo {
  constructor(private readonly db: Database) {}
  system(level: string, source: string, message: string, detail?: unknown): void {
    this.db.run(
      "INSERT INTO system_events(ts, level, source, message, detail_json) VALUES (?,?,?,?,?)",
      Date.now(),
      level,
      source,
      message,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }
  risk(kind: string, severity: "info" | "warn" | "critical", detail?: unknown): void {
    this.db.run(
      "INSERT INTO risk_events(ts, kind, severity, detail_json) VALUES (?,?,?,?)",
      Date.now(),
      kind,
      severity,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }
  recentSystem(limit: number, level?: string): Record<string, unknown>[] {
    return level
      ? this.db.all("SELECT * FROM system_events WHERE level=? ORDER BY id DESC LIMIT ?", level, limit)
      : this.db.all("SELECT * FROM system_events ORDER BY id DESC LIMIT ?", limit);
  }
  recentRisk(limit: number): Record<string, unknown>[] {
    return this.db.all("SELECT * FROM risk_events ORDER BY id DESC LIMIT ?", limit);
  }
  prune(before: number): void {
    this.db.run("DELETE FROM system_events WHERE ts<?", before);
    this.db.run("DELETE FROM api_health WHERE ts<?", before);
    this.db.run("DELETE FROM market_snapshots WHERE ts<?", before);
  }
}

export class HealthRepo {
  constructor(private readonly db: Database) {}
  record(e: {
    provider: string;
    endpoint: string;
    ok: boolean;
    latencyMs: number;
    statusCode?: number | undefined;
    credits: number;
    error?: string | undefined;
  }): void {
    this.db.run(
      "INSERT INTO api_health(ts, provider, endpoint, ok, latency_ms, status_code, credits, error) VALUES (?,?,?,?,?,?,?,?)",
      Date.now(),
      e.provider,
      e.endpoint,
      e.ok ? 1 : 0,
      Math.round(e.latencyMs),
      e.statusCode ?? null,
      e.credits,
      e.error ?? null,
    );
  }
  summary(since: number): Record<string, unknown>[] {
    return this.db.all(
      `SELECT provider, COUNT(*) AS calls, SUM(ok) AS ok, AVG(latency_ms) AS avg_latency_ms, SUM(credits) AS credits,
              MAX(CASE WHEN ok=1 THEN ts END) AS last_ok, MAX(CASE WHEN ok=0 THEN ts END) AS last_fail
         FROM api_health WHERE ts>=? GROUP BY provider`,
      since,
    );
  }
  lastError(provider: string): string | undefined {
    const r = this.db.get<{ error: string }>(
      "SELECT error FROM api_health WHERE provider=? AND ok=0 ORDER BY id DESC LIMIT 1",
      provider,
    );
    return r?.error;
  }
  creditsSince(provider: string, since: number): number {
    return Number(
      this.db.get<{ c: number | null }>(
        "SELECT SUM(credits) AS c FROM api_health WHERE provider=? AND ts>=?",
        provider,
        since,
      )?.c ?? 0,
    );
  }
}

export class ConfigVersionRepo {
  constructor(private readonly db: Database) {}
  /** Record the config if it differs from the last recorded version; returns its hash. */
  record(config: unknown, source: string): string {
    const json = JSON.stringify(config);
    const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
    const last = this.db.get<{ hash: string }>("SELECT hash FROM config_versions ORDER BY id DESC LIMIT 1");
    if (last?.hash !== hash)
      this.db.run(
        "INSERT INTO config_versions(ts, hash, config_json, source) VALUES (?,?,?,?)",
        Date.now(),
        hash,
        json,
        source,
      );
    return hash;
  }
  list(limit: number): Record<string, unknown>[] {
    return this.db.all("SELECT id, ts, hash, source FROM config_versions ORDER BY id DESC LIMIT ?", limit);
  }
}

export class ProcessedRepo {
  constructor(private readonly db: Database) {}
  /** Claim a (job, tf, ts) once; false when it was already processed. */
  claim(job: string, tf: Timeframe, ts: number): boolean {
    return (
      this.db.run(
        "INSERT OR IGNORE INTO processed_candles(job, tf, ts, processed_at) VALUES (?,?,?,?)",
        job,
        tf,
        ts,
        Date.now(),
      ).changes === 1
    );
  }
  last(job: string, tf: Timeframe): number | undefined {
    const r = this.db.get<{ ts: number | null }>(
      "SELECT MAX(ts) AS ts FROM processed_candles WHERE job=? AND tf=?",
      job,
      tf,
    );
    return r?.ts == null ? undefined : Number(r.ts);
  }
}
