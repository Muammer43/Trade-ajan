import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, type QuantForgeConfig } from "../../src/quantforge/config/schema.js";
import { silentLogger } from "../../src/quantforge/core/logger.js";
import type { Quote, StoredCandle } from "../../src/quantforge/core/types.js";
import { Database } from "../../src/quantforge/database/db.js";
import { StateRepo } from "../../src/quantforge/database/repositories.js";
import { exitOf } from "../../src/quantforge/discovery/generator.js";
import type { BrokerAdapter, OrderRequest } from "../../src/quantforge/execution/broker.js";
import { Ledger } from "../../src/quantforge/execution/ledger.js";
import { ARM_PHRASE, LIVE_ENV_PHRASE, LiveGate } from "../../src/quantforge/execution/live-guard.js";
import { clientOrderId, OrderManager } from "../../src/quantforge/execution/order-manager.js";
import { PaperBroker } from "../../src/quantforge/execution/paper-broker.js";
import { tempHome } from "../helpers.js";

const T = Date.UTC(2026, 0, 6, 12, 0); // Tuesday, market open

function rig(patch: (c: QuantForgeConfig) => void = () => {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.risk.initialBalance = 10_000;
  patch(config);
  const db = Database.open(":memory:");
  let now = T;
  const clock = () => now;
  const ledger = new Ledger(db, new StateRepo(db), config, "paper", "paper", clock);
  ledger.ensure();
  let price = 2650;
  const quote = async (): Promise<Quote> => ({
    symbol: "XAUUSD",
    price,
    bid: price - 0.175,
    ask: price + 0.175,
    spread: 0.35,
    spreadSource: "modelled",
    ts: now,
    provider: "test",
  });
  const broker = new PaperBroker(db, ledger, config, quote, silentLogger().child("paper"), clock);
  const orders = new OrderManager(db, broker, "paper", silentLogger().child("orders"), clock);
  return {
    db,
    ledger,
    broker,
    orders,
    config,
    setPrice: (p: number) => (price = p),
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

const bar = (ts: number, o: number, h: number, l: number, c: number): StoredCandle => ({
  ts,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: null,
  symbol: "XAUUSD",
  tf: "5m",
  provider: "t",
  marketOpen: true,
  quality: "ok",
});

const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: clientOrderId("paper", "S1", T, "long"),
  side: "long",
  type: "market",
  lots: 0.1,
  sl: 2645,
  tp: 2660,
  strategyId: "S1",
  decisionId: null,
  meta: { atr: 3, rules: exitOf(1.5, 2, 16, false), regime: "range" },
  ...over,
});

describe("ledger", () => {
  it("starts with the initial deposit and keeps balance equal to the sum of transactions", () => {
    const { ledger, db } = rig();
    assert.equal(ledger.balance(), 10_000);
    ledger.post("commission", -3.5);
    ledger.post("realized_pnl", 12.25);
    assert.deepEqual(ledger.verify(), { ok: true, balance: 10_008.75, sum: 10_008.75 });
    db.run("UPDATE accounts SET balance=balance+1 WHERE name='paper'");
    assert.equal(ledger.verify().ok, false, "tampering is detected");
  });
});

describe("paper broker and order manager", () => {
  it("fills market orders at the ask plus slippage and charges entry commission", async () => {
    const { orders, ledger, config } = rig();
    const r = await orders.submit(order(), () => ({ ok: true }));
    assert.equal(r.outcome, "filled");
    if (r.outcome !== "filled") return;
    assert.ok(Math.abs(r.fillPrice - (2650 + 0.175 + config.costs.slippage)) < 1e-9);
    const p = ledger.openPositions()[0];
    assert.ok(p);
    assert.ok(Math.abs((p?.entry_price ?? 0) - r.fillPrice) < 1e-9);
    assert.equal(ledger.balance(), 10_000 - 0.35, "half the round-trip commission (7 USD/lot × 0.1 lot / 2)");
    // Stop and target re-anchored to the fill: the sized risk distance is preserved.
    assert.ok(Math.abs((p?.entry_price ?? 0) - (p?.sl ?? 0) - 5) < 1e-9);
  });
  it("never submits the same signal twice (idempotency)", async () => {
    const { orders, ledger } = rig();
    await orders.submit(order(), () => ({ ok: true }));
    const again = await orders.submit(order(), () => ({ ok: true }));
    assert.equal(again.outcome, "duplicate");
    assert.equal(ledger.openPositions().length, 1);
  });
  it("records validation refusals without submitting", async () => {
    const { orders, ledger, db } = rig();
    const r = await orders.submit(order(), () => ({ ok: false, reason: "risk says no" }));
    assert.equal(r.outcome, "rejected");
    assert.equal(ledger.openPositions().length, 0);
    assert.equal(db.get<{ status: string }>("SELECT status FROM orders")?.status, "rejected");
    assert.equal(db.all("SELECT * FROM order_events").length, 2);
  });
  it("executes stop-loss and take-profit on monitoring bars", async () => {
    const stop = rig();
    await stop.orders.submit(order(), () => ({ ok: true }));
    stop.advance(60_000);
    const res = stop.broker.processMonitorBar(bar(T, 2650, 2651, 2644, 2646), 0.35);
    assert.equal(res[0]?.kind, "stop");
    const closed = stop.ledger.closedPositions()[0];
    assert.equal(closed?.exit_reason, "stop");
    assert.ok((closed?.realized_pnl ?? 0) < 0);
    assert.ok(stop.ledger.verify().ok);

    const target = rig();
    await target.orders.submit(order(), () => ({ ok: true }));
    const r2 = target.broker.processMonitorBar(bar(T, 2650, 2661, 2649, 2660), 0.35);
    assert.equal(r2[0]?.kind, "target");
    assert.ok((target.ledger.closedPositions()[0]?.realized_pnl ?? 0) > 0);
  });
  it("takes partial profits when the size can be split, and skips them when it cannot", async () => {
    const big = rig();
    await big.orders.submit(
      order({ lots: 0.2, meta: { atr: 3, rules: exitOf(1.5, 2.5, 16, true), regime: null } }),
      () => ({ ok: true }),
    );
    const r = big.broker.processMonitorBar(bar(T, 2650, 2656.5, 2649.5, 2656), 0.35);
    assert.equal(r[0]?.kind, "partial");
    const p = big.ledger.openPositions()[0];
    assert.equal(p?.lots_open, 0.1);
    assert.ok((p?.sl ?? 0) >= (p?.entry_price ?? 0), "stop moved to break-even after the partial");

    const small = rig();
    await small.orders.submit(
      order({ lots: 0.01, meta: { atr: 3, rules: exitOf(1.5, 2.5, 16, true), regime: null } }),
      () => ({ ok: true }),
    );
    const r3 = small.broker.processMonitorBar(bar(T, 2650, 2656.5, 2649.5, 2656), 0.35);
    assert.equal(r3[0]?.kind, "partial_skipped");
    assert.equal(small.ledger.openPositions()[0]?.lots_open, 0.01);
  });
  it("charges swap at the New York rollover", async () => {
    const { orders, broker, ledger, advance, now } = rig();
    await orders.submit(order({ sl: 2600, tp: 2700 }), () => ({ ok: true }));
    advance(10 * 3_600_000 + 5 * 60_000); // past 22:00 UTC (17:00 New York)
    broker.processMonitorBar(bar(now() - 5 * 60_000, 2650, 2651, 2649, 2650), 0.35);
    const swaps = ledger.transactions().filter((t) => t.type === "swap");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]?.amount, -4.5, "−45 USD/lot/night × 0.1 lot");
  });
  it("time exit and break-even run at strategy-timeframe closes", async () => {
    const { orders, broker, ledger } = rig();
    await orders.submit(order({ meta: { atr: 3, rules: exitOf(1.5, 5, 2, false), regime: null } }), () => ({
      ok: true,
    }));
    const b15 = (k: number) => ({ ...bar(T + k * 900_000, 2650, 2651, 2649, 2650.5), tf: "15m" as const });
    broker.processDecisionBar(b15(1), 0.35, 3);
    assert.equal(ledger.openPositions().length, 1);
    broker.processDecisionBar(b15(2), 0.35, 3);
    assert.equal(ledger.closedPositions()[0]?.exit_reason, "time");
  });
  it("reconciles orders interrupted by a crash without re-sending them", async () => {
    const { orders, db } = rig();
    db.run(
      "INSERT INTO orders(client_order_id, account, broker, mode, side, type, lots, sl, tp, status, intent, created_at, updated_at) VALUES ('x1','paper','paper','paper','long','market',0.1,1,2,'submitted','open',0,0)",
    );
    db.run(
      "INSERT INTO orders(client_order_id, account, broker, mode, side, type, lots, sl, tp, status, intent, created_at, updated_at) VALUES ('x2','paper','paper','paper','long','market',0.1,1,2,'new','open',0,0)",
    );
    const r = await orders.reconcile();
    assert.equal(r.checked, 2);
    assert.equal(r.cancelled, 2);
    assert.equal(db.all("SELECT * FROM orders WHERE status='cancelled'").length, 2);
  });
  it("manual and emergency closes use the live price", async () => {
    const { orders, broker, ledger, setPrice } = rig();
    await orders.submit(order(), () => ({ ok: true }));
    setPrice(2655);
    const id = ledger.openPositions()[0]?.id as number;
    const r = await broker.close(id, 1, "emergency");
    assert.ok(r.ok && r.pnl && r.pnl > 0);
    assert.equal(ledger.closedPositions()[0]?.exit_reason, "emergency");
  });
});

