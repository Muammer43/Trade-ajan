// Optional LLM review for the AI Judge, through the original TradingAgents model-provider layer
// (src/models/providers.ts). The model sees only the structured evidence, must answer in a fixed JSON schema,
// may cite only evidence ids it was given, and can only agree, ask for caution (lower confidence) or veto.
// It can never raise confidence, set a price, or turn NO TRADE into a trade. Any malformed answer, invalid
// citation, timeout or error is discarded and the deterministic decision stands.

import type { ModelRoute } from "../../../contracts/index.js";
import { providerOf } from "../../../models/providers.js";
import type { QuantForgeConfig } from "../../config/schema.js";
import type { StateRepo } from "../../database/repositories.js";
import type { AgentReport, Evidence } from "./types.js";

export type LlmVerdict = {
  stance: "agree" | "caution" | "veto";
  reasons: { text: string; evidence: string[] }[];
  model: string;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stance", "reasons"],
  properties: {
    stance: { type: "string", enum: ["agree", "caution", "veto"] },
    reasons: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence"],
        properties: {
          text: { type: "string", maxLength: 300 },
          evidence: { type: "array", items: { type: "string" }, maxItems: 6 },
        },
      },
    },
  },
} as const;

const SYSTEM = `You are the AI Judge reviewing a proposed XAUUSD paper trade for QuantForge AI.
You receive structured evidence produced by deterministic analysts. Rules:
- Use only the evidence given. Never state a price, level, spread or indicator value that is not in the evidence.
- Cite evidence by its id in each reason.
- Answer "agree" if the evidence is consistent with the trade, "caution" if it is mixed, "veto" if it clearly argues against it.
- You cannot change sizes, stops or targets. Reply with JSON only.`;

function routeOf(config: QuantForgeConfig, apiKey: string | undefined): ModelRoute | { error: string } {
  const l = config.agents.llm;
  if (l.provider === "openai-compatible") {
    if (!l.baseURL) return { error: "agents.llm.baseURL is required for openai-compatible" };
    return {
      provider: "openai-compatible",
      model: l.model,
      baseURL: l.baseURL,
      thinking: "none",
      sampling: { thinking: {}, plain: {} },
      ...(apiKey ? { apiKey } : {}),
    };
  }
  if (!apiKey) return { error: `no API key for ${l.provider}` };
  return { provider: l.provider, model: l.model, apiKey };
}

export class LlmJudge {
  constructor(
    private readonly config: QuantForgeConfig,
    private readonly apiKey: string | undefined,
    private readonly state: StateRepo,
    private readonly now: () => number = Date.now,
    /** Injected client stream (tests). */
    private readonly clientOverride?: {
      model: string;
      stream: ReturnType<ReturnType<typeof providerOf>["client"]>["stream"];
    },
  ) {}

  enabled(): boolean {
    return this.config.agents.llm.enabled;
  }

  private budgetOk(): boolean {
    const key = `llm.calls.${new Date(this.now()).toISOString().slice(0, 10)}`;
    const used = this.state.get<number>(key) ?? 0;
    if (used >= this.config.agents.llm.maxCallsPerDay) return false;
    this.state.set(key, used + 1);
    return true;
  }

  async review(
    proposal: { side: string; strategyId: string },
    reports: AgentReport[],
    signal?: AbortSignal,
  ): Promise<LlmVerdict | { skipped: string }> {
    if (!this.enabled()) return { skipped: "LLM review disabled" };
    if (!this.budgetOk()) return { skipped: "daily LLM call budget used" };
    let client = this.clientOverride;
    if (!client) {
      const route = routeOf(this.config, this.apiKey);
      if ("error" in route) return { skipped: route.error };
      client = providerOf(route).client({ stallMs: 20_000 });
    }
    const evidence: Evidence[] = reports.flatMap((r) => r.evidence);
    const ids = new Set(evidence.map((e) => e.id));
    const payload = {
      proposal,
      agents: reports.map((r) => ({
        agent: r.agent,
        status: r.status,
        bias: r.bias,
        confidence: r.confidence,
        summary: r.summary,
        veto: r.veto,
      })),
      evidence,
    };
    let text = "";
    for await (const chunk of client.stream(
      {
        system: SYSTEM,
        messages: [{ role: "user", text: JSON.stringify(payload) }],
        tools: [],
        responseFormat: { schema: SCHEMA as never, name: "judge_verdict" },
        maxOutputTokens: 800,
      },
      signal,
    )) {
      if (chunk.type === "text") text += chunk.text;
      if (chunk.type === "error") return { skipped: `model error: ${chunk.error.message}` };
    }
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    let parsed: { stance?: unknown; reasons?: unknown };
    try {
      parsed = JSON.parse(json) as { stance?: unknown; reasons?: unknown };
    } catch {
      return { skipped: "model answer was not JSON" };
    }
    if (parsed.stance !== "agree" && parsed.stance !== "caution" && parsed.stance !== "veto")
      return { skipped: "model answer had no valid stance" };
    if (!Array.isArray(parsed.reasons)) return { skipped: "model answer had no reasons" };
    const reasons: LlmVerdict["reasons"] = [];
    for (const r of parsed.reasons as { text?: unknown; evidence?: unknown }[]) {
      if (typeof r.text !== "string" || !Array.isArray(r.evidence)) return { skipped: "malformed reason" };
      const cited = r.evidence.filter((e): e is string => typeof e === "string");
      if (cited.length === 0 || cited.some((e) => !ids.has(e)))
        return { skipped: "model cited evidence that does not exist; answer discarded" };
      reasons.push({ text: r.text.slice(0, 300), evidence: cited });
    }
    return { stance: parsed.stance, reasons, model: client.model };
  }
}
