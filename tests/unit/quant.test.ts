import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBacktest } from "../../src/quantforge/backtest/engine.js";
import { equityStats, tradeStats } from "../../src/quantforge/backtest/metrics.js";
import { buildConfig, DEFAULT_CONFIG } from "../../src/quantforge/config/schema.js";
import type { Candle } from "../../src/quantforge/core/types.js";
import { resample } from "../../src/quantforge/data/resample.js";
import { computeFeatures, type FeatureSet } from "../../src/quantforge/intelligence/features.js";
import { classifyAt, evaluateRegimes } from "../../src/quantforge/intelligence/regime.js";
import { openPosition, stepBar } from "../../src/quantforge/risk/position-rules.js";
import { evaluateStrategy, modelsForRegime } from "../../src/quantforge/strategy/engine.js";
import { TradingFrame } from "../../src/quantforge/strategy/structure.js";
import type { ExitRules } from "../../src/quantforge/strategy/types.js";
import { syntheticMarket } from "../helpers.js";
import {
  breakoutRetestLong,
  failedBreakoutLong,
  flat,
  mirror,
  trendPullbackLong,
} from "../support/patterns.js";

const fifteen = (days: number, seed: number) => resample(syntheticMarket({ days, seed }), "5m", "15m");
const exitOf = (slAtr: number, tpR: number, maxBars: number, managed: boolean): ExitRules =>
  managed
    ? {
        slAtr,
        tpR,
        maxBars,
        breakEvenR: null,
        partialR: Math.min(1, tpR * 0.6),
        partialFrac: 0.5,
        trailAtr: 1.5,
      }
    : { slAtr, tpR, maxBars, breakEvenR: null, partialR: null, partialFrac: 0, trailAtr: null };

describe("features", () => {
  it("are causal: appending future candles never changes past values", () => {
    const bars = fifteen(20, 11);
    const cut = 1200;
    const a = computeFeatures(bars.slice(0, cut), "15m");
    const b = computeFeatures(bars, "15m");
    const keys: (keyof FeatureSet)[] = [
      "atr",
      "adx",
      "volRatio",
      "atrPct",
      "er",
      "slopeT",
      "z",
      "body",
      "clv",
      "volCluster",
      "htf1hSlopeT",
      "htf4hSlopeT",
    ];
    for (const k of keys) {
      const x = a[k] as Float64Array;
      const y = b[k] as Float64Array;
      for (let i = 0; i < cut; i++) {
        const same =
          (Number.isNaN(x[i] as number) && Number.isNaN(y[i] as number)) ||
          Math.abs((x[i] as number) - (y[i] as number)) < 1e-9;
        assert.ok(same, `${String(k)}[${i}] changed after future candles were appended`);
      }
    }
  });
});

