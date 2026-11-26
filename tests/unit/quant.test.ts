import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { costModelOf, simulate } from "../../src/quantforge/backtest/engine.js";
import { computeMetrics } from "../../src/quantforge/backtest/metrics.js";
import type { Candle } from "../../src/quantforge/core/types.js";
import { resample } from "../../src/quantforge/data/resample.js";
import { runDiscovery } from "../../src/quantforge/discovery/engine.js";
import { allExits, exitOf, signalConfigs } from "../../src/quantforge/discovery/generator.js";
import { computeFeatures, type FeatureSet } from "../../src/quantforge/intelligence/features.js";
import { classifyAt, evaluateRegimes, trendSeries } from "../../src/quantforge/intelligence/regime.js";
import { openPosition, stepBar } from "../../src/quantforge/risk/position-rules.js";
import { makeSpec } from "../../src/quantforge/strategy/spec.js";
import { monteCarlo, splitSegments, walkForwardFolds } from "../../src/quantforge/validation/robustness.js";
import { syntheticMarket, testConfig } from "../helpers.js";

const fifteen = (days: number, seed: number, edge?: number) =>
  resample(syntheticMarket({ days, seed, ...(edge !== undefined ? { edge } : {}) }), "5m", "15m");

describe("features", () => {
  it("are causal: appending future bars never changes past values", () => {
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
        assert.ok(same, `${String(k)}[${i}] changed after future bars were appended`);
      }
    }
    const dh = a.donchianHigh(24);
    const dhb = b.donchianHigh(24);
    for (let i = 0; i < cut; i++)
      assert.ok(Number.isNaN(dh[i] as number) ? Number.isNaN(dhb[i] as number) : dh[i] === dhb[i]);
  });
  it("Donchian channels exclude the current bar", () => {
    const f = computeFeatures(fifteen(10, 12), "15m");
    const i = 500;
    let max = Number.NEGATIVE_INFINITY;
    for (let k = i - 12; k < i; k++) max = Math.max(max, f.high[k] as number);
    assert.equal(f.donchianHigh(12)[i], max);
  });
});

function trending(n: number, drift: number): Candle[] {
  const out: Candle[] = [];
  let p = 2000;
  const t0 = Date.UTC(2026, 0, 5, 0);
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + drift + 0.0004 * Math.sin(i * 1.7));
    out.push({
      ts: t0 + i * 900_000,
      open: o,
      high: Math.max(o, p) + 0.3,
      low: Math.min(o, p) - 0.3,
      close: p,
      volume: null,
    });
  }
  return out;
}

describe("regime classifier", () => {
  it("labels a persistent uptrend strong bull and a persistent downtrend strong bear", () => {
    const up = computeFeatures(trending(900, 0.0008), "15m");
    assert.equal(classifyAt(up, up.n - 1).trend, "strong_bull");
    const down = computeFeatures(trending(900, -0.0008), "15m");
    assert.equal(classifyAt(down, down.n - 1).trend, "strong_bear");
  });
  it("evaluation reports accuracy against forward behaviour and naive baselines", () => {
    const f = computeFeatures(fifteen(40, 13), "15m");
    const ev = evaluateRegimes(f, 16);
    assert.ok(ev.trend.accuracy >= 0 && ev.trend.accuracy <= 1);
    assert.ok(ev.trend.baselineMajority > 0);
    assert.ok(Object.keys(ev.trend.confusion).length > 0);
    assert.ok(Number.isFinite(ev.volatility.rankCorrelation));
  });
});

