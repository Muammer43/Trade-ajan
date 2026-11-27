// The three XAUUSD trade models. Each is evaluated at the close of a 15-minute candle with hard conditions
// (all must hold for a setup) and scored components (0–1 each, weighted to a 0–100 signal score).
//
//   A  Trend Pullback        trade with the 1h trend after a measured pullback ends with a reversal candle
//   B  Breakout + Retest     a confirmed close through a tested S/R zone, a retest that holds, a trigger candle
//   C  Failed Breakout       a sweep of a prior swing that closes back inside, confirmed by a structural break
//
// Every rule reads only candles 0..i of the TradingFrame. Stops are structural (beyond the pullback, retest or
// sweep extreme); targets stop short of the nearest opposing S/R zone and must give the minimum reward/risk.

import type { Regime } from "../core/types.js";
import { type Side, sideSign } from "../core/types.js";
import type { TradingFrame, Zone } from "./structure.js";
import {
  COMPONENT_WEIGHTS,
  type Component,
  type ComponentName,
  type ExitRules,
  type ModelEvaluation,
  type ModelId,
} from "./types.js";

export type StrategyParams = {
  minScore: number;
  minRewardRisk: number;
  targetR: number;
  minStopAtr: number;
  maxStopAtr: number;
  minAtrPercentile: number;
  maxAtrPercentile: number;
  management: {
    partialAtR: number | null;
    partialFraction: number;
    breakEvenAtR: number | null;
    trailAtr: number | null;
    maxBars: number;
  };
};

