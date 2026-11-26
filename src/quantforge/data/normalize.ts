// Normalization and integrity of provider candles: parse, convert to UTC, validate OHLC, drop duplicates,
// keep only closed bars, flag market-closed and stale (non-trading) quotes, and find missing bars.
// Nothing here ever invents a value: missing bars are reported, never filled.

import { isBarInMarketHours, isClosed } from "../core/time.js";
import { type Candle, type CandleQuality, type StoredCandle, TF_MS, type Timeframe } from "../core/types.js";

export type RawBar = {
  datetime: string | number;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume?: unknown;
};

export type NormalizeIssue = {
  ts?: number | undefined;
  kind: "unparseable" | "invalid_ohlc" | "duplicate" | "unclosed" | "misaligned";
  detail: string;
};

/**
 * Parse a provider timestamp as UTC. Accepts epoch seconds/ms and "YYYY-MM-DD[ HH:MM[:SS]]" strings,
 * which must already be in UTC (providers are asked for UTC explicitly).
 */
export function parseUtc(value: string | number): number | undefined {
  if (typeof value === "number") return value < 1e11 ? value * 1000 : value;
  const s = value.trim();
  if (/^\d+$/.test(s)) return parseUtc(Number(s));
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return undefined;
  const [, y, mo, d, h = "0", mi = "0", se = "0", zone] = m;
  let ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
  if (zone && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    ts -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  return Number.isFinite(ts) ? ts : undefined;
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return Number.NaN;
}

export function validOhlc(c: Candle): boolean {
  const { open, high, low, close } = c;
  if (![open, high, low, close].every((x) => Number.isFinite(x) && x > 0)) return false;
  if (high < low) return false;
  const eps = 1e-9 * high;
  return high + eps >= Math.max(open, close) && low - eps <= Math.min(open, close);
}

/**
 * Normalize raw provider bars into closed, validated, de-duplicated UTC candles sorted ascending.
 * `now` decides which bars are closed; the provider's still-forming bar is dropped.
 */
export function normalizeBars(
  raw: readonly RawBar[],
  opts: { symbol: string; tf: Timeframe; provider: string; now: number; closeLagMs?: number },
): { candles: StoredCandle[]; issues: NormalizeIssue[] } {
  const issues: NormalizeIssue[] = [];
  const byTs = new Map<number, Candle>();
  const len = TF_MS[opts.tf];
  for (const r of raw) {
    const ts = parseUtc(r.datetime);
    if (ts === undefined) {
      issues.push({ kind: "unparseable", detail: `timestamp ${String(r.datetime)}` });
      continue;
    }
    if (ts % Math.min(len, TF_MS["1h"]) !== 0 && opts.tf !== "1d") {
      issues.push({ ts, kind: "misaligned", detail: `bar start not aligned to ${opts.tf}` });
      continue;
    }
    const vol = num(r.volume);
    const c: Candle = {
      ts,
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      volume: Number.isFinite(vol) ? vol : null,
    };
    if (!validOhlc(c)) {
      issues.push({ ts, kind: "invalid_ohlc", detail: JSON.stringify([r.open, r.high, r.low, r.close]) });
      continue;
    }
    if (!isClosed(ts, opts.tf, opts.now, opts.closeLagMs ?? 0)) {
      issues.push({ ts, kind: "unclosed", detail: "bar still forming; dropped" });
      continue;
    }
    if (byTs.has(ts)) {
      const prev = byTs.get(ts) as Candle;
      if (prev.close !== c.close || prev.high !== c.high || prev.low !== c.low)
        issues.push({ ts, kind: "duplicate", detail: "conflicting duplicate; kept last" });
      else issues.push({ ts, kind: "duplicate", detail: "exact duplicate" });
    }
    byTs.set(ts, c);
  }
  const candles = [...byTs.values()]
    .sort((a, b) => a.ts - b.ts)
    .map(
      (c): StoredCandle => ({
        ...c,
        symbol: opts.symbol,
        tf: opts.tf,
        provider: opts.provider,
        marketOpen: isBarInMarketHours(c.ts, opts.tf),
        quality: isBarInMarketHours(c.ts, opts.tf) ? "ok" : "market_closed",
      }),
    );
  return { candles, issues };
}

/**
 * Flag runs of near-flat bars inside market hours (holiday or stale quotes). A run of at least `minRun` bars
 * whose range is below `fraction` of the median range of open bars is marked `stale_quote`.
 */
export function flagStaleQuotes<T extends StoredCandle>(
  candles: T[],
  { minRun = 8, fraction = 0.08 } = {},
): T[] {
  const ranges = candles
    .filter((c) => c.marketOpen)
    .map((c) => c.high - c.low)
    .sort((a, b) => a - b);
  if (ranges.length < 50) return candles;
  const median = ranges[Math.floor(ranges.length / 2)] as number;
  const limit = median * fraction;
  let runStart = -1;
  const mark = (from: number, to: number) => {
    if (to - from >= minRun)
      for (let k = from; k < to; k++) (candles[k] as T).quality = "stale_quote" as CandleQuality;
  };
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i] as T;
    const flat = c.marketOpen && c.high - c.low <= limit;
    if (flat && runStart < 0) runStart = i;
    if (!flat && runStart >= 0) {
      mark(runStart, i);
      runStart = -1;
    }
  }
  if (runStart >= 0) mark(runStart, candles.length);
  return candles;
}

export type Gap = { from: number; to: number; missing: number };

/** Missing bars inside market hours between consecutive candles (the calendar decides what is expected). */
export function findGaps(candles: readonly Candle[], tf: Timeframe): Gap[] {
  const len = TF_MS[tf];
  const gaps: Gap[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = (candles[i - 1] as Candle).ts;
    const cur = (candles[i] as Candle).ts;
    if (cur - prev <= len) continue;
    let missing = 0;
    for (let t = prev + len; t < cur; t += len) if (isBarInMarketHours(t, tf)) missing++;
    if (missing > 0) gaps.push({ from: prev + len, to: cur - len, missing });
  }
  return gaps;
}

/** Data-quality summary over the most recent bars. */
export function qualityReport(
  candles: readonly StoredCandle[],
  tf: Timeframe,
  now: number,
  staleAfterBars: number,
) {
  const open = candles.filter((c) => c.marketOpen);
  const gaps = findGaps(open, tf);
  const last = candles[candles.length - 1];
  const ageBars = last ? (now - (last.ts + TF_MS[tf])) / TF_MS[tf] : Number.POSITIVE_INFINITY;
  const stale = candles.filter((c) => c.quality === "stale_quote").length;
  return {
    bars: candles.length,
    openBars: open.length,
    missingBars: gaps.reduce((s, g) => s + g.missing, 0),
    gaps: gaps.slice(-10),
    staleQuoteBars: stale,
    lastBarTs: last?.ts ?? null,
    ageBars,
    fresh: ageBars <= staleAfterBars,
  };
}