describe("position rules", () => {
  const rules = exitOf(1, 2, 10, false);
  it("a bar touching both stop and target is a stop (conservative)", () => {
    const p = openPosition("long", 100, 1, rules);
    const ev = stepBar(
      p,
      { open: 100, high: 103, low: 98, close: 101 },
      { spread: 0, slippage: 0.1, atr: 1 },
    );
    assert.equal(ev[0]?.kind, "stop");
    assert.ok(Math.abs((ev[0]?.price ?? 0) - 98.9) < 1e-9);
  });
  it("a gap through the stop fills at the open, worse than the stop", () => {
    const p = openPosition("long", 100, 1, rules);
    const ev = stepBar(
      p,
      { open: 97, high: 97.5, low: 96, close: 97 },
      { spread: 0.2, slippage: 0.1, atr: 1 },
    );
    assert.equal(ev[0]?.kind, "stop");
    assert.ok(Math.abs((ev[0]?.price ?? 0) - (97 - 0.1 - 0.1)) < 1e-9);
  });
  it("targets fill at the limit for shorts too", () => {
    const p = openPosition("short", 100, 1, rules);
    const ev = stepBar(
      p,
      { open: 99.5, high: 99.8, low: 97.5, close: 98 },
      { spread: 0.2, slippage: 0.1, atr: 1 },
    );
    assert.equal(ev[0]?.kind, "target");
    assert.equal(ev[0]?.price, 98);
  });
  it("takes a partial, moves the stop to break-even, then trails", () => {
    const p = openPosition("long", 100, 1, exitOf(1, 2.5, 50, true));
    const e1 = stepBar(
      p,
      { open: 100, high: 101.6, low: 99.9, close: 101.5 },
      { spread: 0, slippage: 0, atr: 1 },
    );
    assert.equal(e1[0]?.kind, "partial");
    assert.ok(Math.abs(p.openFrac - 0.5) < 1e-9);
    assert.ok(p.sl >= 100, "stop at break-even or better after the partial");
    stepBar(p, { open: 101.5, high: 102.4, low: 101.4, close: 102.3 }, { spread: 0, slippage: 0, atr: 0.4 });
    assert.ok(p.sl > 101, "trailing stop follows the close");
  });
  it("exits on time after maxBars", () => {
    const p = openPosition("long", 100, 1, exitOf(1, 5, 2, false));
    stepBar(p, { open: 100, high: 100.2, low: 99.8, close: 100.1 }, { spread: 0, slippage: 0, atr: 1 });
    const ev = stepBar(
      p,
      { open: 100.1, high: 100.3, low: 99.9, close: 100.2 },
      { spread: 0, slippage: 0, atr: 1 },
    );
    assert.equal(ev[0]?.kind, "time");
  });
  it("monitor and manage phases split the work", () => {
    const p = openPosition("long", 100, 1, exitOf(1, 5, 1, false));
    assert.equal(
      stepBar(
        p,
        { open: 100, high: 100.2, low: 99.8, close: 100.1 },
        { spread: 0, slippage: 0, atr: 1, phase: "monitor" },
      ).length,
      0,
    );
    assert.equal(p.barsHeld, 0, "monitoring bars do not count toward the time exit");
    assert.equal(
      stepBar(
        p,
        { open: 100, high: 100.2, low: 99.8, close: 100.1 },
        { spread: 0, slippage: 0, atr: 1, phase: "manage" },
      )[0]?.kind,
      "time",
    );
  });
});

