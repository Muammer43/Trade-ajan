// Causal feature engine. Every value at index i uses only bars 0..i, so a signal computed at the close of
// bar i can be acted on at the open of bar i+1 without look-ahead. Higher-timeframe context is joined only
// from higher bars that had closed by the close of bar i.
//
// ATR and ADX come from the original TradingAgents compute module (TA-Lib conventions).

import { indicatorsOf } from "../../compute/indicators.js";
import { newYorkParts, SESSION_CODES, sessionOf } from "../core/time.js";
import { type Candle, TF_MS, type Timeframe } from "../core/types.js";
import { resample } from "../data/resample.js";

export type FeatureSet = {
  tf: Timeframe;
  n: number;
  ts: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  atr: Float64Array;
  adx: Float64Array;
  ret: Float64Array;
  rvShort: Float64Array;
  rvLong: Float64Array;
  volRatio: Float64Array;
  atrPct: Float64Array;
  er: Float64Array;
  slopeT: Float64Array;
  z: Float64Array;
  body: Float64Array;
  rangeAtr: Float64Array;
  clv: Float64Array;
  upWick: Float64Array;
  loWick: Float64Array;
  streak: Int32Array;
  volCluster: Float64Array;
  session: Uint8Array;
  londonOpen: Uint8Array;
  nyOpen: Uint8Array;
  htf1hSlopeT: Float64Array;
  htf4hSlopeT: Float64Array;
  /** First index at which every feature is defined. */
  warmup: number;
  donchianHigh(n: number): Float64Array;
  donchianLow(n: number): Float64Array;
};

export const WINDOWS = {
  atr: 14,
  adx: 14,
  rvShort: 12,
  rvLong: 96,
  atrPct: 500,
  er: 20,
  slope: 48,
  z: 50,
  volCluster: 96,
} as const;

function rollingStd(xs: Float64Array, w: number): Float64Array {
  const out = new Float64Array(xs.length).fill(Number.NaN);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] as number;
    s += x;
    s2 += x * x;
    if (i >= w) {
      const o = xs[i - w] as number;
      s -= o;
      s2 -= o * o;
    }
    if (i >= w) {
      const m = s / w;
      out[i] = Math.sqrt(Math.max(0, (s2 - w * m * m) / (w - 1)));
    }
  }
  return out;
}

/** t-statistic of the OLS slope of log close over the last w bars. */
function rollingSlopeT(logc: Float64Array, w: number): Float64Array {
  const n = logc.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const xm = (w - 1) / 2;
  let sxx = 0;
  for (let k = 0; k < w; k++) sxx += (k - xm) ** 2;
  for (let i = w - 1; i < n; i++) {
    let ym = 0;
    for (let k = 0; k < w; k++) ym += logc[i - w + 1 + k] as number;
    ym /= w;
    let sxy = 0;
    for (let k = 0; k < w; k++) sxy += (k - xm) * ((logc[i - w + 1 + k] as number) - ym);
    const b = sxy / sxx;
    let sse = 0;
    for (let k = 0; k < w; k++) {
      const e = (logc[i - w + 1 + k] as number) - (ym + b * (k - xm));
      sse += e * e;
    }
    const se = Math.sqrt(sse / (w - 2) / sxx);
    out[i] = se > 0 ? b / se : 0;
  }
  return out;
}

/** Percentile rank of xs[i] within the trailing window (inclusive). */
function rollingPercentile(xs: Float64Array, w: number, minObs: number): Float64Array {
  const out = new Float64Array(xs.length).fill(Number.NaN);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] as number;
    if (!Number.isFinite(x)) continue;
    let below = 0;
    let total = 0;
    for (let k = Math.max(0, i - w + 1); k <= i; k++) {
      const v = xs[k] as number;
      if (!Number.isFinite(v)) continue;
      total++;
      if (v < x) below++;
    }
    if (total >= minObs) out[i] = below / (total - 1 || 1);
  }
  return out;
}

