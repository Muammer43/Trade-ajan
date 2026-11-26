// Deterministic risk engine: the final authority over whether a trade may be opened. It never consults an AI
// agent; agent output can only make the system more cautious upstream. Controls (kill switch, circuit
// breakers, cooldown) persist across restarts.

import type { QuantForgeConfig } from "../config/schema.js";
import { utcDayStart, utcWeekStart } from "../core/time.js";
import type { Side } from "../core/types.js";
import type { EventRepo, StateRepo } from "../database/repositories.js";
import { type SizingResult, sizePosition } from "./sizing.js";

export type AccountView = {
  balance: number;
  equity: number;
  dayStartEquity: number;
  weekStartEquity: number;
  peakEquity: number;
  openPositions: { side: Side; lots: number; riskUsd: number }[];
  tradesToday: number;
  consecutiveLosses: number;
  freeMargin: number;
};

export type Controls = {
  killSwitch: { on: boolean; reason: string | null; ts: number | null };
  circuitBreaker: { until: number | null; reason: string | null };
  cooldownUntil: number | null;
};

export type Proposal = {
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  spread: number;
  expectedSlippage: number;
  atrPercentile: number;
  ts: number;
  dataFresh: boolean;
  minutesToClose: number;
  closeIsWeekend: boolean;
  expectedHoldingMinutes: number;
};

export type RiskCheck = { rule: string; passed: boolean; detail: string };
export type RiskVerdict = {
  allowed: boolean;
  checks: RiskCheck[];
  sizing: SizingResult | null;
  reasons: string[];
};

const KEY = "risk.controls";

export function defaultControls(): Controls {
  return {
    killSwitch: { on: false, reason: null, ts: null },
    circuitBreaker: { until: null, reason: null },
    cooldownUntil: null,
  };
}

export class RiskEngine {
  constructor(
    private config: QuantForgeConfig,
    private readonly state: StateRepo,
    private readonly events: EventRepo,
    private readonly now: () => number = Date.now,
  ) {}

  setConfig(config: QuantForgeConfig): void {
    this.config = config;
  }

  controls(): Controls {
    return { ...defaultControls(), ...(this.state.get<Controls>(KEY) ?? {}) };
  }

  private save(c: Controls): void {
    this.state.set(KEY, c);
  }

  setKillSwitch(on: boolean, reason: string): Controls {
    const c = this.controls();
    c.killSwitch = { on, reason: on ? reason : null, ts: this.now() };
    this.save(c);
    this.events.risk(on ? "kill_switch_on" : "kill_switch_off", on ? "critical" : "info", { reason });
    return c;
  }

