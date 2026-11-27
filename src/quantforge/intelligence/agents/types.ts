// Agent contract. Agents analyze structured market information and return evidence-backed assessments.
// They never produce prices, never place orders, and cannot override the risk engine.

import type { QuantForgeConfig } from "../../config/schema.js";
import type { Candle, Quote, Regime, Side, Timeframe } from "../../core/types.js";
import type { AccountView, Controls } from "../../risk/engine.js";
import type { ModelId, StrategySignal } from "../../strategy/types.js";
import type { FeatureSet } from "../features.js";

export const AGENT_IDS = ["quant", "macro", "market", "strategy", "risk", "ai_judge"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** A fact an agent's assessment rests on; `id` is how reports and the AI judge cite it. */
export type Evidence = { id: string; label: string; value: number | string | boolean | null };

export type AgentReport = {
  agent: AgentId;
  status: "ok" | "insufficient_data" | "error" | "timeout";
  /** Directional lean: −1 bearish … +1 bullish (0 = no view). */
  bias: number;
  /** How much the agent trusts its own assessment, 0–1. */
  confidence: number;
  summary: string;
  evidence: Evidence[];
  /** A reason to refuse the current trade proposal, or null. */
  veto: string | null;
  durationMs: number;
};

/** Paper results of one trade model, for the Strategy agent's drift check. */
export type ModelPerformance = { model: ModelId; trades: number; expectancyR: number | null };

export type MarketContext = {
  now: number;
  tf: Timeframe;
  features: FeatureSet;
  i: number;
  regime: Regime;
  quote: Quote | null;
  quality: { fresh: boolean; missingBars: number; staleQuoteBars: number; ageBars: number };
  macro: { eurusd: Candle[]; xagusd: Candle[] };
  /** The deterministic strategy engine's output for this candle. */
  signal: StrategySignal;
  modelPerformance: ModelPerformance[];
  account: AccountView;
  controls: Controls;
  config: QuantForgeConfig;
  providerHealthy: boolean;
  proposal: { side: Side; model: ModelId; entry: number; sl: number; tp: number } | null;
};

export type AgentDefinition = {
  id: AgentId;
  label: string;
  responsibility: string;
  inputs: string;
  outputs: string;
  run(
    ctx: MarketContext,
  ): Omit<AgentReport, "agent" | "durationMs" | "status"> & { status?: AgentReport["status"] };
};