function htfSlope(
  candles: readonly Candle[],
  base: Float64Array,
  baseTf: Timeframe,
  htf: Timeframe,
  w: number,
): Float64Array {
  const out = new Float64Array(base.length).fill(Number.NaN);
  const higher = resample(candles, baseTf, htf, { requireComplete: false });
  if (higher.length < w + 1) return out;
  const logc = new Float64Array(higher.map((c) => Math.log(c.close)));
  const slope = rollingSlopeT(logc, w);
  const hlen = TF_MS[htf];
  const blen = TF_MS[baseTf];
  let j = -1;
  for (let i = 0; i < base.length; i++) {
    const closeTime = (base[i] as number) + blen;
    while (j + 1 < higher.length && (higher[j + 1] as Candle).ts + hlen <= closeTime) j++;
    if (j >= 0) out[i] = slope[j] as number;
  }
  return out;
}

/** Build every feature for market-open candles of one timeframe (oldest first). */
export function computeFeatures(candles: readonly Candle[], tf: Timeframe): FeatureSet {
  const n = candles.length;
  const f64 = (fn: (c: Candle) => number) => new Float64Array(candles.map(fn));
  const ts = f64((c) => c.ts);
  const open = f64((c) => c.open);
  const high = f64((c) => c.high);
  const low = f64((c) => c.low);
  const close = f64((c) => c.close);

  const bars = {
    dates: candles.map((c) => new Date(c.ts).toISOString()),
    highs: candles.map((c) => c.high),
    lows: candles.map((c) => c.low),
    closes: candles.map((c) => c.close),
  };
  const { columns } =
    n > 40
      ? indicatorsOf(
          bars,
          [
            { name: "atr", periods: [WINDOWS.atr] },
            { name: "adx", periods: [WINDOWS.adx] },
          ],
          0,
        )
      : { columns: {} as Record<string, (number | null)[]> };
  const toF = (vals: (number | null)[] | undefined) =>
    new Float64Array(n).map((_, i) => vals?.[i] ?? Number.NaN);
  const atr = toF(columns[`atr_${WINDOWS.atr}`]);
  const adx = toF(columns[`adx_${WINDOWS.adx}`]);

  const ret = new Float64Array(n);
  for (let i = 1; i < n; i++) ret[i] = Math.log((close[i] as number) / (close[i - 1] as number));
  const rvShort = rollingStd(ret, WINDOWS.rvShort);
  const rvLong = rollingStd(ret, WINDOWS.rvLong);
  const volRatio = new Float64Array(n).map((_, i) => (rvShort[i] as number) / (rvLong[i] as number));
  const atrPct = rollingPercentile(atr, WINDOWS.atrPct, 100);

  const er = new Float64Array(n).fill(Number.NaN);
  for (let i = WINDOWS.er; i < n; i++) {
    let path = 0;
    for (let k = i - WINDOWS.er + 1; k <= i; k++)
      path += Math.abs((close[k] as number) - (close[k - 1] as number));
    const net = Math.abs((close[i] as number) - (close[i - WINDOWS.er] as number));
    er[i] = path > 0 ? net / path : 0;
  }
  const slopeT = rollingSlopeT(new Float64Array(close.map(Math.log)), WINDOWS.slope);

  const z = new Float64Array(n).fill(Number.NaN);
  {
    let s = 0;
    let s2 = 0;
    const w = WINDOWS.z;
    for (let i = 0; i < n; i++) {
      const x = close[i] as number;
      s += x;
      s2 += x * x;
      if (i >= w) {
        const o = close[i - w] as number;
        s -= o;
        s2 -= o * o;
      }
      if (i >= w - 1) {
        const m = s / w;
        const sd = Math.sqrt(Math.max(0, (s2 - w * m * m) / (w - 1)));
        z[i] = sd > 0 ? (x - m) / sd : 0;
      }
    }
  }

  const body = new Float64Array(n);
  const rangeAtr = new Float64Array(n);
  const clv = new Float64Array(n);
  const upWick = new Float64Array(n);
  const loWick = new Float64Array(n);
  const streak = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const o = open[i] as number;
    const h = high[i] as number;
    const l = low[i] as number;
    const c = close[i] as number;
    const a = atr[i] as number;
    const r = h - l;
    body[i] = a > 0 ? (c - o) / a : Number.NaN;
    rangeAtr[i] = a > 0 ? r / a : Number.NaN;
    clv[i] = r > 0 ? (c - l - (h - c)) / r : 0;
    upWick[i] = r > 0 ? (h - Math.max(o, c)) / r : 0;
    loWick[i] = r > 0 ? (Math.min(o, c) - l) / r : 0;
    if (i > 0) {
      const d = Math.sign(c - (close[i - 1] as number));
      const prev = streak[i - 1] as number;
      streak[i] = d === 0 ? 0 : Math.sign(prev) === d ? prev + d : d;
    }
  }

  const volCluster = new Float64Array(n).fill(Number.NaN);
  {
    const w = WINDOWS.volCluster;
    const abs = ret.map(Math.abs);
    for (let i = w; i < n; i++) {
      let m = 0;
      for (let k = i - w + 1; k <= i; k++) m += abs[k] as number;
      m /= w;
      let num = 0;
      let den = 0;
      for (let k = i - w + 1; k <= i; k++) {
        const d = (abs[k] as number) - m;
        den += d * d;
        if (k > i - w + 1) num += d * ((abs[k - 1] as number) - m);
      }
      volCluster[i] = den > 0 ? num / den : 0;
    }
  }

  const session = new Uint8Array(n);
  const londonOpen = new Uint8Array(n);
  const nyOpen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = ts[i] as number;
    session[i] = SESSION_CODES[sessionOf(t)];
    const d = new Date(t);
    if (d.getUTCHours() === 7 && d.getUTCMinutes() === 0) londonOpen[i] = 1;
    const nyMin = newYorkParts(t).minutes;
    if (nyMin <= 510 && nyMin + TF_MS[tf] / 60_000 > 510) nyOpen[i] = 1; // the bar containing 08:30 New York
  }

  const htf1hSlopeT = TF_MS[tf] < TF_MS["1h"] ? htfSlope(candles, ts, tf, "1h", 24) : slopeT;
  const htf4hSlopeT = TF_MS[tf] < TF_MS["4h"] ? htfSlope(candles, ts, tf, "4h", 24) : slopeT;

  const donCache = new Map<string, Float64Array>();
  const donchian = (len: number, kind: "high" | "low") => {
    const key = `${kind}${len}`;
    const cached = donCache.get(key);
    if (cached) return cached;
    const src = kind === "high" ? high : low;
    const out = new Float64Array(n).fill(Number.NaN);
    // Max/min of bars i-len .. i-1 (excludes bar i) with a monotonic deque.
    const dq: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i >= len) out[i] = src[dq[0] as number] as number;
      const v = src[i] as number;
      while (
        dq.length &&
        (kind === "high"
          ? (src[dq[dq.length - 1] as number] as number) <= v
          : (src[dq[dq.length - 1] as number] as number) >= v)
      )
        dq.pop();
      dq.push(i);
      while ((dq[0] as number) <= i - len) dq.shift();
    }
    donCache.set(key, out);
    return out;
  };

  const warmup = Math.min(
    n,
    Math.max(WINDOWS.rvLong, WINDOWS.volCluster, 100, WINDOWS.slope, 4 * 24 + 1) + 1,
  );
  return {
    tf,
    n,
    ts,
    open,
    high,
    low,
    close,
    atr,
    adx,
    ret,
    rvShort,
    rvLong,
    volRatio,
    atrPct,
    er,
    slopeT,
    z,
    body,
    rangeAtr,
    clv,
    upWick,
    loWick,
    streak,
    volCluster,
    session,
    londonOpen,
    nyOpen,
    htf1hSlopeT,
    htf4hSlopeT,
    warmup,
    donchianHigh: (len) => donchian(len, "high"),
    donchianLow: (len) => donchian(len, "low"),
  };
}

/** A plain snapshot of the features at index i (for agents, evidence and storage). */
export function snapshotAt(f: FeatureSet, i: number): Record<string, number | null> {
  const v = (a: ArrayLike<number>) => {
    const x = a[i] as number;
    return Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : null;
  };
  return {
    ts: f.ts[i] ?? null,
    close: v(f.close),
    atr: v(f.atr),
    adx: v(f.adx),
    volRatio: v(f.volRatio),
    atrPct: v(f.atrPct),
    er: v(f.er),
    slopeT: v(f.slopeT),
    z: v(f.z),
    body: v(f.body),
    rangeAtr: v(f.rangeAtr),
    clv: v(f.clv),
    upWick: v(f.upWick),
    loWick: v(f.loWick),
    streak: f.streak[i] ?? null,
    volCluster: v(f.volCluster),
    session: f.session[i] ?? null,
    htf1hSlopeT: v(f.htf1hSlopeT),
    htf4hSlopeT: v(f.htf4hSlopeT),
  };
}
