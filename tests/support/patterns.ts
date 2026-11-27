// Deterministic 15-minute price paths that contain one textbook setup of each trade model, for tests.
// Prices are built from a list of closes; each candle opens at the previous close with small wicks.
// `mirror` turns a bullish path into the equivalent bearish one.

import { seededRandom } from "../../src/quantforge/core/stats.js";
import type { Candle } from "../../src/quantforge/core/types.js";

export const START = Date.UTC(2026, 0, 5, 0, 0);
const STEP = 900_000;

export type Spec = { close: number; wickUp?: number; wickDn?: number; open?: number };

export function build(specs: Spec[], start = START): Candle[] {
  const out: Candle[] = [];
  let prev = specs[0]?.close ?? 2000;
  specs.forEach((s, k) => {
    const open = s.open ?? prev;
    const hi = Math.max(open, s.close) + (s.wickUp ?? 0.4);
    const lo = Math.min(open, s.close) - (s.wickDn ?? 0.4);
    out.push({ ts: start + k * STEP, open, high: hi, low: lo, close: s.close, volume: null });
    prev = s.close;
  });
  return out;
}

export function mirror(candles: Candle[], around = 2000): Candle[] {
  return candles.map((c) => ({
    ...c,
    open: 2 * around - c.open,
    close: 2 * around - c.close,
    high: 2 * around - c.low,
    low: 2 * around - c.high,
  }));
}

/** A noisy trend: `n` candles drifting `drift` per candle with seeded noise of amplitude `noise`. */
export function trend(n: number, from: number, drift: number, noise: number, seed: number): Spec[] {
  const rnd = seededRandom(seed);
  const out: Spec[] = [];
  let p = from;
  for (let k = 0; k < n; k++) {
    // Volatility cycles (as real markets cluster volatility) so ATR percentiles are meaningful.
    const v = noise * (1 + 0.6 * Math.sin((2 * Math.PI * k) / 160));
    p += drift + (rnd() - 0.5) * 2 * v;
    out.push({ close: p, wickUp: 0.3 + rnd() * v * 0.5, wickDn: 0.3 + rnd() * v * 0.5 });
  }
  return out;
}

/** A sideways market oscillating between `lo` and `hi` with period `period` candles. */
export function range(n: number, lo: number, hi: number, period: number, seed: number, noise = 2.5): Spec[] {
  const rnd = seededRandom(seed);
  const mid = (lo + hi) / 2;
  const amp = (hi - lo) / 2;
  return Array.from({ length: n }, (_, k) => ({
    close: mid + amp * Math.sin((2 * Math.PI * k) / period) + (rnd() - 0.5) * noise,
    wickUp: 0.4 + rnd() * noise * 0.6,
    wickDn: 0.4 + rnd() * noise * 0.6,
  }));
}

const last = (s: Spec[]) => (s[s.length - 1] as Spec).close;

/** Uptrend, an impulse, a ~50% pullback toward the EMAs, then a bullish trigger candle. */
export function trendPullbackLong(): Candle[] {
  const s = trend(700, 2000, 0.3, 2.4, 3);
  let p = last(s);
  const step = (d: number, wickUp?: number, wickDn?: number) => {
    p += d;
    s.push({
      close: p,
      ...(wickUp !== undefined ? { wickUp } : {}),
      ...(wickDn !== undefined ? { wickDn } : {}),
    });
  };
  for (const d of [-1.6, -1.8, -1.4]) step(d); // swing low (impulse origin)
  for (let k = 0; k < 6; k++) step(3.2, 0.5, 0.4); // impulse
  for (const d of [-2.6, -2.8, -2.4, -2.2]) step(d, 0.4, 0.8); // pullback
  s.push({ close: p + 4.6, open: p, wickUp: 0.4, wickDn: 0.6 }); // trigger
  return build(s);
}

/** A range with a tested ceiling, a decisive breakout, a retest that holds, then a trigger candle. */
export function breakoutRetestLong(): Candle[] {
  const s = range(700, 2000, 2010, 40, 5);
  s.push({ close: 2008.5 }, { close: 2009.2 });
  s.push({ close: 2015.5, open: 2009.4, wickUp: 0.4, wickDn: 0.3 }); // breakout
  s.push({ close: 2014.6, wickUp: 0.5, wickDn: 0.4 });
  s.push({ close: 2012.6, wickUp: 0.4, wickDn: 2.2 }); // retest into the old ceiling, holds above it
  s.push({ close: 2016.2, open: 2012.7, wickUp: 0.3, wickDn: 0.3 }); // trigger
  return build(s);
}

/** A range whose swing low is swept by a long-wick candle, then a candle closes back above the sweep candle. */
export function failedBreakoutLong(): Candle[] {
  const s = range(700, 2000, 2030, 60, 7);
  // Walk down toward the range floor.
  for (const c of [2005, 2003, 2001.6]) s.push({ close: c });
  s.push({ close: 2001.2, open: 2001.6, wickDn: 4.2, wickUp: 0.3 }); // sweep below the swing lows, close back inside
  s.push({ close: 2005.2, open: 2001.3, wickUp: 0.4, wickDn: 0.3 }); // structural confirmation
  return build(s);
}

/** Directionless noise: no setup should qualify. */
export function flat(): Candle[] {
  const rnd = seededRandom(11);
  return build(
    Array.from({ length: 800 }, () => ({ close: 2000 + (rnd() - 0.5) * 0.8, wickUp: 0.2, wickDn: 0.2 })),
  );
}
