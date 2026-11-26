import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../../src/quantforge/config/schema.js";
import { Database } from "../../src/quantforge/database/db.js";
import { EventRepo, StateRepo } from "../../src/quantforge/database/repositories.js";
import { type AccountView, type Proposal, RiskEngine } from "../../src/quantforge/risk/engine.js";
import { sizePosition } from "../../src/quantforge/risk/sizing.js";

const inst = DEFAULT_CONFIG.instrument;
const costs = DEFAULT_CONFIG.costs;

describe("position sizing", () => {
  it("sizes from equity, stop distance, contract size and costs", () => {
    const r = sizePosition(
      { equity: 10_000, riskPct: 1, stopDistance: 5, spread: 0.35, slippage: 0.05 },
      inst,
      costs,
      2650,
    );
    assert.ok(r.ok);
    if (r.ok) {
      // Loss per lot = (5 + 0.35 + 0.1) × 100 + 7 = 552 USD → 100 USD / 552 = 0.181 → 0.18 lots.
      assert.equal(r.lots, 0.18);
      assert.ok(r.lossAtStopUsd <= 100);
      assert.equal(r.ticksToStop, 500);
      assert.equal(r.tickValuePerLot, 1);
    }
  });
  it("refuses instead of rounding up to the minimum lot", () => {
    const r = sizePosition(
      { equity: 1000, riskPct: 1, stopDistance: 12, spread: 0.35, slippage: 0.05 },
      inst,
      costs,
      2650,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /minimum lot/);
  });
  it("respects other contract specifications and the max lot", () => {
    const small = { ...inst, contractSize: 10, lotStep: 0.1, minLot: 0.1 };
    const r = sizePosition(
      { equity: 1000, riskPct: 1, stopDistance: 3, spread: 0.3, slippage: 0 },
      small,
      { ...costs, commissionPerLotRoundTrip: 0 },
      2650,
    );
    assert.ok(r.ok && r.lots === 0.3);
    const capped = sizePosition(
      { equity: 10_000_000, riskPct: 1, stopDistance: 1, spread: 0, slippage: 0 },
      inst,
      costs,
      2650,
    );
    assert.ok(capped.ok && capped.lots === inst.maxLot);
  });
});

function engine() {
  const db = Database.open(":memory:");
  const state = new StateRepo(db);
  const events = new EventRepo(db);
  let t = Date.UTC(2026, 0, 6, 12);
  const risk = new RiskEngine(structuredClone(DEFAULT_CONFIG), state, events, () => t);
  return { risk, db, events, advance: (ms: number) => (t += ms), now: () => t };
}

const account = (over: Partial<AccountView> = {}): AccountView => ({
  balance: 10_000,
  equity: 10_000,
  dayStartEquity: 10_000,
  weekStartEquity: 10_000,
  peakEquity: 10_000,
  openPositions: [],
  tradesToday: 0,
  consecutiveLosses: 0,
  freeMargin: 10_000,
  ...over,
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  side: "long",
  entry: 2650,
  sl: 2645,
  tp: 2657.5,
  spread: 0.35,
  expectedSlippage: 0.05,
  atrPercentile: 0.5,
  ts: Date.UTC(2026, 0, 6, 12),
  dataFresh: true,
  minutesToClose: 500,
  closeIsWeekend: false,
  expectedHoldingMinutes: 240,
  ...over,
});

describe("risk engine", () => {
  it("allows a clean proposal and sizes it", () => {
    const { risk } = engine();
    const v = risk.evaluate(proposal(), account());
    assert.equal(v.allowed, true, v.reasons.join("; "));
    assert.ok(v.sizing?.ok);
  });
  it("blocks on every limit independently", () => {
    const { risk } = engine();
    const cases: [Partial<Proposal>, Partial<AccountView>, string][] = [
      [{}, { equity: 9600, dayStartEquity: 10_000 }, "daily_loss"],
      [{}, { equity: 9300, weekStartEquity: 10_000, dayStartEquity: 9300 }, "weekly_loss"],
      [{}, { equity: 8400, peakEquity: 10_000, dayStartEquity: 8400, weekStartEquity: 8400 }, "max_drawdown"],
      [
        {},
        {
          openPositions: [
            { side: "long", lots: 0.1, riskUsd: 10 },
            { side: "long", lots: 0.1, riskUsd: 10 },
          ],
        },
        "max_open_positions",
      ],
      [{}, { openPositions: [{ side: "short", lots: 0.1, riskUsd: 10 }] }, "no_hedging"],
      [{}, { openPositions: [{ side: "long", lots: 0.3, riskUsd: 200 }] }, "correlated_exposure"],
      [{}, { tradesToday: 5 }, "daily_trade_limit"],
      [{ spread: 1.2 }, {}, "spread"],
      [{ expectedSlippage: 1 }, {}, "slippage"],
      [{ atrPercentile: 0.995 }, {}, "volatility"],
      [{ tp: 2652 }, {}, "reward_risk"],
      [{ dataFresh: false }, {}, "data_quality"],
      [{ minutesToClose: 10 }, {}, "market_hours"],
      [{ closeIsWeekend: true, minutesToClose: 100 }, {}, "market_hours"],
      [{ sl: 2655 }, {}, "order_geometry"],
    ];
    for (const [p, a, rule] of cases) {
      const v = risk.evaluate(proposal(p), account(a));
      assert.equal(v.allowed, false, `${rule} should block`);
      assert.ok(
        v.checks.some((c) => c.rule === rule && !c.passed),
        `${rule} not reported: ${v.reasons.join("; ")}`,
      );
    }
  });
  it("the kill switch persists in the database and blocks everything", () => {
    const { risk, db } = engine();
    risk.setKillSwitch(true, "test");
    const again = new RiskEngine(structuredClone(DEFAULT_CONFIG), new StateRepo(db), new EventRepo(db));
    assert.equal(again.controls().killSwitch.on, true);
    assert.equal(again.evaluate(proposal(), account()).allowed, false);
  });
  it("engages the daily circuit breaker, the drawdown kill switch and the loss-streak cooldown automatically", () => {
    const { risk, advance, events } = engine();
    risk.refresh(account({ equity: 9650, dayStartEquity: 10_000 }));
    assert.ok(risk.controls().circuitBreaker.until);
    advance(86_400_000);
    risk.refresh(account());
    assert.equal(risk.controls().circuitBreaker.until, null, "the breaker clears the next day");
    risk.refresh(account({ consecutiveLosses: 4 }));
    assert.ok(risk.controls().cooldownUntil);
    risk.refresh(account({ equity: 8400, peakEquity: 10_000, dayStartEquity: 8400, weekStartEquity: 8400 }));
    assert.equal(risk.controls().killSwitch.on, true);
    assert.ok(events.recentRisk(10).some((e) => e.kind === "max_drawdown"));
  });
});