/** Contract every broker adapter must satisfy; run here against the paper broker. */
export async function brokerContract(make: () => Promise<BrokerAdapter>): Promise<void> {
  const b = await make();
  assert.ok((await b.connect()).ok);
  const acct = await b.account();
  assert.ok(acct.balance > 0 && acct.currency === "USD");
  const ack = await b.submit(order({ clientOrderId: "contract-1" }));
  assert.equal(ack.status, "filled");
  if (ack.status !== "filled") return;
  const positions = await b.positions();
  assert.equal(positions.length, 1);
  assert.ok((await b.modify(ack.positionId, { sl: 2646 })).ok);
  assert.equal((await b.positions())[0]?.sl, 2646);
  assert.ok((await b.close(ack.positionId, 1, "manual")).ok);
  assert.equal((await b.positions()).length, 0);
  assert.equal((await b.close(ack.positionId, 1, "manual")).ok, false, "closing twice fails cleanly");
  assert.equal((await b.submit(order({ clientOrderId: "contract-2", lots: 0 }))).status, "rejected");
}

describe("broker adapter contract", () => {
  it("the paper broker satisfies the contract", async () => {
    await brokerContract(async () => rig().broker);
  });
});

describe("live-trading gate", () => {
  it("stays paper by default and with every flag but a verified adapter", () => {
    const { paths, cleanup } = tempHome();
    try {
      const off = new LiveGate(structuredClone(DEFAULT_CONFIG), paths, {});
      assert.equal(off.status().effectiveMode, "paper");
      const config = structuredClone(DEFAULT_CONFIG);
      config.mode = "live";
      config.live.enabled = true;
      config.live.broker = "some-broker";
      const gate = new LiveGate(config, paths, { QF_LIVE_TRADING: LIVE_ENV_PHRASE });
      gate.markVerified(true);
      const st = gate.status();
      assert.equal(st.effectiveMode, "paper");
      assert.equal(st.checks.find((c) => c.name === "verified_broker_adapter")?.passed, false);
      assert.equal(gate.arm("wrong").ok, false);
      assert.equal(gate.arm(ARM_PHRASE).ok, false, "arming is refused while prerequisites fail");
    } finally {
      cleanup();
    }
  });
});
