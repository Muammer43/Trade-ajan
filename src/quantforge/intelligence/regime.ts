// Quantitative market-regime classifier and its historical evaluation.
//
// Trend state uses the t-statistic of the log-price slope (48 bars) together with Kaufman's efficiency ratio
// (20 bars), so a trend needs both statistical significance and an orderly path; ADX is reported as
// supporting evidence only. Volatility level is the ATR's percentile in its trailing 500-bar history;
// volatility dynamics is the ratio of short (12) to long (96) realized volatility. Breakouts are closes
// beyond the prior 48-bar range on an expanded bar; liquidity traps are sweeps of the prior 20-bar range
// that closed back inside within the last three bars.
//
// Evaluation scores the label at t against what the following H bars actually did (forward trend class from
// forward slope significance, forward volatility from realized range), against naive baselines.

import { mean } from "../core/stats.js";
import type { Regime, TrendRegime, VolDynamic, VolLevel } from "../core/types.js";
import type { FeatureSet } from "./features.js";

export type RegimeThresholds = {
  strongT: number;
  weakT: number;
  strongEr: number;
  highVolPct: number;
  lowVolPct: number;
  expansion: number;
  contraction: number;
};

export const DEFAULT_THRESHOLDS: RegimeThresholds = {
  // Calibrated on XAU/USD 15m (Oct–Nov 2026): |t| median ≈ 6.3, 85th percentile ≈ 13. Slope t-statistics of
  // autocorrelated prices are inflated, so they are used as a ranked strength measure, not as p-values.
  strongT: 12,
  weakT: 6,
  strongEr: 0.3,
  highVolPct: 0.8,
  lowVolPct: 0.2,
  expansion: 1.3,
  contraction: 0.75,
};

export function classifyAt(f: FeatureSet, i: number, th: RegimeThresholds = DEFAULT_THRESHOLDS): Regime {
  const t = f.slopeT[i] as number;
  const er = f.er[i] as number;
  const adxV = f.adx[i] as number;
  const pct = f.atrPct[i] as number;
  const vr = f.volRatio[i] as number;
  let trend: TrendRegime = "range";
  if (Number.isFinite(t) && Number.isFinite(er)) {
    if (t >= th.strongT && er >= th.strongEr) trend = "strong_bull";
    else if (t <= -th.strongT && er >= th.strongEr) trend = "strong_bear";
    else if (Math.abs(t) >= th.weakT) trend = "weak_trend";
  }
  const vol: VolLevel = !Number.isFinite(pct)
    ? "normal"
    : pct >= th.highVolPct
      ? "high"
      : pct <= th.lowVolPct
        ? "low"
        : "normal";
  const volDynamic: VolDynamic = !Number.isFinite(vr)
    ? "stable"
    : vr >= th.expansion
      ? "expansion"
      : vr <= th.contraction
        ? "contraction"
        : "stable";

  let breakout: Regime["breakout"] = null;
  const hi48 = f.donchianHigh(48)[i] as number;
  const lo48 = f.donchianLow(48)[i] as number;
  const ra = f.rangeAtr[i] as number;
  if (Number.isFinite(hi48) && (f.close[i] as number) > hi48 && ra >= 1.2) breakout = "up";
  else if (Number.isFinite(lo48) && (f.close[i] as number) < lo48 && ra >= 1.2) breakout = "down";

  let liquidityTrap: Regime["liquidityTrap"] = null;
  const hi20 = f.donchianHigh(20);
  const lo20 = f.donchianLow(20);
  for (let k = Math.max(0, i - 2); k <= i; k++) {
    const h = hi20[k] as number;
    const l = lo20[k] as number;
    if (
      Number.isFinite(h) &&
      (f.high[k] as number) > h &&
      (f.close[k] as number) < h &&
      (f.upWick[k] as number) >= 0.5
    )
      liquidityTrap = "bull_trap";
    if (
      Number.isFinite(l) &&
      (f.low[k] as number) < l &&
      (f.close[k] as number) > l &&
      (f.loWick[k] as number) >= 0.5
    )
      liquidityTrap = "bear_trap";
  }

  const parts = [
    trend.replace("_", " "),
    `${vol} vol`,
    volDynamic !== "stable" ? `vol ${volDynamic}` : null,
    breakout ? `breakout ${breakout}` : null,
    liquidityTrap ? liquidityTrap.replace("_", " ") : null,
  ].filter(Boolean);
  return {
    trend,
    vol,
    volDynamic,
    breakout,
    liquidityTrap,
    scores: {
      slopeT: t,
      efficiency: er,
      adx: Number.isFinite(adxV) ? adxV : null,
      atrPercentile: pct,
      volRatio: vr,
    },
    label: parts.join(", "),
  };
}

