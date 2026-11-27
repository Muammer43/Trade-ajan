import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { QuantForgeApp } from "../../src/quantforge/app.js";
import { silentLogger } from "../../src/quantforge/core/logger.js";
import { TF_MS } from "../../src/quantforge/core/types.js";
import { DashboardServer } from "../../src/quantforge/dashboard/server.js";
import { ApiBudget } from "../../src/quantforge/data/budget.js";
import { ProviderRouter } from "../../src/quantforge/data/router.js";
import { MarketDataService } from "../../src/quantforge/data/service.js";
import { Database } from "../../src/quantforge/database/db.js";
import { MIGRATIONS } from "../../src/quantforge/database/migrations.js";
import { CandleRepo, HealthRepo } from "../../src/quantforge/database/repositories.js";
import { Clock, ReplayProvider, syntheticMarket, T0, tempHome, testConfig } from "../helpers.js";

describe("database", () => {
  it("migrations are idempotent and transactions roll back", () => {
    const { paths, cleanup } = tempHome();
    try {
      const db = Database.open(paths.db);
      assert.equal(db.schemaVersion(), MIGRATIONS.length);
      assert.deepEqual(db.migrate(MIGRATIONS), [], "re-running applies nothing");
      assert.throws(() =>
        db.tx(() => {
          db.run("INSERT INTO kv_state(key, value_json, updated_at) VALUES ('a', '1', 1)");
          db.tx(() => db.run("INSERT INTO kv_state(key, value_json, updated_at) VALUES ('b', '1', 1)"));
          throw new Error("abort");
        }),
      );
      assert.equal(db.all("SELECT * FROM kv_state").length, 0);
      db.close();
    } finally {
      cleanup();
    }
  });
  it("committed data survives a process that never closed the database (crash)", () => {
    const { paths, cleanup } = tempHome();
    try {
      const crashed = Database.open(paths.db);
      crashed.run("INSERT INTO kv_state(key, value_json, updated_at) VALUES ('k', '\"v\"', 1)");
      // No close, no checkpoint: the row lives only in the WAL, as after a kill -9.
      const reopened = Database.open(paths.db);
      assert.equal(
        reopened.get<{ value_json: string }>("SELECT value_json FROM kv_state WHERE key='k'")?.value_json,
        '"v"',
      );
      assert.equal(reopened.integrityCheck(), "ok");
      reopened.close();
    } finally {
      cleanup();
    }
  });
});

describe("market data service", () => {
  it("syncs incrementally, survives a network outage and catches up without gaps or duplicates", async () => {
    const clock = new Clock(T0 + 2 * 86_400_000 + 12 * 3_600_000);
    const provider = new ReplayProvider(syntheticMarket({ days: 6, seed: 51 }), clock);
    const db = Database.open(":memory:");
    const candles = new CandleRepo(db);
    const config = testConfig();
    const router = new ProviderRouter(
      [
        {
          provider,
          config: {
            id: "csv",
            enabled: true,
            priority: 1,
            symbol: "XAU/USD",
            basis: "spot",
            useForTrading: true,
          },
        },
      ],
      new ApiBudget(1000, 100_000, 0, clock.now),
      new HealthRepo(db),
      silentLogger().child("t"),
      { sleep: async () => {}, now: clock.now },
    );
    const service = new MarketDataService(router, candles, config, silentLogger().child("t"), clock.now);
    const first = await service.sync("5m");
    assert.ok(first.inserted > 100);
    const lastTs = candles.last("XAUUSD", "5m")?.ts as number;
    assert.ok(lastTs + TF_MS["5m"] <= clock.t, "the still-forming bar is never stored");
    clock.advance(10 * 60_000);
    assert.equal((await service.sync("5m")).inserted, 2);
    provider.down = true;
    clock.advance(60 * 60_000);
    await assert.rejects(service.sync("5m"));
    assert.equal(service.quality("5m").fresh, false, "stale data is reported, not hidden");
    provider.down = false;
    clock.advance(3 * 60_000); // past the circuit cool-down
    const caught = await service.sync("5m");
    assert.equal(caught.inserted, 12, "the hour missed during the outage is fetched on recovery");
    const all = candles.latest("XAUUSD", "5m", 100_000);
    assert.equal(new Set(all.map((c) => c.ts)).size, all.length, "no duplicate candles");
    assert.equal(service.quality("5m").missingBars, 0);
  });
});

