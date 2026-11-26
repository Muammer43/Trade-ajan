// Signal families. Each looks only at bars 0..i and returns +1 (long), −1 (short) or 0 at the close of bar i.

import { SESSION_CODES } from "../core/time.js";
import type { FeatureSet } from "../intelligence/features.js";
import { TREND_CODES } from "../intelligence/regime.js";
import { type FamilyId, REGIME_FILTER_ADMITS, type StrategySpec } from "./spec.js";

type Raw = (f: FeatureSet, i: number, p: Record<string, number>) => -1 | 0 | 1;

const fin = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);

const RAW: Record<FamilyId, Raw> = {
  disp_cont(f, i, p) {
    const b = f.body[i];
    const c = f.clv[i] as number;
    if (!fin(b) || Math.abs(b) < (p.k as number)) return 0;
    if (b > 0 && c >= (p.clv as number)) return 1;
    if (b < 0 && c <= -(p.clv as number)) return -1;
    return 0;
  },
  disp_fade(f, i, p) {
    return -RAW.disp_cont(f, i, p) as -1 | 0 | 1;
  },
  sweep_reject(f, i, p) {
    const n = p.n as number;
    const hi = f.donchianHigh(n)[i];
    const lo = f.donchianLow(n)[i];
    if (!fin(hi) || !fin(lo)) return 0;
    const w = p.w as number;
    if ((f.high[i] as number) > hi && (f.close[i] as number) < hi && (f.upWick[i] as number) >= w) return -1;
    if ((f.low[i] as number) < lo && (f.close[i] as number) > lo && (f.loWick[i] as number) >= w) return 1;
    return 0;
  },
  breakout_fail(f, i, p) {
    const n = p.n as number;
    const m = p.m as number;
    const hi = f.donchianHigh(n);
    const lo = f.donchianLow(n);
    const c = f.close[i] as number;
    // A close above the range within the last m bars, and now back inside below that breakout level.
    for (let k = i - 1; k >= Math.max(0, i - m); k--) {
      const h = hi[k] as number;
      const l = lo[k] as number;
      if (fin(h) && (f.close[k] as number) > h && c < h) return -1;
      if (fin(l) && (f.close[k] as number) < l && c > l) return 1;
    }
    return 0;
  },
  squeeze_break(f, i, p) {
    const vr = f.volRatio[i - 1];
    const ra = f.rangeAtr[i];
    if (!fin(vr) || !fin(ra) || vr >= (p.c as number) || ra < (p.r as number)) return 0;
    const c = f.clv[i] as number;
    if (c >= 0.5) return 1;
    if (c <= -0.5) return -1;
    return 0;
  },
  zrevert(f, i, p) {
    const z = f.z[i];
    const er = f.er[i];
    if (!fin(z) || !fin(er) || er >= (p.e as number)) return 0;
    if (z <= -(p.k as number)) return 1;
    if (z >= (p.k as number)) return -1;
    return 0;
  },
  momentum_persist(f, i, p) {
    const e = p.e as number;
    const er = f.er[i];
    const prev = f.er[i - 1];
    const t = f.slopeT[i];
    if (!fin(er) || !fin(prev) || !fin(t) || !(prev < e && er >= e)) return 0;
    return t > 0 ? 1 : t < 0 ? -1 : 0;
  },
  session_drive(f, i, p) {
    const flag = p.session === 1 ? f.londonOpen[i] : f.nyOpen[i];
    const b = f.body[i];
    if (!flag || !fin(b) || Math.abs(b) < (p.k as number)) return 0;
    const dir = b > 0 ? 1 : -1;
    return (p.fade ? -dir : dir) as -1 | 1;
  },
  streak_fade(f, i, p) {
    const s = f.streak[i] as number;
    const n = p.n as number;
    if (s === n) return -1;
    if (s === -n) return 1;
    return 0;
  },
  streak_follow(f, i, p) {
    return -RAW.streak_fade(f, i, p) as -1 | 0 | 1;
  },
};

/** Raw family signal before filters. */
export function rawSignal(
  spec: Pick<StrategySpec, "family" | "params">,
  f: FeatureSet,
  i: number,
): -1 | 0 | 1 {
  if (i < f.warmup || i < 1) return 0;
  return RAW[spec.family](f, i, spec.params);
}

/** Filtered signal at the close of bar i. `trend` holds trendSeries codes. */
export function signalAt(spec: StrategySpec, f: FeatureSet, trend: Uint8Array, i: number): -1 | 0 | 1 {
  const s = rawSignal(spec, f, i);
  if (s === 0) return 0;
  return passesFilters(spec, f, trend, i, s) ? s : 0;
}

export function passesFilters(
  spec: StrategySpec,
  f: FeatureSet,
  trend: Uint8Array,
  i: number,
  side: -1 | 1,
): boolean {
  const sess = f.session[i] as number;
  if (sess === SESSION_CODES.closed) return false;
  if (
    spec.session === "london_ny" &&
    !(sess === SESSION_CODES.london || sess === SESSION_CODES.overlap || sess === SESSION_CODES.newyork)
  )
    return false;
  if (spec.session === "asia" && sess !== SESSION_CODES.asia) return false;
  const label = TREND_CODES[trend[i] as number] as string;
  if (!REGIME_FILTER_ADMITS[spec.regime].includes(label)) return false;
  if (spec.htfAlign) {
    const h = f.htf4hSlopeT[i];
    if (!fin(h) || Math.sign(h) !== side) return false;
  }
  return true;
}

/** Every signal index in [from, to), for discovery. */
export function signalIndices(
  spec: StrategySpec,
  f: FeatureSet,
  trend: Uint8Array,
  from: number,
  to: number,
): { idx: number[]; side: Int8Array } {
  const idx: number[] = [];
  const side = new Int8Array(f.n);
  for (let i = Math.max(from, f.warmup); i < Math.min(to, f.n - 1); i++) {
    const s = signalAt(spec, f, trend, i);
    if (s !== 0) {
      idx.push(i);
      side[i] = s;
    }
  }
  return { idx, side };
}
