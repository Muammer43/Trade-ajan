// QuantForge configuration: typed defaults, risk profiles and strict validation.
// The user's config.json is deep-merged over DEFAULT_CONFIG, then validated; unknown keys are rejected.

import { z } from "zod";

const pct = z.number().min(0).max(100);
const positive = z.number().positive();

const providerSchema = z
  .object({
    id: z.enum(["twelvedata", "yahoo", "csv"]),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(100),
    /** The provider's own symbol for spot gold. */
    symbol: z.string().min(1).max(32),
    /** "spot" when the series is spot XAUUSD; "futures_proxy" when it is a related contract (not tradable spot). */
    basis: z.enum(["spot", "futures_proxy"]),
    /** Allowed to feed trading decisions (only spot series should be). */
    useForTrading: z.boolean(),
    websocket: z.boolean().optional(),
    csvDir: z.string().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    symbol: z.literal("XAUUSD"),
    /** Requested mode. "live" only takes effect when every live-safety gate passes; see execution/live-guard. */
    mode: z.enum(["paper", "live"]),
    data: z
      .object({
        providers: z.array(providerSchema).min(1),
        decisionTf: z.enum(["15m", "1h"]),
        monitorTf: z.enum(["1m", "5m", "15m"]),
        apiBudget: z
          .object({
            perMinute: z.number().int().min(1),
            perDay: z.number().int().min(10),
            reserve: z.number().int().min(0),
          })
          .strict(),
        backfillDays: z
          .object({
            "5m": z.number().int().min(1).max(180),
            "15m": z.number().int().min(30).max(2000),
            "1h": z.number().int().min(30).max(3000),
          })
          .strict(),
        closeLagMs: z.number().int().min(0).max(120_000),
        staleAfterBars: z.number().int().min(1).max(20),
        macroSymbols: z.array(z.string().max(16)).max(4),
        retentionDays: z
          .object({
            "5m": z.number().int().min(7),
            "15m": z.number().int().min(90),
            "1h": z.number().int().min(180),
          })
          .strict(),
        requestTimeoutMs: z.number().int().min(1000).max(60_000),
      })
      .strict(),
    instrument: z
      .object({
        contractSize: positive,
        tickSize: positive,
        minLot: positive,
        lotStep: positive,
        maxLot: positive,
        leverage: positive,
        brokerName: z.string().max(64),
      })
      .strict(),
    costs: z
      .object({
        spread: z.number().min(0),
        slippage: z.number().min(0),
        commissionPerLotRoundTrip: z.number().min(0),
        swapLongPerLotNight: z.number(),
        swapShortPerLotNight: z.number(),
      })
      .strict(),
    risk: z
      .object({
        profile: z.enum(["conservative", "balanced", "custom"]),
        initialBalance: positive,
        /** Hard-capped at 1% per trade. */
        riskPerTradePct: z.number().min(0.25).max(1),
        maxDailyLossPct: pct,
        maxWeeklyLossPct: pct,
        maxDrawdownPct: pct,
        maxOpenPositions: z.number().int().min(0).max(10),
        maxCorrelatedRiskPct: pct,
        maxConsecutiveLosses: z.number().int().min(1).max(50),
        cooldownHours: z.number().min(0).max(240),
        maxTradesPerDay: z.number().int().min(0).max(100),
        maxSpread: z.number().min(0),
        maxSlippage: z.number().min(0),
        minAtrPercentile: z.number().min(0).max(1),
        maxAtrPercentile: z.number().min(0).max(1),
        minRewardRisk: z.number().min(0),
        noTradeMinutesBeforeClose: z.number().int().min(0).max(600),
        closeBeforeWeekend: z.boolean(),
        maxMarginUsePct: pct,
      })
      .strict(),
    decision: z
      .object({ minConfidence: z.number().min(0).max(1), maxSignalAgeBars: z.number().int().min(0).max(4) })
      .strict(),
    strategy: z
      .object({
        /** Minimum signal score (0–100) for a setup to become a trade proposal. */
        minScore: z.number().min(0).max(100),
        minRewardRisk: z.number().min(1).max(10),
        /** Default target in R when no opposing S/R zone is closer. */
        targetR: z.number().min(1).max(10),
        minStopAtr: z.number().min(0.1).max(5),
        maxStopAtr: z.number().min(0.2).max(10),
        models: z
          .object({ trend_pullback: z.boolean(), breakout_retest: z.boolean(), failed_breakout: z.boolean() })
          .strict(),
        management: z
          .object({
            partialAtR: z.number().min(0.25).max(10).nullable(),
            partialFraction: z.number().min(0.1).max(0.9),
            breakEvenAtR: z.number().min(0.25).max(10).nullable(),
            trailAtr: z.number().min(0.25).max(10).nullable(),
            maxBars: z.number().int().min(1).max(500),
          })
          .strict(),
      })
      .strict(),
    agents: z
      .object({
        timeoutMs: z.number().int().min(100).max(60_000),
        llm: z
          .object({
            enabled: z.boolean(),
            provider: z.enum([
              "anthropic",
              "openai",
              "google",
              "deepseek",
              "openrouter",
              "openai-compatible",
            ]),
            model: z.string().min(1).max(128),
            baseURL: z.string().max(256).optional(),
            timeoutMs: z.number().int().min(1000).max(180_000),
            maxCallsPerDay: z.number().int().min(0).max(1000),
          })
          .strict(),
      })
      .strict(),
    dashboard: z
      .object({
        host: z.string().min(1).max(64),
        port: z.number().int().min(1024).max(65535),
        sessionHours: z.number().min(1).max(168),
        /** Must be true to bind anywhere other than loopback. */
        allowRemote: z.boolean(),
      })
      .strict(),
    live: z
      .object({ enabled: z.boolean(), broker: z.string().max(64).nullable(), maxLots: positive })
      .strict(),
    scheduler: z
      .object({
        enabled: z.boolean(),
        backupHourUtc: z.number().int().min(0).max(23),
        keepBackups: z.number().int().min(1).max(100),
      })
      .strict(),
  })
  .strict();

