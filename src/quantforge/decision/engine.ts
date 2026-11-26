// Deterministic trade decision engine. At each closed decision-timeframe bar it combines: data quality, the
// regime, active validated strategies' signals, the agents' assessments and vetoes, and the risk engine's
// verdict, and produces BUY, SELL or NO_TRADE with full reasons, including why each alternative was rejected.
// NO_TRADE is the normal outcome; the risk engine has the final word.

import type { QuantForgeConfig } from "../config/schema.js";
import { minutesToClose, nextCloseIsWeekend } from "../core/time.js";
import { type Action, type Quote, type Regime, TF_MS } from "../core/types.js";
import type { Database } from "../database/db.js";
import type { LlmJudge } from "../intelligence/agents/llm.js";
import { judge, runSpecialists } from "../intelligence/agents/runner.js";
import type { ActiveStrategy, AgentReport, MarketContext } from "../intelligence/agents/types.js";
import type { FeatureSet } from "../intelligence/features.js";
import type { AccountView, Controls, RiskEngine, RiskVerdict } from "../risk/engine.js";
import { signalAt } from "../strategy/signals.js";
import type { StrategySpec } from "../strategy/spec.js";

export type Decision = {
  id?: number;
  ts: number;
  barTs: number;
  tf: string;
  mode: "paper" | "live";
  action: Action;
  strategyId: string | null;
  regime: string;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  rr: number | null;
  lots: number | null;
  holdingBars: number | null;
  expectedHoldingMinutes: number | null;
  confidence: number;
  reasons: string[];
  rejectedAlternatives: { action: Action; reason: string }[];
  risk: RiskVerdict | null;
  agents: AgentReport[];
  judge: AgentReport | null;
  atr: number | null;
  spec: StrategySpec | null;
};

export function strategyQuality(s: ActiveStrategy | undefined): number {
  if (!s) return 0;
  const dsr = s.validation.dsr ?? 0;
  const pf = s.validation.testProfitFactor ?? 1;
  const ci = s.validation.ciLow ?? 0;
  return Math.max(
    0.35,
    Math.min(
      0.9,
      0.45 + 0.25 * dsr + 0.1 * Math.min(1, Math.max(0, pf - 1)) + 0.1 * Math.min(1, Math.max(0, ci * 5)),
    ),
  );
}

export type DecisionInput = {
  now: number;
  features: FeatureSet;
  trend: Uint8Array;
  regime: Regime;
  quote: Quote | null;
  quality: MarketContext["quality"];
  macro: MarketContext["macro"];
  active: { spec: StrategySpec; summary: ActiveStrategy | undefined }[];
  account: AccountView;
  controls: Controls;
  providerHealthy: boolean;
  mode: "paper" | "live";
};

export class DecisionEngine {
  constructor(
    private config: QuantForgeConfig,
    private readonly risk: RiskEngine,
    private readonly llm: LlmJudge | null,
  ) {}

