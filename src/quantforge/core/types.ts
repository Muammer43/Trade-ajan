// QuantForge AI — shared domain types.
// Every price is in quote currency (USD) per troy ounce. Every timestamp is UTC epoch milliseconds,
// and a candle's `ts` is its OPEN time.

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TF_MS: Readonly<Record<Timeframe, number>> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (TIMEFRAMES as readonly string[]).includes(value);
}

/** One OHLC bar. `volume` is null when the provider publishes none (spot FX/metals usually do not). */
export type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

/** Quality flags a stored candle carries. */
export type CandleQuality = "ok" | "market_closed" | "stale_quote" | "suspect";

export type StoredCandle = Candle & {
  symbol: string;
  tf: Timeframe;
  provider: string;
  /** False for bars a provider publishes while the spot market is closed (weekend synthetic quotes). */
  marketOpen: boolean;
  quality: CandleQuality;
};

export type Quote = {
  symbol: string;
  /** Mid/last price the provider published. */
  price: number;
  /** Bid and ask: provider values when published, otherwise modelled from `price` and the configured spread. */
  bid: number;
  ask: number;
  spread: number;
  /** "provider" when bid/ask came from the feed, "modelled" when derived from configuration. */
  spreadSource: "provider" | "modelled";
  ts: number;
  provider: string;
};

export type Side = "long" | "short";
export type Action = "BUY" | "SELL" | "NO_TRADE";

export function sideSign(side: Side): 1 | -1 {
  return side === "long" ? 1 : -1;
}

export type TrendRegime = "strong_bull" | "strong_bear" | "weak_trend" | "range";
export type VolLevel = "high" | "normal" | "low";
export type VolDynamic = "expansion" | "contraction" | "stable";

export type Regime = {
  trend: TrendRegime;
  vol: VolLevel;
  volDynamic: VolDynamic;
  breakout: "up" | "down" | null;
  liquidityTrap: "bull_trap" | "bear_trap" | null;
  /** Numeric evidence the label came from. */
  scores: {
    slopeT: number;
    efficiency: number;
    adx: number | null;
    atrPercentile: number;
    volRatio: number;
  };
  label: string;
};

export type TradingMode = "paper" | "live";
