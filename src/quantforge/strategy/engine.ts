// The strategy engine: at each closed 15-minute candle, the market regime decides which trade models may run,
// those models are evaluated, and the best qualifying setup becomes a BUY or SELL proposal. Everything else
// (no setup, score below the threshold, opposite setups at once) is NO_TRADE with its reasons.

import type { QuantForgeConfig } from "../config/schema.js";
import type { Regime } from "../core/types.js";
import { classifyAt } from "../intelligence/regime.js";
import { EVALUATORS, type StrategyParams } from "./models.js";
import type { TradingFrame } from "./structure.js";
import { MODEL_LABELS, type ModelEvaluation, type ModelId, type StrategySignal } from "./types.js";

export function strategyParams(config: QuantForgeConfig): StrategyParams {
  const s = config.strategy;
  return {
    minScore: s.minScore,
    minRewardRisk: s.minRewardRisk,
    targetR: s.targetR,
    minStopAtr: s.minStopAtr,
    maxStopAtr: s.maxStopAtr,
    minAtrPercentile: config.risk.minAtrPercentile,
    maxAtrPercentile: config.risk.maxAtrPercentile,
    management: s.management,
  };
}

/**
 * Which models the regime admits, primary first, with the regime-fit score each gets:
 *   trending (strong trend, or weak trend agreeing with the 1h trend) → Trend Pullback, then Breakout + Retest
 *   range                                                            → Failed Breakout, then Breakout + Retest
 *   weak trend without 1h direction                                  → Breakout + Retest, then Failed Breakout
 *   volatility outside the tradable band                             → none
 */
export function modelsForRegime(
  frame: TradingFrame,
  i: number,
  regime: Regime,
  config: QuantForgeConfig,
): { models: { id: ModelId; fit: number }[]; reason: string } {
  const pct = regime.scores.atrPercentile;
  if (Number.isFinite(pct) && (pct > config.risk.maxAtrPercentile || pct < config.risk.minAtrPercentile)) {
    return { models: [], reason: `volatility outside the tradable band (ATR percentile ${pct.toFixed(2)})` };
  }
  const htf = frame.htfTrend(i);
  const enabled = (m: ModelId) => config.strategy.models[m];
  let list: { id: ModelId; fit: number }[];
  let reason: string;
  if (
    regime.trend === "strong_bull" ||
    regime.trend === "strong_bear" ||
    (regime.trend === "weak_trend" && htf.dir !== "flat")
  ) {
    list = [
      { id: "trend_pullback", fit: 1 },
      { id: "breakout_retest", fit: 0.6 },
    ];
    reason = `trending market (${regime.label}; 1h ${htf.dir})`;
  } else if (regime.trend === "range") {
    list = [
      { id: "failed_breakout", fit: regime.vol === "high" ? 0.7 : 1 },
      { id: "breakout_retest", fit: regime.volDynamic === "contraction" || regime.vol === "low" ? 0.9 : 0.6 },
    ];
    reason = `range-bound market (${regime.label})`;
  } else {
    list = [
      { id: "breakout_retest", fit: 0.8 },
      { id: "failed_breakout", fit: 0.6 },
    ];
    reason = `weak trend without 1h direction (${regime.label})`;
  }
  return { models: list.filter((m) => enabled(m.id)), reason };
}

export function evaluateStrategy(frame: TradingFrame, i: number, config: QuantForgeConfig): StrategySignal {
  const params = strategyParams(config);
  const regime = classifyAt(frame.f, i);
  const atr = frame.atr(i);
  const { models, reason } = modelsForRegime(frame, i, regime, config);
  const evaluations: ModelEvaluation[] = models.map((m) =>
    EVALUATORS[m.id]({ frame, i, regime, regimeFit: m.fit, params }),
  );
  const base = {
    barTs: frame.ts(i),
    atr,
    regime: regime.label,
    allowedModels: models.map((m) => m.id),
    evaluations,
  };
  const noTrade = (reasons: string[], rejected: StrategySignal["rejected"]): StrategySignal => ({
    ...base,
    action: "NO_TRADE",
    model: null,
    side: null,
    entry: null,
    sl: null,
    tp: null,
    rr: null,
    score: 0,
    reasons,
    rejected,
    exit: null,
  });
  const reasons = [
    `regime: ${reason}; models allowed: ${models.length ? models.map((m) => MODEL_LABELS[m.id]).join(", ") : "none"}`,
  ];
  if (!models.length)
    return noTrade(reasons, [
      { action: "BUY", reason: reason },
      { action: "SELL", reason: reason },
    ]);
  const setups = evaluations.filter((e) => e.triggered);
  const qualified = setups.filter((e) => e.score >= params.minScore);
  const rejected: StrategySignal["rejected"] = [];
  for (const e of evaluations) {
    if (!e.triggered) reasons.push(`${MODEL_LABELS[e.model]}: ${e.rejection}`);
    else if (e.score < params.minScore)
      reasons.push(`${MODEL_LABELS[e.model]}: ${e.side} setup scored ${e.score} < ${params.minScore}`);
  }
  const longs = qualified.filter((e) => e.side === "long");
  const shorts = qualified.filter((e) => e.side === "short");
  if (longs.length && shorts.length) {
    return noTrade(
      [...reasons, "conflicting long and short setups on the same candle"],
      [
        { action: "BUY", reason: "conflicting short setup" },
        { action: "SELL", reason: "conflicting long setup" },
      ],
    );
  }
  if (!qualified.length) {
    rejected.push(
      { action: "BUY", reason: "no qualifying long setup" },
      { action: "SELL", reason: "no qualifying short setup" },
    );
    return noTrade(reasons, rejected);
  }
  const best = qualified.sort((a, b) => b.score - a.score)[0] as ModelEvaluation;
  const action = best.side === "long" ? "BUY" : "SELL";
  rejected.push({
    action: action === "BUY" ? "SELL" : "BUY",
    reason: "no qualifying setup in that direction",
  });
  rejected.push({
    action: "NO_TRADE",
    reason: `${MODEL_LABELS[best.model]} setup passed every hard condition with score ${best.score}`,
  });
  return {
    ...base,
    action,
    model: best.model,
    side: best.side,
    entry: best.entry,
    sl: best.sl,
    tp: best.tp,
    rr: best.rr,
    score: best.score,
    reasons: [
      ...reasons,
      `${MODEL_LABELS[best.model]} ${best.side} (score ${best.score}): ${best.reasons.join("; ")}`,
    ],
    rejected,
    exit: best.exit,
  };
}
