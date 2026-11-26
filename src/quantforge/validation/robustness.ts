// Robustness tests of a strategy's trades: Monte Carlo resampling of the trade sequence, bootstrap confidence
// of expectancy, and chronological segment helpers.

import { bootstrapMeanCi, quantile, seededRandom } from "../core/stats.js";

export type MonteCarlo = {
  iterations: number;
  probProfit: number;
  medianTotalR: number;
  p5TotalR: number;
  p95MaxDrawdownPct: number;
  medianMaxDrawdownPct: number;
  probRuin: number;
};

/**
 * Bootstrap the trade list (with replacement, same length) `iterations` times at a fixed risk fraction and
 * read the distribution of total R and maximum drawdown. Ruin = a drawdown beyond `ruinPct`.
 */
export function monteCarlo(
  rs: readonly number[],
  { iterations = 1000, riskFraction = 0.01, ruinPct = 30, seed = 11 } = {},
): MonteCarlo {
  const n = rs.length;
  if (n === 0)
    return {
      iterations: 0,
      probProfit: 0,
      medianTotalR: 0,
      p5TotalR: 0,
      p95MaxDrawdownPct: 0,
      medianMaxDrawdownPct: 0,
      probRuin: 1,
    };
  const rnd = seededRandom(seed);
  const totals: number[] = [];
  const dds: number[] = [];
  let ruin = 0;
  for (let it = 0; it < iterations; it++) {
    let total = 0;
    let eq = 1;
    let peak = 1;
    let maxDd = 0;
    for (let k = 0; k < n; k++) {
      const r = rs[Math.floor(rnd() * n)] as number;
      total += r;
      eq *= 1 + riskFraction * r;
      peak = Math.max(peak, eq);
      maxDd = Math.max(maxDd, 1 - eq / peak);
    }
    totals.push(total);
    dds.push(maxDd * 100);
    if (maxDd * 100 >= ruinPct) ruin++;
  }
  totals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  return {
    iterations,
    probProfit: totals.filter((t) => t > 0).length / iterations,
    medianTotalR: quantile(totals, 0.5),
    p5TotalR: quantile(totals, 0.05),
    p95MaxDrawdownPct: quantile(dds, 0.95),
    medianMaxDrawdownPct: quantile(dds, 0.5),
    probRuin: ruin / iterations,
  };
}

export function expectancyCi(rs: readonly number[], alpha = 0.1, seed = 5): { low: number; high: number } {
  return bootstrapMeanCi(rs, { alpha, seed, iterations: 1500 });
}

export type Segments = { start: number; trainEnd: number; validEnd: number; end: number };

/** Chronological train / validation / test split of usable bar indices [start, end). */
export function splitSegments(start: number, end: number, trainFrac: number, validFrac: number): Segments {
  const len = end - start;
  const trainEnd = start + Math.floor(len * trainFrac);
  const validEnd = trainEnd + Math.floor(len * validFrac);
  return { start, trainEnd, validEnd, end };
}

/** Anchored walk-forward folds over [start, end): fold k trains on blocks 0..k-1 and tests on block k. */
export function walkForwardFolds(
  start: number,
  end: number,
  folds: number,
): { isFrom: number; isTo: number; oosFrom: number; oosTo: number }[] {
  const block = Math.floor((end - start) / (folds + 1));
  const out: { isFrom: number; isTo: number; oosFrom: number; oosTo: number }[] = [];
  for (let k = 1; k <= folds; k++) {
    out.push({
      isFrom: start,
      isTo: start + k * block,
      oosFrom: start + k * block,
      oosTo: k === folds ? end : start + (k + 1) * block,
    });
  }
  return out;
}
