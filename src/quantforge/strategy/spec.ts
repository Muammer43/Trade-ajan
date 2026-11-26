// Strategy specification shared by discovery, backtesting, the strategy lab and live/paper decisions, so a
// strategy trades exactly the rules it was validated with.

import { createHash } from "node:crypto";
import type { Timeframe } from "../core/types.js";

export const FAMILIES = [
  "disp_cont",
  "disp_fade",
  "sweep_reject",
  "breakout_fail",
  "squeeze_break",
  "zrevert",
  "momentum_persist",
  "session_drive",
  "streak_fade",
  "streak_follow",
] as const;
export type FamilyId = (typeof FAMILIES)[number];

export type SessionFilter = "all" | "london_ny" | "asia";
export type RegimeFilter = "any" | "trending" | "ranging" | "not_strong";

export type ExitRules = {
  /** Stop distance in ATR multiples at the signal bar. */
  slAtr: number;
  /** Take-profit distance in R (multiples of the stop distance). */
  tpR: number;
  /** Time exit: bars after entry. */
  maxBars: number;
  /** Move the stop to entry after this favorable excursion (R); null = never. */
  breakEvenR: number | null;
  /** Close `partialFrac` of the position at this R; null = no partial. */
  partialR: number | null;
  partialFrac: number;
  /** After the partial (or break-even), trail the stop this many ATRs behind the close; null = no trail. */
  trailAtr: number | null;
};

export type StrategySpec = {
  version: 1;
  id: string;
  family: FamilyId;
  tf: Timeframe;
  params: Record<string, number>;
  session: SessionFilter;
  regime: RegimeFilter;
  /** Require the 4h slope to agree with the trade direction. */
  htfAlign: boolean;
  exit: ExitRules;
};

export function strategyId(spec: Omit<StrategySpec, "id">): string {
  const canonical = JSON.stringify({
    f: spec.family,
    tf: spec.tf,
    p: Object.entries(spec.params).sort(),
    s: spec.session,
    r: spec.regime,
    h: spec.htfAlign,
    e: spec.exit,
  });
  return `QF-${spec.family}-${createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
}

export function makeSpec(spec: Omit<StrategySpec, "id" | "version">): StrategySpec {
  const withVersion = { version: 1 as const, ...spec };
  return { ...withVersion, id: strategyId(withVersion) };
}

const FAMILY_TEXT: Record<FamilyId, (p: Record<string, number>) => string> = {
  disp_cont: (p) =>
    `Follow a displacement bar: |close−open| ≥ ${p.k}×ATR closing in its outer ${Math.round((1 - (p.clv ?? 0.5)) * 50)}% (CLV ≥ ${p.clv})`,
  disp_fade: (p) =>
    `Fade a displacement bar: |close−open| ≥ ${p.k}×ATR with CLV ≥ ${p.clv}, trade against it`,
  sweep_reject: (p) =>
    `Liquidity sweep rejection: high/low runs the prior ${p.n}-bar extreme, closes back inside with a ≥ ${Math.round((p.w ?? 0) * 100)}% wick; trade the rejection`,
  breakout_fail: (p) =>
    `Failed breakout: a close beyond the prior ${p.n}-bar range returns inside within ${p.m} bars; trade back into the range`,
  squeeze_break: (p) =>
    `Volatility-compression breakout: short/long realized vol < ${p.c}, then a ≥ ${p.r}×ATR range bar closing strongly; follow it`,
  zrevert: (p) =>
    `Mean reversion: close ≥ ${p.k} standard deviations from its 50-bar mean while the 20-bar efficiency ratio < ${p.e}; trade back to the mean`,
  momentum_persist: (p) =>
    `Momentum persistence: 20-bar efficiency ratio crosses above ${p.e} with a significant slope; follow the move`,
  session_drive: (p) =>
    `${p.session === 1 ? "London" : "New York 08:30"} opening drive: first bar body ≥ ${p.k}×ATR; ${p.fade ? "fade" : "follow"} it`,
  streak_fade: (p) =>
    `Conditional return asymmetry: after ${p.n} consecutive closes in one direction, trade against the streak`,
  streak_follow: (p) =>
    `Conditional return asymmetry: after ${p.n} consecutive closes in one direction, trade with the streak`,
};

export function describeSpec(spec: StrategySpec): {
  entry: string;
  stop: string;
  takeProfit: string;
  exit: string;
  filters: string;
} {
  const e = spec.exit;
  return {
    entry: `${FAMILY_TEXT[spec.family](spec.params)}. Entry at the next ${spec.tf} bar open after the signal bar closes.`,
    stop: `${e.slAtr}×ATR(14) from the fill${e.breakEvenR !== null ? `, moved to break-even at +${e.breakEvenR}R` : ""}${e.trailAtr !== null ? `, then trailed ${e.trailAtr}×ATR behind the close` : ""}`,
    takeProfit: `${e.tpR}R${e.partialR !== null ? `, with ${Math.round(e.partialFrac * 100)}% closed at +${e.partialR}R` : ""}`,
    exit: `stop, target, or time exit after ${e.maxBars} bars; positions are flattened before the weekend close`,
    filters: `session: ${spec.session}; regime: ${spec.regime}; 4h alignment: ${spec.htfAlign ? "required" : "not required"}`,
  };
}

/** Regime labels each filter admits. */
export const REGIME_FILTER_ADMITS: Record<RegimeFilter, readonly string[]> = {
  any: ["strong_bull", "strong_bear", "weak_trend", "range"],
  trending: ["strong_bull", "strong_bear", "weak_trend"],
  ranging: ["range"],
  not_strong: ["weak_trend", "range"],
};
