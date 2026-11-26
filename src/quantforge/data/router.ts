// Provider priority, fallback and health. Every call goes through the API budget, is retried with backoff
// when retryable, and is recorded in the health log. A provider that keeps failing is opened (skipped) for a
// cool-down; the next provider by priority that supports the request is used instead.

import type { ProviderConfig } from "../config/schema.js";
import type { SourceLogger } from "../core/logger.js";
import type { Timeframe } from "../core/types.js";
import { errorMessage, sleep } from "../core/util.js";
import type { HealthRepo } from "../database/repositories.js";
import type { ApiBudget, Priority } from "./budget.js";
import type { RawBar } from "./normalize.js";
import {
  type CallMeta,
  type MarketDataProvider,
  ProviderError,
  type ProviderQuote,
} from "./providers/types.js";

type Slot = {
  provider: MarketDataProvider;
  config: ProviderConfig;
  failures: number;
  openUntil: number;
  lastOk: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
};

export type ProviderHealth = {
  id: string;
  enabled: boolean;
  priority: number;
  basis: string;
  useForTrading: boolean;
  state: "healthy" | "degraded" | "open" | "disabled";
  failures: number;
  lastOk: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  capabilities: MarketDataProvider["capabilities"];
};

export class NoProviderError extends Error {
  override readonly name = "NoProviderError";
}