export type QuantForgeConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;

export const DEFAULT_CONFIG: QuantForgeConfig = {
  version: 1,
  symbol: "XAUUSD",
  mode: "paper",
  data: {
    providers: [
      {
        id: "twelvedata",
        enabled: true,
        priority: 1,
        symbol: "XAU/USD",
        basis: "spot",
        useForTrading: true,
        websocket: false,
      },
      {
        id: "yahoo",
        enabled: false,
        priority: 5,
        symbol: "GC=F",
        basis: "futures_proxy",
        useForTrading: false,
      },
      {
        id: "csv",
        enabled: false,
        priority: 9,
        symbol: "XAUUSD",
        basis: "spot",
        useForTrading: true,
        csvDir: "import",
      },
    ],
    decisionTf: "15m",
    monitorTf: "5m",
    apiBudget: { perMinute: 8, perDay: 800, reserve: 60 },
    backfillDays: { "5m": 30, "15m": 365, "1h": 1095 },
    closeLagMs: 20_000,
    staleAfterBars: 3,
    macroSymbols: ["EUR/USD", "XAG/USD"],
    retentionDays: { "5m": 60, "15m": 1500, "1h": 3000 },
    requestTimeoutMs: 15_000,
  },
  instrument: {
    contractSize: 100,
    tickSize: 0.01,
    minLot: 0.01,
    lotStep: 0.01,
    maxLot: 5,
    leverage: 100,
    brokerName: "generic (configure to match your broker)",
  },
  costs: {
    spread: 0.35,
    slippage: 0.05,
    commissionPerLotRoundTrip: 7,
    swapLongPerLotNight: -45,
    swapShortPerLotNight: -10,
  },
  risk: {
    profile: "balanced",
    initialBalance: 1000,
    riskPerTradePct: 0.5,
    maxDailyLossPct: 2,
    maxWeeklyLossPct: 4,
    maxDrawdownPct: 12,
    maxOpenPositions: 2,
    maxCorrelatedRiskPct: 1,
    maxConsecutiveLosses: 4,
    cooldownHours: 24,
    maxTradesPerDay: 5,
    maxSpread: 0.8,
    maxSlippage: 0.5,
    minAtrPercentile: 0.03,
    maxAtrPercentile: 0.98,
    minRewardRisk: 1.5,
    noTradeMinutesBeforeClose: 30,
    closeBeforeWeekend: true,
    maxMarginUsePct: 50,
  },
  decision: { minConfidence: 0.55, maxSignalAgeBars: 1 },
  strategy: {
    minScore: 60,
    minRewardRisk: 1.5,
    targetR: 2.5,
    minStopAtr: 0.4,
    maxStopAtr: 2.5,
    models: { trend_pullback: true, breakout_retest: true, failed_breakout: true },
    management: { partialAtR: 1, partialFraction: 0.5, breakEvenAtR: 1, trailAtr: 1.5, maxBars: 32 },
  },
  agents: {
    timeoutMs: 2000,
    llm: {
      enabled: false,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      timeoutMs: 45_000,
      maxCallsPerDay: 40,
    },
  },
  dashboard: { host: "127.0.0.1", port: 8787, sessionHours: 12, allowRemote: false },
  live: { enabled: false, broker: null, maxLots: 0.05 },
  scheduler: { enabled: true, backupHourUtc: 1, keepBackups: 14 },
};

