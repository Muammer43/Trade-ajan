// The specialist agents. Each is a deterministic analyst over the structured market context, adapted from
// the TradingAgents research roles (Quant Research, Macro Strategy, Risk Analysis) and extended with the
// trading-specific roles. Their outputs are evidence, a directional lean, a confidence and an optional veto.

import { mean, stdev } from "../../core/stats.js";
import { minutesToClose, nextCloseIsWeekend, sessionOf } from "../../core/time.js";
import type { Candle } from "../../core/types.js";
import type { AgentDefinition, Evidence, MarketContext } from "./types.js";

const clamp = (x: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, x));
const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
const sideSign = (ctx: MarketContext) => (ctx.proposal ? (ctx.proposal.side === "long" ? 1 : -1) : 0);

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  return v === undefined ? Number.NaN : v;
}

/** Lo–MacKinlay variance ratio VR(q) of log returns over the last `n` bars. */
export function varianceRatio(ret: ArrayLike<number>, end: number, n: number, q: number): number {
  const xs: number[] = [];
  for (let k = Math.max(1, end - n + 1); k <= end; k++) xs.push(at(ret, k));
  if (xs.length < q * 10) return Number.NaN;
  const v1 = stdev(xs) ** 2;
  const agg: number[] = [];
  for (let k = q - 1; k < xs.length; k++) {
    let s = 0;
    for (let j = 0; j < q; j++) s += xs[k - j] as number;
    agg.push(s);
  }
  const vq = stdev(agg) ** 2;
  return v1 > 0 ? vq / (q * v1) : Number.NaN;
}

const quantResearch: AgentDefinition = {
  id: "quant_research",
  label: "Quant Research Agent",
  responsibility:
    "Measure drift, momentum and serial dependence of returns (variance ratio) over several windows.",
  inputs: "decision-timeframe features (returns, ATR, z-score, slope t-statistic)",
  outputs: "momentum lean, mean-reversion vs persistence diagnosis",
  run(ctx) {
    const f = ctx.features;
    const i = ctx.i;
    const atr = at(f.atr, i);
    const move = (k: number) =>
      i - k >= 0 && atr > 0 ? (at(f.close, i) - at(f.close, i - k)) / atr : Number.NaN;
    const m4 = move(4);
    const m16 = move(16);
    const m64 = move(64);
    const vr = varianceRatio(f.ret, i, 300, 4);
    const z = at(f.z, i);
    if (![m4, m16, m64].every(Number.isFinite))
      return {
        status: "insufficient_data",
        bias: 0,
        confidence: 0,
        summary: "not enough bars for momentum windows",
        evidence: [],
        veto: null,
      };
    // Momentum lean, tempered (or reversed) when returns show mean reversion (VR < 1).
    const momentum = clamp((0.2 * m4 + 0.4 * Math.tanh(m16 / 4) * 4 + 0.4 * Math.tanh(m64 / 8) * 4) / 4);
    const persistence = Number.isFinite(vr) ? clamp((vr - 1) * 3) : 0;
    const bias = clamp(momentum * (persistence >= 0 ? 1 : 1 + persistence));
    const confidence = clamp(0.25 + 0.5 * Math.abs(persistence) * Math.abs(momentum), 0, 0.8);
    const evidence: Evidence[] = [
      { id: "quant.move4_atr", label: "4-bar move (ATR)", value: r4(m4) },
      { id: "quant.move16_atr", label: "16-bar move (ATR)", value: r4(m16) },
      { id: "quant.move64_atr", label: "64-bar move (ATR)", value: r4(m64) },
      { id: "quant.variance_ratio4", label: "variance ratio VR(4), 300 bars", value: r4(vr) },
      { id: "quant.zscore50", label: "z-score vs 50-bar mean", value: r4(z) },
    ];
    const regimeWord = !Number.isFinite(vr)
      ? "unknown dependence"
      : vr > 1.05
        ? "persistent (trending) returns"
        : vr < 0.95
          ? "mean-reverting returns"
          : "close to a random walk";
    return {
      bias,
      confidence,
      summary: `16-bar move ${m16.toFixed(2)} ATR, VR(4)=${Number.isFinite(vr) ? vr.toFixed(2) : "n/a"}: ${regimeWord}`,
      evidence,
      veto: null,
    };
  },
};

function returnsOf(c: readonly Candle[]): number[] {
  const out: number[] = [];
  for (let k = 1; k < c.length; k++) out.push(Math.log((c[k] as Candle).close / (c[k - 1] as Candle).close));
  return out;
}