describe("backtester", () => {
  const config = testConfig();
  const bars = fifteen(30, 14);
  const f = computeFeatures(bars, "15m");
  const trend = trendSeries(f);
  const spec = makeSpec({
    family: "streak_follow",
    tf: "15m",
    params: { n: 3 },
    session: "all",
    regime: "any",
    htfAlign: false,
    exit: exitOf(1.5, 1.5, 16, false),
  });
  it("enters at the next bar's open plus half the spread and slippage", () => {
    const costs = costModelOf(config);
    const trades = simulate(spec, f, trend, { from: 0, to: f.n, costs, closeBeforeWeekend: true });
    assert.ok(trades.length > 20);
    for (const t of trades.slice(0, 10)) {
      assert.equal(t.entryIdx, t.signalIdx + 1);
      const s = t.side === "long" ? 1 : -1;
      const spread = f.session[t.entryIdx] === 0 ? costs.spread * 1.3 : costs.spread;
      assert.ok(
        Math.abs(t.entry - ((f.open[t.entryIdx] as number) + s * (spread / 2 + costs.slippage))) < 1e-9,
      );
    }
  });
  it("costs strictly reduce results", () => {
    const free = {
      ...costModelOf(config),
      spread: 0,
      slippage: 0,
      commissionPerUnit: 0,
      swapLongPerUnitNight: 0,
      swapShortPerUnitNight: 0,
    };
    const a = computeMetrics(
      simulate(spec, f, trend, { from: 0, to: f.n, costs: free, closeBeforeWeekend: true }),
    );
    const b = computeMetrics(
      simulate(spec, f, trend, { from: 0, to: f.n, costs: costModelOf(config), closeBeforeWeekend: true }),
    );
    const c = computeMetrics(
      simulate(spec, f, trend, { from: 0, to: f.n, costs: costModelOf(config, 2), closeBeforeWeekend: true }),
    );
    assert.ok(a.totalR > b.totalR && b.totalR > c.totalR);
  });
  it("keeps every trade inside its segment (no leakage across boundaries)", () => {
    const to = Math.floor(f.n * 0.6);
    for (const t of simulate(spec, f, trend, {
      from: 0,
      to,
      costs: costModelOf(config),
      closeBeforeWeekend: true,
    }))
      assert.ok(t.exitIdx < to);
  });
  it("flattens before the weekend", () => {
    const longHold = makeSpec({ ...spec, exit: exitOf(5, 10, 400, false) });
    const trades = simulate(longHold, f, trend, {
      from: 0,
      to: f.n,
      costs: costModelOf(config),
      closeBeforeWeekend: true,
    });
    assert.ok(trades.some((t) => t.reason === "weekend"));
  });
});

describe("validation helpers", () => {
  it("splits chronologically and builds anchored walk-forward folds", () => {
    const s = splitSegments(100, 1100, 0.6, 0.2);
    assert.deepEqual(s, { start: 100, trainEnd: 700, validEnd: 900, end: 1100 });
    const folds = walkForwardFolds(0, 1000, 4);
    assert.equal(folds.length, 4);
    for (const fold of folds) assert.ok(fold.isTo <= fold.oosFrom && fold.isFrom === 0);
  });
  it("Monte Carlo is deterministic for a seed", () => {
    const rs = [1, -1, 0.5, -0.5, 2, -1, 1.5];
    assert.deepEqual(monteCarlo(rs, { seed: 3 }), monteCarlo(rs, { seed: 3 }));
  });
});

describe("strategy discovery", () => {
  const config = testConfig((c) => {
    c.discovery.mcIterations = 300;
  });
  const configs = signalConfigs().filter(
    (c) => c.family === "disp_cont" || c.family === "disp_fade" || c.family === "streak_fade",
  );
  const exits = allExits().filter((e) => e.maxBars === 16 && e.partialR === null);
  it("finds and validates a planted continuation edge", () => {
    const f = computeFeatures(fifteen(120, 21, 0.8), "15m");
    const rep = runDiscovery(f, trendSeries(f), config, costModelOf(config), { configs, exits });
    assert.ok(
      rep.validated >= 1,
      `expected a validated strategy; got ${JSON.stringify(rep.rejectionCounts)}`,
    );
    const best = rep.reports.find((r) => r.status === "validated");
    assert.equal(best?.spec.family, "disp_cont");
    assert.ok((best?.test?.expectancyR ?? 0) > 0);
    assert.ok(best?.gates.every((g) => g.passed));
  });
  it("rejects everything on a market without an edge (multiple-testing control)", () => {
    const f = computeFeatures(fifteen(120, 22), "15m");
    const rep = runDiscovery(f, trendSeries(f), config, costModelOf(config), { configs, exits });
    assert.equal(rep.validated, 0);
    assert.match(rep.conclusion, /No strategy/);
  });
});
