// Market data service: incremental sync of closed candles, paged historical backfill, quotes with bid/ask,
// and the data-quality view the decision engine gates on.

import type { QuantForgeConfig } from "../config/schema.js";
import type { SourceLogger } from "../core/logger.js";
import { minutesToClose, sessionOf } from "../core/time.js";
import { type Quote, type StoredCandle, TF_MS, type Timeframe } from "../core/types.js";
import type { CandleRepo } from "../database/repositories.js";
import type { Priority } from "./budget.js";
import { flagStaleQuotes, normalizeBars, qualityReport } from "./normalize.js";
import { resample } from "./resample.js";
import type { ProviderRouter } from "./router.js";

export const CANONICAL = "XAUUSD";

export type SyncResult = {
  tf: Timeframe;
  provider: string;
  received: number;
  inserted: number;
  updated: number;
  issues: number;
  lastTs: number | null;
};

export class MarketDataService {
  private lastQuote: Quote | undefined;

  constructor(
    private readonly router: ProviderRouter,
    private readonly candles: CandleRepo,
    private readonly config: QuantForgeConfig,
    private readonly log: SourceLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Fetch bars newer than what is stored (plus a short overlap to pick up late revisions). */
  async sync(
    tf: Timeframe,
    opts: { priority?: Priority; symbol?: string; signal?: AbortSignal } = {},
  ): Promise<SyncResult> {
    const symbol = opts.symbol ?? CANONICAL;
    const last = this.candles.last(symbol, tf);
    const len = TF_MS[tf];
    const now = this.now();
    const behind = last ? Math.ceil((now - last.ts) / len) + 3 : 500;
    const limit = Math.min(5000, Math.max(4, behind));
    const { bars, provider } = await this.router.bars(
      symbol,
      tf,
      { limit },
      { priority: opts.priority ?? "high", forTrading: symbol === CANONICAL, signal: opts.signal },
    );
    return this.store(symbol, tf, provider.id, bars, now);
  }

  private store(
    symbol: string,
    tf: Timeframe,
    provider: string,
    bars: Parameters<typeof normalizeBars>[0],
    now: number,
  ): SyncResult {
    const { candles, issues } = normalizeBars(bars, {
      symbol,
      tf,
      provider,
      now,
      closeLagMs: this.config.data.closeLagMs,
    });
    const serious = issues.filter((i) => i.kind !== "unclosed" && i.kind !== "duplicate");
    if (serious.length)
      this.log.warn(
        `${provider} ${symbol} ${tf}: ${serious.length} bars rejected during normalization`,
        serious.slice(0, 5),
      );
    // Stale-quote detection needs context: look at recent stored bars together with the new ones.
    const context = this.candles.latest(symbol, tf, 300).filter((c) => !candles.some((n) => n.ts === c.ts));
    const merged = flagStaleQuotes([...context, ...candles].sort((a, b) => a.ts - b.ts));
    const fresh = merged.filter((c) => candles.some((n) => n.ts === c.ts));
    const { inserted, updated } = this.candles.upsert(fresh);
    return {
      tf,
      provider,
      received: bars.length,
      inserted,
      updated,
      issues: serious.length,
      lastTs: candles.at(-1)?.ts ?? null,
    };
  }

  /** Page back until `days` of history are stored for `tf` (or the provider has no more). */
  async backfill(
    tf: Timeframe,
    days: number,
    opts: { symbol?: string; signal?: AbortSignal; onProgress?: (msg: string) => void } = {},
  ): Promise<{ pages: number; inserted: number; from: number | null }> {
    const symbol = opts.symbol ?? CANONICAL;
    const target = this.now() - days * 86_400_000;
    let pages = 0;
    let inserted = 0;
    // First the recent end.
    const first = await this.sync(tf, {
      priority: "low",
      symbol,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    inserted += first.inserted;
    pages++;
    for (let guard = 0; guard < 200; guard++) {
      if (opts.signal?.aborted) break;
      const earliest = this.candles.first(symbol, tf);
      if (!earliest || earliest.ts <= target) break;
      const end = earliest.ts - TF_MS[tf];
      const { bars, provider } = await this.router.bars(
        symbol,
        tf,
        { limit: 5000, end },
        { priority: "low", forTrading: symbol === CANONICAL, signal: opts.signal },
      );
      pages++;
      const r = this.store(symbol, tf, provider.id, bars, this.now());
      inserted += r.inserted;
      opts.onProgress?.(
        `${symbol} ${tf}: page ${pages}, +${r.inserted} bars, back to ${new Date(this.candles.first(symbol, tf)?.ts ?? 0).toISOString()}`,
      );
      if (r.inserted === 0) break; // provider has nothing older
    }
    return { pages, inserted, from: this.candles.first(symbol, tf)?.ts ?? null };
  }

  /** Stored candles of a native timeframe, or 1h/4h aggregated exactly from stored 15m bars. */
  series(tf: Timeframe, limit: number, symbol = CANONICAL): StoredCandle[] {
    return this.candles.latest(symbol, tf, limit);
  }

  /** Higher-timeframe candles built from the decision timeframe (complete bars only). */
  derived(from: Timeframe, to: Timeframe, limit: number, symbol = CANONICAL): StoredCandle[] {
    const ratio = TF_MS[to] / TF_MS[from];
    const base = this.candles
      .latest(symbol, from, Math.ceil(limit * ratio) + ratio * 2)
      .filter((c) => c.marketOpen && c.quality !== "stale_quote");
    return resample(base, from, to, { now: this.now() })
      .slice(-limit)
      .map((c) => ({ ...c, symbol, tf: to, provider: "derived", marketOpen: true, quality: "ok" as const }));
  }

  /** Latest price with bid/ask. Twelve Data publishes no bid/ask for XAU/USD, so they are modelled. */
  async quote(opts: { priority?: Priority; signal?: AbortSignal } = {}): Promise<Quote> {
    const { quote, provider } = await this.router.quote(CANONICAL, {
      priority: opts.priority ?? "high",
      forTrading: true,
      signal: opts.signal,
    });
    const spread =
      quote.bid !== undefined && quote.ask !== undefined && quote.ask > quote.bid
        ? quote.ask - quote.bid
        : this.modelledSpread(quote.ts);
    const fromProvider = quote.bid !== undefined && quote.ask !== undefined && quote.ask > quote.bid;
    const q: Quote = {
      symbol: CANONICAL,
      price: quote.price,
      bid: fromProvider ? (quote.bid as number) : quote.price - spread / 2,
      ask: fromProvider ? (quote.ask as number) : quote.price + spread / 2,
      spread,
      spreadSource: fromProvider ? "provider" : "modelled",
      ts: quote.ts,
      provider: provider.id,
    };
    this.lastQuote = q;
    return q;
  }

  /** The quote implied by the latest stored monitor bar, when a fresh price call is not worth a credit. */
  quoteFromBar(bar: StoredCandle): Quote {
    const spread = this.modelledSpread(bar.ts + TF_MS[bar.tf]);
    return {
      symbol: CANONICAL,
      price: bar.close,
      bid: bar.close - spread / 2,
      ask: bar.close + spread / 2,
      spread,
      spreadSource: "modelled",
      ts: bar.ts + TF_MS[bar.tf],
      provider: bar.provider,
    };
  }

  /**
   * Modelled spread: the configured typical spread, widened in the thin Asian session (×1.3) and in the 30
   * minutes before a market close (×2), when dealer spreads on gold are known to widen.
   */
  modelledSpread(ts: number): number {
    let s = this.config.costs.spread;
    if (sessionOf(ts) === "asia") s *= 1.3;
    const toClose = minutesToClose(ts);
    if (toClose > 0 && toClose <= 30) s *= 2;
    return Math.round(s * 100) / 100;
  }

  /** A price pushed by a streaming connection (bid/ask modelled unless the stream publishes them). */
  pushStreamQuote(price: number, ts: number, provider: string, bid?: number, ask?: number): Quote {
    const fromProvider = bid !== undefined && ask !== undefined && ask > bid;
    const spread = fromProvider ? (ask as number) - (bid as number) : this.modelledSpread(ts);
    const q: Quote = {
      symbol: CANONICAL,
      price,
      bid: fromProvider ? (bid as number) : price - spread / 2,
      ask: fromProvider ? (ask as number) : price + spread / 2,
      spread,
      spreadSource: fromProvider ? "provider" : "modelled",
      ts,
      provider: `${provider}:ws`,
    };
    this.lastQuote = q;
    return q;
  }

  latestQuote(): Quote | undefined {
    return this.lastQuote;
  }

  quality(tf: Timeframe, bars = 200) {
    return qualityReport(
      this.candles.latest(CANONICAL, tf, bars),
      tf,
      this.now(),
      this.config.data.staleAfterBars,
    );
  }
}
