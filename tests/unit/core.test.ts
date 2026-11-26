import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEnvFile } from "../../src/quantforge/config/load.js";
import { buildConfig, DEFAULT_CONFIG } from "../../src/quantforge/config/schema.js";
import { redact, registerSecret } from "../../src/quantforge/core/logger.js";
import {
  benjaminiHochberg,
  bootstrapMeanCi,
  deflatedSharpe,
  normalCdf,
  normalInv,
  pValueMeanPositive,
  studentTCdf,
} from "../../src/quantforge/core/stats.js";
import {
  floorTo,
  isMarketOpenAt,
  isUsDst,
  minutesToClose,
  newYorkParts,
  rolloversBetween,
  sessionOf,
} from "../../src/quantforge/core/time.js";
import { floorToStep } from "../../src/quantforge/core/util.js";
import { ApiBudget } from "../../src/quantforge/data/budget.js";

describe("market calendar", () => {
  it("follows US daylight saving time", () => {
    assert.equal(isUsDst(Date.UTC(2026, 6, 1)), true);
    assert.equal(isUsDst(Date.UTC(2026, 0, 15)), false);
    // 2026: DST starts 8 March 07:00 UTC, ends 1 November 06:00 UTC.
    assert.equal(isUsDst(Date.UTC(2026, 2, 8, 6, 59)), false);
    assert.equal(isUsDst(Date.UTC(2026, 2, 8, 7, 0)), true);
    assert.equal(isUsDst(Date.UTC(2026, 10, 1, 5, 59)), true);
    assert.equal(isUsDst(Date.UTC(2026, 10, 1, 6, 0)), false);
    assert.equal(newYorkParts(Date.UTC(2026, 6, 1, 21, 0)).minutes, 17 * 60);
  });
  it("closes on weekends and in the daily break", () => {
    // Winter: Friday 22:00 UTC = 17:00 New York (close); Sunday 23:00 UTC = 18:00 New York (open).
    assert.equal(isMarketOpenAt(Date.UTC(2026, 0, 9, 21, 59)), true);
    assert.equal(isMarketOpenAt(Date.UTC(2026, 0, 9, 22, 0)), false);
    assert.equal(isMarketOpenAt(Date.UTC(2026, 0, 10, 12, 0)), false);
    assert.equal(isMarketOpenAt(Date.UTC(2026, 0, 11, 22, 59)), false);
    assert.equal(isMarketOpenAt(Date.UTC(2026, 0, 11, 23, 0)), true);
    // Tuesday daily break 22:00–23:00 UTC in winter, 21:00–22:00 in summer.
    assert.equal(isMarketOpenAt(Date.UTC(2026, 0, 13, 22, 30)), false);
    assert.equal(isMarketOpenAt(Date.UTC(2026, 6, 14, 21, 30)), false);
    assert.equal(isMarketOpenAt(Date.UTC(2026, 6, 14, 22, 30)), true);
    assert.equal(minutesToClose(Date.UTC(2026, 0, 9, 21, 30)), 30);
    assert.equal(sessionOf(Date.UTC(2026, 0, 13, 13, 0)), "overlap");
    assert.equal(sessionOf(Date.UTC(2026, 0, 10, 13, 0)), "closed");
  });
  it("counts swap rollovers with a triple Wednesday", () => {
    // Monday 12:00 UTC to Thursday 12:00 UTC (winter): Mon, Tue, Wed(×3) rollovers = 5.
    assert.equal(rolloversBetween(Date.UTC(2026, 0, 12, 12), Date.UTC(2026, 0, 15, 12)), 5);
    assert.equal(rolloversBetween(Date.UTC(2026, 0, 12, 12), Date.UTC(2026, 0, 12, 21, 59)), 0);
    assert.equal(rolloversBetween(Date.UTC(2026, 0, 12, 12), Date.UTC(2026, 0, 12, 22, 0)), 1);
  });
  it("floors timestamps to bar starts", () => {
    assert.equal(floorTo(Date.UTC(2026, 0, 5, 10, 14, 59), "15m"), Date.UTC(2026, 0, 5, 10, 0));
    assert.equal(floorTo(Date.UTC(2026, 0, 5, 10, 14, 59), "4h"), Date.UTC(2026, 0, 5, 8, 0));
  });
});

