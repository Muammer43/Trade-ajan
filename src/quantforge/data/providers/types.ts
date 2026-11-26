// The unified market-data provider interface. Each adapter declares its capabilities; callers check them
// instead of assuming that every provider serves the same symbols, timeframes or fields.

import type { Timeframe } from "../../core/types.js";
import type { RawBar } from "../normalize.js";

export type ProviderCapabilities = {
  timeframes: readonly Timeframe[];
  /** Most bars one request may return. */
  maxBarsPerRequest: number;
  /** Whether older history can be paged with an end date. */
  pagination: boolean;
  /** Latest price endpoint. */
  quotes: boolean;
  /** Whether the provider publishes bid/ask (else they are modelled). */
  bidAsk: boolean;
  websocket: boolean;
  volume: boolean;
  /** How far back intraday history goes, in days, per timeframe (undefined = not limited/known). */
  historyDays?: Partial<Record<Timeframe, number>>;
};

export type BarsRequest = {
  /** Provider-native symbol (already mapped). */
  symbol: string;
  tf: Timeframe;
  /** Most bars wanted (≤ maxBarsPerRequest). */
  limit: number;
  /** Inclusive end (UTC ms) for paging back; latest bars when omitted. */
  end?: number | undefined;
  start?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type ProviderQuote = { price: number; bid?: number | undefined; ask?: number | undefined; ts: number };

export type CallMeta = {
  credits: number;
  latencyMs: number;
  endpoint: string;
  statusCode?: number | undefined;
};

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  constructor(
    message: string,
    readonly kind:
      | "auth"
      | "rate_limit"
      | "not_supported"
      | "bad_request"
      | "network"
      | "server"
      | "no_data"
      | "timeout",
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export interface MarketDataProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  /** Map a canonical symbol (XAUUSD, EURUSD, XAGUSD) to this provider's, or undefined when not served. */
  mapSymbol(canonical: string): string | undefined;
  fetchBars(req: BarsRequest): Promise<{ bars: RawBar[]; meta: CallMeta }>;
  fetchQuote(symbol: string, signal?: AbortSignal): Promise<{ quote: ProviderQuote; meta: CallMeta }>;
}