  /** Engage automatic protections from the account state. Returns notes on anything that changed. */
  refresh(account: AccountView): string[] {
    const r = this.config.risk;
    const c = this.controls();
    const now = this.now();
    const notes: string[] = [];
    const dd = account.peakEquity > 0 ? (1 - account.equity / account.peakEquity) * 100 : 0;
    if (dd >= r.maxDrawdownPct && !c.killSwitch.on) {
      c.killSwitch = {
        on: true,
        reason: `maximum drawdown ${dd.toFixed(2)}% ≥ ${r.maxDrawdownPct}%`,
        ts: now,
      };
      this.events.risk("max_drawdown", "critical", { drawdownPct: dd });
      notes.push(c.killSwitch.reason as string);
    }
    const dayLoss = account.dayStartEquity > 0 ? (1 - account.equity / account.dayStartEquity) * 100 : 0;
    if (dayLoss >= r.maxDailyLossPct && !(c.circuitBreaker.until && c.circuitBreaker.until > now)) {
      c.circuitBreaker = {
        until: utcDayStart(now) + 86_400_000,
        reason: `daily loss ${dayLoss.toFixed(2)}% ≥ ${r.maxDailyLossPct}%`,
      };
      this.events.risk("daily_circuit_breaker", "warn", { dayLossPct: dayLoss });
      notes.push(c.circuitBreaker.reason as string);
    }
    const weekLoss = account.weekStartEquity > 0 ? (1 - account.equity / account.weekStartEquity) * 100 : 0;
    if (
      weekLoss >= r.maxWeeklyLossPct &&
      !(c.circuitBreaker.until && c.circuitBreaker.until >= utcWeekStart(now) + 7 * 86_400_000)
    ) {
      c.circuitBreaker = {
        until: utcWeekStart(now) + 7 * 86_400_000,
        reason: `weekly loss ${weekLoss.toFixed(2)}% ≥ ${r.maxWeeklyLossPct}%`,
      };
      this.events.risk("weekly_circuit_breaker", "warn", { weekLossPct: weekLoss });
      notes.push(c.circuitBreaker.reason as string);
    }
    if (account.consecutiveLosses >= r.maxConsecutiveLosses && !(c.cooldownUntil && c.cooldownUntil > now)) {
      c.cooldownUntil = now + r.cooldownHours * 3_600_000;
      this.events.risk("loss_streak_cooldown", "warn", { consecutiveLosses: account.consecutiveLosses });
      notes.push(`${account.consecutiveLosses} consecutive losses: cooldown ${r.cooldownHours}h`);
    }
    if (c.circuitBreaker.until && c.circuitBreaker.until <= now)
      c.circuitBreaker = { until: null, reason: null };
    if (c.cooldownUntil && c.cooldownUntil <= now) c.cooldownUntil = null;
    this.save(c);
    return notes;
  }

