// Yahoo Finance chart adapter through the yahoo-finance2 library the original project already uses.
// Yahoo does not serve spot XAUUSD; its gold series is COMEX gold futures (GC=F), which trades at a basis to
// spot and on different hours. It is therefore configured as basis "futures_proxy" and must not feed
// trading decisions; it serves as a cross-check and display fallback only. Intraday history is limited
// (about 60 days for 5m/15m, 730 days for 1h).

import YahooFinance from "yahoo-finance2";
import type { Timeframe } from "../../core/types.js";
import type { RawBar } from "../normalize.js";
import {
  type BarsRequest,
  type CallMeta,
  type MarketDataProvider,
  ProviderError,
  type ProviderQuote,
} from "./types.js";

type YahooChartClient = {
  chart(
    symbol: string,
    options: { period1: Date; period2?: Date; interval: string },
  ): Promise<{
    quotes: {
      date: Date;
      open: number | null;
      high: number | null;
      low: number | null;
      close: number | null;
      volume: number | null;
    }[];
  }>;
  quote(
    symbol: string,
  ): Promise<{ regularMarketPrice?: number; bid?: number; ask?: number; regularMarketTime?: Date }>;
};

const INTERVAL: Partial<Record<Timeframe, string>> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "60m",
  "1d": "1d",
};
const HISTORY: Partial<Record<Timeframe, number>> = { "1m": 7, "5m": 59, "15m": 59, "1h": 729, "1d": 10_000 };

export class YahooProvider implements MarketDataProvider {
  readonly id = "yahoo";
  readonly capabilities = {
    timeframes: ["1m", "5m", "15m", "1h", "1d"] as const,
    maxBarsPerRequest: 20_000,
    pagination: false,
    quotes: true,
    bidAsk: true,
    websocket: false,
    volume: true,
    historyDays: HISTORY,
  };
  private readonly client: YahooChartClient;

  constructor(client?: YahooChartClient) {
    const silent = { info() {}, warn() {}, error() {}, debug() {}, dir() {} };
    this.client =
      client ??
      (new YahooFinance({
        suppressNotices: ["yahooSurvey", "ripHistorical"],
        logger: silent,
      } as never) as unknown as YahooChartClient);
  }

  mapSymbol(canonical: string): string | undefined {
    const map: Record<string, string> = { XAUUSD: "GC=F", XAGUSD: "SI=F", EURUSD: "EURUSD=X" };
    return map[canonical.replace("/", "").toUpperCase()];
  }

  async fetchBars(req: BarsRequest): Promise<{ bars: RawBar[]; meta: CallMeta }> {
    const interval = INTERVAL[req.tf];
    if (!interval) throw new ProviderError(`yahoo has no ${req.tf} interval`, "not_supported", false);
    const days = HISTORY[req.tf] ?? 30;
    const end = req.end ?? Date.now();
    const start = Math.max(req.start ?? 0, end - days * 86_400_000);
    const started = performance.now();
    let answer: Awaited<ReturnType<YahooChartClient["chart"]>>;
    try {
      answer = await this.client.chart(req.symbol, {
        period1: new Date(start),
        period2: new Date(end),
        interval,
      });
    } catch (error) {
      const msg = (error as Error).message ?? String(error);
      const rate = /429|too many/i.test(msg);
      throw new ProviderError(`yahoo: ${msg}`, rate ? "rate_limit" : "network", true);
    }
    const bars: RawBar[] = answer.quotes
      .filter((q) => q.open !== null && q.high !== null && q.low !== null && q.close !== null)
      .map((q) => ({
        datetime: q.date.getTime(),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
      }));
    return {
      bars: bars.slice(-req.limit),
      meta: { credits: 0, latencyMs: performance.now() - started, endpoint: "chart" },
    };
  }

  async fetchQuote(symbol: string): Promise<{ quote: ProviderQuote; meta: CallMeta }> {
    const started = performance.now();
    const q = await this.client.quote(symbol);
    if (!q.regularMarketPrice) throw new ProviderError("yahoo: no price", "no_data", false);
    return {
      quote: {
        price: q.regularMarketPrice,
        bid: q.bid || undefined,
        ask: q.ask || undefined,
        ts: q.regularMarketTime?.getTime() ?? Date.now(),
      },
      meta: { credits: 0, latencyMs: performance.now() - started, endpoint: "quote" },
    };
  }
}
