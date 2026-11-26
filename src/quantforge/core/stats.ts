// Statistics used by validation: moments, distributions, multiple-testing corrections, the deflated Sharpe
// ratio and a seeded PRNG for reproducible resampling.

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n − 1). */
export function stdev(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return Number.NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

export function skewness(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / n);
  if (sd === 0) return 0;
  return xs.reduce((a, x) => a + ((x - m) / sd) ** 3, 0) / n;
}

/** Non-excess kurtosis (normal = 3). */
export function kurtosis(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 4) return 3;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / n);
  if (sd === 0) return 3;
  return xs.reduce((a, x) => a + ((x - m) / sd) ** 4, 0) / n;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

/** Standard normal CDF (Abramowitz–Stegun 26.2.17 via erf, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normalInv(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const ak = (i: number) => a[i] as number;
  const bk = (i: number) => b[i] as number;
  const ck = (i: number) => c[i] as number;
  const dk = (i: number) => d[i] as number;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((ck(0) * q + ck(1)) * q + ck(2)) * q + ck(3)) * q + ck(4)) * q + ck(5)) /
      ((((dk(0) * q + dk(1)) * q + dk(2)) * q + dk(3)) * q + 1)
    );
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((ck(0) * q + ck(1)) * q + ck(2)) * q + ck(3)) * q + ck(4)) * q + ck(5)) /
      ((((dk(0) * q + dk(1)) * q + dk(2)) * q + dk(3)) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((ak(0) * r + ak(1)) * r + ak(2)) * r + ak(3)) * r + ak(4)) * r + ak(5)) * q) /
    (((((bk(0) * r + bk(1)) * r + bk(2)) * r + bk(3)) * r + bk(4)) * r + 1)
  );
}

function logGamma(x: number): number {
  const g = [
    76.180091729471, -86.505320329417, 24.014098240831, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.00000000019;
  for (const coef of g) ser += coef / ++y;
  return -tmp + Math.log((Math.sqrt(2 * Math.PI) * ser) / x);
}

/** Continued fraction for the regularized incomplete beta (Numerical Recipes betacf). */
function betacf(a: number, b: number, x: number): number {
  const maxIt = 200;
  const eps = 3e-14;
  const fpmin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIt; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t CDF with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** One-sided p-value that the mean of `xs` is greater than zero (t-test). */
export function pValueMeanPositive(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return 1;
  const sd = stdev(xs);
  if (!(sd > 0)) return mean(xs) > 0 ? 0 : 1;
  const t = mean(xs) / (sd / Math.sqrt(n));
  return 1 - studentTCdf(t, n - 1);
}

/**
 * Benjamini–Hochberg: which hypotheses are rejected (discoveries) at false-discovery rate `q`.
 * Returns a boolean per input p-value.
 */
export function benjaminiHochberg(pValues: readonly number[], q: number): boolean[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let cutoff = -1;
  order.forEach(({ p }, k) => {
    if (p <= ((k + 1) / m) * q) cutoff = k;
  });
  const out = new Array<boolean>(m).fill(false);
  for (let k = 0; k <= cutoff; k++) out[(order[k] as { i: number }).i] = true;
  return out;
}

const EULER_GAMMA = 0.5772156649015329;

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014): the probability that the observed per-period
 * Sharpe ratio `sr` (over `n` observations with the given skew and non-excess kurtosis) exceeds the
 * maximum Sharpe expected from `trials` independent trials whose Sharpe ratios have variance `srVariance`.
 */
export function deflatedSharpe(input: {
  sr: number;
  n: number;
  skew: number;
  kurt: number;
  trials: number;
  srVariance: number;
}): { dsr: number; sr0: number } {
  const { sr, n, skew, kurt, trials, srVariance } = input;
  if (n < 3) return { dsr: 0, sr0: Number.NaN };
  const N = Math.max(1, trials);
  const sd = Math.sqrt(Math.max(srVariance, 0));
  const sr0 =
    N <= 1
      ? 0
      : sd * ((1 - EULER_GAMMA) * normalInv(1 - 1 / N) + EULER_GAMMA * normalInv(1 - 1 / (N * Math.E)));
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return { dsr: normalCdf(((sr - sr0) * Math.sqrt(n - 1)) / denom), sr0 };
}

/** Mulberry32: a small, fast, seeded PRNG giving floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap confidence interval of the mean. */
export function bootstrapMeanCi(
  xs: readonly number[],
  { iterations = 2000, alpha = 0.1, seed = 7 }: { iterations?: number; alpha?: number; seed?: number } = {},
): { low: number; high: number } {
  const n = xs.length;
  if (n < 2) return { low: Number.NaN, high: Number.NaN };
  const rnd = seededRandom(seed);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += xs[Math.floor(rnd() * n)] as number;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { low: quantile(means, alpha / 2), high: quantile(means, 1 - alpha / 2) };
}

/** Lag-1 autocorrelation. */
export function autocorr1(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = (xs[i] as number) - m;
    den += d * d;
    if (i > 0) num += d * ((xs[i - 1] as number) - m);
  }
  return den === 0 ? 0 : num / den;
}

export function round(x: number, digits = 4): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
