// Backtest of the live trading rules. It runs the very components the bot trades with: the strategy engine,
// the agents and AI Judge (without the optional LLM), the risk engine with lot sizing, the order manager and
// the paper broker with its ledger, all on an in-memory database with a simulated clock.
//
// Timing is the live timing: the decision is taken at the close of a 15-minute candle using only closed
// candles; the order fills at the next candle's open (ask + slippage for buys, bid − slippage for sells);
// stops, targets and partials are checked on 5-minute candles when they are available for the period
// (otherwise on the 15-minute candle, adverse extreme first); break-even, trailing and time exits run at
// 15-minute closes. Spread, slippage, commission and swap are charged as in paper trading.

import type { QuantForgeConfig } from "../config/schema.js";
import { silentLogger } from "../core/logger.js";
import { floorTo } from "../core/time.js";
import { type Candle, type Quote, type StoredCandle, TF_MS } from "../core/types.js";
import { modelledSpread } from "../data/spread.js";
import { Database } from "../database/db.js";
import { EventRepo, StateRepo } from "../database/repositories.js";
import { DecisionEngine } from "../decision/engine.js";
import { Ledger } from "../execution/ledger.js";
import { clientOrderId, OrderManager } from "../execution/order-manager.js";
import { PaperBroker } from "../execution/paper-broker.js";
import { RiskEngine } from "../risk/engine.js";
import { TradingFrame } from "../strategy/structure.js";
import { type ClosedTrade, type EquityStats, equityStats, type TradeStats, tradeStats } from "./metrics.js";

export type BacktestOptions = {
  candles15: readonly Candle[];
  /** 5-minute candles for exit simulation where available (optional). */
  candles5?: readonly Candle[] | undefined;
  config: QuantForgeConfig;
  /** Trade only candles with open time in [from, to] (earlier candles still warm the indicators up). */
  from?: number | undefined;
  to?: number | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
};

export type BacktestReport = {
  period: { from: number; to: number };
  candles: number;
  initialBalance: number;
  finalBalance: number;
  netProfit: number;
  returnPct: number;
  stats: TradeStats;
  equityStats: EquityStats;
  equity: { ts: number; equity: number }[];
  signals: {
    generated: number;
    executed: number;
    byModel: Record<string, number>;
    refused: Record<string, number>;
  };
  exitsOn5mPct: number;
  killSwitch: { engagedAt: number | null; reason: string | null };
  trades: (ClosedTrade & { entry: number; exit: number | null; lots: number })[];
  durationMs: number;
  notes: string[];
};

const LAG = 20_000;

function stored(c: Candle, tf: "5m" | "15m"): StoredCandle {
  return { ...c, symbol: "XAUUSD", tf, provider: "backtest", marketOpen: true, quality: "ok" };
}