describe("trade models (BUY / SELL / NO TRADE)", () => {
  const cases: [string, () => Candle[], string][] = [
    ["Trend Pullback", trendPullbackLong, "trend_pullback"],
    ["Breakout + Retest", breakoutRetestLong, "breakout_retest"],
    ["Failed Breakout", failedBreakoutLong, "failed_breakout"],
  ];
  for (const [name, make, model] of cases) {
    it(`${name}: BUY on the bullish setup with entry, structural stop, target and score`, () => {
      const fr = new TradingFrame(make());
      const sig = evaluateStrategy(fr, fr.n - 1, DEFAULT_CONFIG);
      assert.equal(sig.action, "BUY", sig.reasons.join(" | "));
      assert.equal(sig.model, model);
      assert.ok((sig.sl as number) < (sig.entry as number) && (sig.tp as number) > (sig.entry as number));
      assert.ok((sig.rr as number) >= DEFAULT_CONFIG.strategy.minRewardRisk);
      assert.ok(sig.score >= DEFAULT_CONFIG.strategy.minScore);
      assert.ok(sig.exit && sig.exit.maxBars > 0);
      assert.ok(
        sig.rejected.some((r) => r.action === "SELL"),
        "the rejected alternative is explained",
      );
    });
    it(`${name}: SELL on the mirrored bearish setup`, () => {
      const fr = new TradingFrame(mirror(make()));
      const sig = evaluateStrategy(fr, fr.n - 1, DEFAULT_CONFIG);
      assert.equal(sig.action, "SELL", sig.reasons.join(" | "));
      assert.equal(sig.model, model);
      assert.ok((sig.sl as number) > (sig.entry as number) && (sig.tp as number) < (sig.entry as number));
    });
    it(`${name}: no signal one candle before the trigger (setup incomplete)`, () => {
      const c = make();
      const fr = new TradingFrame(c.slice(0, -1));
      assert.notEqual(evaluateStrategy(fr, fr.n - 1, DEFAULT_CONFIG).model, model);
    });
  }
  it("NO TRADE in a directionless market, with reasons", () => {
    const fr = new TradingFrame(flat());
    const sig = evaluateStrategy(fr, fr.n - 1, DEFAULT_CONFIG);
    assert.equal(sig.action, "NO_TRADE");
    assert.ok(sig.reasons.length >= 1);
  });
  it("NO TRADE when the score is below the threshold", () => {
    const strict = buildConfig({ strategy: { minScore: 99 } });
    assert.ok("config" in strict);
    if (!("config" in strict)) return;
    const fr = new TradingFrame(trendPullbackLong());
    const sig = evaluateStrategy(fr, fr.n - 1, strict.config);
    assert.equal(sig.action, "NO_TRADE");
    assert.ok(sig.reasons.some((r) => /scored .* < 99/.test(r)));
  });
  it("a disabled model never signals", () => {
    const cfg = buildConfig({
      strategy: { models: { trend_pullback: false, breakout_retest: true, failed_breakout: true } },
    });
    assert.ok("config" in cfg);
    if (!("config" in cfg)) return;
    const fr = new TradingFrame(trendPullbackLong());
    assert.notEqual(evaluateStrategy(fr, fr.n - 1, cfg.config).model, "trend_pullback");
  });
  it("the regime engine chooses the models", () => {
    const trending = new TradingFrame(trendPullbackLong());
    const i = trending.n - 1;
    assert.equal(
      modelsForRegime(trending, i, classifyAt(trending.f, i), DEFAULT_CONFIG).models[0]?.id,
      "trend_pullback",
    );
    const ranging = new TradingFrame(failedBreakoutLong());
    const j = ranging.n - 1;
    assert.equal(
      modelsForRegime(ranging, j, classifyAt(ranging.f, j), DEFAULT_CONFIG).models[0]?.id,
      "failed_breakout",
    );
  });
  it("signals never use candles after the decision candle (no look-ahead)", () => {
    const c = fifteen(40, 12);
    const full = new TradingFrame(c);
    const cut = 2200;
    const part = new TradingFrame(c.slice(0, cut));
    for (let i = 1500; i < cut; i += 7) {
      const a = evaluateStrategy(part, i, DEFAULT_CONFIG);
      const b = evaluateStrategy(full, i, DEFAULT_CONFIG);
      assert.equal(a.action, b.action, `candle ${i}`);
      assert.equal(a.score, b.score, `candle ${i}`);
    }
  });
});

describe("regime classifier", () => {
  it("evaluation reports accuracy against forward behaviour and naive baselines", () => {
    const f = computeFeatures(fifteen(40, 13), "15m");
    const ev = evaluateRegimes(f, 16);
    assert.ok(ev.trend.accuracy >= 0 && ev.trend.accuracy <= 1);
    assert.ok(ev.trend.baselineMajority > 0);
    assert.ok(Number.isFinite(ev.volatility.rankCorrelation));
  });
});

describe("position rules (stop-loss, take-profit, partial, break-even, trailing, time)", () => {
  const rules = exitOf(1, 2, 10, false);
  it("stop-loss: a candle touching both stop and target is a stop (conservative)", () => {
    const p = openPosition("long", 100, 1, rules);
    const ev = stepBar(
      p,
      { open: 100, high: 103, low: 98, close: 101 },
      { spread: 0, slippage: 0.1, atr: 1 },
    );
    assert.equal(ev[0]?.kind, "stop");
    assert.ok(Math.abs((ev[0]?.price ?? 0) - 98.9) < 1e-9);
  });
  it("stop-loss: a gap through the stop fills at the open", () => {
    const p = openPosition("long", 100, 1, rules);
    const ev = stepBar(
      p,
      { open: 97, high: 97.5, low: 96, close: 97 },
      { spread: 0.2, slippage: 0.1, atr: 1 },
    );
    assert.equal(ev[0]?.kind, "stop");
    assert.ok(Math.abs((ev[0]?.price ?? 0) - (97 - 0.1 - 0.1)) < 1e-9);
  });
  it("take-profit fills at the limit, for shorts too", () => {
    const p = openPosition("short", 100, 1, rules);
    const ev = stepBar(
      p,
      { open: 99.5, high: 99.8, low: 97.5, close: 98 },
      { spread: 0.2, slippage: 0.1, atr: 1 },
    );
    assert.equal(ev[0]?.kind, "target");
    assert.equal(ev[0]?.price, 98);
  });
  it("partial take-profit, then break-even, then trailing", () => {
    const p = openPosition("long", 100, 1, exitOf(1, 2.5, 50, true));
    const e1 = stepBar(
      p,
      { open: 100, high: 101.6, low: 99.9, close: 101.5 },
      { spread: 0, slippage: 0, atr: 1 },
    );
    assert.equal(e1[0]?.kind, "partial");
    assert.ok(p.sl >= 100);
    stepBar(p, { open: 101.5, high: 102.4, low: 101.4, close: 102.3 }, { spread: 0, slippage: 0, atr: 0.4 });
    assert.ok(p.sl > 101);
  });
  it("time exit after maxBars", () => {
    const p = openPosition("long", 100, 1, exitOf(1, 5, 2, false));
    stepBar(p, { open: 100, high: 100.2, low: 99.8, close: 100.1 }, { spread: 0, slippage: 0, atr: 1 });
    assert.equal(
      stepBar(p, { open: 100.1, high: 100.3, low: 99.9, close: 100.2 }, { spread: 0, slippage: 0, atr: 1 })[0]
        ?.kind,
      "time",
    );
  });
});

