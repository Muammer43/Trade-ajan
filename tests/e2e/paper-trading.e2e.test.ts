// End-to-end: the complete bot on a replayed market. History backfill → scheduler-driven decisions at every
// closed 15-minute candle → paper orders, positions, stops/targets → a crash and restart → a network outage →
// consistency checks of every ledger, order and decision.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { QuantForgeApp } from "../../src/quantforge/app.js";
import { Scheduler } from "../../src/quantforge/scheduler/scheduler.js";
import { Clock, ReplayProvider, syntheticMarket, T0, tempHome, testConfig } from "../helpers.js";

const DAY = 86_400_000;

describe("end-to-end paper trading", () => {
  const home = tempHome();
  after(() => home.cleanup());
  const market = syntheticMarket({ days: 75, seed: 77 });
  const clock = new Clock(T0 + 55 * DAY + 3 * 3_600_000);
  const provider = new ReplayProvider(market, clock);
  const config = testConfig((c) => {
    c.scheduler.enabled = false; // no backups inside the test
    // A larger paper balance so that 0.5% risk can size the minimum lot on this synthetic market.
    c.risk.initialBalance = 10_000;
  });
  const providers = [
    {
      provider,
      config: {
        id: "csv" as const,
        enabled: true,
        priority: 1,
        symbol: "XAU/USD",
        basis: "spot" as const,
        useForTrading: true,
      },
    },
  ];
  const make = () =>
    QuantForgeApp.create({
      paths: home.paths,
      config,
      providers,
      now: clock.now,
      logToStderr: false,
      sleep: async () => {},
    });

  /** Advance the clock in 5-minute steps, ticking the scheduler 20 s after each bar close. */
  async function runFor(app: QuantForgeApp, ms: number): Promise<void> {
    const scheduler = new Scheduler(app, clock.now);
    const end = clock.t + ms;
    while (clock.t < end) {
      clock.t = Math.floor(clock.t / 300_000) * 300_000 + 300_000 + 20_000;
      await scheduler.tick();
    }
  }

  let app: QuantForgeApp;
  it("backfills history", async () => {
    app = await make();
    await app.recover();
    await app.ensureHistory();
    assert.ok(app.candles.count("XAUUSD", "15m") > 3000);
    assert.ok(app.candles.count("XAUUSD", "5m") > 3000);
  });

  it("trades on paper from scheduler ticks, with decisions, orders, positions and a consistent ledger", async () => {
    await runFor(app, 5 * DAY);
    const decisions = app.db.all<{ action: string; bar_ts: number }>("SELECT action, bar_ts FROM decisions");
    assert.ok(decisions.length > 200, `decisions: ${decisions.length}`);
    assert.equal(new Set(decisions.map((d) => d.bar_ts)).size, decisions.length, "one decision per candle");
    assert.ok(
      decisions.filter((d) => d.action === "NO_TRADE").length > decisions.length / 2,
      "NO TRADE is the normal outcome",
    );
    const filled = app.db.all("SELECT * FROM orders WHERE status='filled'");
    assert.ok(filled.length >= 1, "at least one paper order filled");
    const closed = app.ledger.closedPositions();
    assert.ok(closed.length >= 1, "at least one paper position closed");
    for (const p of closed)
      assert.ok(
        ["stop", "target", "time", "weekend", "partial", "manual", "emergency"].includes(
          String(p.exit_reason),
        ),
      );
    assert.ok(app.ledger.verify().ok, "balance equals the sum of transactions");
    assert.ok(app.ledger.transactions(1000).some((t) => t.type === "realized_pnl"));
    const o = app.overview();
    assert.equal(o.stats.trades, closed.length, "dashboard statistics come from stored trades");
    assert.equal(o.mode, "paper");
    const agentRows = app.db.all("SELECT DISTINCT agent FROM agent_reports");
    assert.equal(agentRows.length, 6, "all six agents reported");
  });

  it("recovers after an unclean stop without duplicating candles, decisions or orders", async () => {
    const decisionsBefore = app.db.all("SELECT id FROM decisions").length;
    // Simulate a crash: an order left half-submitted, and the process gone without a graceful shutdown.
    app.db.run(
      "INSERT INTO orders(client_order_id, account, broker, mode, side, type, lots, sl, tp, status, intent, created_at, updated_at) VALUES ('crash-1','paper','paper','paper','long','market',0.01,1,2,'submitted','open',0,0)",
    );
    app.close();
    app = await make();
    const notes = await app.recover();
    assert.ok(notes.some((n) => /reconciled/.test(n)));
    assert.equal(
      app.db.get<{ status: string }>("SELECT status FROM orders WHERE client_order_id='crash-1'")?.status,
      "cancelled",
    );
    // Re-running the same moment must not re-process the same candle.
    const scheduler = new Scheduler(app, clock.now);
    await scheduler.tick();
    assert.equal(
      app.db.all("SELECT id FROM decisions").length,
      decisionsBefore,
      "no candle is decided twice",
    );
    assert.ok(app.ledger.verify().ok);
  });

  it("survives a network outage and keeps managing positions afterwards", async () => {
    provider.down = true;
    await runFor(app, 2 * 3_600_000);
    const events = app.events.recentSystem(200).filter((e) => e.level === "error" || e.level === "warn");
    assert.ok(events.length > 0, "the outage was logged");
    provider.down = false;
    const before = app.candles.count("XAUUSD", "5m");
    await runFor(app, 3 * DAY); // spans the weekend into the next trading session
    assert.ok(app.candles.count("XAUUSD", "5m") > before + 250, "missed bars were fetched after the outage");
    assert.equal(app.data.quality("5m").missingBars, 0, "no gaps remain");
    assert.ok(app.ledger.verify().ok);
    const orders = app.db.all<{ client_order_id: string }>("SELECT client_order_id FROM orders");
    assert.equal(new Set(orders.map((x) => x.client_order_id)).size, orders.length);
    app.close();
  });
});