const macroIntelligence: AgentDefinition = {
  id: "macro_intelligence",
  label: "Macro Intelligence Agent",
  responsibility:
    "Read cross-asset context: the US dollar through EUR/USD and precious-metal breadth through silver.",
  inputs: "EUR/USD and XAG/USD hourly bars from the data provider (when available)",
  outputs: "dollar/breadth tailwind or headwind for gold, its correlation and confidence",
  run(ctx) {
    const eur = ctx.macro.eurusd;
    const xag = ctx.macro.xagusd;
    if (eur.length < 30 && xag.length < 30)
      return {
        status: "insufficient_data",
        bias: 0,
        confidence: 0,
        summary: "no cross-asset data (EUR/USD, XAG/USD) available; no macro view",
        evidence: [],
        veto: null,
      };
    const evidence: Evidence[] = [];
    let bias = 0;
    let weight = 0;
    if (eur.length >= 30) {
      const last = eur[eur.length - 1] as Candle;
      const prev = eur[Math.max(0, eur.length - 25)] as Candle;
      const r24 = Math.log(last.close / prev.close);
      // A weaker dollar (EUR/USD up) is historically a tailwind for gold; read the sign over the window.
      bias += clamp(r24 / 0.004);
      weight++;
      evidence.push({
        id: "macro.eurusd_24h_ret_pct",
        label: "EUR/USD 24h return (%)",
        value: r4(r24 * 100),
      });
    }
    if (xag.length >= 30) {
      const r = returnsOf(xag.slice(-25));
      const sr = r.reduce((a, b) => a + b, 0);
      bias += clamp(sr / 0.01);
      weight++;
      evidence.push({ id: "macro.xagusd_24h_ret_pct", label: "XAG/USD 24h return (%)", value: r4(sr * 100) });
    }
    bias = weight ? bias / weight : 0;
    return {
      bias: clamp(bias),
      confidence: 0.3,
      summary: `cross-asset lean ${bias >= 0.2 ? "supportive" : bias <= -0.2 ? "adverse" : "neutral"} for gold (hourly proxies; low confidence by design)`,
      evidence,
      veto: null,
    };
  },
};

const marketRegime: AgentDefinition = {
  id: "market_regime",
  label: "Market Regime Agent",
  responsibility:
    "Classify the current regime (trend, volatility level and dynamics, breakouts, liquidity traps).",
  inputs: "slope t-statistic, efficiency ratio, ADX, ATR percentile, volatility ratio, range breaks",
  outputs: "regime label with its scores",
  run(ctx) {
    const r = ctx.regime;
    const bias =
      r.trend === "strong_bull"
        ? 0.6
        : r.trend === "strong_bear"
          ? -0.6
          : r.trend === "weak_trend"
            ? 0.25 * Math.sign(r.scores.slopeT)
            : 0;
    const evidence: Evidence[] = [
      { id: "regime.label", label: "regime", value: r.label },
      { id: "regime.slope_t", label: "48-bar slope t-statistic", value: r4(r.scores.slopeT) },
      { id: "regime.efficiency", label: "20-bar efficiency ratio", value: r4(r.scores.efficiency) },
      { id: "regime.adx", label: "ADX(14)", value: r.scores.adx === null ? null : r4(r.scores.adx) },
      { id: "regime.atr_percentile", label: "ATR percentile (500 bars)", value: r4(r.scores.atrPercentile) },
      { id: "regime.vol_ratio", label: "realized vol ratio 12/96", value: r4(r.scores.volRatio) },
    ];
    return {
      bias,
      confidence: r.trend.startsWith("strong") ? 0.6 : 0.35,
      summary: r.label,
      evidence,
      veto: null,
    };
  },
};

