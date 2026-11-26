// Live Twelve Data connectivity test (opt-in: QF_LIVE_TESTS=1, uses ~3 API credits). Verifies the real
// endpoints, symbol and intervals this project depends on, and that normalization accepts real data.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TF_MS } from "../../src/quantforge/core/types.js";
import { normalizeBars } from "../../src/quantforge/data/normalize.js";
import { TwelveDataProvider } from "../../src/quantforge/data/providers/twelvedata.js";

const live = process.env.QF_LIVE_TESTS === "1";

describe("Twelve Data (live)", { skip: live ? false : "set QF_LIVE_TESTS=1 to call the real API" }, () => {
  const td = new TwelveDataProvider({
    apiKey: process.env.TWELVEDATA_API_KEY || undefined,
    timeoutMs: 20_000,
  });
  it("serves closed, valid, UTC XAU/USD 15m bars", async () => {
    const now = Date.now();
    const { bars } = await td.fetchBars({ symbol: "XAU/USD", tf: "15m", limit: 50 });
    const { candles, issues } = normalizeBars(bars, {
      symbol: "XAUUSD",
      tf: "15m",
      provider: "twelvedata",
      now,
    });
    assert.ok(candles.length >= 40, `${candles.length} candles`);
    assert.equal(issues.filter((i) => i.kind === "invalid_ohlc" || i.kind === "unparseable").length, 0);
    for (const c of candles) assert.ok(c.ts + TF_MS["15m"] <= now, "only closed bars are kept");
    for (let k = 1; k < candles.length; k++) assert.ok((candles[k]?.ts ?? 0) > (candles[k - 1]?.ts ?? 0));
  });
  it("pages back in history with end_date", async () => {
    const end = Date.now() - 30 * 86_400_000;
    const { bars } = await td.fetchBars({ symbol: "XAU/USD", tf: "1h", limit: 10, end });
    const { candles } = normalizeBars(bars, {
      symbol: "XAUUSD",
      tf: "1h",
      provider: "twelvedata",
      now: Date.now(),
    });
    assert.ok(candles.length > 0 && (candles.at(-1)?.ts ?? Infinity) <= end);
  });
  it("quotes the latest price", async () => {
    const { quote } = await td.fetchQuote("XAU/USD");
    assert.ok(quote.price > 100 && quote.price < 100_000);
  });
});