/** Trend label per bar (cheap path for backtests and filters). */
export function trendSeries(f: FeatureSet, th: RegimeThresholds = DEFAULT_THRESHOLDS): Uint8Array {
  const codes: Record<TrendRegime, number> = { strong_bull: 0, strong_bear: 1, weak_trend: 2, range: 3 };
  const out = new Uint8Array(f.n).fill(3);
  for (let i = 0; i < f.n; i++) {
    const t = f.slopeT[i] as number;
    const er = f.er[i] as number;
    if (!Number.isFinite(t) || !Number.isFinite(er)) continue;
    if (t >= th.strongT && er >= th.strongEr) out[i] = codes.strong_bull;
    else if (t <= -th.strongT && er >= th.strongEr) out[i] = codes.strong_bear;
    else if (Math.abs(t) >= th.weakT) out[i] = codes.weak_trend;
  }
  return out;
}
export const TREND_CODES: readonly TrendRegime[] = ["strong_bull", "strong_bear", "weak_trend", "range"];

export type RegimeEvaluation = {
  bars: number;
  horizon: number;
  trend: {
    accuracy: number;
    baselineMajority: number;
    baselinePersistence: number | null;
    confusion: Record<string, Record<string, number>>;
    forwardReturnByRegime: Record<string, { n: number; meanBps: number }>;
  };
  volatility: {
    accuracy: number;
    baselineMajority: number;
    /** Mean forward absolute return (bps) per predicted volatility level: should rise from low to high. */
    forwardAbsReturnByLevel: Record<string, { n: number; meanBps: number }>;
    monotonic: boolean;
    /** Spearman rank correlation of ATR percentile at t with absolute forward return. */
    rankCorrelation: number;
  };
};

/**
 * Score labels against forward realized behaviour over `horizon` bars (non-overlapping sampling every
 * `horizon` bars to keep observations close to independent).
 */