describe("dashboard API", () => {
  const { paths, cleanup } = tempHome();
  const clock = new Clock(T0 + 22 * 86_400_000 + 12 * 3_600_000);
  let app: QuantForgeApp;
  let server: DashboardServer;
  let base = "";
  let cookie = "";
  before(async () => {
    const provider = new ReplayProvider(syntheticMarket({ days: 24, seed: 52 }), clock);
    app = await QuantForgeApp.create({
      paths,
      config: testConfig(),
      providers: [
        {
          provider,
          config: {
            id: "csv",
            enabled: true,
            priority: 1,
            symbol: "XAU/USD",
            basis: "spot",
            useForTrading: true,
          },
        },
      ],
      now: clock.now,
      logToStderr: false,
    });
    await app.data.backfill("15m", 30);
    await app.data.sync("5m");
    server = new DashboardServer({ app, token: "test-token-0123456789abcdef", host: "127.0.0.1", port: 0 });
    const addr = await server.listen();
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(async () => {
    await server.close();
    app.close();
    cleanup();
  });
  it("serves the app shell and a public health probe", async () => {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /QuantForge/);
    assert.match(html.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const traversal = await fetch(`${base}/..%2F..%2Fpackage.json`);
    assert.doesNotMatch(await traversal.text(), /"dependencies"/);
  });
  it("requires login, the CSRF header and a correct token", async () => {
    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/login`, {
          method: "POST",
          body: JSON.stringify({ token: "test-token-0123456789abcdef" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/login`, {
          method: "POST",
          headers: { "x-qf-request": "1" },
          body: JSON.stringify({ token: "wrong" }),
        })
      ).status,
      401,
    );
    const ok = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "x-qf-request": "1" },
      body: JSON.stringify({ token: "test-token-0123456789abcdef" }),
    });
    assert.equal(ok.status, 200);
    cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] as string;
    assert.match(ok.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
  });
  it("answers every page's endpoint with real application data", async () => {
    for (const p of [
      "overview",
      "market?tf=15m",
      "market?tf=4h",
      "agents",
      "decisions",
      "signals",
      "signals?only=trades",
      "backtests",
      "paper",
      "trades",
      "positions",
      "risk",
      "performance",
      "providers",
      "logs",
      "settings",
    ]) {
      const r = await fetch(`${base}/api/${p}`, { headers: { cookie } });
      assert.equal(r.status, 200, p);
    }
    const o = (await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json()) as {
      account: { balance: number };
      mode: string;
      bot: { running: boolean };
      recentTrades: unknown[];
    };
    assert.equal(o.account.balance, 1000);
    assert.equal(o.mode, "paper");
    assert.equal(o.bot.running, true);
    assert.equal(o.recentTrades.length, 0);
  });
  it("validates input and toggles the kill switch", async () => {
    const bad = await fetch(`${base}/api/backtests/run`, {
      method: "POST",
      headers: { cookie, "x-qf-request": "1" },
      body: JSON.stringify({ days: "many" }),
    });
    assert.equal(bad.status, 400, "invalid input is a client error");
    const ks = await fetch(`${base}/api/risk/kill-switch`, {
      method: "POST",
      headers: { cookie, "x-qf-request": "1" },
      body: JSON.stringify({ on: true, reason: "test" }),
    });
    assert.equal(ks.status, 200);
    assert.equal(app.risk.controls().killSwitch.on, true);
  });
  it("streams server-sent events", async () => {
    const controller = new AbortController();
    const r = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: controller.signal });
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    controller.abort();
  });
});
