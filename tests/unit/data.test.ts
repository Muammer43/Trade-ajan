import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { silentLogger } from "../../src/quantforge/core/logger.js";
import { type StoredCandle, TF_MS } from "../../src/quantforge/core/types.js";
import { ApiBudget } from "../../src/quantforge/data/budget.js";
import {
  findGaps,
  flagStaleQuotes,
  normalizeBars,
  parseUtc,
  qualityReport,
} from "../../src/quantforge/data/normalize.js";
import { parseCsv } from "../../src/quantforge/data/providers/csv.js";
import { TwelveDataProvider } from "../../src/quantforge/data/providers/twelvedata.js";
import { ProviderError } from "../../src/quantforge/data/providers/types.js";
import { resample } from "../../src/quantforge/data/resample.js";
import { NoProviderError, ProviderRouter } from "../../src/quantforge/data/router.js";
import { Clock, ReplayProvider, syntheticMarket, T0 } from "../helpers.js";

const NOW = Date.UTC(2026, 0, 6, 12, 7);

describe("normalization", () => {
  it("parses UTC timestamps in every accepted form", () => {
    assert.equal(parseUtc("2026-01-06 10:15:00"), Date.UTC(2026, 0, 6, 10, 15));
    assert.equal(parseUtc("2026-01-06T10:15:00Z"), Date.UTC(2026, 0, 6, 10, 15));
    assert.equal(parseUtc("2026-01-06T12:15:00+02:00"), Date.UTC(2026, 0, 6, 10, 15));
    assert.equal(parseUtc(1767694500), 1767694500000);
    assert.equal(parseUtc("2026-01-06"), Date.UTC(2026, 0, 6));
    assert.equal(parseUtc("not a date"), undefined);
  });
  it("drops invalid, duplicate and still-forming bars and never fills gaps", () => {
    const raw = [
      { datetime: "2026-01-06 11:30:00", open: "2650", high: "2652", low: "2649", close: "2651" },
      { datetime: "2026-01-06 11:30:00", open: "2650", high: "2652", low: "2649", close: "2651" },
      { datetime: "2026-01-06 11:45:00", open: "2651", high: "2650", low: "2652", close: "2651" }, // high < low
      // 12:00 is missing on purpose.
      { datetime: "2026-01-06 11:15:00", open: "2649", high: "2650.5", low: "2648", close: "2650" },
      { datetime: "2026-01-06 12:00:00", open: "2651", high: "2653", low: "2650", close: "2652" }, // forming at 12:07
      { datetime: "garbage", open: "1", high: "1", low: "1", close: "1" },
    ];
    const { candles, issues } = normalizeBars(raw, { symbol: "XAUUSD", tf: "15m", provider: "t", now: NOW });
    assert.deepEqual(
      candles.map((c) => c.ts),
      [Date.UTC(2026, 0, 6, 11, 15), Date.UTC(2026, 0, 6, 11, 30)],
    );
    const kinds = issues.map((i) => i.kind).sort();
    assert.deepEqual(kinds, ["duplicate", "invalid_ohlc", "unclosed", "unparseable"]);
    assert.equal(candles.length, 2, "no fabricated bar replaces the invalid one");
  });
  it("flags weekend provider quotes as market closed", () => {
    const raw = [
      { datetime: "2026-01-10 12:00:00", open: "2650", high: "2650.2", low: "2649.9", close: "2650" },
    ];
    const { candles } = normalizeBars(raw, {
      symbol: "XAUUSD",
      tf: "15m",
      provider: "t",
      now: NOW + 7 * 86_400_000,
    });
    assert.equal(candles[0]?.marketOpen, false);
    assert.equal(candles[0]?.quality, "market_closed");
  });
  it("detects stale-quote runs inside market hours", () => {
    const base = syntheticMarket({ days: 3, seed: 1 }).slice(0, 300);
    const stored: StoredCandle[] = base.map((c) => ({
      ...c,
      symbol: "XAUUSD",
      tf: "5m" as const,
      provider: "t",
      marketOpen: true,
      quality: "ok" as const,
    }));
    for (let k = 100; k < 112; k++) {
      const p = (stored[k] as { close: number }).close;
      Object.assign(stored[k] as object, { open: p, high: p + 0.01, low: p - 0.01, close: p });
    }
    flagStaleQuotes(stored);
    assert.equal(stored.filter((c) => c.quality === "stale_quote").length, 12);
  });
  it("finds missing bars only inside market hours", () => {
    const bars = syntheticMarket({ days: 7, seed: 2 });
    const fifteen = resample(bars, "5m", "15m");
    assert.equal(findGaps(fifteen, "15m").length, 0, "weekends and daily breaks are not gaps");
    const holed = fifteen.filter((_, i) => i !== 50 && i !== 51);
    const gaps = findGaps(holed, "15m");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.missing, 2);
    const q = qualityReport(
      holed.map((c) => ({
        ...c,
        symbol: "XAUUSD",
        tf: "15m" as const,
        provider: "t",
        marketOpen: true,
        quality: "ok" as const,
      })),
      "15m",
      (holed.at(-1)?.ts ?? 0) + TF_MS["15m"],
      3,
    );
    assert.equal(q.missingBars, 2);
    assert.equal(q.fresh, true);
  });
  it("parses CSV history", () => {
    const rows = parseCsv(
      "time,open,high,low,close,volume\n2026-01-06T10:00:00Z,1,2,0.5,1.5,10\n1767693600,1,2,0.5,1.5,\n",
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.datetime, 1767693600);
  });
});