export type ModelContext = {
  frame: TradingFrame;
  i: number;
  regime: Regime;
  regimeFit: number;
  params: StrategyParams;
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const fin = (x: number) => Number.isFinite(x);

export function scoreOf(components: Partial<Record<ComponentName, Component>>): number {
  let total = 0;
  let weight = 0;
  for (const [name, w] of Object.entries(COMPONENT_WEIGHTS) as [ComponentName, number][]) {
    weight += w;
    total += w * Math.max(0, Math.min(1, components[name]?.score ?? 0));
  }
  return Math.round((total / weight) * 1000) / 10;
}

function exitRules(p: StrategyParams, slAtr: number, tpR: number): ExitRules {
  return {
    slAtr: r2(slAtr),
    tpR: r2(tpR),
    maxBars: p.management.maxBars,
    breakEvenR: p.management.breakEvenAtR,
    partialR:
      p.management.partialAtR !== null && p.management.partialAtR < tpR ? p.management.partialAtR : null,
    partialFrac: p.management.partialFraction,
    trailAtr: p.management.trailAtr,
  };
}

function empty(
  model: ModelId,
  p: StrategyParams,
  rejection: string,
  reasons: string[] = [],
  components: ModelEvaluation["components"] = {},
): ModelEvaluation {
  return {
    model,
    triggered: false,
    side: null,
    entry: null,
    sl: null,
    tp: null,
    rr: null,
    score: scoreOf(components),
    components,
    reasons,
    rejection,
    exit: exitRules(p, 0, p.targetR),
  };
}

/** Bullish (s = 1) or bearish (s = −1) trigger candle: closes in its direction, in the outer part of its range. */
function trigger(fr: TradingFrame, i: number, s: 1 | -1, minClv = 0.3): boolean {
  const c = fr.close(i);
  const o = fr.open(i);
  const clv = fr.f.clv[i] as number;
  return s * (c - o) > 0 && s * clv >= minClv;
}

/**
 * Target: `targetR` × risk (or `cap`, when given and nearer), stopped short of the nearest opposing zone with at
 * least `minTouches` touches; returns tp and rr, or a rejection when the reward/risk is below the minimum.
 */
function target(
  fr: TradingFrame,
  i: number,
  s: 1 | -1,
  entry: number,
  sl: number,
  zones: Zone[],
  p: StrategyParams,
  opts: { minTouches?: number; cap?: { price: number; label: string } } = {},
): { tp: number; rr: number; detail: string } | { reject: string } {
  const risk = Math.abs(entry - sl);
  const atr = fr.atr(i);
  let tp = entry + s * p.targetR * risk;
  let detail = `${p.targetR}R target`;
  if (opts.cap && s * (opts.cap.price - tp) < 0) {
    tp = opts.cap.price;
    detail = opts.cap.label;
  }
  zones = zones.filter((z) => z.touches >= (opts.minTouches ?? 2));
  const opposing = zones
    .filter((z) => (s > 0 ? z.low > entry + 0.1 * atr : z.high < entry - 0.1 * atr))
    .sort((a, b) => (s > 0 ? a.low - b.low : b.high - a.high))[0];
  if (opposing) {
    const edge = s > 0 ? opposing.low - 0.1 * atr : opposing.high + 0.1 * atr;
    if (s * (edge - tp) < 0) {
      tp = edge;
      detail = `capped before the ${s > 0 ? "resistance" : "support"} zone ${opposing.low.toFixed(2)}–${opposing.high.toFixed(2)} (${opposing.touches} touches)`;
    }
  }
  const rr = Math.abs(tp - entry) / risk;
  if (rr < p.minRewardRisk)
    return { reject: `reward/risk ${rr.toFixed(2)} below ${p.minRewardRisk} (${detail})` };
  return { tp, rr, detail };
}

function stopCheck(fr: TradingFrame, i: number, entry: number, sl: number, p: StrategyParams): string | null {
  const d = Math.abs(entry - sl) / fr.atr(i);
  if (d < p.minStopAtr)
    return `structural stop ${d.toFixed(2)} ATR is tighter than ${p.minStopAtr} ATR (inside normal noise)`;
  if (d > p.maxStopAtr) return `structural stop ${d.toFixed(2)} ATR is wider than ${p.maxStopAtr} ATR`;
  return null;
}

function volatilityComponent(fr: TradingFrame, i: number, p: StrategyParams): Component | { reject: string } {
  const pct = fr.f.atrPct[i] as number;
  if (!fin(pct)) return { reject: "ATR percentile not available yet" };
  if (pct < p.minAtrPercentile || pct > p.maxAtrPercentile)
    return { reject: `ATR percentile ${pct.toFixed(2)} outside ${p.minAtrPercentile}–${p.maxAtrPercentile}` };
  return {
    score: pct >= 0.2 && pct <= 0.85 ? 1 : 0.5,
    detail: `ATR ${fr.atr(i).toFixed(2)}, percentile ${pct.toFixed(2)}`,
  };
}

function rrComponent(rr: number): Component {
  return { score: Math.min(1, 0.4 + (rr - 1.5) * 0.6), detail: `reward/risk ${rr.toFixed(2)}` };
}

// ---------------------------------------------------------------------------------------------------- A

export function trendPullback(ctx: ModelContext): ModelEvaluation {
  const { frame: fr, i, params: p } = ctx;
  const model: ModelId = "trend_pullback";
  const htf = fr.htfTrend(i);
  if (htf.dir === "flat") return empty(model, p, `1h trend is flat (${htf.detail})`);
  const s: 1 | -1 = htf.dir === "up" ? 1 : -1;
  const side: Side = s > 0 ? "long" : "short";
  const atr = fr.atr(i);
  const components: ModelEvaluation["components"] = {
    trend: { score: 0.6 + 0.4 * htf.strength, detail: htf.detail },
  };
  const st = fr.structure(i);
  if (st.dir === (s > 0 ? "down" : "up"))
    return empty(model, p, `15m structure against the 1h trend (${st.detail})`, [], components);
  components.structure = { score: st.dir === (s > 0 ? "up" : "down") ? 1 : 0.5, detail: st.detail };
  // The impulse: the last confirmed swing in the trend direction, and the swing it started from.
  const sw = fr.swings(i, 60);
  const ext = [...sw].reverse().find((x) => x.kind === (s > 0 ? "high" : "low") && i - x.idx <= 14);
  if (!ext) return empty(model, p, "no recent impulse swing within 14 candles", [], components);
  const start = [...sw].reverse().find((x) => x.kind === (s > 0 ? "low" : "high") && x.idx < ext.idx);
  if (!start) return empty(model, p, "no swing before the impulse", [], components);
  const impulse = s * (ext.price - start.price);
  if (impulse < 1.5 * atr)
    return empty(
      model,
      p,
      `impulse ${(impulse / atr).toFixed(2)} ATR is smaller than 1.5 ATR`,
      [],
      components,
    );
  // The pullback since the impulse extreme.
  let pb = s > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  let minRsi = Number.POSITIVE_INFINITY;
  let maxRsi = Number.NEGATIVE_INFINITY;
  for (let k = ext.idx + 1; k <= i; k++) {
    pb = s > 0 ? Math.min(pb, fr.low(k)) : Math.max(pb, fr.high(k));
    minRsi = Math.min(minRsi, fr.rsi[k] as number);
    maxRsi = Math.max(maxRsi, fr.rsi[k] as number);
  }
  const bars = i - ext.idx;
  if (bars < 2) return empty(model, p, "pullback shorter than 2 candles", [], components);
  const depth = (s * (ext.price - pb)) / impulse;
  if (depth < 0.25 || depth > 0.8)
    return empty(
      model,
      p,
      `pullback depth ${(depth * 100).toFixed(0)}% outside 25–80% of the impulse`,
      [],
      components,
    );
  if (s * (pb - start.price) <= 0)
    return empty(model, p, "pullback broke the impulse origin (structure failed)", [], components);
  const e20 = fr.ema20[i] as number;
  const e50 = fr.ema50[i] as number;
  const inBand =
    s > 0 ? pb <= e20 + 0.3 * atr && pb >= e50 - 0.6 * atr : pb >= e20 - 0.3 * atr && pb <= e50 + 0.6 * atr;
  components.setup_quality = {
    score: Math.max(0, 1 - Math.abs(depth - 0.5) * 2) * 0.6 + (inBand ? 0.4 : 0.1),
    detail: `pullback ${(depth * 100).toFixed(0)}% of a ${(impulse / atr).toFixed(1)} ATR impulse over ${bars} candles${inBand ? ", into the EMA20–EMA50 band" : ""}`,
  };
  if (!trigger(fr, i, s) || s * (fr.close(i) - (s > 0 ? fr.high(i - 1) : fr.low(i - 1))) <= 0) {
    return empty(
      model,
      p,
      `no ${s > 0 ? "bullish" : "bearish"} trigger candle closing beyond the previous candle`,
      [],
      components,
    );
  }
  const rsiNow = fr.rsi[i] as number;
  const reset = s > 0 ? minRsi <= 52 && rsiNow > minRsi + 2 : maxRsi >= 48 && rsiNow < maxRsi - 2;
  const macdTurn = s * ((fr.macdHist[i] as number) - (fr.macdHist[i - 1] as number)) > 0;
  components.momentum = {
    score: (reset ? 0.6 : 0.2) + (macdTurn ? 0.4 : 0),
    detail: `RSI ${rsiNow.toFixed(1)} (pullback ${s > 0 ? "min" : "max"} ${(s > 0 ? minRsi : maxRsi).toFixed(1)}), MACD histogram ${macdTurn ? "turning" : "not turning"}`,
  };
  const vol = volatilityComponent(fr, i, p);
  if ("reject" in vol) return empty(model, p, vol.reject, [], components);
  components.volatility = vol;
  const entry = fr.close(i);
  const sl = (s > 0 ? Math.min(pb, fr.low(i)) : Math.max(pb, fr.high(i))) - s * 0.15 * atr;
  const stopProblem = stopCheck(fr, i, entry, sl, p);
  if (stopProblem) return empty(model, p, stopProblem, [], components);
  const zones = fr.zones(i);
  const tgt = target(fr, i, s, entry, sl, zones, p);
  if ("reject" in tgt) return empty(model, p, tgt.reject, [], components);
  components.support_resistance = { score: tgt.detail.startsWith("capped") ? 0.6 : 1, detail: tgt.detail };
  const sweptPrior = sw.some(
    (x) => x.kind === (s > 0 ? "low" : "high") && x.idx < ext.idx && s * (pb - x.price) < 0,
  );
  components.liquidity = {
    score: sweptPrior ? 1 : 0.5,
    detail: sweptPrior ? "the pullback swept a prior swing and recovered" : "no sweep during the pullback",
  };
  components.regime_fit = { score: ctx.regimeFit, detail: `regime: ${ctx.regime.label}` };
  components.reward_risk = rrComponent(tgt.rr);
  const reasons = [
    `1h trend ${htf.dir}; 15m ${st.detail}`,
    `pullback of ${(depth * 100).toFixed(0)}% ended with a ${s > 0 ? "bullish" : "bearish"} trigger candle`,
    `stop beyond the pullback extreme, ${(Math.abs(entry - sl) / atr).toFixed(2)} ATR; target ${tgt.detail}`,
  ];
  return {
    model,
    triggered: true,
    side,
    entry,
    sl,
    tp: tgt.tp,
    rr: tgt.rr,
    score: scoreOf(components),
    components,
    reasons,
    rejection: null,
    exit: exitRules(p, Math.abs(entry - sl) / atr, tgt.rr),
  };
}

// ---------------------------------------------------------------------------------------------------- B

export function breakoutRetest(ctx: ModelContext): ModelEvaluation {
  const { frame: fr, i, params: p } = ctx;
  const model: ModelId = "breakout_retest";
  let found: { b: number; zone: Zone; s: 1 | -1 } | null = null;
  for (let b = i - 1; b >= Math.max(2, i - 8) && !found; b--) {
    const atrB = fr.atr(b);
    const body = fr.f.body[b] as number;
    for (const z of fr.zones(b - 1)) {
      if (fr.close(b - 1) <= z.high && fr.close(b) > z.high + 0.2 * atrB && body >= 0.5)
        found = { b, zone: z, s: 1 };
      else if (fr.close(b - 1) >= z.low && fr.close(b) < z.low - 0.2 * atrB && body <= -0.5)
        found = { b, zone: z, s: -1 };
      if (found) break;
    }
  }
  if (!found) return empty(model, p, "no confirmed close through a tested S/R zone in the last 8 candles");
  const { b, zone, s } = found;
  const side: Side = s > 0 ? "long" : "short";
  const atr = fr.atr(i);
  const level = s > 0 ? zone.high : zone.low;
  const components: ModelEvaluation["components"] = {};
  // Real breakout: no close back inside the zone after the breakout candle.
  for (let k = b + 1; k <= i; k++) {
    if (s * (fr.close(k) - level) < -0.1 * atr)
      return empty(
        model,
        p,
        `closed back inside the zone after the breakout (false breakout)`,
        [],
        components,
      );
  }
  let retest = -1;
  for (let k = b + 1; k <= i; k++)
    if (s > 0 ? fr.low(k) <= level + 0.3 * atr : fr.high(k) >= level - 0.3 * atr) retest = k;
  if (retest < 0) return empty(model, p, "no retest of the broken level yet", [], components);
  components.setup_quality = {
    score: Math.min(1, 0.5 + 0.15 * zone.touches) * (i - b <= 6 ? 1 : 0.8),
    detail: `${s > 0 ? "resistance" : "support"} ${zone.low.toFixed(2)}–${zone.high.toFixed(2)} (${zone.touches} touches) broken ${i - b} candles ago and retested`,
  };
  const triggered =
    retest === i
      ? trigger(fr, i, s, 0.5) && s * (fr.close(i) - level) > 0.1 * atr
      : trigger(fr, i, s) && s * (fr.close(i) - (s > 0 ? fr.high(i - 1) : fr.low(i - 1))) > 0;
  if (!triggered || s * (fr.close(i) - level) <= 0)
    return empty(model, p, "no trigger candle after the retest", [], components);
  const htf = fr.htfTrend(i);
  if (htf.dir === (s > 0 ? "down" : "up"))
    return empty(model, p, `1h trend is ${htf.dir}, against the breakout`, [], components);
  components.trend = { score: htf.dir === "flat" ? 0.5 : 0.6 + 0.4 * htf.strength, detail: htf.detail };
  const st = fr.structure(i);
  components.structure = {
    score: st.dir === (s > 0 ? "up" : "down") ? 1 : st.dir === "mixed" ? 0.5 : 0.2,
    detail: st.detail,
  };
  const volB = fr.volume[b];
  let avgVol = 0;
  for (let k = b - 20; k < b; k++) avgVol += fr.volume[k] ?? 0;
  avgVol /= 20;
  const ra = fr.f.rangeAtr[b] as number;
  components.liquidity =
    volB !== null && volB !== undefined && avgVol > 0
      ? {
          score: volB >= 1.3 * avgVol ? 1 : 0.4,
          detail: `breakout volume ${(volB / avgVol).toFixed(2)}× its 20-candle average`,
        }
      : {
          score: ra >= 1.2 ? 0.8 : 0.4,
          detail: `no volume published; range proxy: breakout candle ${ra.toFixed(2)} ATR`,
        };
  const macdOk = s * (fr.macdHist[i] as number) > 0;
  const rsiNow = fr.rsi[i] as number;
  components.momentum = {
    score: (macdOk ? 0.6 : 0.2) + (s * (rsiNow - 50) > 0 ? 0.4 : 0),
    detail: `MACD histogram ${(fr.macdHist[i] as number).toFixed(2)}, RSI ${rsiNow.toFixed(1)}`,
  };
  const vol = volatilityComponent(fr, i, p);
  if ("reject" in vol) return empty(model, p, vol.reject, [], components);
  components.volatility = vol;
  let extreme = s > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let k = retest; k <= i; k++)
    extreme = s > 0 ? Math.min(extreme, fr.low(k)) : Math.max(extreme, fr.high(k));
  const entry = fr.close(i);
  const sl = extreme - s * 0.15 * atr;
  const stopProblem = stopCheck(fr, i, entry, sl, p);
  if (stopProblem) return empty(model, p, stopProblem, [], components);
  const tgt = target(
    fr,
    i,
    s,
    entry,
    sl,
    fr.zones(i).filter((z) => z !== zone && Math.abs(z.mid - zone.mid) > 0.3 * atr),
    p,
  );
  if ("reject" in tgt) return empty(model, p, tgt.reject, [], components);
  components.support_resistance = { score: tgt.detail.startsWith("capped") ? 0.6 : 1, detail: tgt.detail };
  components.regime_fit = { score: ctx.regimeFit, detail: `regime: ${ctx.regime.label}` };
  components.reward_risk = rrComponent(tgt.rr);
  const reasons = [
    `confirmed close ${s > 0 ? "above" : "below"} ${zone.touches}-touch zone ${zone.low.toFixed(2)}–${zone.high.toFixed(2)}`,
    `retest held and a ${s > 0 ? "bullish" : "bearish"} trigger candle closed beyond it`,
    `stop beyond the retest extreme, ${(Math.abs(entry - sl) / atr).toFixed(2)} ATR; target ${tgt.detail}`,
  ];
  return {
    model,
    triggered: true,
    side,
    entry,
    sl,
    tp: tgt.tp,
    rr: tgt.rr,
    score: scoreOf(components),
    components,
    reasons,
    rejection: null,
    exit: exitRules(p, Math.abs(entry - sl) / atr, tgt.rr),
  };
}

