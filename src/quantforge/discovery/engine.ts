// Strategy discovery and validation pipeline.
//
// Data are split chronologically into train / validation / test. Every trade is contained in its segment
// (it is closed at the segment's last bar), so no information crosses a boundary. Gates, in order:
//   A  train screen        — sample size, expectancy, profit factor, no single-trade dependence
//   B  validation          — independent out-of-sample confirmation; Benjamini–Hochberg FDR across all
//                            train survivors on validation p-values (selection on train, test on validation)
//   C  deflated Sharpe     — on train+validation trades, deflated for the number of signal configurations tried
//   D  walk-forward        — anchored folds, exits re-optimized in-sample, judged out-of-sample
//   E  parameter stability — neighbouring exit settings must also be profitable
//   F  cost sensitivity    — still profitable with 1.5× spread, slippage and commission
//   G  Monte Carlo         — probability of profit under trade resampling
//   H  bootstrap CI        — lower bound of expectancy above zero
//   I  holdout test        — the untouched final segment, evaluated once for the few finalists
// A strategy is "validated" only if it passes every gate. High win rate alone never passes anything.

import { type CostModel, simulate, type Trade } from "../backtest/engine.js";
import { computeMetrics, jsonSafe, type Metrics } from "../backtest/metrics.js";
import type { QuantForgeConfig } from "../config/schema.js";
import { benjaminiHochberg, deflatedSharpe, mean, pValueMeanPositive, stdev } from "../core/stats.js";
import type { FeatureSet } from "../intelligence/features.js";
import { signalIndices } from "../strategy/signals.js";
import type { ExitRules, StrategySpec } from "../strategy/spec.js";
import {
  expectancyCi,
  type MonteCarlo,
  monteCarlo,
  splitSegments,
  walkForwardFolds,
} from "../validation/robustness.js";
import { allExits, exitNeighbours, type SignalConfig, signalConfigs, specOf } from "./generator.js";

export type GateResult = { gate: string; passed: boolean; detail: string };

export type CandidateReport = {
  spec: StrategySpec;
  status: "validated" | "rejected";
  score: number;
  gates: GateResult[];
  rejection: string[];
  train: Metrics;
  validation: Metrics | null;
  combined: Metrics | null;
  test: Metrics | null;
  walkForward: {
    folds: { oosTrades: number; oosExpectancyR: number; chosenExit: string }[];
    positiveFolds: number;
    pooledExpectancyR: number;
  } | null;
  stability: { neighbours: number; profitable: number; ratio: number } | null;
  costSensitivity: { x15ExpectancyR: number; x2ExpectancyR: number } | null;
  monteCarlo: MonteCarlo | null;
  expectancyCi: { low: number; high: number } | null;
  dsr: { dsr: number; sr0: number; trials: number; crossCandidateVariance: number } | null;
};

export type DiscoveryReport = {
  bars: number;
  dataFrom: number;
  dataTo: number;
  segments: { train: [number, number]; validation: [number, number]; test: [number, number] };
  signalConfigs: number;
  candidates: number;
  passedTrain: number;
  passedValidation: number;
  validated: number;
  rejectionCounts: Record<string, number>;
  reports: CandidateReport[];
  durationMs: number;
  conclusion: string;
};

type Ctx = { f: FeatureSet; trend: Uint8Array; costs: CostModel; config: QuantForgeConfig };

function run(
  spec: StrategySpec,
  ctx: Ctx,
  from: number,
  to: number,
  sides: { idx: number[]; side: Int8Array },
  opts: { exit?: ExitRules; costs?: CostModel } = {},
): Trade[] {
  return simulate(spec, ctx.f, ctx.trend, {
    from,
    to,
    costs: opts.costs ?? ctx.costs,
    closeBeforeWeekend: ctx.config.risk.closeBeforeWeekend,
    exit: opts.exit,
    sides: sides.side,
    signalIdx: sides.idx,
  });
}

const tsRange = (f: FeatureSet, a: number, b: number): [number, number] => [
  f.ts[Math.max(0, a)] as number,
  f.ts[Math.min(f.n - 1, Math.max(0, b - 1))] as number,
];