export class ProviderRouter {
  private readonly slots: Slot[];
  constructor(
    providers: { provider: MarketDataProvider; config: ProviderConfig }[],
    private readonly budget: ApiBudget,
    private readonly health: HealthRepo | undefined,
    private readonly log: SourceLogger,
    private readonly opts: {
      maxRetries?: number;
      openAfter?: number;
      openMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.slots = providers
      .map((p) => ({ ...p, failures: 0, openUntil: 0, lastOk: null, lastError: null, lastLatencyMs: null }))
      .sort((a, b) => a.config.priority - b.config.priority);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Providers able to serve `tf` for `canonical`, in priority order, skipping open circuits. */
  private candidates(canonical: string, tf: Timeframe | null, forTrading: boolean): Slot[] {
    return this.slots.filter(
      (s) =>
        s.config.enabled &&
        (!forTrading || s.config.useForTrading) &&
        s.openUntil <= this.now() &&
        s.provider.mapSymbol(canonical) !== undefined &&
        (tf === null ? s.provider.capabilities.quotes : s.provider.capabilities.timeframes.includes(tf)),
    );
  }

  private async attempt<T>(
    slot: Slot,
    label: string,
    priority: Priority,
    fn: () => Promise<{ value: T; meta: CallMeta }>,
  ): Promise<{ value: T; meta: CallMeta }> {
    const maxRetries = this.opts.maxRetries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const credits = slot.provider.id === "twelvedata" ? 1 : 0;
      if (credits > 0) {
        const wait = this.budget.waitFor(credits, priority);
        if (wait === Number.POSITIVE_INFINITY)
          throw new ProviderError(
            `${slot.provider.id}: daily API budget exhausted for ${priority} work`,
            "rate_limit",
            false,
          );
        if (wait > 0) {
          if (wait > 65_000)
            throw new ProviderError(`${slot.provider.id}: per-minute budget busy`, "rate_limit", true);
          await (this.opts.sleep ?? sleep)(wait);
        }
        this.budget.spend(credits);
      }
      const started = performance.now();
      try {
        const out = await fn();
        slot.failures = 0;
        slot.lastOk = this.now();
        slot.lastLatencyMs = out.meta.latencyMs;
        this.health?.record({
          provider: slot.provider.id,
          endpoint: label,
          ok: true,
          latencyMs: out.meta.latencyMs,
          statusCode: out.meta.statusCode,
          credits: out.meta.credits,
        });
        return out;
      } catch (error) {
        lastError = error;
        const pe =
          error instanceof ProviderError ? error : new ProviderError(errorMessage(error), "network", true);
        slot.lastError = pe.message;
        this.health?.record({
          provider: slot.provider.id,
          endpoint: label,
          ok: false,
          latencyMs: performance.now() - started,
          statusCode: pe.statusCode,
          credits,
          error: pe.message,
        });
        if (!pe.retryable || attempt === maxRetries) break;
        const backoff = pe.kind === "rate_limit" ? 15_000 : 1000 * 2 ** attempt;
        await (this.opts.sleep ?? sleep)(backoff);
      }
    }
    // Request-specific refusals (unsupported symbol or interval, plan restriction, no data) say nothing about
    // the provider's health; only transport, server, timeout, rate-limit and auth failures count.
    const kind = lastError instanceof ProviderError ? lastError.kind : "network";
    if (kind === "bad_request" || kind === "not_supported" || kind === "no_data") throw lastError;
    slot.failures++;
    if (slot.failures >= (this.opts.openAfter ?? 3)) {
      slot.openUntil = this.now() + (this.opts.openMs ?? 120_000);
      this.log.warn(`provider ${slot.provider.id} circuit opened after ${slot.failures} failures`, {
        lastError: slot.lastError,
      });
    }
    throw lastError;
  }

  /** Bars from the first healthy provider that can serve them; `forTrading` keeps proxies out. */
  async bars(
    canonical: string,
    tf: Timeframe,
    req: { limit: number; end?: number | undefined; start?: number | undefined },
    opts: { priority: Priority; forTrading: boolean; signal?: AbortSignal | undefined },
  ): Promise<{ bars: RawBar[]; provider: MarketDataProvider; config: ProviderConfig }> {
    const errors: string[] = [];
    for (const slot of this.candidates(canonical, tf, opts.forTrading)) {
      const symbol = slot.provider.mapSymbol(canonical) as string;
      try {
        const { value } = await this.attempt(slot, `bars:${tf}`, opts.priority, async () => {
          const r = await slot.provider.fetchBars({
            symbol,
            tf,
            limit: req.limit,
            end: req.end,
            start: req.start,
            signal: opts.signal,
          });
          return { value: r.bars, meta: r.meta };
        });
        return { bars: value, provider: slot.provider, config: slot.config };
      } catch (error) {
        errors.push(`${slot.provider.id}: ${errorMessage(error)}`);
      }
    }
    throw new NoProviderError(
      errors.length
        ? `no provider served ${canonical} ${tf}: ${errors.join("; ")}`
        : `no enabled provider serves ${canonical} ${tf}`,
    );
  }

  async quote(
    canonical: string,
    opts: { priority: Priority; forTrading: boolean; signal?: AbortSignal | undefined },
  ): Promise<{ quote: ProviderQuote; provider: MarketDataProvider }> {
    const errors: string[] = [];
    for (const slot of this.candidates(canonical, null, opts.forTrading)) {
      const symbol = slot.provider.mapSymbol(canonical) as string;
      try {
        const { value } = await this.attempt(slot, "quote", opts.priority, async () => {
          const r = await slot.provider.fetchQuote(symbol, opts.signal);
          return { value: r.quote, meta: r.meta };
        });
        return { quote: value, provider: slot.provider };
      } catch (error) {
        errors.push(`${slot.provider.id}: ${errorMessage(error)}`);
      }
    }
    throw new NoProviderError(
      errors.length
        ? `no provider quoted ${canonical}: ${errors.join("; ")}`
        : `no enabled provider quotes ${canonical}`,
    );
  }

  healthReport(): ProviderHealth[] {
    const now = this.now();
    return this.slots.map((s) => ({
      id: s.provider.id,
      enabled: s.config.enabled,
      priority: s.config.priority,
      basis: s.config.basis,
      useForTrading: s.config.useForTrading,
      state: !s.config.enabled
        ? "disabled"
        : s.openUntil > now
          ? "open"
          : s.failures > 0
            ? "degraded"
            : "healthy",
      failures: s.failures,
      lastOk: s.lastOk,
      lastError: s.lastError,
      lastLatencyMs: s.lastLatencyMs,
      capabilities: s.provider.capabilities,
    }));
  }

  provider(id: string): MarketDataProvider | undefined {
    return this.slots.find((s) => s.provider.id === id)?.provider;
  }
}
