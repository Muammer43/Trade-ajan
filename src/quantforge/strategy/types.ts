// Shared types of the trading strategy: the three trade models, the exit-management rules a position carries,
// and the signal the strategy engine produces at a closed 15-minute candle.

import type { Side } from "../core/types.js";

export const MODELS = ["trend_pullback", "breakout_retest", "failed_breakout"] as const;
export type ModelId = (typeof MODELS)[number];

export const MODEL_LABELS: Record<ModelId, string> = {
  trend_pullback: "Trend Pullback",
  breakout_retest: "Breakout + Retest",
  failed_breakout: "Failed Breakout / Reversal",
};

/** How an open position is managed (shared by backtest and paper/live execution). */
export type ExitRules = {
  /** Stop distance in ATR multiples (informational; the actual stop is structural). */
  slAtr: number;
  /** Take-profit distance in R (multiples of the initial stop distance). */
  tpR: number;
  /** Time exit: decision-timeframe bars after entry. */
  maxBars: number;
  /** Move the stop to entry after this favorable excursion (R); null = never. */
  breakEvenR: number | null;
  /** Close `partialFrac` of the position at this R; null = no partial. */
  partialR: number | null;
  partialFrac: number;
  /** After the partial (or break-even), trail the stop this many ATRs behind the close; null = no trail. */
  trailAtr: number | null;
};

/** One measurable component of a signal, scored 0–1 with the facts behind it. */
export type Component = { score: number; detail: string };

export type ComponentName =
  | "trend"
  | "structure"
  | "momentum"
  | "volatility"
  | "support_resistance"
  | "setup_quality"
  | "liquidity"
  | "regime_fit"
  | "reward_risk";

export const COMPONENT_WEIGHTS: Record<ComponentName, number> = {
  trend: 15,
  structure: 10,
  momentum: 10,
  volatility: 10,
  support_resistance: 10,
  setup_quality: 20,
  liquidity: 5,
  regime_fit: 10,
  reward_risk: 10,
};

/** A trade model's evaluation at one closed candle. */
export type ModelEvaluation = {
  model: ModelId;
  /** Hard conditions all passed: the model has a setup. */
  triggered: boolean;
  side: Side | null;
  /** Reference entry (the signal candle's close; the fill happens at the next price). */
  entry: number | null;
  sl: number | null;
  tp: number | null;
  rr: number | null;
  /** Weighted score 0–100 of the components. */
  score: number;
  components: Partial<Record<ComponentName, Component>>;
  /** Conditions met, in words. */
  reasons: string[];
  /** The first hard condition that failed (when not triggered). */
  rejection: string | null;
  exit: ExitRules;
};

export type StrategySignal = {
  action: "BUY" | "SELL" | "NO_TRADE";
  barTs: number;
  model: ModelId | null;
  side: Side | null;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  rr: number | null;
  score: number;
  atr: number;
  regime: string;
  allowedModels: ModelId[];
  evaluations: ModelEvaluation[];
  reasons: string[];
  rejected: { action: "BUY" | "SELL" | "NO_TRADE"; reason: string }[];
  exit: ExitRules | null;
};
