// Runs the specialist agents with time budgets and isolation, then the AI Judge.
// An agent that throws is reported as "error"; one that exceeds its time budget has its output discarded and
// is reported as "timeout". Neither can block the decision or weaken risk protection.

import { withTimeout } from "../../core/util.js";
import { DIRECTIONAL_WEIGHTS, SPECIALISTS } from "./agents.js";
import type { LlmJudge, LlmVerdict } from "./llm.js";
import type { AgentDefinition, AgentReport, MarketContext } from "./types.js";

export function runAgent(def: AgentDefinition, ctx: MarketContext, budgetMs: number): AgentReport {
  const started = performance.now();
  try {
    const out = def.run(ctx);
    const durationMs = performance.now() - started;
    if (durationMs > budgetMs) {
      return {
        agent: def.id,
        status: "timeout",
        bias: 0,
        confidence: 0,
        summary: `exceeded its ${budgetMs} ms budget (${durationMs.toFixed(0)} ms); output discarded`,
        evidence: [],
        veto: null,
        durationMs,
      };
    }
    return {
      agent: def.id,
      status: out.status ?? "ok",
      bias: Number.isFinite(out.bias) ? Math.max(-1, Math.min(1, out.bias)) : 0,
      confidence: Number.isFinite(out.confidence) ? Math.max(0, Math.min(1, out.confidence)) : 0,
      summary: out.summary,
      evidence: out.evidence,
      veto: out.veto,
      durationMs,
    };
  } catch (error) {
    return {
      agent: def.id,
      status: "error",
      bias: 0,
      confidence: 0,
      summary: `failed: ${(error as Error).message}`,
      evidence: [],
      veto: null,
      durationMs: performance.now() - started,
    };
  }
}

export type JudgeResult = {
  report: AgentReport;
  confidence: number;
  consensus: number;
  vetoes: string[];
  llm: LlmVerdict | { skipped: string } | null;
};

/**
 * The AI Judge. Confidence = strategy quality (from its validation) + 0.15 × directional consensus of the
 * agents with the proposed side, scaled down for imperfect data; any veto blocks the trade. An optional LLM
 * review can lower confidence (caution −0.1) or veto; it can never raise confidence.
 */
export async function judge(
  ctx: MarketContext,
  reports: AgentReport[],
  quality: number,
  llm: LlmJudge | null,
  timeoutMs: number,
): Promise<JudgeResult> {
  const started = performance.now();
  const side = ctx.proposal ? (ctx.proposal.side === "long" ? 1 : -1) : 0;
  let num = 0;
  let den = 0;
  for (const r of reports) {
    const w = DIRECTIONAL_WEIGHTS[r.agent];
    if (!w || r.status !== "ok") continue;
    num += w * r.confidence * r.bias * side;
    den += w * r.confidence;
  }
  const consensus = den > 0 ? num / den : 0;
  const dataFactor = ctx.quality.fresh ? (ctx.quality.missingBars === 0 ? 1 : 0.85) : 0;
  let confidence = side === 0 ? 0 : Math.max(0, Math.min(1, (quality + 0.15 * consensus) * dataFactor));
  const vetoes = reports.filter((r) => r.veto).map((r) => `${r.agent}: ${r.veto}`);
  let llmResult: JudgeResult["llm"] = null;
  if (ctx.proposal && vetoes.length === 0 && llm?.enabled()) {
    try {
      llmResult = await withTimeout(
        timeoutMs,
        (signal) =>
          llm.review(
            { side: ctx.proposal?.side ?? "", strategyId: ctx.proposal?.strategyId ?? "" },
            reports,
            signal,
          ),
        "LLM review",
      );
    } catch (error) {
      llmResult = { skipped: `LLM review failed: ${(error as Error).message}` };
    }
    if ("stance" in llmResult) {
      if (llmResult.stance === "veto")
        vetoes.push(`ai_judge(llm): ${llmResult.reasons.map((r) => r.text).join("; ")}`);
      if (llmResult.stance === "caution") confidence = Math.max(0, confidence - 0.1);
    }
  }
  const summary = !ctx.proposal
    ? "no trade proposal to judge"
    : vetoes.length
      ? `veto: ${vetoes.join(" | ")}`
      : `confidence ${confidence.toFixed(2)} (strategy quality ${quality.toFixed(2)}, agent consensus ${consensus >= 0 ? "+" : ""}${consensus.toFixed(2)})`;
  return {
    report: {
      agent: "ai_judge",
      status: "ok",
      bias: side * confidence,
      confidence,
      summary,
      evidence: [
        { id: "judge.strategy_quality", label: "strategy quality", value: Math.round(quality * 1000) / 1000 },
        {
          id: "judge.consensus",
          label: "agent consensus with the proposal",
          value: Math.round(consensus * 1000) / 1000,
        },
        { id: "judge.data_factor", label: "data-quality factor", value: dataFactor },
        {
          id: "judge.llm",
          label: "LLM review",
          value: llmResult
            ? "stance" in llmResult
              ? llmResult.stance
              : `skipped: ${llmResult.skipped}`
            : "not used",
        },
      ],
      veto: vetoes.length ? vetoes.join(" | ") : null,
      durationMs: performance.now() - started,
    },
    confidence,
    consensus,
    vetoes,
    llm: llmResult,
  };
}

export function runSpecialists(ctx: MarketContext, budgetMs: number): AgentReport[] {
  return SPECIALISTS.map((def) => runAgent(def, ctx, budgetMs));
}

/** Agent catalogue for the dashboard. */
export function agentCatalogue(): {
  id: string;
  label: string;
  responsibility: string;
  inputs: string;
  outputs: string;
}[] {
  return [
    ...SPECIALISTS.map(({ id, label, responsibility, inputs, outputs }) => ({
      id,
      label,
      responsibility,
      inputs,
      outputs,
    })),
    {
      id: "ai_judge",
      label: "AI Judge Agent",
      responsibility:
        "Combine strategy quality, agent consensus and data quality into a confidence; apply vetoes; optional LLM review that can only add caution.",
      inputs: "all specialist reports, the trade proposal, strategy validation statistics",
      outputs: "confidence and veto list for the decision engine",
    },
  ];
}