export function runDiscovery(
  f: FeatureSet,
  trend: Uint8Array,
  config: QuantForgeConfig,
  costs: CostModel,
  opts: {
    onProgress?: (msg: string) => void;
    configs?: SignalConfig[];
    exits?: ExitRules[];
    shouldStop?: () => boolean;
  } = {},
): DiscoveryReport {
  const started = Date.now();
  const d = config.discovery;
  const seg = splitSegments(f.warmup, f.n, d.trainFrac, d.validFrac);
  const ctx: Ctx = { f, trend, costs, config };
  const configs = opts.configs ?? signalConfigs();
  const exits = opts.exits ?? allExits();
  const progress = opts.onProgress ?? (() => {});
  const rejectionCounts: Record<string, number> = {};
  const reject = (r: CandidateReport, reason: string) => {
    r.rejection.push(reason);
    r.status = "rejected";
    rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
  };

  // Stage A: every candidate on the training segment.
  type Pending = {
    report: CandidateReport;
    cfg: SignalConfig;
    sides: { idx: number[]; side: Int8Array };
    trainTrades: Trade[];
  };
  const survivors: Pending[] = [];
  const sharpes: number[] = [];
  let candidates = 0;
  configs.forEach((cfg, ci) => {
    if (opts.shouldStop?.()) return;
    const probe = specOf(cfg, exits[0] as ExitRules, f.tf);
    const sides = signalIndices(probe, f, trend, seg.start, seg.end);
    for (const exit of exits) {
      candidates++;
      const spec = specOf(cfg, exit, f.tf);
      const trades = run(spec, ctx, seg.start, seg.trainEnd, sides);
      const m = computeMetrics(trades);
      if (m.trades >= d.minTrainTrades) sharpes.push(m.perTradeSharpe);
      const report: CandidateReport = {
        spec,
        status: "rejected",
        score: 0,
        gates: [],
        rejection: [],
        train: m,
        validation: null,
        combined: null,
        test: null,
        walkForward: null,
        stability: null,
        costSensitivity: null,
        monteCarlo: null,
        expectancyCi: null,
        dsr: null,
      };
      const reasons: string[] = [];
      if (m.trades < d.minTrainTrades) reasons.push("insufficient_train_sample");
      else {
        if (m.expectancyR <= d.trainMinExpectancyR) reasons.push("train_expectancy_too_low");
        if (m.profitFactor < d.trainMinProfitFactor) reasons.push("train_profit_factor_too_low");
        if (m.topTradeShare > d.maxTopTradeShare) reasons.push("train_depends_on_few_trades");
      }
      report.gates.push({
        gate: "A_train",
        passed: reasons.length === 0,
        detail: `n=${m.trades} E=${m.expectancyR.toFixed(3)}R PF=${m.profitFactor.toFixed(2)} WR=${(m.winRate * 100).toFixed(1)}%`,
      });
      if (reasons.length) {
        for (const r of reasons) rejectionCounts[r] = (rejectionCounts[r] ?? 0) + 1;
        continue; // not stored individually: the counts summarize them
      }
      survivors.push({ report, cfg, sides, trainTrades: trades });
    }
    if (ci % 20 === 0)
      progress(`train screen ${ci + 1}/${configs.length} signal configs, ${survivors.length} survivors`);
  });
  const passedTrain = survivors.length;
  progress(`stage A: ${passedTrain} of ${candidates} candidates passed the training screen`);

  // Stage B: validation segment, BH-FDR over the survivors.
  const validTrades = new Map<Pending, Trade[]>();
  const pvals: number[] = [];
  for (const p of survivors) {
    const t = run(p.report.spec, ctx, seg.trainEnd, seg.validEnd, p.sides);
    validTrades.set(p, t);
    p.report.validation = computeMetrics(t);
    pvals.push(pValueMeanPositive(t.map((x) => x.netR)));
  }
  const bh = benjaminiHochberg(pvals, d.fdrQ);
  const stageC: Pending[] = [];
  survivors.forEach((p, k) => {
    const v = p.report.validation as Metrics;
    const reasons: string[] = [];
    if (v.trades < d.minValidTrades) reasons.push("insufficient_validation_sample");
    else {
      if (v.expectancyR <= 0) reasons.push("validation_expectancy_not_positive");
      if (v.profitFactor < d.validMinProfitFactor) reasons.push("validation_profit_factor_too_low");
      if (!bh[k]) reasons.push("not_significant_after_fdr");
    }
    p.report.gates.push({
      gate: "B_validation_fdr",
      passed: reasons.length === 0,
      detail: `n=${v.trades} E=${v.expectancyR.toFixed(3)}R PF=${v.profitFactor.toFixed(2)} p=${(pvals[k] as number).toFixed(4)} BH(q=${d.fdrQ})=${bh[k] ? "pass" : "fail"}`,
    });
    for (const r of reasons) reject(p.report, r);
    if (!reasons.length) stageC.push(p);
  });
  const passedValidation = stageC.length;
  progress(`stage B: ${passedValidation} survived out-of-sample validation with FDR control`);

  // Stages C–H for validation survivors.
  const trials = configs.length;
  const srVar = sharpes.length > 1 ? stdev(sharpes) ** 2 : 0;
  const finalists: Pending[] = [];
  for (const p of stageC) {
    const r = p.report;
    const combinedTrades = [...p.trainTrades, ...(validTrades.get(p) ?? [])];
    const cm = computeMetrics(combinedTrades);
    r.combined = cm;
    const rs = combinedTrades.map((t) => t.netR);
    // C: deflated Sharpe. The hurdle SR0 is the maximum per-trade Sharpe expected from `trials` independent
    // signal configurations that have no edge; their estimates would scatter with the null sampling
    // variance 1/(n−1). (The cross-candidate variance is reported but not used: exit variants of one signal
    // are strongly correlated, and a genuine edge would inflate it and hide itself.)
    const nullVar = cm.trades > 1 ? 1 / (cm.trades - 1) : 1;
    const ds = deflatedSharpe({
      sr: cm.perTradeSharpe,
      n: cm.trades,
      skew: cm.skew,
      kurt: cm.kurt,
      trials,
      srVariance: nullVar,
    });
    r.dsr = { ...ds, trials, crossCandidateVariance: srVar };
    const passC = ds.dsr >= d.minDsr;
    r.gates.push({
      gate: "C_deflated_sharpe",
      passed: passC,
      detail: `DSR=${ds.dsr.toFixed(3)} (SR/trade=${cm.perTradeSharpe.toFixed(3)}, SR0=${ds.sr0.toFixed(3)}, trials=${trials}, n=${cm.trades})`,
    });
    if (!passC) reject(r, "deflated_sharpe_too_low");
    // D: walk-forward with exits re-optimized in-sample.
    const folds = walkForwardFolds(seg.start, seg.validEnd, d.walkForwardFolds).map((fold) => {
      let best: { exit: ExitRules; e: number } | null = null;
      for (const exit of exits) {
        const m = computeMetrics(run(r.spec, ctx, fold.isFrom, fold.isTo, p.sides, { exit }));
        if (m.trades >= 15 && (!best || m.expectancyR > best.e)) best = { exit, e: m.expectancyR };
      }
      if (!best)
        return {
          oosTrades: 0,
          oosExpectancyR: 0,
          chosenExit: "none (insufficient in-sample trades)",
          trades: [] as Trade[],
        };
      const oos = run(r.spec, ctx, fold.oosFrom, fold.oosTo, p.sides, { exit: best.exit });
      return {
        oosTrades: oos.length,
        oosExpectancyR: oos.length ? mean(oos.map((t) => t.netR)) : 0,
        chosenExit: `sl ${best.exit.slAtr}ATR tp ${best.exit.tpR}R ${best.exit.maxBars} bars${best.exit.partialR !== null ? " managed" : ""}`,
        trades: oos,
      };
    });
    const pooled = folds.flatMap((x) => x.trades);
    const positive = folds.filter((x) => x.oosTrades > 0 && x.oosExpectancyR > 0).length;
    r.walkForward = {
      folds: folds.map(({ trades: _t, ...rest }) => rest),
      positiveFolds: positive,
      pooledExpectancyR: pooled.length ? mean(pooled.map((t) => t.netR)) : 0,
    };
    const passD =
      positive >= Math.ceil(folds.length * d.wfMinPositiveFrac) && r.walkForward.pooledExpectancyR > 0;
    r.gates.push({
      gate: "D_walk_forward",
      passed: passD,
      detail: `${positive}/${folds.length} folds positive, pooled OOS E=${r.walkForward.pooledExpectancyR.toFixed(3)}R over ${pooled.length} trades`,
    });
    if (!passD) reject(r, "walk_forward_failed");
    // E: parameter stability.
    const neigh = exitNeighbours(r.spec.exit);
    const profitable = neigh.filter(
      (exit) => computeMetrics(run(r.spec, ctx, seg.start, seg.validEnd, p.sides, { exit })).expectancyR > 0,
    ).length;
    r.stability = {
      neighbours: neigh.length,
      profitable,
      ratio: neigh.length ? profitable / neigh.length : 0,
    };
    const passE = r.stability.ratio >= d.minStability;
    r.gates.push({
      gate: "E_parameter_stability",
      passed: passE,
      detail: `${profitable}/${neigh.length} neighbouring exit settings profitable`,
    });
    if (!passE) reject(r, "parameter_instability");
    // F: cost sensitivity.
    const x15 = computeMetrics(
      run(r.spec, ctx, seg.start, seg.validEnd, p.sides, {
        costs: { ...costs, multiplier: d.costStressMultiplier },
      }),
    ).expectancyR;
    const x2 = computeMetrics(
      run(r.spec, ctx, seg.start, seg.validEnd, p.sides, { costs: { ...costs, multiplier: 2 } }),
    ).expectancyR;
    r.costSensitivity = { x15ExpectancyR: x15, x2ExpectancyR: x2 };
    const passF = x15 > 0;
    r.gates.push({
      gate: "F_cost_sensitivity",
      passed: passF,
      detail: `E at ${d.costStressMultiplier}× costs=${x15.toFixed(3)}R, at 2×=${x2.toFixed(3)}R`,
    });
    if (!passF) reject(r, "fails_higher_costs");
    // G: Monte Carlo.
    r.monteCarlo = monteCarlo(rs, {
      iterations: d.mcIterations,
      riskFraction: config.risk.riskPerTradePct / 100,
    });
    const passG = r.monteCarlo.probProfit >= d.minMcProbProfit;
    r.gates.push({
      gate: "G_monte_carlo",
      passed: passG,
      detail: `P(profit)=${r.monteCarlo.probProfit.toFixed(3)}, 95th pct max DD=${r.monteCarlo.p95MaxDrawdownPct.toFixed(1)}%`,
    });
    if (!passG) reject(r, "monte_carlo_probability_too_low");
    // H: bootstrap CI.
    r.expectancyCi = expectancyCi(rs, d.ciAlpha);
    const passH = r.expectancyCi.low > 0;
    r.gates.push({
      gate: "H_bootstrap_ci",
      passed: passH,
      detail: `${Math.round((1 - d.ciAlpha) * 100)}% CI of expectancy [${r.expectancyCi.low.toFixed(3)}, ${r.expectancyCi.high.toFixed(3)}]R`,
    });
    if (!passH) reject(r, "expectancy_ci_includes_zero");
    r.score = r.expectancyCi.low * Math.sqrt(cm.trades);
    if (passC && passD && passE && passF && passG && passH) finalists.push(p);
  }
  progress(`stages C–H: ${finalists.length} finalists`);

  // I: holdout test, once, for at most five finalists ranked by score (selection never looks at test data).
  finalists.sort((a, b) => b.report.score - a.report.score);
  finalists.forEach((p, k) => {
    const r = p.report;
    if (k >= 5) {
      reject(r, "not_in_top_finalists");
      return;
    }
    const t = run(r.spec, ctx, seg.validEnd, seg.end, p.sides);
    const m = computeMetrics(t);
    r.test = m;
    const reasons: string[] = [];
    if (m.trades < d.minTestTrades) reasons.push("insufficient_test_sample");
    else {
      if (m.expectancyR <= 0) reasons.push("test_expectancy_not_positive");
      if (m.profitFactor <= 1) reasons.push("test_profit_factor_below_one");
    }
    r.gates.push({
      gate: "I_holdout_test",
      passed: reasons.length === 0,
      detail: `n=${m.trades} E=${m.expectancyR.toFixed(3)}R PF=${m.profitFactor.toFixed(2)}`,
    });
    for (const reason of reasons) reject(r, reason);
    if (!reasons.length && r.rejection.length === 0) r.status = "validated";
  });

  const reports = survivors.map((p) => p.report).map((r) => jsonSafe(r));
  reports.sort((a, b) => (a.status === b.status ? b.score - a.score : a.status === "validated" ? -1 : 1));
  const validated = reports.filter((r) => r.status === "validated").length;
  const profileNote = d.profile === "relaxed" ? " [relaxed gates]" : "";
  const conclusion =
    validated > 0
      ? `${validated} strategies passed every gate, including the untouched holdout segment${d.profile === "relaxed" ? " (RELAXED exploratory gates: higher risk that an edge is due to chance; paper only)" : ""}.`
      : passedValidation > 0
        ? `No strategy passed every robustness gate: ${passedValidation} confirmed out-of-sample but failed later gates. No statistically robust edge was demonstrated; the system will not trade.`
        : `No strategy demonstrated a statistically robust edge after costs: ${passedTrain} of ${candidates} passed the training screen and none was confirmed out-of-sample with FDR control. The system will not trade.${profileNote}`;
  return {
    bars: f.n,
    dataFrom: f.ts[0] as number,
    dataTo: f.ts[f.n - 1] as number,
    segments: {
      train: tsRange(f, seg.start, seg.trainEnd),
      validation: tsRange(f, seg.trainEnd, seg.validEnd),
      test: tsRange(f, seg.validEnd, seg.end),
    },
    signalConfigs: configs.length,
    candidates,
    passedTrain,
    passedValidation,
    validated,
    rejectionCounts,
    reports,
    durationMs: Date.now() - started,
    conclusion,
  };
}

/** Backtest one spec over a range (strategy lab / reporting). */
export function backtestSpec(
  spec: StrategySpec,
  f: FeatureSet,
  trend: Uint8Array,
  config: QuantForgeConfig,
  costs: CostModel,
  from = f.warmup,
  to = f.n,
): { trades: Trade[]; metrics: Metrics } {
  const trades = simulate(spec, f, trend, {
    from,
    to,
    costs,
    closeBeforeWeekend: config.risk.closeBeforeWeekend,
  });
  return { trades, metrics: computeMetrics(trades, { riskFraction: config.risk.riskPerTradePct / 100 }) };
}
