import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../../src/quantforge/config/schema.js";
import { resample } from "../../src/quantforge/data/resample.js";
import { Database } from "../../src/quantforge/database/db.js";
import { StateRepo } from "../../src/quantforge/database/repositories.js";
import { SPECIALISTS } from "../../src/quantforge/intelligence/agents/agents.js";
import { LlmJudge } from "../../src/quantforge/intelligence/agents/llm.js";
import { judge, runAgent, runSpecialists } from "../../src/quantforge/intelligence/agents/runner.js";
import type { AgentDefinition, MarketContext } from "../../src/quantforge/intelligence/agents/types.js";
import { computeFeatures } from "../../src/quantforge/intelligence/features.js";
import { classifyAt } from "../../src/quantforge/intelligence/regime.js";
import { defaultControls } from "../../src/quantforge/risk/engine.js";
import {
  loadOrCreateToken,
  RateLimiter,
  SessionStore,
  tokensEqual,
} from "../../src/quantforge/security/auth.js";
import { createBackup, restoreBackup } from "../../src/quantforge/security/backup.js";
import { syntheticMarket, tempHome } from "../helpers.js";

function context(proposal: MarketContext["proposal"] = null): MarketContext {
  const f = computeFeatures(resample(syntheticMarket({ days: 20, seed: 31 }), "5m", "15m"), "15m");
  const i = f.n - 1;
  return {
    now: (f.ts[i] as number) + 900_000 + 30_000,
    tf: "15m",
    features: f,
    i,
    regime: classifyAt(f, i),
    quote: {
      symbol: "XAUUSD",
      price: f.close[i] as number,
      bid: (f.close[i] as number) - 0.2,
      ask: (f.close[i] as number) + 0.2,
      spread: 0.4,
      spreadSource: "modelled",
      ts: Date.now(),
      provider: "t",
    },
    quality: { fresh: true, missingBars: 0, staleQuoteBars: 0, ageBars: 0 },
    macro: { eurusd: [], xagusd: [] },
    signal: {
      action: proposal ? (proposal.side === "long" ? "BUY" : "SELL") : "NO_TRADE",
      barTs: f.ts[i] as number,
      model: proposal?.model ?? null,
      side: proposal?.side ?? null,
      entry: proposal?.entry ?? null,
      sl: proposal?.sl ?? null,
      tp: proposal?.tp ?? null,
      rr: proposal ? 2 : null,
      score: proposal ? 75 : 0,
      atr: f.atr[i] as number,
      regime: "test",
      allowedModels: ["trend_pullback", "breakout_retest"],
      evaluations: [],
      reasons: [],
      rejected: [],
      exit: null,
    },
    modelPerformance: [],
    account: {
      balance: 1000,
      equity: 1000,
      dayStartEquity: 1000,
      weekStartEquity: 1000,
      peakEquity: 1000,
      openPositions: [],
      tradesToday: 0,
      consecutiveLosses: 0,
      freeMargin: 1000,
    },
    controls: defaultControls(),
    config: structuredClone(DEFAULT_CONFIG),
    providerHealthy: true,
    proposal,
  };
}

