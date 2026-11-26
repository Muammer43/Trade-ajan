// Twelve Data adapter (https://twelvedata.com/docs). Verified endpoints: /time_series, /price, /api_usage,
// and the price WebSocket (wss://ws.twelvedata.com/v1/quotes/price). Spot gold is "XAU/USD"; Twelve Data
// publishes no bid/ask or volume for it, so spreads are modelled from configuration downstream.
// Each REST call costs one API credit on the basic plan.

import type { Timeframe } from "../../core/types.js";
import type { RawBar } from "../normalize.js";
import { formatTwelveDate } from "./format.js";
import {
  type BarsRequest,
  type CallMeta,
  type MarketDataProvider,
  ProviderError,
  type ProviderQuote,
} from "./types.js";

const INTERVAL: Partial<Record<Timeframe, string>> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "1h": "1h",
  "4h": "4h",
  "1d": "1day",
};

const SYMBOLS: Record<string, string> = {
  XAUUSD: "XAU/USD",
  XAGUSD: "XAG/USD",
  EURUSD: "EUR/USD",
  USDJPY: "USD/JPY",
};

export type TwelveDataOptions = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
};

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = "twelvedata";
  readonly capabilities = {
    timeframes: ["1m", "5m", "15m", "1h", "4h", "1d"] as const,
    maxBarsPerRequest: 5000,
    pagination: true,
    quotes: true,
    bidAsk: false,
    websocket: true,
    volume: false,
  };
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly opts: TwelveDataOptions = {}) {
    this.base = (opts.baseUrl ?? "https://api.twelvedata.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  mapSymbol(canonical: string): string | undefined {
    const key = canonical.replace("/", "").toUpperCase();
    return SYMBOLS[key] ?? (canonical.includes("/") ? canonical : undefined);
  }

  private async call(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ body: Record<string, unknown>; meta: CallMeta }> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json" };
    // Sent as a header so the key never appears in a URL that might be logged.
    if (this.opts.apiKey) headers.authorization = `apikey ${this.opts.apiKey}`;
    const started = performance.now();
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: combined });
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError" || timeout.aborted;
      throw new ProviderError(
        `twelvedata ${path}: ${timedOut ? "request timed out" : (error as Error).message}`,
        timedOut ? "timeout" : "network",
        true,
      );
    }
    const latencyMs = performance.now() - started;
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderError(
        `twelvedata ${path}: HTTP ${res.status} with a non-JSON body`,
        res.status >= 500 ? "server" : "bad_request",
        res.status >= 500,
        res.status,
      );
    }
    const code = typeof body.code === "number" ? body.code : res.ok ? 200 : res.status;
    if (body.status === "error" || code >= 400) {
      const message = String(body.message ?? `HTTP ${code}`);
      if (code === 401 || code === 403)
        throw new ProviderError(`twelvedata: authentication failed (${message})`, "auth", false, code);
      if (code === 429)
        throw new ProviderError(`twelvedata: rate limit (${message})`, "rate_limit", true, code);
      if (code === 404 || /no data/i.test(message))
        throw new ProviderError(`twelvedata: ${message}`, "no_data", false, code);
      if (code >= 500)
        throw new ProviderError(`twelvedata: server error ${code} (${message})`, "server", true, code);
      throw new ProviderError(`twelvedata: ${message}`, "bad_request", false, code);
    }
    return { body, meta: { credits: 1, latencyMs, endpoint: path, statusCode: res.status } };
  }

  async fetchBars(req: BarsRequest): Promise<{ bars: RawBar[]; meta: CallMeta }> {
    const interval = INTERVAL[req.tf];
    if (!interval) throw new ProviderError(`twelvedata has no ${req.tf} interval`, "not_supported", false);
    const params: Record<string, string> = {
      symbol: req.symbol,
      interval,
      outputsize: String(Math.max(1, Math.min(req.limit, this.capabilities.maxBarsPerRequest))),
      timezone: "UTC",
      order: "asc",
    };
    if (req.end !== undefined) params.end_date = formatTwelveDate(req.end);
    if (req.start !== undefined) params.start_date = formatTwelveDate(req.start);
    const { body, meta } = await this.call("/time_series", params, req.signal);
    const values = body.values;
    if (!Array.isArray(values))
      throw new ProviderError("twelvedata: time_series without values", "no_data", false);
    const meta2 = body.meta as { exchange_timezone?: string } | undefined;
    if (meta2?.exchange_timezone && meta2.exchange_timezone !== "UTC") {
      // We always request UTC; anything else would shift every bar.
      throw new ProviderError(
        `twelvedata answered in ${meta2.exchange_timezone}, not UTC`,
        "bad_request",
        false,
      );
    }
    return { bars: values as RawBar[], meta };
  }

  async fetchQuote(symbol: string, signal?: AbortSignal): Promise<{ quote: ProviderQuote; meta: CallMeta }> {
    const { body, meta } = await this.call("/price", { symbol }, signal);
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0)
      throw new ProviderError("twelvedata: /price returned no usable price", "no_data", false);
    return { quote: { price, ts: Date.now() }, meta };
  }

  /** Usage on the account (does not cost a credit). */
  async usage(signal?: AbortSignal): Promise<{
    currentUsage: number;
    planLimit: number;
    dailyUsage: number;
    planDailyLimit: number;
    plan: string;
  }> {
    const { body } = await this.call("/api_usage", {}, signal);
    return {
      currentUsage: Number(body.current_usage ?? 0),
      planLimit: Number(body.plan_limit ?? 0),
      dailyUsage: Number(body.daily_usage ?? 0),
      planDailyLimit: Number(body.plan_daily_limit ?? 0),
      plan: String(body.plan_category ?? "unknown"),
    };
  }

  /**
   * Open the price stream. Twelve Data's WebSocket requires a plan that includes it; on failure the caller
   * falls back to REST polling. Returns a close function.
   */
  stream(
    symbol: string,
    onPrice: (q: ProviderQuote) => void,
    onState: (state: "open" | "closed" | "error", detail?: string) => void,
  ): () => void {
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      onState("error", "this Node.js has no WebSocket client");
      return () => {};
    }
    if (!this.opts.apiKey) {
      onState("error", "the WebSocket needs an API key in the URL; none configured");
      return () => {};
    }
    const ws = new WS(
      `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(this.opts.apiKey)}`,
    );
    let heartbeat: NodeJS.Timeout | undefined;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ action: "subscribe", params: { symbols: symbol } }));
      heartbeat = setInterval(
        () => ws.readyState === 1 && ws.send(JSON.stringify({ action: "heartbeat" })),
        10_000,
      );
      onState("open");
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          event?: string;
          price?: number;
          timestamp?: number;
          bid?: number;
          ask?: number;
          status?: string;
          messages?: unknown;
        };
        if (msg.event === "price" && typeof msg.price === "number") {
          onPrice({
            price: msg.price,
            bid: msg.bid,
            ask: msg.ask,
            ts: (msg.timestamp ?? Date.now() / 1000) * 1000,
          });
        } else if (msg.event === "subscribe-status" && msg.status !== "ok") {
          onState("error", `subscription refused: ${JSON.stringify(msg.messages ?? msg)}`);
        }
      } catch {
        // Ignore malformed frames.
      }
    });
    ws.addEventListener("error", () => onState("error", "websocket error"));
    ws.addEventListener("close", () => {
      clearInterval(heartbeat);
      onState("closed");
    });
    return () => {
      clearInterval(heartbeat);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    };
  }
}
