// Event-driven bar backtester. Signals are computed at the close of bar i and filled at the open of bar i+1
// (never at a price the strategy could not have seen). Costs: spread (paid through bid/ask), slippage on
// entries and stop/market exits, commission per lot round trip, and swap for each rollover held (Wednesday
// triple). One position at a time per strategy; signals during an open position are ignored.

import type { QuantForgeConfig } from "../config/schema.js";
import { nextCloseIsWeekend, rolloversBetween, SESSION_CODES } from "../core/time.js";
import { TF_MS } from "../core/types.js";
import type { FeatureSet } from "../intelligence/features.js";
import { TREND_CODES } from "../intelligence/regime.js";
import { type ExitKind, grossPerUnit, openPosition, stepBar } from "../risk/position-rules.js";
import { signalAt } from "../strategy/signals.js";
import type { ExitRules, StrategySpec } from "../strategy/spec.js";

export type CostModel = {
  /** Round-trip spread in price units, or a function of the bar time (modelled session widening). */
  spread: number;
  slippage: number;
  commissionPerUnit: number;
  swapLongPerUnitNight: number;
  swapShortPerUnitNight: number;
  /** Multiplier applied to spread, slippage and commission (sensitivity analysis). */
  multiplier: number;
};

export function costModelOf(config: QuantForgeConfig, multiplier = 1): CostModel {
  const cs = config.instrument.contractSize;
  return {
    spread: config.costs.spread,
    slippage: config.costs.slippage,
    commissionPerUnit: config.costs.commissionPerLotRoundTrip / cs,
    swapLongPerUnitNight: config.costs.swapLongPerLotNight / cs,
    swapShortPerUnitNight: config.costs.swapShortPerLotNight / cs,
    multiplier,
  };
}

export type Trade = {
  signalIdx: number;
  entryIdx: number;
  exitIdx: number;
  entryTs: number;
  exitTs: number;
  side: "long" | "short";
  entry: number;
  stopDist: number;
  grossR: number;
  costR: number;
  netR: number;
  reason: ExitKind;
  barsHeld: number;
  regime: string;
  session: number;
  mfeR: number;
  maeR: number;
};

function spreadAt(f: FeatureSet, i: number, base: number): number {
  return f.session[i] === SESSION_CODES.asia ? base * 1.3 : base;
}

/** Whether bar j is the last bar before the weekend close (the next stored bar is days away). */
function isLastBeforeWeekend(f: FeatureSet, j: number): boolean {
  const next = f.ts[j + 1];
  const len = TF_MS[f.tf];
  if (next === undefined) return false;
  return next - (f.ts[j] as number) > 6 * 3_600_000 && nextCloseIsWeekend((f.ts[j] as number) + len - 60_000);
}

export type SimOptions = {
  from: number;
  to: number;
  costs: CostModel;
  closeBeforeWeekend: boolean;
  /** Override the exits (walk-forward re-optimization). */
  exit?: ExitRules | undefined;
  /** Precomputed signal sides per bar (discovery fast path); computed from the spec otherwise. */
  sides?: Int8Array | undefined;
  /** Sorted indices where `sides` is non-zero, to skip bars without signals. */
  signalIdx?: readonly number[] | undefined;
};

export function simulate(spec: StrategySpec, f: FeatureSet, trend: Uint8Array, opts: SimOptions): Trade[] {
  const rules = opts.exit ?? spec.exit;
  const c = opts.costs;
  const trades: Trade[] = [];
  const len = TF_MS[f.tf];
  // Last bar index usable by this run: trades never read a bar at or beyond `to` (segment containment).
  const end = Math.min(opts.to, f.n) - 1;
  let i = Math.max(opts.from, f.warmup);
  let cursor = 0;
  const list = opts.sides && opts.signalIdx ? opts.signalIdx : undefined;
  while (i < end) {
    if (list) {
      while (cursor < list.length && (list[cursor] as number) < i) cursor++;
      if (cursor >= list.length) break;
      i = list[cursor] as number;
      if (i >= end) break;
    }
    const side = opts.sides ? (opts.sides[i] as number) : signalAt(spec, f, trend, i);
    if (side === 0) {
      i++;
      continue;
    }
    const e = i + 1;
    // A signal is valid only for the very next bar; across a closure it is stale.
    if ((f.ts[e] as number) - (f.ts[i] as number) > len || isLastBeforeWeekend(f, i)) {
      i++;
      continue;
    }
    const atr = f.atr[i] as number;
    if (!(atr > 0)) {
      i++;
      continue;
    }
    const s = side > 0 ? 1 : -1;
    const spread = spreadAt(f, e, c.spread) * c.multiplier;
    const slip = c.slippage * c.multiplier;
    const fill = (f.open[e] as number) + s * (spread / 2 + slip);
    const stopDist = rules.slAtr * atr;
    const pos = openPosition(s > 0 ? "long" : "short", fill, stopDist, rules);
    const exits: ReturnType<typeof stepBar> = [];
    let j = e;
    for (; j <= end; j++) {
      const force = opts.closeBeforeWeekend && isLastBeforeWeekend(f, j) ? "weekend" : undefined;
      const ev = stepBar(
        pos,
        {
          open: f.open[j] as number,
          high: f.high[j] as number,
          low: f.low[j] as number,
          close: f.close[j] as number,
        },
        {
          spread: spreadAt(f, j, c.spread) * c.multiplier,
          slippage: slip,
          atr: f.atr[j] as number,
          forceExit: force,
        },
      );
      exits.push(...ev);
      if (pos.openFrac <= 1e-12) break;
    }
    if (pos.openFrac > 1e-12) {
      // Ran out of data: mark to the last close (bid/ask side) so the trade is still counted honestly.
      const last = Math.min(j, end);
      exits.push({
        kind: "time",
        price: (f.close[last] as number) - (s * (spreadAt(f, last, c.spread) * c.multiplier)) / 2,
        fraction: pos.openFrac,
      });
      j = last;
    }
    const exitIdx = Math.min(j, end);
    const gross = grossPerUnit(pos, exits);
    const nights = rolloversBetween(f.ts[e] as number, (f.ts[exitIdx] as number) + len);
    const swap = nights * (s > 0 ? c.swapLongPerUnitNight : c.swapShortPerUnitNight);
    const commission = c.commissionPerUnit * c.multiplier;
    const net = gross - commission + swap;
    // Approximate friction in R: a spread crossing, entry and exit slippage, commission and swap.
    const friction = spread + 2 * slip + commission - swap;
    trades.push({
      signalIdx: i,
      entryIdx: e,
      exitIdx,
      entryTs: f.ts[e] as number,
      exitTs: (f.ts[exitIdx] as number) + len,
      side: s > 0 ? "long" : "short",
      entry: fill,
      stopDist,
      grossR: gross / stopDist,
      costR: friction / stopDist,
      netR: net / stopDist,
      reason: (exits.find((x) => x.kind !== "partial") ?? exits[exits.length - 1])?.kind ?? "time",
      barsHeld: exitIdx - e + 1,
      regime: TREND_CODES[trend[i] as number] as string,
      session: f.session[i] as number,
      mfeR: pos.mfe / stopDist,
      maeR: pos.mae / stopDist,
    });
    i = exitIdx + 1;
  }
  return trades;
}
