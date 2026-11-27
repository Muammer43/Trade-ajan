// Trade and equity statistics shared by the backtest report and the live/paper performance page.

import { mean, stdev } from "../core/stats.js";
import { utcDay } from "../core/time.js";

export type ClosedTrade = {
  side: "long" | "short";
  model: string;
  regime: string;
  openedAt: number;
  closedAt: number;
  /** Net P&L in USD after commission and swap. */
  pnl: number;
  /** Net result in R (multiples of the initial risk). */
  r: number;
  exitReason: string;
};

export type GroupStats = {
  trades: number;
  wins: number;
  winRate: number;
  netProfit: number;
  profitFactor: number | null;
  expectancyR: number | null;
};

export type TradeStats = GroupStats & {
  grossProfit: number;
  grossLoss: number;
  expectancyUsd: number | null;
  avgR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  bestR: number | null;
  worstR: number | null;
  long: GroupStats;
  short: GroupStats;
  byModel: Record<string, GroupStats>;
  byRegime: Record<string, GroupStats>;
  byExit: Record<string, number>;
  monthly: { month: string; trades: number; netProfit: number; returnPct: number | null }[];
};

export type EquityStats = {
  maxDrawdownPct: number;
  sharpe: number | null;
  sortino: number | null;
  days: number;
};

function group(trades: readonly ClosedTrade[]): GroupStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netProfit: Math.round((gp - gl) * 100) / 100,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : null,
    expectancyR: trades.length ? mean(trades.map((t) => t.r)) : null,
  };
}

function groupBy(
  trades: readonly ClosedTrade[],
  key: (t: ClosedTrade) => string,
): Record<string, GroupStats> {
  const map = new Map<string, ClosedTrade[]>();
  for (const t of trades) map.set(key(t), [...(map.get(key(t)) ?? []), t]);
  return Object.fromEntries([...map.entries()].map(([k, v]) => [k, group(v)]));
}

/** Statistics of closed trades. `startBalance` turns monthly P&L into a return on the month's opening balance. */
export function tradeStats(trades: readonly ClosedTrade[], startBalance?: number): TradeStats {
  const g = group(trades);
  const rs = trades.map((t) => t.r);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const monthly: TradeStats["monthly"] = [];
  let balance = startBalance ?? Number.NaN;
  for (const t of sorted) {
    const m = new Date(t.closedAt).toISOString().slice(0, 7);
    let row = monthly[monthly.length - 1];
    if (!row || row.month !== m) {
      row = { month: m, trades: 0, netProfit: 0, returnPct: Number.isFinite(balance) ? 0 : null };
      (row as { open?: number }).open = balance;
      monthly.push(row);
    }
    row.trades++;
    row.netProfit = Math.round((row.netProfit + t.pnl) * 100) / 100;
    balance += t.pnl;
    const open = (row as { open?: number }).open;
    if (open !== undefined && Number.isFinite(open) && open > 0) row.returnPct = (row.netProfit / open) * 100;
  }
  for (const row of monthly) delete (row as { open?: number }).open;
  const byExit: Record<string, number> = {};
  for (const t of trades) byExit[t.exitReason] = (byExit[t.exitReason] ?? 0) + 1;
  return {
    ...g,
    grossProfit: wins.reduce((a, t) => a + t.pnl, 0),
    grossLoss: -losses.reduce((a, t) => a + t.pnl, 0),
    expectancyUsd: trades.length ? g.netProfit / trades.length : null,
    avgR: rs.length ? mean(rs) : null,
    avgWinR: wins.length ? mean(wins.map((t) => t.r)) : null,
    avgLossR: losses.length ? mean(losses.map((t) => t.r)) : null,
    bestR: rs.length ? Math.max(...rs) : null,
    worstR: rs.length ? Math.min(...rs) : null,
    long: group(trades.filter((t) => t.side === "long")),
    short: group(trades.filter((t) => t.side === "short")),
    byModel: groupBy(trades, (t) => t.model),
    byRegime: groupBy(trades, (t) => t.regime.split(",")[0] ?? t.regime),
    byExit,
    monthly,
  };
}

/** Drawdown, Sharpe and Sortino from an equity curve (daily closes, weekdays, annualized with √252). */
export function equityStats(curve: readonly { ts: number; equity: number }[]): EquityStats {
  let peak = 0;
  let maxDd = 0;
  const daily = new Map<string, number>();
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.max(maxDd, 1 - p.equity / peak);
    const d = new Date(p.ts).getUTCDay();
    if (d !== 0 && d !== 6) daily.set(utcDay(p.ts), p.equity);
  }
  const closes = [...daily.values()];
  const rets: number[] = [];
  for (let k = 1; k < closes.length; k++) rets.push((closes[k] as number) / (closes[k - 1] as number) - 1);
  const m = mean(rets);
  const sd = stdev(rets);
  const downside = rets.length
    ? Math.sqrt(rets.reduce((a, r) => a + Math.min(0, r) ** 2, 0) / rets.length)
    : 0;
  return {
    maxDrawdownPct: maxDd * 100,
    sharpe: rets.length >= 20 && sd > 0 ? (m / sd) * Math.sqrt(252) : null,
    sortino: rets.length >= 20 && downside > 0 ? (m / downside) * Math.sqrt(252) : null,
    days: closes.length,
  };
}

/** JSON-safe numbers (Infinity → ±999, NaN → null, non-integers rounded to 6 decimals). */
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