export async function runBacktest(opts: BacktestOptions): Promise<BacktestReport> {
  const started = Date.now();
  const config = structuredClone(opts.config);
  config.agents.llm.enabled = false;
  const db = Database.open(":memory:");
  const state = new StateRepo(db);
  const events = new EventRepo(db);
  let now = 0;
  const clock = () => now;
  const log = silentLogger().child("backtest");
  const ledger = new Ledger(db, state, config, "backtest", "paper", clock);
  const quoteAt = (price: number, ts: number): Quote => {
    const spread = modelledSpread(config, ts);
    return {
      symbol: "XAUUSD",
      price,
      bid: price - spread / 2,
      ask: price + spread / 2,
      spread,
      spreadSource: "modelled",
      ts,
      provider: "backtest",
    };
  };
  let quote = quoteAt(opts.candles15[0]?.close ?? 1, 0);
  const paper = new PaperBroker(db, ledger, config, async () => quote, log, clock);
  const orders = new OrderManager(db, paper, "backtest", log, clock);
  const risk = new RiskEngine(config, state, events, clock);
  const decisions = new DecisionEngine(config, risk, null);
  const frame = new TradingFrame(opts.candles15);
  const n = frame.n;

  const fives = new Map<number, StoredCandle[]>();
  for (const c of opts.candles5 ?? []) {
    const key = floorTo(c.ts, "15m");
    const list = fives.get(key) ?? [];
    list.push(stored(c, "5m"));
    fives.set(key, list);
  }

  const first = Math.max(frame.f.warmup, 300);
  const inRange = (ts: number) =>
    (opts.from === undefined || ts >= opts.from) && (opts.to === undefined || ts <= opts.to);
  const startIdx = (() => {
    for (let i = first; i < n; i++) if (inRange(frame.ts(i))) return i;
    return n;
  })();
  if (startIdx < n) now = frame.ts(startIdx);
  ledger.ensure();

  const refused: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let generated = 0;
  let executed = 0;
  let monitored5 = 0;
  let monitoredTotal = 0;
  let killAt: number | null = null;
  const equity: { ts: number; equity: number }[] = [];
  let lastIdx = startIdx;

  for (let i = startIdx; i < n; i++) {
    const ts = frame.ts(i);
    if (!inRange(ts)) break;
    lastIdx = i;
    const bar15 = stored(opts.candles15[i] as Candle, "15m");
    const closeT = ts + TF_MS["15m"];
    // 1. Stops, targets, partials inside the candle.
    if (ledger.openPositions().length) {
      monitoredTotal++;
      const inner = fives.get(ts);
      if (inner && inner.length === 3) {
        monitored5++;
        for (const b of inner) {
          now = b.ts + TF_MS["5m"];
          paper.processMonitorBar(b, modelledSpread(config, now));
        }
      } else {
        now = closeT;
        paper.processMonitorBar(bar15, modelledSpread(config, closeT));
      }
    }
    // 2. Break-even, trailing and time exits at the close.
    now = closeT;
    paper.processDecisionBar(bar15, modelledSpread(config, closeT), frame.atr(i));
    // 3. Account protections.
    quote = quoteAt(frame.close(i), closeT);
    const view = ledger.view(quote);
    risk.refresh(view);
    const controls = risk.controls();
    if (controls.killSwitch.on) {
      killAt ??= closeT;
      for (const p of ledger.openPositions()) await paper.close(p.id, 1, "emergency");
    }
    // 4. The decision, exactly as live.
    now = closeT + LAG;
    const d = await decisions.decide({
      now,
      frame,
      i,
      quote,
      quality: { fresh: true, missingBars: 0, staleQuoteBars: 0, ageBars: 0 },
      macro: { eurusd: [], xagusd: [] },
      account: ledger.view(quote),
      controls,
      providerHealthy: true,
      mode: "paper",
      modelPerformance: ledger.modelPerformance(),
      agentsOnlyOnSignal: true,
    });
    if (d.signal.action !== "NO_TRADE") {
      generated++;
      byModel[d.signal.model ?? "?"] = (byModel[d.signal.model ?? "?"] ?? 0) + 1;
    }
    if (d.action === "NO_TRADE") {
      if (d.signal.action !== "NO_TRADE") {
        const failed = d.risk?.checks.filter((c) => !c.passed).map((c) => `risk:${c.rule}`) ?? [];
        const key =
          failed[0] ??
          (d.reasons.find((r) => r.startsWith("rejected:"))
            ? "agents_rejected"
            : d.reasons.some((r) => r.startsWith("confidence"))
              ? "low_confidence"
              : "other");
        refused[key] = (refused[key] ?? 0) + 1;
      }
    } else if (
      i + 1 < n &&
      frame.ts(i + 1) - ts === TF_MS["15m"] &&
      d.lots &&
      d.exit &&
      d.sl !== null &&
      d.tp !== null
    ) {
      // Fill at the next candle's open.
      const nextTs = frame.ts(i + 1);
      now = nextTs;
      quote = quoteAt(frame.open(i + 1), nextTs);
      const side = d.action === "BUY" ? "long" : "short";
      const s = side === "long" ? 1 : -1;
      const stopDist = Math.abs((d.entry as number) - d.sl);
      const rewardDist = Math.abs(d.tp - (d.entry as number));
      const ref = quote.price;
      const r = await orders.submit(
        {
          clientOrderId: clientOrderId("backtest", "candle", ts, side),
          side,
          type: "market",
          lots: d.lots,
          sl: ref - s * stopDist,
          tp: ref + s * rewardDist,
          strategyId: d.model,
          decisionId: null,
          meta: { atr: d.atr ?? frame.atr(i), rules: d.exit, regime: d.regime },
        },
        () => ({ ok: true }),
      );
      if (r.outcome === "filled") executed++;
      else refused[`order_${r.outcome}`] = (refused[`order_${r.outcome}`] ?? 0) + 1;
    } else {
      refused.market_closed_before_fill = (refused.market_closed_before_fill ?? 0) + 1;
    }
    equity.push({ ts: closeT, equity: ledger.view(quoteAt(frame.close(i), closeT)).equity });
    if (opts.onProgress && (i - startIdx) % 2000 === 0) opts.onProgress(i - startIdx, n - startIdx);
  }
  // Close what is still open at the last close.
  now = frame.ts(lastIdx) + TF_MS["15m"];
  quote = quoteAt(frame.close(lastIdx), now);
  for (const p of ledger.openPositions()) await paper.close(p.id, 1, "manual");
  const closed = ledger.closedPositions(1_000_000).reverse();
  const trades = closed.map((p) => ({
    side: p.side,
    model: p.strategy_id ?? "?",
    regime: p.regime ?? "unknown",
    openedAt: p.opened_at,
    closedAt: p.closed_at ?? p.opened_at,
    pnl: Math.round((p.realized_pnl - p.commission + p.swap) * 100) / 100,
    r: p.r_multiple ?? 0,
    exitReason: p.closed_at === now && p.exit_reason === "manual" ? "end_of_test" : (p.exit_reason ?? "?"),
    entry: p.entry_price,
    exit: p.exit_price,
    lots: p.lots_initial,
  }));
  const initialBalance = config.risk.initialBalance;
  const finalBalance = ledger.balance();
  const notes = [
    "Same strategy engine, agents (without the optional LLM), risk engine, order manager and paper broker as live trading.",
    "Macro agent has no historical macro feed in the backtest; it can only have lowered confidence live.",
    "Bid/ask are modelled from the configured spread (×1.3 in the Asian session, ×2 before a close).",
  ];
  if ((opts.candles5?.length ?? 0) === 0)
    notes.push("No 5-minute candles: exits were simulated on 15-minute candles (adverse extreme first).");
  return {
    period: { from: frame.ts(startIdx) ?? 0, to: frame.ts(lastIdx) ?? 0 },
    candles: Math.max(0, lastIdx - startIdx + 1),
    initialBalance,
    finalBalance,
    netProfit: Math.round((finalBalance - initialBalance) * 100) / 100,
    returnPct: ((finalBalance - initialBalance) / initialBalance) * 100,
    stats: tradeStats(trades, initialBalance),
    equityStats: equityStats(equity),
    equity: thin(equity, 1500),
    signals: { generated, executed, byModel, refused },
    exitsOn5mPct: monitoredTotal ? (monitored5 / monitoredTotal) * 100 : 0,
    killSwitch: { engagedAt: killAt, reason: killAt ? (risk.controls().killSwitch.reason ?? null) : null },
    trades,
    durationMs: Date.now() - started,
    notes,
  };
}

function thin<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: T[] = [];
  for (let k = 0; k < max; k++) out.push(xs[Math.floor(k * step)] as T);
  out.push(xs[xs.length - 1] as T);
  return out;
}
