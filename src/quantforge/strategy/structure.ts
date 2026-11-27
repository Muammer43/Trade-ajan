// Market structure for the trading strategy, computed causally over closed 15-minute candles: indicators
// (EMA, RSI, MACD from the original TradingAgents compute module), confirmed swing points, support/resistance
// zones from clustered swings, 15-minute structure trend and the 1-hour trend. Every query at index i uses
// only candles 0..i, and a swing point is only known once the candles that confirm it have closed.

import { indicatorsOf } from "../../compute/indicators.js";
import { type Candle, TF_MS } from "../core/types.js";
import { resample } from "../data/resample.js";
import { computeFeatures, type FeatureSet } from "../intelligence/features.js";

/** Candles on each side that confirm a swing point. */
export const PIVOT_K = 2;

export type Swing = { idx: number; price: number; kind: "high" | "low" };
export type Zone = { low: number; high: number; mid: number; touches: number; lastIdx: number };
export type HtfTrend = { dir: "up" | "down" | "flat"; strength: number; detail: string };

function column(values: (number | null)[] | undefined, n: number): Float64Array {
  return new Float64Array(n).map((_, i) => values?.[i] ?? Number.NaN);
}

export class TradingFrame {
  readonly f: FeatureSet;
  readonly n: number;
  readonly ema20: Float64Array;
  readonly ema50: Float64Array;
  readonly rsi: Float64Array;
  readonly macdHist: Float64Array;
  readonly volume: (number | null)[];
  private readonly swingHigh: Uint8Array;
  private readonly swingLow: Uint8Array;
  private readonly h1: {
    ts: number[];
    close: Float64Array;
    ema50: Float64Array;
    atr: Float64Array;
    adx: Float64Array;
  };
  private readonly h1Index: Int32Array;

  constructor(readonly candles: readonly Candle[]) {
    this.n = candles.length;
    this.f = computeFeatures(candles, "15m");
    const bars = {
      dates: candles.map((c) => new Date(c.ts).toISOString()),
      highs: candles.map((c) => c.high),
      lows: candles.map((c) => c.low),
      closes: candles.map((c) => c.close),
    };
    const { columns } =
      this.n > 60
        ? indicatorsOf(
            bars,
            [
              { name: "ema", periods: [20] },
              { name: "ema", periods: [50] },
              { name: "rsi", periods: [14] },
              { name: "macd", periods: [12, 26, 9] },
            ],
            0,
          )
        : { columns: {} as Record<string, (number | null)[]> };
    this.ema20 = column(columns.ema_20, this.n);
    this.ema50 = column(columns.ema_50, this.n);
    this.rsi = column(columns.rsi_14, this.n);
    this.macdHist = column(columns.macd_histogram_12_26_9, this.n);
    this.volume = candles.map((c) => c.volume);

    this.swingHigh = new Uint8Array(this.n);
    this.swingLow = new Uint8Array(this.n);
    for (let j = PIVOT_K; j < this.n - PIVOT_K; j++) {
      let hi = true;
      let lo = true;
      for (let d = 1; d <= PIVOT_K; d++) {
        if (!(this.high(j) > this.high(j - d) && this.high(j) >= this.high(j + d))) hi = false;
        if (!(this.low(j) < this.low(j - d) && this.low(j) <= this.low(j + d))) lo = false;
      }
      if (hi) this.swingHigh[j] = 1;
      if (lo) this.swingLow[j] = 1;
    }

    // 1-hour context from the same candles (complete hours only), joined causally.
    const hours = resample(candles, "15m", "1h", { requireComplete: false });
    const hf = hours.length > 60 ? computeFeatures(hours, "1h") : null;
    const hcols =
      hours.length > 60
        ? indicatorsOf(
            {
              dates: hours.map((h) => new Date(h.ts).toISOString()),
              highs: hours.map((h) => h.high),
              lows: hours.map((h) => h.low),
              closes: hours.map((h) => h.close),
            },
            [{ name: "ema", periods: [50] }],
            0,
          ).columns
        : {};
    this.h1 = {
      ts: hours.map((h) => h.ts),
      close: new Float64Array(hours.map((h) => h.close)),
      ema50: column(hcols.ema_50, hours.length),
      atr: hf ? hf.atr : new Float64Array(hours.length).fill(Number.NaN),
      adx: hf ? hf.adx : new Float64Array(hours.length).fill(Number.NaN),
    };
    this.h1Index = new Int32Array(this.n).fill(-1);
    let j = -1;
    for (let i = 0; i < this.n; i++) {
      const closeTime = (this.f.ts[i] as number) + TF_MS["15m"];
      while (j + 1 < hours.length && (this.h1.ts[j + 1] as number) + TF_MS["1h"] <= closeTime) j++;
      this.h1Index[i] = j;
    }
  }