const strategyResearch: AgentDefinition = {
  id: "strategy_research",
  label: "Strategy Research Agent",
  responsibility: "Track validated strategies and whether their paper results still match their validation.",
  inputs: "active strategies with validation statistics and their paper-trade outcomes",
  outputs: "strategy health; veto when a strategy's live results have broken from validation",
  run(ctx) {
    if (!ctx.strategies.length)
      return {
        bias: 0,
        confidence: 1,
        summary: "no validated strategy is active: the system has no statistically supported edge to trade",
        evidence: [{ id: "strategy.active_count", label: "active strategies", value: 0 }],
        veto: ctx.proposal ? "no active validated strategy" : null,
      };
    const evidence: Evidence[] = [
      { id: "strategy.active_count", label: "active strategies", value: ctx.strategies.length },
    ];
    let veto: string | null = null;
    for (const s of ctx.strategies) {
      evidence.push({
        id: `strategy.${s.id}.validation_expectancy`,
        label: `${s.id} validated expectancy (R)`,
        value: r4(s.validation.expectancyR),
      });
      evidence.push({
        id: `strategy.${s.id}.paper_trades`,
        label: `${s.id} paper trades`,
        value: s.live.trades,
      });
      if (s.live.expectancyR !== null)
        evidence.push({
          id: `strategy.${s.id}.paper_expectancy`,
          label: `${s.id} paper expectancy (R)`,
          value: r4(s.live.expectancyR),
        });
      // Drift: after 15 paper trades, an expectancy below −0.25R is inconsistent with a validated positive edge.
      if (
        ctx.proposal?.strategyId === s.id &&
        s.live.trades >= 15 &&
        s.live.expectancyR !== null &&
        s.live.expectancyR < -0.25
      )
        veto = `${s.id} paper expectancy ${s.live.expectancyR.toFixed(2)}R after ${s.live.trades} trades contradicts its validation`;
    }
    return {
      bias: 0,
      confidence: 0.7,
      summary: `${ctx.strategies.length} validated strategies active`,
      evidence,
      veto,
    };
  },
};

/** Swing pivots (fractal of `k` bars each side) in the last `n` bars. */
function pivots(ctx: MarketContext, n: number, k: number) {
  const f = ctx.features;
  const highs: { i: number; p: number }[] = [];
  const lows: { i: number; p: number }[] = [];
  for (let i = Math.max(k, ctx.i - n); i <= ctx.i - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(at(f.high, i) > at(f.high, i - j) && at(f.high, i) >= at(f.high, i + j))) isH = false;
      if (!(at(f.low, i) < at(f.low, i - j) && at(f.low, i) <= at(f.low, i + j))) isL = false;
    }
    if (isH) highs.push({ i, p: at(f.high, i) });
    if (isL) lows.push({ i, p: at(f.low, i) });
  }
  return { highs, lows };
}

const priceAction: AgentDefinition = {
  id: "price_action",
  label: "Price Action Agent",
  responsibility:
    "Read market structure: swing highs/lows sequence, displacement and where bars close in their range.",
  inputs: "OHLC of the last 100 decision bars",
  outputs: "structural lean (higher highs/lows vs lower highs/lows) and the last bar's character",
  run(ctx) {
    const { highs, lows } = pivots(ctx, 100, 3);
    if (highs.length < 3 || lows.length < 3)
      return {
        status: "insufficient_data",
        bias: 0,
        confidence: 0,
        summary: "too few swing points to read structure",
        evidence: [],
        veto: null,
      };
    const seq = (xs: { p: number }[]) => {
      let up = 0;
      let down = 0;
      for (let k = Math.max(1, xs.length - 4); k < xs.length; k++) {
        if ((xs[k] as { p: number }).p > (xs[k - 1] as { p: number }).p) up++;
        else down++;
      }
      return up - down;
    };
    const hs = seq(highs);
    const ls = seq(lows);
    const f = ctx.features;
    const body = at(f.body, ctx.i);
    const clv = at(f.clv, ctx.i);
    const structure = clamp((hs + ls) / 6);
    const bias = clamp(0.8 * structure + 0.2 * clamp(body / 2));
    return {
      bias,
      confidence: clamp(0.3 + 0.4 * Math.abs(structure), 0, 0.75),
      summary: `swing highs ${hs >= 0 ? "rising" : "falling"} (${hs}), swing lows ${ls >= 0 ? "rising" : "falling"} (${ls}); last bar body ${Number.isFinite(body) ? body.toFixed(2) : "n/a"} ATR, CLV ${clv.toFixed(2)}`,
      evidence: [
        { id: "pa.swing_high_seq", label: "net rising swing highs (last 4)", value: hs },
        { id: "pa.swing_low_seq", label: "net rising swing lows (last 4)", value: ls },
        {
          id: "pa.last_high",
          label: "last swing high",
          value: r4((highs[highs.length - 1] as { p: number }).p),
        },
        { id: "pa.last_low", label: "last swing low", value: r4((lows[lows.length - 1] as { p: number }).p) },
        { id: "pa.body_atr", label: "last bar body (ATR)", value: r4(body) },
        { id: "pa.clv", label: "last bar close location", value: r4(clv) },
      ],
      veto: null,
    };
  },
};