describe("resampling", () => {
  it("aggregates OHLC exactly and drops incomplete bars", () => {
    const bars = syntheticMarket({ days: 2, seed: 3 });
    const h1 = resample(bars, "5m", "1h");
    const first = h1[0];
    assert.ok(first);
    const parts = bars.filter((b) => b.ts >= first.ts && b.ts < first.ts + TF_MS["1h"]);
    assert.equal(first.open, parts[0]?.open);
    assert.equal(first.close, parts.at(-1)?.close);
    assert.equal(first.high, Math.max(...parts.map((p) => p.high)));
    assert.equal(first.low, Math.min(...parts.map((p) => p.low)));
    const missingOne = bars.filter((b) => b.ts !== (parts[3]?.ts ?? 0));
    assert.notEqual(
      resample(missingOne, "5m", "1h")[0]?.ts,
      first.ts,
      "an hour missing a 5m bar is not emitted",
    );
  });
});

describe("Twelve Data adapter (mocked HTTP)", () => {
  const ok =
    (body: unknown, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("requests UTC ascending bars and sends the key in a header, never in the URL", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const td = new TwelveDataProvider({
      apiKey: "k-123456",
      fetch: (async (url: URL, init: RequestInit) => {
        seen = { url: String(url), auth: new Headers(init.headers).get("authorization") };
        return ok({
          meta: {},
          values: [{ datetime: "2026-01-06 10:00:00", open: "1", high: "2", low: "0.5", close: "1.5" }],
          status: "ok",
        })();
      }) as typeof fetch,
    });
    const r = await td.fetchBars({ symbol: "XAU/USD", tf: "15m", limit: 10, end: Date.UTC(2026, 0, 6, 10) });
    assert.equal(r.bars.length, 1);
    assert.ok(seen);
    assert.match(seen.url, /interval=15min/);
    assert.match(seen.url, /timezone=UTC/);
    assert.match(seen.url, /end_date=2026-01-06\+10%3A00%3A00/);
    assert.doesNotMatch(seen.url, /k-123456/);
    assert.equal(seen.auth, "apikey k-123456");
  });
  it("maps errors to typed, correctly retryable provider errors", async () => {
    const cases: [unknown, number, string, boolean][] = [
      [{ code: 401, message: "bad key", status: "error" }, 200, "auth", false],
      [{ code: 429, message: "too many", status: "error" }, 200, "rate_limit", true],
      [
        { code: 400, message: "This symbol is available starting with the Grow plan", status: "error" },
        200,
        "bad_request",
        false,
      ],
      [{ code: 500, message: "oops", status: "error" }, 500, "server", true],
    ];
    for (const [body, status, kind, retryable] of cases) {
      const td = new TwelveDataProvider({ fetch: ok(body, status) as unknown as typeof fetch });
      await assert.rejects(
        td.fetchBars({ symbol: "XAU/USD", tf: "5m", limit: 1 }),
        (e: unknown) => e instanceof ProviderError && e.kind === kind && e.retryable === retryable,
      );
    }
    const net = new TwelveDataProvider({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      net.fetchQuote("XAU/USD"),
      (e: unknown) => e instanceof ProviderError && e.kind === "network",
    );
  });
  it("validates symbols and timeframes it serves", () => {
    const td = new TwelveDataProvider();
    assert.equal(td.mapSymbol("XAUUSD"), "XAU/USD");
    assert.equal(td.mapSymbol("UNKNOWN"), undefined);
  });
});

describe("provider router", () => {
  const cfg = (id: string, priority: number, useForTrading = true) => ({
    id: "csv" as const,
    enabled: true,
    priority,
    symbol: id,
    basis: "spot" as const,
    useForTrading,
  });
  it("falls back to the next provider and opens the circuit of a failing one", async () => {
    const clock = new Clock(Date.UTC(2026, 0, 7, 12));
    const bars = syntheticMarket({ days: 3, seed: 4 });
    const a = new ReplayProvider(bars, clock, "a");
    const b = new ReplayProvider(bars, clock, "b");
    a.down = true;
    const router = new ProviderRouter(
      [
        { provider: a, config: cfg("a", 1) },
        { provider: b, config: cfg("b", 2) },
      ],
      new ApiBudget(100, 1000, 0),
      undefined,
      silentLogger().child("t"),
      { sleep: async () => {}, now: clock.now },
    );
    for (let k = 0; k < 3; k++) {
      const r = await router.bars("XAUUSD", "15m", { limit: 5 }, { priority: "high", forTrading: true });
      assert.equal(r.provider.id, "b");
    }
    assert.equal(router.healthReport().find((p) => p.id === "a")?.state, "open");
    const callsBefore = a.calls;
    await router.bars("XAUUSD", "15m", { limit: 5 }, { priority: "high", forTrading: true });
    assert.equal(a.calls, callsBefore, "an open circuit is skipped");
  });
  it("never uses a non-trading (proxy) provider for trading data", async () => {
    const clock = new Clock(Date.UTC(2026, 0, 7, 12));
    const proxy = new ReplayProvider(syntheticMarket({ days: 3, seed: 5 }), clock, "proxy");
    const router = new ProviderRouter(
      [{ provider: proxy, config: cfg("proxy", 1, false) }],
      new ApiBudget(100, 1000, 0),
      undefined,
      silentLogger().child("t"),
      { sleep: async () => {} },
    );
    await assert.rejects(
      router.bars("XAUUSD", "15m", { limit: 5 }, { priority: "high", forTrading: true }),
      NoProviderError,
    );
    const r = await router.bars("XAUUSD", "15m", { limit: 5 }, { priority: "high", forTrading: false });
    assert.equal(r.provider.id, "proxy");
  });
  it("does not count request-specific refusals against provider health", async () => {
    const refusing = {
      id: "r",
      capabilities: {
        timeframes: ["1h"] as const,
        maxBarsPerRequest: 10,
        pagination: false,
        quotes: false,
        bidAsk: false,
        websocket: false,
        volume: false,
      },
      mapSymbol: (s: string) => s,
      fetchBars: async () => {
        throw new ProviderError("plan", "bad_request", false);
      },
      fetchQuote: async () => {
        throw new ProviderError("x", "not_supported", false);
      },
    };
    const router = new ProviderRouter(
      [{ provider: refusing, config: cfg("r", 1) }],
      new ApiBudget(100, 1000, 0),
      undefined,
      silentLogger().child("t"),
      { sleep: async () => {} },
    );
    for (let k = 0; k < 4; k++)
      await assert.rejects(router.bars("XAGUSD", "1h", { limit: 1 }, { priority: "low", forTrading: false }));
    assert.equal(router.healthReport()[0]?.state, "healthy");
  });
});

describe("replay provider sanity", () => {
  it("serves only bars that have started", async () => {
    const clock = new Clock(T0 + 3 * 86_400_000 + 7 * 60_000);
    const p = new ReplayProvider(syntheticMarket({ days: 5, seed: 6 }), clock);
    const r = await p.fetchBars({ symbol: "XAU/USD", tf: "15m", limit: 3 });
    const last = r.bars.at(-1);
    assert.ok(last && (parseUtc(last.datetime) as number) <= clock.t);
  });
});