describe("agents", () => {
  it("every specialist returns a bounded, evidence-backed report", () => {
    const reports = runSpecialists(
      context({ side: "long", model: "trend_pullback", entry: 2650, sl: 2645, tp: 2660 }),
      2000,
    );
    assert.equal(reports.length, 5);
    for (const r of reports) {
      assert.ok(["ok", "insufficient_data"].includes(r.status), `${r.agent}: ${r.status} ${r.summary}`);
      assert.ok(r.bias >= -1 && r.bias <= 1);
      assert.ok(r.confidence >= 0 && r.confidence <= 1);
      assert.ok(r.summary.length > 0);
    }
    assert.equal(
      reports.find((r) => r.agent === "macro")?.status,
      "insufficient_data",
      "no macro data → no invented view",
    );
  });
  it("a failing agent is isolated and an over-budget agent is discarded", () => {
    const boom: AgentDefinition = {
      ...(SPECIALISTS[0] as AgentDefinition),
      run: () => {
        throw new Error("kaput");
      },
    };
    assert.equal(runAgent(boom, context(), 100).status, "error");
    const slow: AgentDefinition = {
      ...(SPECIALISTS[0] as AgentDefinition),
      run: (c) => {
        const end = Date.now() + 30;
        while (Date.now() < end) {}
        return (SPECIALISTS[0] as AgentDefinition).run(c);
      },
    };
    const r = runAgent(slow, context(), 5);
    assert.equal(r.status, "timeout");
    assert.equal(r.confidence, 0);
  });
  it("the risk agent vetoes while the kill switch is on", () => {
    const ctx = context({ side: "long", model: "trend_pullback", entry: 2650, sl: 2645, tp: 2660 });
    ctx.controls.killSwitch = { on: true, reason: "test", ts: 1 };
    const risk = runSpecialists(ctx, 2000).find((r) => r.agent === "risk");
    assert.match(risk?.veto ?? "", /kill switch/);
  });
  it("the judge turns any veto into a block and never raises confidence through the LLM", async () => {
    const ctx = context({ side: "long", model: "trend_pullback", entry: 2650, sl: 2645, tp: 2660 });
    // Clear specialist vetoes (the synthetic clock may sit near a market close) so the LLM path is exercised.
    const reports = runSpecialists(ctx, 2000).map((r) => ({ ...r, veto: null }));
    const db = Database.open(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.llm.enabled = true;
    const fake = (text: string) => ({
      model: "fake",
      async *stream() {
        yield { type: "text" as const, text };
        yield {
          type: "finish" as const,
          reason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1 } as never,
        };
      },
    });
    const base = await judge(ctx, reports, null, 1000);
    const agree = await judge(
      ctx,
      reports,
      new LlmJudge(
        config,
        "k",
        new StateRepo(db),
        Date.now,
        fake(JSON.stringify({ stance: "agree", reasons: [{ text: "fine", evidence: ["vol.atr"] }] })),
      ),
      1000,
    );
    assert.equal(agree.confidence, base.confidence, "agreement cannot raise confidence");
    const caution = await judge(
      ctx,
      reports,
      new LlmJudge(
        config,
        "k",
        new StateRepo(db),
        Date.now,
        fake(JSON.stringify({ stance: "caution", reasons: [{ text: "mixed", evidence: ["vol.atr"] }] })),
      ),
      1000,
    );
    assert.ok(caution.confidence < base.confidence);
    const veto = await judge(
      ctx,
      reports,
      new LlmJudge(
        config,
        "k",
        new StateRepo(db),
        Date.now,
        fake(JSON.stringify({ stance: "veto", reasons: [{ text: "no", evidence: ["regime.label"] }] })),
      ),
      1000,
    );
    assert.ok(veto.vetoes.length > 0);
    const invented = await judge(
      ctx,
      reports,
      new LlmJudge(
        config,
        "k",
        new StateRepo(db),
        Date.now,
        fake(JSON.stringify({ stance: "veto", reasons: [{ text: "price is 9999", evidence: ["made.up"] }] })),
      ),
      1000,
    );
    assert.equal(invented.vetoes.length, 0, "an answer citing non-existent evidence is discarded");
    assert.ok(invented.llm && "skipped" in invented.llm);
    const garbage = await judge(
      ctx,
      reports,
      new LlmJudge(config, "k", new StateRepo(db), Date.now, fake("not json")),
      1000,
    );
    assert.equal(garbage.confidence, base.confidence);
  });
});

describe("security", () => {
  it("creates a private dashboard token and compares tokens in constant time", async () => {
    const { paths, cleanup } = tempHome();
    try {
      const a = await loadOrCreateToken(paths.dashboardToken);
      const b = await loadOrCreateToken(paths.dashboardToken);
      assert.equal(a.created, true);
      assert.equal(b.token, a.token);
      assert.ok(tokensEqual(a.token, b.token));
      assert.ok(!tokensEqual(a.token, `${a.token}x`));
    } finally {
      cleanup();
    }
  });
  it("sessions expire and the rate limiter caps attempts", () => {
    const s = new SessionStore(-1);
    assert.equal(s.valid(s.create()), false);
    const ok = new SessionStore(60_000);
    const id = ok.create();
    assert.ok(ok.valid(id));
    ok.revoke(id);
    assert.equal(ok.valid(id), false);
    const rl = new RateLimiter(2, 60_000);
    assert.deepEqual([rl.allow("a"), rl.allow("a"), rl.allow("a"), rl.allow("b")], [true, true, false, true]);
  });
  it("backs up and restores the database, encrypted, and detects tampering", () => {
    const { paths, cleanup } = tempHome();
    try {
      const db = Database.open(paths.db);
      db.run("INSERT INTO kv_state(key, value_json, updated_at) VALUES ('x', '42', 1)");
      const file = createBackup(db, paths, 5, "correct horse battery");
      assert.match(file, /\.enc$/);
      db.run("UPDATE kv_state SET value_json='0' WHERE key='x'");
      db.close();
      assert.throws(
        () => restoreBackup(file, paths, "wrong"),
        /unable to authenticate|bad decrypt|Unsupported state/i,
      );
      restoreBackup(file, paths, "correct horse battery");
      const back = Database.open(paths.db);
      assert.equal(
        back.get<{ value_json: string }>("SELECT value_json FROM kv_state WHERE key='x'")?.value_json,
        "42",
      );
      back.close();
      writeFileSync(file, "tampered");
      assert.throws(() => restoreBackup(file, paths, "correct horse battery"), /checksum/);
    } finally {
      cleanup();
    }
  });
});