  /** Evaluate a proposed entry. Every rule is checked and reported, so a rejection explains itself fully. */
  evaluate(p: Proposal, account: AccountView): RiskVerdict {
    const r = this.config.risk;
    const c = this.controls();
    const now = this.now();
    const checks: RiskCheck[] = [];
    const check = (rule: string, passed: boolean, detail: string) => checks.push({ rule, passed, detail });
    const stopDistance = Math.abs(p.entry - p.sl);
    const reward = Math.abs(p.tp - p.entry);
    const rr = stopDistance > 0 ? reward / stopDistance : 0;
    const dd = account.peakEquity > 0 ? (1 - account.equity / account.peakEquity) * 100 : 0;
    const dayLoss = account.dayStartEquity > 0 ? (1 - account.equity / account.dayStartEquity) * 100 : 0;
    const weekLoss = account.weekStartEquity > 0 ? (1 - account.equity / account.weekStartEquity) * 100 : 0;

    check(
      "kill_switch",
      !c.killSwitch.on,
      c.killSwitch.on ? `kill switch on: ${c.killSwitch.reason}` : "off",
    );
    check(
      "circuit_breaker",
      !(c.circuitBreaker.until && c.circuitBreaker.until > now),
      c.circuitBreaker.until && c.circuitBreaker.until > now
        ? `${c.circuitBreaker.reason} (until ${new Date(c.circuitBreaker.until).toISOString()})`
        : "clear",
    );
    check(
      "cooldown",
      !(c.cooldownUntil && c.cooldownUntil > now),
      c.cooldownUntil && c.cooldownUntil > now
        ? `loss-streak cooldown until ${new Date(c.cooldownUntil).toISOString()}`
        : "clear",
    );
    check("max_drawdown", dd < r.maxDrawdownPct, `drawdown ${dd.toFixed(2)}% (limit ${r.maxDrawdownPct}%)`);
    check(
      "daily_loss",
      dayLoss < r.maxDailyLossPct,
      `today ${dayLoss.toFixed(2)}% (limit ${r.maxDailyLossPct}%)`,
    );
    check(
      "weekly_loss",
      weekLoss < r.maxWeeklyLossPct,
      `this week ${weekLoss.toFixed(2)}% (limit ${r.maxWeeklyLossPct}%)`,
    );
    check(
      "max_open_positions",
      account.openPositions.length < r.maxOpenPositions,
      `${account.openPositions.length} open (limit ${r.maxOpenPositions})`,
    );
    const opposite = account.openPositions.some((x) => x.side !== p.side);
    check(
      "no_hedging",
      !opposite,
      opposite ? "an opposite XAUUSD position is open; offsetting positions are not opened" : "none opposite",
    );
    check(
      "daily_trade_limit",
      account.tradesToday < r.maxTradesPerDay,
      `${account.tradesToday} today (limit ${r.maxTradesPerDay})`,
    );
    check(
      "data_quality",
      p.dataFresh,
      p.dataFresh ? "fresh, complete data" : "market data stale or incomplete",
    );
    check("spread", p.spread <= r.maxSpread, `spread ${p.spread.toFixed(2)} (limit ${r.maxSpread})`);
    check(
      "slippage",
      p.expectedSlippage <= r.maxSlippage,
      `expected slippage ${p.expectedSlippage.toFixed(2)} (limit ${r.maxSlippage})`,
    );
    const pctOk =
      Number.isFinite(p.atrPercentile) &&
      p.atrPercentile >= r.minAtrPercentile &&
      p.atrPercentile <= r.maxAtrPercentile;
    check(
      "volatility",
      pctOk,
      `ATR percentile ${Number.isFinite(p.atrPercentile) ? p.atrPercentile.toFixed(2) : "n/a"} (allowed ${r.minAtrPercentile}–${r.maxAtrPercentile})`,
    );
    check("reward_risk", rr >= r.minRewardRisk, `reward/risk ${rr.toFixed(2)} (minimum ${r.minRewardRisk})`);
    const closeOk =
      p.minutesToClose > r.noTradeMinutesBeforeClose &&
      !(r.closeBeforeWeekend && p.closeIsWeekend && p.minutesToClose < p.expectedHoldingMinutes);
    check(
      "market_hours",
      closeOk,
      p.minutesToClose <= 0
        ? "market closed"
        : `${p.minutesToClose} min to the next close${p.closeIsWeekend ? " (weekend)" : ""}`,
    );
    const geometry = p.side === "long" ? p.sl < p.entry && p.tp > p.entry : p.sl > p.entry && p.tp < p.entry;
    check(
      "order_geometry",
      geometry,
      geometry ? "stop and target on the correct sides" : "stop/target on the wrong side of entry",
    );

    // Correlated exposure: every XAUUSD position is the same risk factor.
    const openRisk = account.openPositions.reduce((s, x) => s + x.riskUsd, 0);
    const correlatedBudget = (account.equity * r.maxCorrelatedRiskPct) / 100 - openRisk;
    const sizing =
      stopDistance > 0
        ? sizePosition(
            {
              equity: account.equity,
              riskPct: r.riskPerTradePct,
              stopDistance,
              spread: p.spread,
              slippage: p.expectedSlippage,
              maxRiskUsd: correlatedBudget,
            },
            this.config.instrument,
            this.config.costs,
            p.entry,
          )
        : null;
    check(
      "correlated_exposure",
      correlatedBudget > 0,
      `open risk ${openRisk.toFixed(2)} USD, budget left ${Math.max(0, correlatedBudget).toFixed(2)} USD (limit ${r.maxCorrelatedRiskPct}% of equity)`,
    );
    check(
      "position_size",
      sizing?.ok === true,
      sizing
        ? sizing.ok
          ? `${sizing.lots} lots, loss at stop ${sizing.lossAtStopUsd.toFixed(2)} USD`
          : sizing.reason
        : "no stop distance",
    );
    if (sizing?.ok) {
      const marginOk = sizing.marginUsd <= (account.freeMargin * r.maxMarginUsePct) / 100;
      check(
        "margin",
        marginOk,
        `margin ${sizing.marginUsd.toFixed(2)} USD of free ${account.freeMargin.toFixed(2)} USD (limit ${r.maxMarginUsePct}%)`,
      );
    }
    const failed = checks.filter((x) => !x.passed);
    return {
      allowed: failed.length === 0,
      checks,
      sizing,
      reasons: failed.map((x) => `${x.rule}: ${x.detail}`),
    };
  }
}