// ---------------------------------------------------------------------------------------------------- C

export function failedBreakout(ctx: ModelContext): ModelEvaluation {
  const { frame: fr, i, params: p } = ctx;
  const model: ModelId = "failed_breakout";
  const swings = fr.swings(i, 60);
  let found: { sIdx: number; level: number; s: 1 | -1; wick: number } | null = null;
  // The sweep candle is 1–3 candles before the confirmation candle i.
  for (let k = i - 1; k >= Math.max(1, i - 3) && !found; k--) {
    const atrK = fr.atr(k);
    for (const sw of swings) {
      if (sw.idx >= k - 1) continue;
      if (
        sw.kind === "high" &&
        fr.high(k) > sw.price + 0.05 * atrK &&
        fr.close(k) < sw.price &&
        (fr.f.upWick[k] as number) >= 0.35
      ) {
        if (!found || sw.price > found.level)
          found = { sIdx: k, level: sw.price, s: -1, wick: fr.f.upWick[k] as number };
      }
      if (
        sw.kind === "low" &&
        fr.low(k) < sw.price - 0.05 * atrK &&
        fr.close(k) > sw.price &&
        (fr.f.loWick[k] as number) >= 0.35
      ) {
        if (!found || sw.price < found.level)
          found = { sIdx: k, level: sw.price, s: 1, wick: fr.f.loWick[k] as number };
      }
    }
  }
  if (!found)
    return empty(model, p, "no liquidity sweep of a prior swing that closed back inside (last 3 candles)");
  const { sIdx, level, s, wick } = found;
  const side: Side = s > 0 ? "long" : "short";
  const atr = fr.atr(i);
  const components: ModelEvaluation["components"] = {
    liquidity: {
      score: Math.min(1, 0.5 + wick),
      detail: `swept the swing ${s > 0 ? "low" : "high"} ${level.toFixed(2)} with a ${(wick * 100).toFixed(0)}% wick and closed back inside`,
    },
  };
  // Structural confirmation: a close beyond the sweep candle's opposite extreme.
  const confirmLevel = s > 0 ? fr.high(sIdx) : fr.low(sIdx);
  if (s * (fr.close(i) - confirmLevel) <= 0 || !trigger(fr, i, s)) {
    return empty(
      model,
      p,
      `no structural confirmation: needs a ${s > 0 ? "bullish" : "bearish"} close beyond the sweep candle's ${s > 0 ? "high" : "low"} ${confirmLevel.toFixed(2)}`,
      [],
      components,
    );
  }
  const htf = fr.htfTrend(i);
  if (htf.dir === (s > 0 ? "down" : "up") && htf.strength > 0.6)
    return empty(model, p, `strong 1h ${htf.dir} trend against the reversal`, [], components);
  components.trend = {
    score: htf.dir === "flat" ? 0.8 : htf.dir === (s > 0 ? "up" : "down") ? 1 : 0.4,
    detail: htf.detail,
  };
  const st = fr.structure(i);
  components.structure = {
    score: st.dir === "mixed" ? 0.8 : st.dir === (s > 0 ? "up" : "down") ? 1 : 0.4,
    detail: st.detail,
  };
  components.setup_quality = {
    score: 0.7 + (i - sIdx === 1 ? 0.3 : 0.1),
    detail: `confirmed ${i - sIdx} candle(s) after the sweep`,
  };
  const rsiSweep = fr.rsi[sIdx] as number;
  const rsiTurn = s * ((fr.rsi[i] as number) - rsiSweep) > 0;
  components.momentum = {
    score: (s > 0 ? rsiSweep <= 40 : rsiSweep >= 60) ? (rsiTurn ? 1 : 0.6) : rsiTurn ? 0.5 : 0.2,
    detail: `RSI at the sweep ${rsiSweep.toFixed(1)}, now ${(fr.rsi[i] as number).toFixed(1)}`,
  };
  const vol = volatilityComponent(fr, i, p);
  if ("reject" in vol) return empty(model, p, vol.reject, [], components);
  components.volatility = vol;
  let extreme = s > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let k = sIdx; k <= i; k++)
    extreme = s > 0 ? Math.min(extreme, fr.low(k)) : Math.max(extreme, fr.high(k));
  const entry = fr.close(i);
  const sl = extreme - s * 0.15 * atr;
  const stopProblem = stopCheck(fr, i, entry, sl, p);
  if (stopProblem) return empty(model, p, stopProblem, [], components);
  // A failed breakout reverts across the range: aim for the opposite edge of the 48-candle range; only strong
  // zones (3+ touches) in between cap the target.
  const edge =
    s > 0
      ? (fr.f.donchianHigh(48)[i] as number) - 0.1 * atr
      : (fr.f.donchianLow(48)[i] as number) + 0.1 * atr;
  const tgt = target(fr, i, s, entry, sl, fr.zones(i), p, {
    minTouches: 3,
    ...(Number.isFinite(edge) && s * (edge - entry) > 0
      ? { cap: { price: edge, label: `opposite edge of the 48-candle range ${edge.toFixed(2)}` } }
      : {}),
  });
  if ("reject" in tgt) return empty(model, p, tgt.reject, [], components);
  components.support_resistance = { score: tgt.detail.startsWith("capped") ? 0.7 : 1, detail: tgt.detail };
  components.regime_fit = { score: ctx.regimeFit, detail: `regime: ${ctx.regime.label}` };
  components.reward_risk = rrComponent(tgt.rr);
  const reasons = [
    `liquidity sweep of the swing ${s > 0 ? "low" : "high"} ${level.toFixed(2)} failed (closed back inside)`,
    `structure confirmed by a close beyond the sweep candle's ${s > 0 ? "high" : "low"}`,
    `stop beyond the sweep extreme, ${(Math.abs(entry - sl) / atr).toFixed(2)} ATR; target ${tgt.detail}`,
  ];
  return {
    model,
    triggered: true,
    side,
    entry,
    sl,
    tp: tgt.tp,
    rr: tgt.rr,
    score: scoreOf(components),
    components,
    reasons,
    rejection: null,
    exit: exitRules(p, Math.abs(entry - sl) / atr, tgt.rr),
  };
}

export const EVALUATORS: Record<ModelId, (ctx: ModelContext) => ModelEvaluation> = {
  trend_pullback: trendPullback,
  breakout_retest: breakoutRetest,
  failed_breakout: failedBreakout,
};

export { sideSign };
