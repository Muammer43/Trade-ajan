// Deterministic trade decision at each closed 15-minute candle:
//   strategy engine (regime → model → setup → score)  →  agents (assessment, vetoes)  →  AI Judge (confidence,
//   contradiction check)  →  risk engine (every limit, lot size; final authority)  →  BUY / SELL / NO_TRADE.
// The same function runs live, on paper and in the backtest, so all three trade identical rules.

import type { QuantForgeConfig } from "../config/schema.js";
import { minutesToClose, nextCloseIsWeekend } from "../core/time.js";
import { type Action, type Quote, TF_MS } from "../core/types.js";
import type { Database } from "../database/db.js";
import type { LlmJudge } from "../intelligence/agents/llm.js";
import { judge, runSpecialists } from "../intelligence/agents/runner.js";
import type { AgentReport, MarketContext, ModelPerformance } from "../intelligence/agents/types.js";
import { classifyAt } from "../intelligence/regime.js";
import type { AccountView, Controls, RiskEngine, RiskVerdict } from "../risk/engine.js";
import { evaluateStrategy } from "../strategy/engine.js";
import type { TradingFrame } from "../strategy/structure.js";
import type { ExitRules, ModelId, StrategySignal } from "../strategy/types.js";

export type Decision = {
  id?: number;
  ts: number;
  barTs: number;
  tf: string;
  mode: "paper" | "live";
  action: Action;
  model: ModelId | null;
  regime: string;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  rr: number | null;
  lots: number | null;
  riskPct: number | null;
  riskUsd: number | null;
  holdingBars: number | null;
  score: number;
  confidence: number;
  reasons: string[];
  rejectedAlternatives: { action: Action; reason: string }[];
  risk: RiskVerdict | null;
  agents: AgentReport[];
  judge: AgentReport | null;
  atr: number | null;
  exit: ExitRules | null;
  signal: StrategySignal;
};

