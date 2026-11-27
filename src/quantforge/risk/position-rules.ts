// Bar-by-bar position management shared by the backtester and the paper broker, so simulated history and
// paper trading follow identical rules.
//
// Conventions: bar prices are mid; a long exits at the bid (mid − spread/2), a short at the ask. Within a bar
// the adverse extreme is tested before the favorable one (a bar that touches both the stop and the target is
// a stop), which is the conservative assumption when the intrabar path is unknown. A bar opening beyond the
// stop fills at its open (gap risk); stops and market exits pay slippage; limit targets fill at their price.
// Stop changes (break-even, trailing) take effect from the next bar.

import type { Side } from "../core/types.js";
import type { ExitRules } from "../strategy/types.js";

export type ManagedPosition = {
  side: Side;
  /** Fill price (already includes spread and slippage). */
  entry: number;
  sl: number;
  tp: number | null;
  /** Initial stop distance (price units), the 1R unit. */
  stopDist: number;
  /** Fraction of the original size still open. */
  openFrac: number;
  partialDone: boolean;
  beDone: boolean;
  barsHeld: number;
  rules: ExitRules;
  /** Best and worst excursion so far, in price units (positive = favorable). */
  mfe: number;
  mae: number;
};

export type ExitKind = "stop" | "target" | "partial" | "time" | "weekend" | "emergency" | "manual";
export type ExitEvent = { kind: ExitKind; price: number; fraction: number };
export type BarInput = { open: number; high: number; low: number; close: number };
export type BarContext = {
  spread: number;
  slippage: number;
  atr: number;
  forceExit?: "weekend" | "emergency" | "manual" | undefined;
  /**
   * "full" (default, backtests): every rule on this bar. "monitor": stop/target/partial checks only, for
   * finer monitoring bars. "manage": break-even, trailing, bar count and time exit only, at the close of a
   * strategy-timeframe bar whose prices were already monitored.
   */
  phase?: "full" | "monitor" | "manage" | undefined;
};

export function openPosition(side: Side, fill: number, stopDist: number, rules: ExitRules): ManagedPosition {
  const s = side === "long" ? 1 : -1;
  return {
    side,
    entry: fill,
    sl: fill - s * stopDist,
    tp: fill + s * rules.tpR * stopDist,
    stopDist,
    openFrac: 1,
    partialDone: false,
    beDone: false,
    barsHeld: 0,
    rules,
    mfe: 0,
    mae: 0,
  };
}

/** Advance a position through one bar; mutates it and returns the exits that happened. */
export function stepBar(pos: ManagedPosition, bar: BarInput, ctx: BarContext): ExitEvent[] {
  if (pos.openFrac <= 0) return [];
  const s = pos.side === "long" ? 1 : -1;
  const half = ctx.spread / 2;
  const px = (mid: number) => mid - s * half; // the price this position exits at
  const events: ExitEvent[] = [];
  const closeAll = (kind: ExitKind, price: number) => {
    events.push({ kind, price, fraction: pos.openFrac });
    pos.openFrac = 0;
  };
  const fav = s > 0 ? px(bar.high) : px(bar.low);
  const adv = s > 0 ? px(bar.low) : px(bar.high);
  pos.mfe = Math.max(pos.mfe, s * (fav - pos.entry));
  pos.mae = Math.min(pos.mae, s * (adv - pos.entry));

  const phase = ctx.phase ?? "full";
  const r = pos.rules;
  if (phase !== "manage") {
    const openX = px(bar.open);
    if (s * (openX - pos.sl) <= 0) {
      closeAll("stop", openX - s * ctx.slippage);
      return events;
    }
    if (pos.tp !== null && s * (openX - pos.tp) >= 0) {
      closeAll("target", openX);
      return events;
    }
    if (s * (adv - pos.sl) <= 0) {
      closeAll("stop", pos.sl - s * ctx.slippage);
      return events;
    }
    if (r.partialR !== null && !pos.partialDone && pos.openFrac > 0) {
      const level = pos.entry + s * r.partialR * pos.stopDist;
      if (s * (fav - level) >= 0 && (pos.tp === null || s * (level - pos.tp) < 0)) {
        const frac = pos.openFrac * r.partialFrac;
        events.push({ kind: "partial", price: level, fraction: frac });
        pos.openFrac -= frac;
        pos.partialDone = true;
      }
    }
    if (pos.tp !== null && s * (fav - pos.tp) >= 0) {
      closeAll("target", pos.tp);
      return events;
    }
  }
  // Stop adjustments for the next bar.
  if (pos.partialDone && s * (pos.entry - pos.sl) > 0) {
    pos.sl = pos.entry;
    pos.beDone = true;
  }
  if (phase === "monitor") return events;
  if (r.breakEvenR !== null && !pos.beDone && s * (fav - pos.entry) >= r.breakEvenR * pos.stopDist) {
    if (s * (pos.entry - pos.sl) > 0) pos.sl = pos.entry;
    pos.beDone = true;
  }
  if (r.trailAtr !== null && (pos.partialDone || pos.beDone) && ctx.atr > 0) {
    const trail = px(bar.close) - s * r.trailAtr * ctx.atr;
    if (s * (trail - pos.sl) > 0) pos.sl = trail;
  }
  pos.barsHeld++;
  if (ctx.forceExit) {
    closeAll(ctx.forceExit, px(bar.close) - s * ctx.slippage);
    return events;
  }
  if (pos.barsHeld >= r.maxBars) closeAll("time", px(bar.close) - s * ctx.slippage);
  return events;
}

/** Gross P&L per unit (one ounce) of a list of exits. */
export function grossPerUnit(
  pos: Pick<ManagedPosition, "side" | "entry">,
  exits: readonly ExitEvent[],
): number {
  const s = pos.side === "long" ? 1 : -1;
  return exits.reduce((sum, e) => sum + s * (e.price - pos.entry) * e.fraction, 0);
}