  open(i: number): number {
    return this.f.open[i] as number;
  }
  high(i: number): number {
    return this.f.high[i] as number;
  }
  low(i: number): number {
    return this.f.low[i] as number;
  }
  close(i: number): number {
    return this.f.close[i] as number;
  }
  atr(i: number): number {
    return this.f.atr[i] as number;
  }
  ts(i: number): number {
    return this.f.ts[i] as number;
  }

  /** Swing points confirmed by candle i (their confirming candles have closed), newest last. */
  swings(i: number, lookback: number): Swing[] {
    const out: Swing[] = [];
    for (let j = Math.max(PIVOT_K, i - lookback); j <= i - PIVOT_K; j++) {
      if (this.swingHigh[j]) out.push({ idx: j, price: this.high(j), kind: "high" });
      if (this.swingLow[j]) out.push({ idx: j, price: this.low(j), kind: "low" });
    }
    return out;
  }

  /**
   * Support/resistance zones at candle i: confirmed swing points of the last `lookback` candles whose prices lie
   * within `tolAtr` × ATR of each other are one zone; a zone needs at least two touches.
   */
  zones(i: number, lookback = 300, tolAtr = 0.3): Zone[] {
    const atr = this.atr(i);
    if (!(atr > 0)) return [];
    const pts = this.swings(i, lookback).sort((a, b) => a.price - b.price);
    const zones: Zone[] = [];
    let cur: Swing[] = [];
    const flush = () => {
      if (cur.length >= 2) {
        const low = Math.min(...cur.map((p) => p.price));
        const high = Math.max(...cur.map((p) => p.price));
        const pad = Math.max(0, (0.2 * atr - (high - low)) / 2);
        zones.push({
          low: low - pad,
          high: high + pad,
          mid: (low + high) / 2,
          touches: cur.length,
          lastIdx: Math.max(...cur.map((p) => p.idx)),
        });
      }
    };
    for (const p of pts) {
      if (cur.length && p.price - (cur[0] as Swing).price > tolAtr * atr) {
        flush();
        cur = [];
      }
      cur.push(p);
    }
    flush();
    return zones;
  }

  /** 15-minute structure from the last two confirmed swing highs and lows. */
  structure(i: number): { dir: "up" | "down" | "mixed"; detail: string } {
    const sw = this.swings(i, 120);
    const highs = sw.filter((s) => s.kind === "high").slice(-2);
    const lows = sw.filter((s) => s.kind === "low").slice(-2);
    if (highs.length < 2 || lows.length < 2) return { dir: "mixed", detail: "not enough swing points" };
    const hh = (highs[1] as Swing).price > (highs[0] as Swing).price;
    const hl = (lows[1] as Swing).price > (lows[0] as Swing).price;
    if (hh && hl) return { dir: "up", detail: "higher high and higher low" };
    if (!hh && !hl) return { dir: "down", detail: "lower high and lower low" };
    return { dir: "mixed", detail: hh ? "higher high, lower low" : "lower high, higher low" };
  }

  /**
   * 1-hour trend: close relative to the 1h EMA(50), the EMA's slope over 5 hours in 1h-ATR units, and ADX.
   * Up/down needs the close on that side of the EMA and a slope of at least 0.15 ATR over 5 hours.
   */
  htfTrend(i: number): HtfTrend {
    const j = this.h1Index[i] as number;
    if (j < 5) return { dir: "flat", strength: 0, detail: "not enough 1h history" };
    const e = this.h1.ema50[j] as number;
    const e5 = this.h1.ema50[j - 5] as number;
    const a = this.h1.atr[j] as number;
    const c = this.h1.close[j] as number;
    if (![e, e5, a, c].every(Number.isFinite) || a <= 0)
      return { dir: "flat", strength: 0, detail: "1h indicators warming up" };
    const slope = (e - e5) / a;
    const adx = this.h1.adx[j] as number;
    const strength =
      Math.min(1, Math.abs(slope) / 0.6) * (Number.isFinite(adx) ? Math.min(1, adx / 30) : 0.5);
    const detail = `1h close ${c.toFixed(2)} vs EMA50 ${e.toFixed(2)}, EMA slope ${slope.toFixed(2)} ATR/5h, ADX ${Number.isFinite(adx) ? adx.toFixed(1) : "n/a"}`;
    if (c > e && slope >= 0.15) return { dir: "up", strength, detail };
    if (c < e && slope <= -0.15) return { dir: "down", strength, detail };
    return { dir: "flat", strength: 0, detail };
  }
}
