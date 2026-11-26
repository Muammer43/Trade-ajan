// Candidate generator: a structured experiment grid over signal families, their parameters, context filters
// and exit templates. Each family encodes a hypothesis about XAUUSD behaviour (continuation vs. exhaustion
// of displacement, liquidity sweeps, failed breakouts, volatility compression, mean reversion, momentum
// persistence, session drives, conditional streak asymmetry); the grid tests each hypothesis under a small,
// fixed set of variations so that the number of trials is known and can be corrected for.

import type { Timeframe } from "../core/types.js";
import {
  type ExitRules,
  type FamilyId,
  makeSpec,
  type RegimeFilter,
  type SessionFilter,
  type StrategySpec,
} from "../strategy/spec.js";

const MOMENTUM: readonly FamilyId[] = ["disp_cont", "squeeze_break", "momentum_persist", "streak_follow"];

type ParamGrid = Record<string, readonly number[]>;

export const FAMILY_GRID: Record<FamilyId, ParamGrid> = {
  disp_cont: { k: [1.0, 1.5, 2.0], clv: [0.5] },
  disp_fade: { k: [1.0, 1.5, 2.0], clv: [0.5] },
  sweep_reject: { n: [12, 24, 48], w: [0.4, 0.55] },
  breakout_fail: { n: [24, 48], m: [2, 4] },
  squeeze_break: { c: [0.7, 0.85], r: [1.3, 1.8] },
  zrevert: { k: [2.0, 2.5], e: [0.25, 0.35] },
  momentum_persist: { e: [0.4, 0.5] },
  session_drive: { session: [1, 2], k: [0.8, 1.2], fade: [0, 1] },
  streak_fade: { n: [3, 4, 5] },
  streak_follow: { n: [3, 4, 5] },
};

export const EXIT_GRID = {
  slAtr: [1.0, 1.5, 2.0],
  tpR: [1.0, 1.5, 2.5],
  maxBars: [16, 48],
  managed: [false, true],
} as const;

export function exitOf(slAtr: number, tpR: number, maxBars: number, managed: boolean): ExitRules {
  return managed
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
}

export function allExits(): ExitRules[] {
  const out: ExitRules[] = [];
  for (const sl of EXIT_GRID.slAtr)
    for (const tp of EXIT_GRID.tpR)
      for (const mb of EXIT_GRID.maxBars) for (const m of EXIT_GRID.managed) out.push(exitOf(sl, tp, mb, m));
  return out;
}

function product(grid: ParamGrid): Record<string, number>[] {
  let rows: Record<string, number>[] = [{}];
  for (const [k, values] of Object.entries(grid))
    rows = rows.flatMap((r) => values.map((v) => ({ ...r, [k]: v })));
  return rows;
}

/** A signal configuration: everything except the exits. */
export type SignalConfig = {
  family: FamilyId;
  params: Record<string, number>;
  session: SessionFilter;
  regime: RegimeFilter;
  htfAlign: boolean;
};

export function signalConfigs(): SignalConfig[] {
  const out: SignalConfig[] = [];
  for (const family of Object.keys(FAMILY_GRID) as FamilyId[]) {
    const momentum = MOMENTUM.includes(family);
    for (const params of product(FAMILY_GRID[family])) {
      const sessions: SessionFilter[] = family === "session_drive" ? ["all"] : ["all", "london_ny"];
      const follows = momentum || (family === "session_drive" && params.fade === 0);
      const regimes: RegimeFilter[] = ["any", follows ? "trending" : "not_strong"];
      const aligns = follows ? [false, true] : [false];
      for (const session of sessions)
        for (const regime of regimes)
          for (const htfAlign of aligns) out.push({ family, params, session, regime, htfAlign });
    }
  }
  return out;
}

export function specOf(cfg: SignalConfig, exit: ExitRules, tf: Timeframe): StrategySpec {
  return makeSpec({
    family: cfg.family,
    tf,
    params: cfg.params,
    session: cfg.session,
    regime: cfg.regime,
    htfAlign: cfg.htfAlign,
    exit,
  });
}

/** Exit-grid neighbours of an exit (one step in stop or target), for parameter-stability analysis. */
export function exitNeighbours(e: ExitRules): ExitRules[] {
  const managed = e.partialR !== null;
  const out: ExitRules[] = [];
  const sl = EXIT_GRID.slAtr as readonly number[];
  const tp = EXIT_GRID.tpR as readonly number[];
  const si = sl.indexOf(e.slAtr);
  const ti = tp.indexOf(e.tpR);
  for (const [ds, dt] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const a = sl[si + ds];
    const b = tp[ti + dt];
    if (a !== undefined && b !== undefined) out.push(exitOf(a, b, e.maxBars, managed));
  }
  out.push(exitOf(e.slAtr, e.tpR, e.maxBars === 16 ? 48 : 16, managed));
  return out;
}
