// Performance metrics of a list of trades. R-based figures are size-independent; equity figures assume a
// fixed fraction of equity risked per trade (default 1%), compounded.

import { kurtosis, mean, pValueMeanPositive, skewness, stdev } from "../core/stats.js";
import { utcDay } from "../core/time.js";
import type { Trade } from "./engine.js";

export type Metrics = {
  trades: number;
  wins: number;
  winRate: number;
  expectancyR: number;
  totalR: number;
  profitFactor: number;
  avgWinR: number;
  avgLossR: number;
  avgR: number;
  maxDrawdownPct: number;
  returnPct: number;
  sharpe: number;
  sortino: number;
  perTradeSharpe: number;
  skew: number;
  kurt: number;
  tStat: number;
  pValue: number;
  avgBarsHeld: number;
  topTradeShare: number;
  longTrades: number;
  shortTrades: number;
  costR: number;
  byRegime: Record<string, { trades: number; expectancyR: number; winRate: number }>;
  byExit: Record<string, number>;
};

export function emptyMetrics(): Metrics {
  return {
    trades: 0,
    wins: 0,
    winRate: 0,
    expectancyR: 0,
    totalR: 0,
    profitFactor: 0,
    avgWinR: 0,
    avgLossR: 0,
    avgR: 0,
    maxDrawdownPct: 0,
    returnPct: 0,
    sharpe: 0,
    sortino: 0,
    perTradeSharpe: 0,
    skew: 0,
    kurt: 3,
    tStat: 0,
    pValue: 1,
    avgBarsHeld: 0,
    topTradeShare: 0,
    longTrades: 0,
    shortTrades: 0,
    costR: 0,
    byRegime: {},
    byExit: {},
  };
}

/** Business days between two instants (the trading-day count used to annualize daily returns). */
function businessDays(from: number, to: number): number {
  let n = 0;
  for (let t = Date.parse(`${utcDay(from)}T00:00:00Z`); t <= to; t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return Math.max(1, n);
}

export function computeMetrics(
  trades: readonly Trade[],
  opts: { riskFraction?: number; periodFrom?: number; periodTo?: number } = {},
): Metrics {
  if (trades.length === 0) return emptyMetrics();
  const risk = opts.riskFraction ?? 0.01;
  const rs = trades.map((t) => t.netR);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  // Compounded fixed-fractional equity.
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  const daily = new Map<string, number>();
  for (const t of trades) {
    const before = eq;
    eq *= 1 + risk * t.netR;
    if (eq <= 0) eq = 1e-9;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    const day = utcDay(t.exitTs);
    daily.set(day, (daily.get(day) ?? 1) * (eq / before));
  }
  const from = opts.periodFrom ?? (trades[0] as Trade).entryTs;
  const to = opts.periodTo ?? (trades[trades.length - 1] as Trade).exitTs;
  const days = businessDays(from, to);
  const dayReturns = [...daily.values()].map((g) => g - 1);
  while (dayReturns.length < days) dayReturns.push(0);
  const dm = mean(dayReturns);
  const dsd = stdev(dayReturns);
  const downside = Math.sqrt(dayReturns.reduce((a, r) => a + Math.min(0, r) ** 2, 0) / dayReturns.length);
  const sd = stdev(rs);
  const byRegime: Metrics["byRegime"] = {};
  for (const regime of new Set(trades.map((t) => t.regime))) {
    const sub = trades.filter((t) => t.regime === regime).map((t) => t.netR);
    byRegime[regime] = {
      trades: sub.length,
      expectancyR: mean(sub),
      winRate: sub.filter((r) => r > 0).length / sub.length,
    };
  }
  const byExit: Record<string, number> = {};
  for (const t of trades) byExit[t.reason] = (byExit[t.reason] ?? 0) + 1;
  const totalR = rs.reduce((a, b) => a + b, 0);
  const best = Math.max(...rs);
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: wins.length / trades.length,
    expectancyR: mean(rs),
    totalR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : 0,
    avgWinR: wins.length ? grossWin / wins.length : 0,
    avgLossR: losses.length ? -grossLoss / losses.length : 0,
    avgR: mean(rs),
    maxDrawdownPct: maxDd * 100,
    returnPct: (eq - 1) * 100,
    sharpe: dsd > 0 ? (dm / dsd) * Math.sqrt(252) : 0,
    sortino: downside > 0 ? (dm / downside) * Math.sqrt(252) : 0,
    perTradeSharpe: sd > 0 ? mean(rs) / sd : 0,
    skew: skewness(rs),
    kurt: kurtosis(rs),
    tStat: sd > 0 ? mean(rs) / (sd / Math.sqrt(rs.length)) : 0,
    pValue: pValueMeanPositive(rs),
    avgBarsHeld: mean(trades.map((t) => t.barsHeld)),
    topTradeShare: totalR > 0 ? best / totalR : 1,
    longTrades: trades.filter((t) => t.side === "long").length,
    shortTrades: trades.filter((t) => t.side === "short").length,
    costR: mean(trades.map((t) => t.costR)),
    byRegime,
    byExit,
  };
}

/** Metrics as JSON-safe numbers (Infinity becomes a large sentinel, NaN null). */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "number"
        ? Number.isFinite(v)
          ? Number.isInteger(v) || Math.abs(v) >= 1e9
            ? v
            : Math.round(v * 1e6) / 1e6
          : Number.isNaN(v)
            ? null
            : v > 0
              ? 999
              : -999
        : v,
    ),
  ) as T;
}
