// Exact OHLC aggregation of lower-timeframe bars into higher ones. A higher bar is emitted only when it is
// complete: every lower bar inside it that falls in market hours is present, and the bar has closed.

import { floorTo, isBarInMarketHours, isClosed } from "../core/time.js";
import { type Candle, TF_MS, type Timeframe } from "../core/types.js";

export function resample(
  candles: readonly Candle[],
  from: Timeframe,
  to: Timeframe,
  opts: { now?: number; requireComplete?: boolean } = {},
): Candle[] {
  if (TF_MS[to] <= TF_MS[from]) throw new Error(`cannot resample ${from} into ${to}`);
  const out: Candle[] = [];
  const now = opts.now ?? Number.POSITIVE_INFINITY;
  const requireComplete = opts.requireComplete ?? true;
  let bucket: Candle | undefined;
  let bucketTs = Number.NaN;
  let count = 0;
  const flush = () => {
    if (!bucket) return;
    const expected = expectedInside(bucketTs, from, to);
    if (isClosed(bucketTs, to, now) && (!requireComplete || count >= expected)) out.push(bucket);
  };
  for (const c of candles) {
    const b = floorTo(c.ts, to);
    if (b !== bucketTs) {
      flush();
      bucketTs = b;
      bucket = { ts: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      count = 1;
    } else if (bucket) {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume = bucket.volume === null || c.volume === null ? null : bucket.volume + c.volume;
      count++;
    }
  }
  flush();
  return out;
}

/** Lower bars expected inside a higher bar, counting only those in market hours. */
function expectedInside(ts: number, from: Timeframe, to: Timeframe): number {
  let n = 0;
  for (let t = ts; t < ts + TF_MS[to]; t += TF_MS[from]) if (isBarInMarketHours(t, from)) n++;
  return n;
}