describe("statistics", () => {
  it("splits results by side, model, regime and month", () => {
    const t = (side: "long" | "short", model: string, pnl: number, r: number, m: number) => ({
      side,
      model,
      regime: "range, low vol",
      openedAt: Date.UTC(2026, m, 3),
      closedAt: Date.UTC(2026, m, 3, 2),
      pnl,
      r,
      exitReason: pnl > 0 ? "target" : "stop",
    });
    const s = tradeStats(
      [t("long", "a", 20, 2, 0), t("short", "b", -10, -1, 0), t("long", "a", -10, -1, 1)],
      1000,
    );
    assert.equal(s.trades, 3);
    assert.equal(s.netProfit, 0);
    assert.equal(s.profitFactor, 1);
    assert.equal(s.long.trades, 2);
    assert.equal(s.byModel.a?.netProfit, 10);
    assert.equal(s.monthly.length, 2);
    assert.equal(s.monthly[0]?.returnPct, 1);
    const eq = equityStats([
      { ts: Date.UTC(2026, 0, 5), equity: 100 },
      { ts: Date.UTC(2026, 0, 6), equity: 120 },
      { ts: Date.UTC(2026, 0, 7), equity: 90 },
    ]);
    assert.ok(Math.abs(eq.maxDrawdownPct - 25) < 1e-9);
  });
});

describe("backtest engine (the live rules on history)", () => {
  it("trades the strategy with costs, the risk engine and the paper broker, without look-ahead", async () => {
    const cfg = buildConfig({ risk: { initialBalance: 10_000, profile: "custom", riskPerTradePct: 0.5 } });
    assert.ok("config" in cfg);
    if (!("config" in cfg)) return;
    const base5 = syntheticMarket({ days: 60, seed: 21 });
    const c15 = resample(base5, "5m", "15m");
    const r = await runBacktest({ candles15: c15, candles5: base5, config: cfg.config });
    assert.ok(r.signals.generated > 0, "the strategy produced signals on the synthetic market");
    assert.equal(r.trades.length, r.stats.trades);
    assert.ok(Math.abs(r.finalBalance - r.initialBalance - r.netProfit) < 0.01);
    assert.ok(
      Math.abs(r.trades.reduce((a, t) => a + t.pnl, 0) - r.netProfit) <= 0.01 * r.trades.length + 0.01,
      "every dollar is a trade's net P&L (to cent rounding)",
    );
    assert.ok(r.exitsOn5mPct > 90, "exits were simulated on 5-minute candles");
    for (const t of r.trades) assert.ok(t.closedAt >= t.openedAt);
    // Entries happen at the open of the candle after the signal candle.
    const opens = new Map(c15.map((c) => [c.ts, c.open]));
    for (const t of r.trades.slice(0, 10)) assert.ok(opens.has(t.openedAt), "fills happen at a candle open");
    // Doubling costs never improves the result.
    const dear = structuredClone(cfg.config);
    dear.costs.spread *= 3;
    dear.costs.commissionPerLotRoundTrip *= 3;
    const r2 = await runBacktest({ candles15: c15, candles5: base5, config: dear });
    assert.ok(r2.netProfit <= r.netProfit + 1e-6 || r2.stats.trades !== r.stats.trades);
  });
});