export type DecisionInput = {
  now: number;
  frame: TradingFrame;
  /** Index of the closed candle being decided (normally the last). */
  i: number;
  quote: Quote | null;
  quality: MarketContext["quality"];
  macro: MarketContext["macro"];
  account: AccountView;
  controls: Controls;
  providerHealthy: boolean;
  mode: "paper" | "live";
  modelPerformance: ModelPerformance[];
  /** Skip agents when the strategy has no signal (backtests: the outcome is NO_TRADE either way). */
  agentsOnlyOnSignal?: boolean;
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
    const { frame, i } = input;
    const barTs = frame.ts(i);
    const tfLen = TF_MS["15m"];
    const signal = evaluateStrategy(frame, i, this.config);
    const age = (input.now - (barTs + tfLen)) / tfLen;
    const proposal =
      signal.side && signal.model && signal.entry !== null && signal.sl !== null && signal.tp !== null
        ? {
            side: signal.side,
            model: signal.model,
            entry: input.quote ? (signal.side === "long" ? input.quote.ask : input.quote.bid) : signal.entry,
            sl: signal.sl,
            tp: signal.tp,
          }
        : null;
    const ctx: MarketContext = {
      now: input.now,
      tf: "15m",
      features: frame.f,
      i,
      regime: classifyAt(frame.f, i),
      quote: input.quote,
      quality: input.quality,
      macro: input.macro,
      signal,
      modelPerformance: input.modelPerformance,
      account: input.account,
      controls: input.controls,
      config: this.config,
      providerHealthy: input.providerHealthy,
      proposal,
    };
    const rejected = [...signal.rejected];
    const base = {
      ts: input.now,
      barTs,
      tf: "15m",
      mode: input.mode,
      regime: signal.regime,
      atr: Number.isFinite(signal.atr) ? signal.atr : null,
      signal,
      score: signal.score,
    };
    const noTrade = (
      reasons: string[],
      agents: AgentReport[],
      judgeReport: AgentReport | null,
      verdict: RiskVerdict | null = null,
    ): Decision => ({
      ...base,
      action: "NO_TRADE",
      model: signal.model,
      entry: null,
      sl: null,
      tp: null,
      rr: null,
      lots: null,
      riskPct: null,
      riskUsd: null,
      holdingBars: null,
      confidence: judgeReport?.confidence ?? 0,
      reasons,
      rejectedAlternatives: rejected,
      risk: verdict,
      agents,
      judge: judgeReport,
      exit: null,
    });

    if (!proposal) {
      if (input.agentsOnlyOnSignal) return noTrade(signal.reasons, [], null);
      const agents = runSpecialists(ctx, this.config.agents.timeoutMs);
      const j = await judge(ctx, agents, null, this.config.agents.llm.timeoutMs);
      return noTrade(signal.reasons, agents, j.report);
    }
    const action: Action = signal.action;
    if (age > this.config.decision.maxSignalAgeBars) {
      rejected.push({
        action,
        reason: `candle is ${age.toFixed(1)} candles old; only fresh signals are traded`,
      });
      return noTrade([...signal.reasons, `signal is stale (${age.toFixed(1)} candles old)`], [], null);
    }
    const agents = runSpecialists(ctx, this.config.agents.timeoutMs);
    const j = await judge(ctx, agents, this.llm, this.config.agents.llm.timeoutMs);
    if (j.vetoes.length) {
      rejected.push({ action, reason: `rejected by the agents: ${j.vetoes.join(" | ")}` });
      return noTrade([...signal.reasons, `rejected: ${j.vetoes.join(" | ")}`], agents, j.report);
    }
    if (j.confidence < this.config.decision.minConfidence) {
      rejected.push({
        action,
        reason: `confidence ${j.confidence.toFixed(2)} below ${this.config.decision.minConfidence}`,
      });
      return noTrade(
        [
          ...signal.reasons,
          `confidence ${j.confidence.toFixed(2)} below ${this.config.decision.minConfidence}`,
        ],
        agents,
        j.report,
      );
    }
    // Re-anchor the stop and target to the executable price, keeping the structural distances.
    const s = proposal.side === "long" ? 1 : -1;
    const stopDist = Math.abs((signal.entry as number) - proposal.sl);
    const rewardDist = Math.abs((signal.tp as number) - (signal.entry as number));
    const entry = proposal.entry;
    const sl = entry - s * stopDist;
    const tp = entry + s * rewardDist;
    const exit = signal.exit as ExitRules;
    const verdict = this.risk.evaluate(
      {
        side: proposal.side,
        entry,
        sl,
        tp,
        spread: input.quote?.spread ?? this.config.costs.spread,
        expectedSlippage: this.config.costs.slippage,
        atrPercentile: frame.f.atrPct[i] as number,
        ts: input.now,
        dataFresh: input.quality.fresh,
        minutesToClose: minutesToClose(input.now),
        closeIsWeekend: nextCloseIsWeekend(input.now),
        expectedHoldingMinutes: exit.maxBars * 15,
      },
      input.account,
    );
    if (!verdict.allowed) {
      rejected.push({ action, reason: `risk engine refused: ${verdict.reasons.join("; ")}` });
      return noTrade(
        [...signal.reasons, `risk engine refused: ${verdict.reasons.join("; ")}`],
        agents,
        j.report,
        verdict,
      );
    }
    const sizing = verdict.sizing?.ok ? verdict.sizing : null;
    return {
      ...base,
      action,
      model: proposal.model,
      entry,
      sl,
      tp,
      rr: rewardDist / stopDist,
      lots: sizing?.lots ?? null,
      riskPct: sizing ? (sizing.lossAtStopUsd / input.account.equity) * 100 : null,
      riskUsd: sizing?.lossAtStopUsd ?? null,
      holdingBars: exit.maxBars,
      confidence: j.confidence,
      reasons: [
        ...signal.reasons,
        j.report.summary,
        sizing ? `${sizing.lots} lots, loss at stop ${sizing.lossAtStopUsd.toFixed(2)} USD` : "",
      ].filter(Boolean),
      rejectedAlternatives: rejected,
      risk: verdict,
      agents,
      judge: j.report,
      exit,
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
    const components = d.signal.evaluations.map((e) => ({
      model: e.model,
      triggered: e.triggered,
      side: e.side,
      score: e.score,
      rejection: e.rejection,
      components: e.components,
    }));
    const id = db.run(
      `INSERT INTO decisions(ts, bar_ts, tf, mode, action, strategy_id, regime, entry, sl, tp, rr, lots, holding_bars, confidence, reasons_json, rejected_json, risk_json, judge_json, model, score, risk_pct, components_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      d.ts,
      d.barTs,
      d.tf,
      d.mode,
      d.action,
      d.model,
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
      d.model,
      d.score,
      d.riskPct,
      JSON.stringify(components),
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
    if (d.model && d.action !== "NO_TRADE")
      db.run(
        "INSERT INTO signals(decision_id, strategy_id, bar_ts, side, ts) VALUES (?,?,?,?,?)",
        id,
        d.model,
        d.barTs,
        d.action === "BUY" ? "long" : "short",
        d.ts,
      );
    return id;
  });
}