  setConfig(config: QuantForgeConfig): void {
    this.config = config;
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const f = input.features;
    const i = f.n - 1;
    const barTs = f.ts[i] as number;
    const atr = f.atr[i] as number;
    const tfLen = TF_MS[f.tf];
    const reasons: string[] = [];
    const rejected: Decision["rejectedAlternatives"] = [];
    const baseCtx: MarketContext = {
      now: input.now,
      tf: f.tf,
      features: f,
      i,
      regime: input.regime,
      quote: input.quote,
      quality: input.quality,
      macro: input.macro,
      strategies: input.active.map((a) => a.summary).filter((s): s is ActiveStrategy => s !== undefined),
      account: input.account,
      controls: input.controls,
      config: this.config,
      providerHealthy: input.providerHealthy,
      proposal: null,
    };
    const noTrade = (
      why: string[],
      agents: AgentReport[],
      judgeReport: AgentReport | null,
      riskVerdict: RiskVerdict | null = null,
      strategyId: string | null = null,
    ): Decision => ({
      ts: input.now,
      barTs,
      tf: f.tf,
      mode: input.mode,
      action: "NO_TRADE",
      strategyId,
      regime: input.regime.label,
      entry: null,
      sl: null,
      tp: null,
      rr: null,
      lots: null,
      holdingBars: null,
      expectedHoldingMinutes: null,
      confidence: judgeReport?.confidence ?? 0,
      reasons: why,
      rejectedAlternatives: rejected,
      risk: riskVerdict,
      agents,
      judge: judgeReport,
      atr: Number.isFinite(atr) ? atr : null,
      spec: null,
    });

    // Signals of every active strategy at this bar (stale bars are not acted on).
    const age = (input.now - (barTs + tfLen)) / tfLen;
    const signals = input.active
      .map((a) => ({ ...a, side: signalAt(a.spec, f, input.trend, i) }))
      .filter((s) => s.side !== 0);
    if (input.active.length === 0)
      reasons.push("no validated strategy is active (discovery has not demonstrated a robust edge)");
    else if (!signals.length)
      reasons.push(`none of the ${input.active.length} active strategies signalled on this bar`);
    if (age > this.config.decision.maxSignalAgeBars)
      reasons.push(`bar is ${age.toFixed(1)} bars old; signals are only acted on when fresh`);
    const buys = signals.filter((s) => s.side > 0);
    const sells = signals.filter((s) => s.side < 0);
    if (!buys.length) rejected.push({ action: "BUY", reason: "no active strategy signalled a long entry" });
    if (!sells.length)
      rejected.push({ action: "SELL", reason: "no active strategy signalled a short entry" });
    if (buys.length && sells.length) {
      reasons.push("active strategies disagree (long and short signals on the same bar)");
      rejected.push(
        { action: "BUY", reason: "conflicting short signal" },
        { action: "SELL", reason: "conflicting long signal" },
      );
    }
    const agentsNoProposal = () => runSpecialists(baseCtx, this.config.agents.timeoutMs);
    if (!signals.length || (buys.length && sells.length) || age > this.config.decision.maxSignalAgeBars) {
      const agents = agentsNoProposal();
      const j = await judge(baseCtx, agents, 0, null, this.config.agents.llm.timeoutMs);
      return noTrade(reasons, agents, j.report);
    }
    // Best signalling strategy by validation score.
    const chosen = signals.sort(
      (a, b) => (b.summary?.score ?? 0) - (a.summary?.score ?? 0),
    )[0] as (typeof signals)[number];
    const side = chosen.side > 0 ? "long" : "short";
    const action: Action = side === "long" ? "BUY" : "SELL";
    const s = side === "long" ? 1 : -1;
    const entry = input.quote
      ? side === "long"
        ? input.quote.ask
        : input.quote.bid
      : (f.close[i] as number);
    const stopDist = chosen.spec.exit.slAtr * atr;
    const sl = entry - s * stopDist;
    const tp = entry + s * chosen.spec.exit.tpR * stopDist;
    const ctx: MarketContext = { ...baseCtx, proposal: { side, strategyId: chosen.spec.id, entry, sl, tp } };
    const agents = runSpecialists(ctx, this.config.agents.timeoutMs);
    const quality = strategyQuality(chosen.summary);
    const j = await judge(ctx, agents, quality, this.llm, this.config.agents.llm.timeoutMs);
    reasons.push(
      `${chosen.spec.id} (${chosen.spec.family}) signalled ${action} at the close of the ${f.tf} bar ${new Date(barTs).toISOString()}`,
    );
    if (j.vetoes.length) {
      rejected.push({ action, reason: `vetoed: ${j.vetoes.join(" | ")}` });
      return noTrade(
        [...reasons, `vetoed by agents: ${j.vetoes.join(" | ")}`],
        agents,
        j.report,
        null,
        chosen.spec.id,
      );
    }
    if (j.confidence < this.config.decision.minConfidence) {
      rejected.push({
        action,
        reason: `confidence ${j.confidence.toFixed(2)} below the ${this.config.decision.minConfidence} minimum`,
      });
      return noTrade(
        [
          ...reasons,
          `confidence ${j.confidence.toFixed(2)} below minimum ${this.config.decision.minConfidence}`,
        ],
        agents,
        j.report,
        null,
        chosen.spec.id,
      );
    }
    const verdict = this.risk.evaluate(
      {
        side,
        entry,
        sl,
        tp,
        spread: input.quote?.spread ?? this.config.costs.spread,
        expectedSlippage: this.config.costs.slippage,
        atrPercentile: f.atrPct[i] as number,
        ts: input.now,
        dataFresh: input.quality.fresh,
        minutesToClose: minutesToClose(input.now),
        closeIsWeekend: nextCloseIsWeekend(input.now),
        expectedHoldingMinutes: chosen.spec.exit.maxBars * (tfLen / 60_000),
      },
      input.account,
    );
    if (!verdict.allowed) {
      rejected.push({ action, reason: `risk engine refused: ${verdict.reasons.join("; ")}` });
      return noTrade(
        [...reasons, `risk engine refused: ${verdict.reasons.join("; ")}`],
        agents,
        j.report,
        verdict,
        chosen.spec.id,
      );
    }
    rejected.push({
      action: "NO_TRADE",
      reason: "a validated strategy signalled, agents raised no veto, confidence and every risk rule passed",
    });
    if (action === "BUY") rejected.push({ action: "SELL", reason: "opposite to the signal" });
    else rejected.push({ action: "BUY", reason: "opposite to the signal" });
    const lots = verdict.sizing?.ok ? verdict.sizing.lots : null;
    return {
      ts: input.now,
      barTs,
      tf: f.tf,
      mode: input.mode,
      action,
      strategyId: chosen.spec.id,
      regime: input.regime.label,
      entry,
      sl,
      tp,
      rr: chosen.spec.exit.tpR,
      lots,
      holdingBars: chosen.spec.exit.maxBars,
      expectedHoldingMinutes: chosen.spec.exit.maxBars * (tfLen / 60_000),
      confidence: j.confidence,
      reasons: [
        ...reasons,
        j.report.summary,
        `size ${lots} lots risking ${verdict.sizing?.ok ? verdict.sizing.lossAtStopUsd.toFixed(2) : "?"} USD`,
      ],
      rejectedAlternatives: rejected,
      risk: verdict,
      agents,
      judge: j.report,
      atr,
      spec: chosen.spec,
    };
  }
}

