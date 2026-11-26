// Shared test helpers: temporary QuantForge homes, a seeded synthetic XAUUSD market (optionally with a planted
// edge so that discovery has something real to find), a replay provider and a controllable clock.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type QfPaths, resolveQfPaths } from "../src/quantforge/config/load.js";
import { DEFAULT_CONFIG, type QuantForgeConfig } from "../src/quantforge/config/schema.js";
import { seededRandom } from "../src/quantforge/core/stats.js";
import { isMarketOpenAt } from "../src/quantforge/core/time.js";
import { type Candle, TF_MS, type Timeframe } from "../src/quantforge/core/types.js";
import type { RawBar } from "../src/quantforge/data/normalize.js";
import type {
  BarsRequest,
  CallMeta,
  MarketDataProvider,
  ProviderQuote,
} from "../src/quantforge/data/providers/types.js";
import { ProviderError } from "../src/quantforge/data/providers/types.js";
import { resample } from "../src/quantforge/data/resample.js";

export function tempHome(): { paths: QfPaths; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qf-test-"));
  const paths = resolveQfPaths({ QF_HOME: dir } as NodeJS.ProcessEnv);
  return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(patch: (c: QuantForgeConfig) => void = () => {}): QuantForgeConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.data.providers = [
    { id: "twelvedata", enabled: true, priority: 1, symbol: "XAU/USD", basis: "spot", useForTrading: true },
  ];
  c.data.macroSymbols = [];
  c.scheduler.enabled = true;
  c.data.closeLagMs = 0;
  patch(c);
  return c;
}

/** Monday 2026-01-05 00:00 UTC. */
export const T0 = Date.UTC(2026, 0, 5, 0, 0);

/**
 * Synthetic 5-minute XAUUSD bars over `days`, only inside market hours. Random walk with volatility
 * clustering; with `edge`, a 15-minute displacement is followed by continuation drift in the next 15 minutes
 * with probability `edge` (a planted, learnable effect).
 */
export function syntheticMarket(opts: {
  days: number;
  seed?: number;
  start?: number;
  edge?: number;
  price?: number;
}): Candle[] {
  const rnd = seededRandom(opts.seed ?? 42);
  const normal = () => {
    const u = Math.max(1e-12, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const start = opts.start ?? T0;
  const out: Candle[] = [];
  let price = opts.price ?? 2650;
  let vol = 0.0006;
  let pending = 0; // continuation drift to apply in the coming 15-minute block
  let blockMove = 0;
  for (let t = start; t < start + opts.days * 86_400_000; t += TF_MS["5m"]) {
    if (!isMarketOpenAt(t)) continue;
    const pos = Math.floor(t / TF_MS["5m"]) % 3; // position inside the 15m block
    if (pos === 0) {
      // Start of a 15m block: decide on drift from the previous block's displacement.
      if (opts.edge !== undefined && Math.abs(blockMove) > 2.2 * vol * price * Math.sqrt(3)) {
        pending = (rnd() < opts.edge ? 1 : -1) * Math.sign(blockMove) * 0.9 * vol * price;
      } else pending = 0;
      blockMove = 0;
    }
    vol = Math.min(0.002, Math.max(0.0003, vol * (0.97 + 0.06 * rnd()) + (rnd() < 0.01 ? 0.0004 : 0)));
    const open = price;
    const step = normal() * vol * price + pending;
    const close = Math.max(100, open + step);
    const wick = Math.abs(normal()) * vol * price * 0.6;
    const high = Math.max(open, close) + wick * rnd();
    const low = Math.min(open, close) - wick * rnd();
    out.push({ ts: t, open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume: null });
    blockMove += close - open;
    price = close;
  }
  return out;
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** A controllable clock. */
export class Clock {
  constructor(public t: number) {}
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function fmt(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Replays a synthetic market as a provider would: only bars that started before "now" (the last one possibly
 * still forming, as real providers do), paging by end date, a latest price, and switchable outages.
 */
export class ReplayProvider implements MarketDataProvider {
  readonly id: string;
  readonly capabilities = {
    timeframes: ["5m", "15m", "1h"] as const,
    maxBarsPerRequest: 5000,
    pagination: true,
    quotes: true,
    bidAsk: false,
    websocket: false,
    volume: false,
  };
  private readonly series: Partial<Record<Timeframe, Candle[]>> = {};
  down = false;
  calls = 0;

  constructor(
    base5m: Candle[],
    private readonly clock: Clock,
    id = "replay",
  ) {
    this.id = id;
    this.series["5m"] = base5m;
    this.series["15m"] = resample(base5m, "5m", "15m", { requireComplete: false });
    this.series["1h"] = resample(base5m, "5m", "1h", { requireComplete: false });
  }

  mapSymbol(canonical: string): string | undefined {
    return canonical === "XAUUSD" ? "XAU/USD" : undefined;
  }

  /** Index of the first bar starting after `t` (binary search). */
  private upper(bars: Candle[], t: number): number {
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((bars[mid] as Candle).ts <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private visible(tf: Timeframe, limit: number, end?: number): Candle[] {
    const now = this.clock.now();
    const all = this.series[tf] ?? [];
    const stop = this.upper(all, Math.min(now, end ?? Number.POSITIVE_INFINITY));
    const out = all.slice(Math.max(0, stop - limit), stop);
    const last = out[out.length - 1];
    if (last && last.ts + TF_MS[tf] > now) {
      // The newest bar is still forming: show only what has happened so far, as real providers do.
      const base = this.series["5m"] ?? [];
      const parts = base.slice(this.upper(base, last.ts - 1), this.upper(base, now - TF_MS["5m"]));
      if (parts.length)
        out[out.length - 1] = {
          ts: last.ts,
          open: last.open,
          high: Math.max(...parts.map((p) => p.high)),
          low: Math.min(...parts.map((p) => p.low)),
          close: (parts[parts.length - 1] as Candle).close,
          volume: null,
        };
      else out.pop();
    }
    return out;
  }

  async fetchBars(req: BarsRequest): Promise<{ bars: RawBar[]; meta: CallMeta }> {
    this.calls++;
    if (this.down) throw new ProviderError("replay: network unreachable", "network", true);
    const bars = this.visible(req.tf, req.limit, req.end);
    return {
      bars: bars.map((b) => ({
        datetime: fmt(b.ts),
        open: String(b.open),
        high: String(b.high),
        low: String(b.low),
        close: String(b.close),
      })),
      meta: { credits: 0, latencyMs: 1, endpoint: "bars" },
    };
  }

  async fetchQuote(): Promise<{ quote: ProviderQuote; meta: CallMeta }> {
    this.calls++;
    if (this.down) throw new ProviderError("replay: network unreachable", "network", true);
    const last = this.visible("5m", 3).at(-1);
    if (!last) throw new ProviderError("replay: no data", "no_data", false);
    return {
      quote: { price: last.close, ts: this.clock.now() },
      meta: { credits: 0, latencyMs: 1, endpoint: "quote" },
    };
  }
}