const volatility: AgentDefinition = {
  id: "volatility",
  label: "Volatility Agent",
  responsibility: "Assess volatility level, clustering and expansion; refuse trading in extreme volatility.",
  inputs: "ATR and its percentile, realized volatility ratio, autocorrelation of absolute returns",
  outputs: "volatility state; veto when volatility is outside the tradable band",
  run(ctx) {
    const f = ctx.features;
    const pct = at(f.atrPct, ctx.i);
    const vr = at(f.volRatio, ctx.i);
    const cl = at(f.volCluster, ctx.i);
    const r = ctx.config.risk;
    const veto =
      Number.isFinite(pct) && pct > r.maxAtrPercentile
        ? `ATR percentile ${pct.toFixed(2)} above ${r.maxAtrPercentile}: extreme volatility`
        : Number.isFinite(pct) && pct < r.minAtrPercentile
          ? `ATR percentile ${pct.toFixed(2)} below ${r.minAtrPercentile}: market too quiet for the cost structure`
          : null;
    return {
      bias: 0,
      confidence: 0.6,
      summary: `ATR ${at(f.atr, ctx.i).toFixed(2)} (percentile ${Number.isFinite(pct) ? pct.toFixed(2) : "n/a"}), vol ratio ${Number.isFinite(vr) ? vr.toFixed(2) : "n/a"}, clustering ${Number.isFinite(cl) ? cl.toFixed(2) : "n/a"}`,
      evidence: [
        { id: "vol.atr", label: "ATR(14)", value: r4(at(f.atr, ctx.i)) },
        { id: "vol.atr_percentile", label: "ATR percentile", value: r4(pct) },
        { id: "vol.ratio", label: "realized vol 12/96", value: r4(vr) },
        { id: "vol.clustering", label: "lag-1 autocorrelation of |returns| (96 bars)", value: r4(cl) },
      ],
      veto,
    };
  },
};

const liquidity: AgentDefinition = {
  id: "liquidity",
  label: "Liquidity Analysis Agent",
  responsibility: "Locate liquidity pools (equal highs/lows, recent extremes), detect sweeps and traps.",
  inputs: "swing points, 20/48-bar range extremes, wicks",
  outputs: "where resting liquidity sits relative to price, recent sweeps, trap lean",
  run(ctx) {
    const f = ctx.features;
    const i = ctx.i;
    const atr = at(f.atr, i);
    const price = at(f.close, i);
    const { highs, lows } = pivots(ctx, 150, 2);
    const tol = 0.15 * atr;
    const equal = (xs: { p: number }[]) => {
      let best: number | null = null;
      for (let a = 0; a < xs.length; a++)
        for (let b = a + 1; b < xs.length; b++)
          if (Math.abs((xs[a] as { p: number }).p - (xs[b] as { p: number }).p) <= tol)
            best = (xs[b] as { p: number }).p;
      return best;
    };
    const eqHigh = equal(highs.filter((h) => h.p > price));
    const eqLow = equal(lows.filter((l) => l.p < price));
    const trap = ctx.regime.liquidityTrap;
    const bias = trap === "bear_trap" ? 0.4 : trap === "bull_trap" ? -0.4 : 0;
    const distUp = eqHigh !== null ? (eqHigh - price) / atr : null;
    const distDown = eqLow !== null ? (price - eqLow) / atr : null;
    return {
      bias,
      confidence: trap ? 0.45 : 0.25,
      summary: `${trap ? `recent ${trap.replace("_", " ")}; ` : ""}equal highs ${distUp !== null ? `${distUp.toFixed(2)} ATR above` : "none above"}, equal lows ${distDown !== null ? `${distDown.toFixed(2)} ATR below` : "none below"}`,
      evidence: [
        { id: "liq.trap", label: "liquidity trap in last 3 bars", value: trap },
        {
          id: "liq.equal_highs_dist_atr",
          label: "distance to equal highs (ATR)",
          value: distUp === null ? null : r4(distUp),
        },
        {
          id: "liq.equal_lows_dist_atr",
          label: "distance to equal lows (ATR)",
          value: distDown === null ? null : r4(distDown),
        },
        { id: "liq.range20_high", label: "prior 20-bar high", value: r4(at(f.donchianHigh(20), i)) },
        { id: "liq.range20_low", label: "prior 20-bar low", value: r4(at(f.donchianLow(20), i)) },
      ],
      veto: null,
    };
  },
};