export function saveDecision(db: Database, d: Decision): number {
  return db.tx(() => {
    const existing = db.get<{ id: number }>(
      "SELECT id FROM decisions WHERE tf=? AND bar_ts=?",
      d.tf,
      d.barTs,
    );
    if (existing) return existing.id;
    const id = db.run(
      `INSERT INTO decisions(ts, bar_ts, tf, mode, action, strategy_id, regime, entry, sl, tp, rr, lots, holding_bars, confidence, reasons_json, rejected_json, risk_json, judge_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      d.ts,
      d.barTs,
      d.tf,
      d.mode,
      d.action,
      d.strategyId,
      d.regime,
      d.entry,
      d.sl,
      d.tp,
      d.rr,
      d.lots,
      d.holdingBars,
      d.confidence,
      JSON.stringify(d.reasons),
      JSON.stringify(d.rejectedAlternatives),
      d.risk ? JSON.stringify(d.risk) : null,
      d.judge ? JSON.stringify(d.judge) : null,
    ).lastId;
    for (const a of [...d.agents, ...(d.judge ? [d.judge] : [])]) {
      db.run(
        "INSERT INTO agent_reports(decision_id, ts, agent, status, bias, confidence, summary, evidence_json, veto, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
        id,
        d.ts,
        a.agent,
        a.status,
        a.bias,
        a.confidence,
        a.summary,
        JSON.stringify(a.evidence),
        a.veto,
        Math.round(a.durationMs),
      );
    }
    if (d.strategyId && d.action !== "NO_TRADE")
      db.run(
        "INSERT INTO signals(decision_id, strategy_id, bar_ts, side, ts) VALUES (?,?,?,?,?)",
        id,
        d.strategyId,
        d.barTs,
        d.action === "BUY" ? "long" : "short",
        d.ts,
      );
    return id;
  });
}