/** Risk presets. `custom` keeps whatever values the file sets. */
export const RISK_PROFILES: Record<"conservative" | "balanced", Partial<QuantForgeConfig["risk"]>> = {
  conservative: {
    riskPerTradePct: 0.25,
    maxDailyLossPct: 1.5,
    maxWeeklyLossPct: 3,
    maxDrawdownPct: 8,
    maxOpenPositions: 1,
    maxCorrelatedRiskPct: 0.5,
    maxConsecutiveLosses: 3,
    maxTradesPerDay: 3,
  },
  balanced: {
    riskPerTradePct: 0.5,
    maxDailyLossPct: 2,
    maxWeeklyLossPct: 4,
    maxDrawdownPct: 12,
    maxOpenPositions: 2,
    maxCorrelatedRiskPct: 1,
    maxConsecutiveLosses: 4,
    maxTradesPerDay: 5,
  },
};

type Plain = Record<string, unknown>;
function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlain(base) || !isPlain(override)) return (override === undefined ? base : override) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

/** Merge a partial config over the defaults, apply the risk profile, and validate. */
/**
 * Bring a config.json written by an earlier version up to date: drop sections that no longer exist
 * (the former strategy-discovery settings) and clamp the per-trade risk into the hard 0.25–1% range.
 */
export function migrateConfig(raw: unknown): { raw: unknown; notes: string[] } {
  if (!isPlain(raw)) return { raw, notes: [] };
  const out: Plain = structuredClone(raw);
  const notes: string[] = [];
  if ("discovery" in out) {
    delete out.discovery;
    notes.push("removed the obsolete 'discovery' section (strategy discovery is no longer part of the bot)");
  }
  if (isPlain(out.risk) && typeof out.risk.riskPerTradePct === "number") {
    const v = out.risk.riskPerTradePct;
    const clamped = Math.min(1, Math.max(0.25, v));
    if (clamped !== v) {
      out.risk = { ...out.risk, riskPerTradePct: clamped };
      notes.push(`risk.riskPerTradePct ${v} is outside the allowed 0.25–1% range; using ${clamped}`);
    }
  }
  return { raw: out, notes };
}

export function buildConfig(partial: unknown): { config: QuantForgeConfig } | { error: string } {
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), partial ?? {});
  const profile = (merged as QuantForgeConfig).risk?.profile;
  if (profile === "conservative" || profile === "balanced") {
    const explicit = isPlain(partial) && isPlain(partial.risk) ? partial.risk : {};
    (merged as QuantForgeConfig).risk = {
      ...(merged as QuantForgeConfig).risk,
      ...RISK_PROFILES[profile],
      ...explicit,
    };
  }
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const c = parsed.data;
  if (c.strategy.minStopAtr >= c.strategy.maxStopAtr)
    return { error: "strategy: minStopAtr must be below maxStopAtr" };
  if (c.risk.minAtrPercentile >= c.risk.maxAtrPercentile)
    return { error: "risk: minAtrPercentile must be below maxAtrPercentile" };
  const loopback =
    c.dashboard.host === "127.0.0.1" || c.dashboard.host === "localhost" || c.dashboard.host === "::1";
  if (!loopback && !c.dashboard.allowRemote)
    return {
      error: "dashboard.host is not loopback; set dashboard.allowRemote=true explicitly to expose it",
    };
  return { config: c };
}