describe("statistics", () => {
  it("normal and Student-t distributions", () => {
    assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
    assert.ok(Math.abs(normalInv(0.975) - 1.96) < 1e-3);
    assert.ok(Math.abs(studentTCdf(2.228, 10) - 0.975) < 1e-3);
    assert.ok(Math.abs(studentTCdf(-1.812, 10) - 0.05) < 1e-3);
  });
  it("one-sided t-test p-value", () => {
    assert.ok(pValueMeanPositive([1, 1.2, 0.8, 1.1, 0.9, 1, 1.05]) < 0.001);
    assert.ok(pValueMeanPositive([-1, 1, -1, 1, -1, 1]) > 0.4);
  });
  it("Benjamini–Hochberg controls the false discovery rate", () => {
    assert.deepEqual(benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205], 0.05), [
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    assert.deepEqual(benjaminiHochberg([0.5, 0.6], 0.1), [false, false]);
  });
  it("deflated Sharpe falls as the number of trials grows", () => {
    const base = { sr: 0.2, n: 200, skew: 0, kurt: 3, srVariance: 0.01 };
    const few = deflatedSharpe({ ...base, trials: 1 }).dsr;
    const many = deflatedSharpe({ ...base, trials: 1000 }).dsr;
    assert.ok(few > 0.99);
    assert.ok(many < few);
  });
  it("bootstrap CI brackets the sample mean", () => {
    const xs = Array.from({ length: 200 }, (_, i) => Math.sin(i) + 0.3);
    const ci = bootstrapMeanCi(xs);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(ci.low < m && m < ci.high);
  });
});

describe("configuration", () => {
  it("defaults are valid and paper-only", () => {
    const b = buildConfig({});
    assert.ok("config" in b);
    if ("config" in b) {
      assert.equal(b.config.mode, "paper");
      assert.equal(b.config.live.enabled, false);
      assert.equal(b.config.dashboard.host, "127.0.0.1");
      assert.equal(b.config.risk.initialBalance, 1000);
    }
  });
  it("rejects unknown keys and invalid values", () => {
    assert.ok("error" in buildConfig({ risk: { riskPerTradePct: 50 } }));
    assert.ok("error" in buildConfig({ surprise: true }));
  });
  it("refuses to expose the dashboard without explicit consent", () => {
    assert.ok("error" in buildConfig({ dashboard: { host: "0.0.0.0" } }));
    assert.ok("config" in buildConfig({ dashboard: { host: "0.0.0.0", allowRemote: true } }));
  });
  it("applies the conservative risk profile", () => {
    const b = buildConfig({ risk: { profile: "conservative" } });
    assert.ok("config" in b && b.config.risk.riskPerTradePct === 0.5);
    assert.equal(DEFAULT_CONFIG.risk.profile, "balanced");
  });
  it("applies discovery profiles, letting explicit values win", () => {
    const relaxed = buildConfig({ discovery: { profile: "relaxed", minDsr: 0, lookbackDays: 1100 } });
    assert.ok("config" in relaxed);
    if ("config" in relaxed) {
      assert.equal(relaxed.config.discovery.fdrQ, 0.3);
      assert.equal(relaxed.config.discovery.minDsr, 0);
      assert.equal(relaxed.config.discovery.lookbackDays, 1100);
    }
    const strict = buildConfig({});
    assert.ok(
      "config" in strict &&
        strict.config.discovery.profile === "strict" &&
        strict.config.discovery.minDsr === 0.9,
    );
  });
  it("parses env files", () => {
    assert.deepEqual(parseEnvFile("# c\nA=1\nB='two'\n bad line\nC=\"3\""), { A: "1", B: "two", C: "3" });
  });
});

describe("utilities and security", () => {
  it("floors lots to the lot step without float error", () => {
    assert.equal(floorToStep(0.0299999, 0.01), 0.02);
    assert.equal(floorToStep(0.03, 0.01), 0.03);
    assert.equal(floorToStep(1.239, 0.1), 1.2);
  });
  it("redacts registered secrets and key-like query parameters", () => {
    registerSecret("supersecretkey123");
    assert.equal(redact("key supersecretkey123 here"), "key *** here");
    assert.equal(redact("GET /x?apikey=abc123&y=1"), "GET /x?apikey=***&y=1");
  });
});

describe("API budget", () => {
  it("enforces per-minute and per-day limits with priorities", () => {
    let t = Date.UTC(2026, 0, 5, 10);
    const b = new ApiBudget(2, 10, 4, () => t);
    assert.equal(b.waitFor(1, "normal"), 0);
    b.spend(1);
    b.spend(1);
    assert.ok(b.waitFor(1, "normal") > 0);
    t += 61_000;
    assert.equal(b.waitFor(1, "normal"), 0);
    b.spend(6); // 8 used today
    assert.equal(b.waitFor(1, "low"), Number.POSITIVE_INFINITY); // low keeps the full reserve back
    t += 61_000;
    assert.equal(b.waitFor(1, "critical"), 0); // critical may use the reserve
  });
});