const riskManagement: AgentDefinition = {
  id: "risk_management",
  label: "Risk Management Agent",
  responsibility: "Report account risk usage and active protections (advisory; the risk engine enforces).",
  inputs: "account equity marks, open risk, loss streak, kill switch and circuit breakers",
  outputs: "risk-usage summary; veto while any protection is engaged",
  run(ctx) {
    const a = ctx.account;
    const c = ctx.controls;
    const dd = a.peakEquity > 0 ? (1 - a.equity / a.peakEquity) * 100 : 0;
    const day = a.dayStartEquity > 0 ? (1 - a.equity / a.dayStartEquity) * 100 : 0;
    const openRisk = a.openPositions.reduce((s, p) => s + p.riskUsd, 0);
    const now = ctx.now;
    const veto = c.killSwitch.on
      ? `kill switch: ${c.killSwitch.reason}`
      : c.circuitBreaker.until && c.circuitBreaker.until > now
        ? `circuit breaker: ${c.circuitBreaker.reason}`
        : c.cooldownUntil && c.cooldownUntil > now
          ? "loss-streak cooldown"
          : null;
    return {
      bias: 0,
      confidence: 1,
      summary: `drawdown ${dd.toFixed(2)}%, today ${day.toFixed(2)}% of ${ctx.config.risk.maxDailyLossPct}% daily limit, open risk ${openRisk.toFixed(2)} USD, ${a.consecutiveLosses} consecutive losses`,
      evidence: [
        { id: "risk.equity", label: "equity (USD)", value: r4(a.equity) },
        { id: "risk.drawdown_pct", label: "drawdown from peak (%)", value: r4(dd) },
        { id: "risk.daily_loss_pct", label: "loss today (%)", value: r4(day) },
        { id: "risk.open_risk_usd", label: "open risk (USD)", value: r4(openRisk) },
        { id: "risk.consecutive_losses", label: "consecutive losses", value: a.consecutiveLosses },
        { id: "risk.kill_switch", label: "kill switch", value: c.killSwitch.on },
      ],
      veto,
    };
  },
};

const executionIntelligence: AgentDefinition = {
  id: "execution_intelligence",
  label: "Execution Intelligence Agent",
  responsibility:
    "Judge execution conditions: session liquidity, spread, time to close, data freshness, provider health.",
  inputs: "quote, modelled/provider spread, market calendar, data-quality report, provider health",
  outputs: "execution quality; veto when conditions make a fill unreliable",
  run(ctx) {
    const q = ctx.quote;
    const session = sessionOf(ctx.now);
    const toClose = minutesToClose(ctx.now);
    const r = ctx.config.risk;
    let veto: string | null = null;
    if (!ctx.quality.fresh) veto = `market data is ${ctx.quality.ageBars.toFixed(1)} bars old`;
    else if (!ctx.providerHealthy) veto = "primary data provider unhealthy";
    else if (q && q.spread > r.maxSpread) veto = `spread ${q.spread.toFixed(2)} above ${r.maxSpread}`;
    else if (toClose <= r.noTradeMinutesBeforeClose)
      veto =
        toClose === 0
          ? "market closed"
          : `${toClose} min to ${nextCloseIsWeekend(ctx.now) ? "weekend" : "daily"} close`;
    const quality = session === "overlap" || session === "london" ? 0.8 : session === "newyork" ? 0.7 : 0.5;
    return {
      bias: 0,
      confidence: quality,
      summary: `${session} session, ${toClose} min to close, spread ${q ? `${q.spread.toFixed(2)} (${q.spreadSource})` : "unknown"}, data ${ctx.quality.fresh ? "fresh" : "stale"}`,
      evidence: [
        { id: "exec.session", label: "session", value: session },
        { id: "exec.minutes_to_close", label: "minutes to next close", value: toClose },
        { id: "exec.spread", label: "spread (USD/oz)", value: q ? r4(q.spread) : null },
        { id: "exec.spread_source", label: "spread source", value: q?.spreadSource ?? null },
        { id: "exec.data_age_bars", label: "data age (bars)", value: r4(ctx.quality.ageBars) },
        { id: "exec.missing_bars", label: "missing bars (recent window)", value: ctx.quality.missingBars },
      ],
      veto,
    };
  },
};

export const SPECIALISTS: readonly AgentDefinition[] = [
  quantResearch,
  macroIntelligence,
  marketRegime,
  strategyResearch,
  priceAction,
  volatility,
  liquidity,
  riskManagement,
  executionIntelligence,
];

/** Weights of directional agents in the judge's consensus. */
export const DIRECTIONAL_WEIGHTS: Partial<Record<string, number>> = {
  quant_research: 1,
  market_regime: 1,
  price_action: 1,
  liquidity: 0.75,
  macro_intelligence: 0.5,
};

export { mean, sideSign };