export function evaluateRegimes(
  f: FeatureSet,
  horizon = 16,
  th: RegimeThresholds = DEFAULT_THRESHOLDS,
): RegimeEvaluation {
  const start = Math.max(f.warmup, 600);
  const trends = trendSeries(f, th);
  const confusion: Record<string, Record<string, number>> = {};
  const fwdRet: Record<string, number[]> = {};
  const fwdAbsByVol: Record<string, number[]> = { low: [], normal: [], high: [] };
  let hit = 0;
  let total = 0;
  let volHit = 0;
  const actualCounts: Record<string, number> = {};
  const volActualCounts: Record<string, number> = {};
  const pctSorted: number[] = [];
  for (let i = start; i < f.n; i += 1)
    pctSorted.push(
      Math.abs(Math.log((f.close[Math.min(f.n - 1, i + horizon)] as number) / (f.close[i] as number))),
    );
  pctSorted.sort((a, b) => a - b);
  const volCut = (q: number) => pctSorted[Math.floor(q * (pctSorted.length - 1))] ?? 0;
  const lowCut = volCut(0.2);
  const highCut = volCut(0.8);
  let persistHit = 0;
  let persistTotal = 0;
  let prevActual: string | null = null;
  const pairs: [number, number][] = [];
  for (let i = start; i + horizon < f.n; i += horizon) {
    const predicted = TREND_CODES[trends[i] as number] as string;
    // Forward truth: slope significance and efficiency over the next `horizon` bars, scaled to the 48-bar test.
    const ys: number[] = [];
    for (let k = 1; k <= horizon; k++) ys.push(Math.log(f.close[i + k] as number));
    const fwdT = slopeTOf(ys); // the same statistic on the forward window
    let path = 0;
    for (let k = i + 1; k <= i + horizon; k++)
      path += Math.abs((f.close[k] as number) - (f.close[k - 1] as number));
    const fwdEr = path > 0 ? Math.abs((f.close[i + horizon] as number) - (f.close[i] as number)) / path : 0;
    const scaledStrong = th.strongT * Math.sqrt(horizon / 48);
    const scaledWeak = th.weakT * Math.sqrt(horizon / 48);
    const actual =
      fwdT >= scaledStrong && fwdEr >= th.strongEr
        ? "strong_bull"
        : fwdT <= -scaledStrong && fwdEr >= th.strongEr
          ? "strong_bear"
          : Math.abs(fwdT) >= scaledWeak
            ? "weak_trend"
            : "range";
    confusion[predicted] ??= {};
    (confusion[predicted] as Record<string, number>)[actual] =
      ((confusion[predicted] as Record<string, number>)[actual] ?? 0) + 1;
    actualCounts[actual] = (actualCounts[actual] ?? 0) + 1;
    if (predicted === actual) hit++;
    if (prevActual !== null) {
      persistTotal++;
      if (prevActual === actual) persistHit++;
    }
    prevActual = actual;
    total++;
    const r = Math.log((f.close[i + horizon] as number) / (f.close[i] as number));
    if (!fwdRet[predicted]) fwdRet[predicted] = [];
    fwdRet[predicted].push(r);
    const pct = f.atrPct[i] as number;
    const level = !Number.isFinite(pct)
      ? "normal"
      : pct >= th.highVolPct
        ? "high"
        : pct <= th.lowVolPct
          ? "low"
          : "normal";
    const absR = Math.abs(r);
    if (Number.isFinite(pct)) pairs.push([pct, absR]);
    (fwdAbsByVol[level] as number[]).push(absR);
    const actualVol = absR >= highCut ? "high" : absR <= lowCut ? "low" : "normal";
    volActualCounts[actualVol] = (volActualCounts[actualVol] ?? 0) + 1;
    if (actualVol === level) volHit++;
  }
  const summarize = (xs: number[]) => ({
    n: xs.length,
    meanBps: xs.length ? Math.round(mean(xs) * 1e6) / 100 : 0,
  });
  const byVol = Object.fromEntries(Object.entries(fwdAbsByVol).map(([k, v]) => [k, summarize(v)]));
  const lowM = (byVol.low as { meanBps: number; n: number }).meanBps;
  const normM = (byVol.normal as { meanBps: number }).meanBps;
  const highM = (byVol.high as { meanBps: number; n: number }).meanBps;
  return {
    bars: f.n,
    horizon,
    trend: {
      accuracy: total ? hit / total : 0,
      baselineMajority: total ? Math.max(0, ...Object.values(actualCounts)) / total : 0,
      baselinePersistence: persistTotal ? persistHit / persistTotal : null,
      confusion,
      forwardReturnByRegime: Object.fromEntries(Object.entries(fwdRet).map(([k, v]) => [k, summarize(v)])),
    },
    volatility: {
      accuracy: total ? volHit / total : 0,
      baselineMajority: total ? Math.max(0, ...Object.values(volActualCounts)) / total : 0,
      forwardAbsReturnByLevel: byVol,
      monotonic: lowM < normM && normM < highM,
      rankCorrelation: spearman(pairs),
    },
  };
}

function slopeTOf(ys: readonly number[]): number {
  const w = ys.length;
  const xm = (w - 1) / 2;
  const ym = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let k = 0; k < w; k++) {
    sxx += (k - xm) ** 2;
    sxy += (k - xm) * ((ys[k] as number) - ym);
  }
  const b = sxy / sxx;
  let sse = 0;
  for (let k = 0; k < w; k++) sse += ((ys[k] as number) - (ym + b * (k - xm))) ** 2;
  const se = Math.sqrt(sse / (w - 2) / sxx);
  return se > 0 ? b / se : 0;
}

function ranks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const r = new Array<number>(xs.length);
  order.forEach(({ i }, k) => {
    r[i] = k;
  });
  return r;
}

export function spearman(pairs: readonly [number, number][]): number {
  if (pairs.length < 3) return 0;
  const a = ranks(pairs.map((p) => p[0]));
  const b = ranks(pairs.map((p) => p[1]));
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += ((a[i] as number) - ma) * ((b[i] as number) - mb);
    da += ((a[i] as number) - ma) ** 2;
    db += ((b[i] as number) - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
