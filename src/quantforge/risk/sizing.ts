// Risk-based position sizing for a contract whose specification comes from configuration (contract size,
// tick size, lot limits), because XAUUSD contracts differ between brokers.

import type { QuantForgeConfig } from "../config/schema.js";
import { floorToStep } from "../core/util.js";

export type SizingInput = {
  equity: number;
  riskPct: number;
  /** Stop distance in price units (USD per ounce). */
  stopDistance: number;
  /** Expected spread and slippage for the trade (price units). */
  spread: number;
  slippage: number;
  /** Risk budget still available (USD), e.g. after correlated exposure; Infinity when unconstrained. */
  maxRiskUsd?: number | undefined;
};

export type SizingResult =
  | {
      ok: true;
      lots: number;
      riskUsd: number;
      lossAtStopUsd: number;
      lossPerLotUsd: number;
      tickValuePerLot: number;
      ticksToStop: number;
      marginUsd: number;
    }
  | { ok: false; reason: string; lossPerLotUsd?: number; requiredEquity?: number };

/**
 * Lots = floor_to_step(risk budget / loss per lot at the stop). The loss per lot includes the stop distance,
 * the spread crossing, slippage on entry and exit, and the round-trip commission, so the realized loss at the
 * stop does not exceed the budget. Sizes below the minimum lot are refused, never rounded up.
 */
export function sizePosition(
  input: SizingInput,
  inst: QuantForgeConfig["instrument"],
  costs: QuantForgeConfig["costs"],
  entryPrice: number,
): SizingResult {
  if (!(input.equity > 0)) return { ok: false, reason: "no equity" };
  if (!(input.stopDistance > 0)) return { ok: false, reason: "stop distance must be positive" };
  const ticksToStop = Math.round(input.stopDistance / inst.tickSize);
  if (ticksToStop < 1) return { ok: false, reason: "stop distance is below one tick" };
  const tickValuePerLot = inst.tickSize * inst.contractSize;
  const lossPerLotUsd =
    (input.stopDistance + input.spread + 2 * input.slippage) * inst.contractSize +
    costs.commissionPerLotRoundTrip;
  const budget = Math.min((input.equity * input.riskPct) / 100, input.maxRiskUsd ?? Number.POSITIVE_INFINITY);
  if (!(budget > 0)) return { ok: false, reason: "no risk budget left", lossPerLotUsd };
  let lots = floorToStep(budget / lossPerLotUsd, inst.lotStep);
  lots = Math.min(lots, inst.maxLot);
  if (lots + 1e-12 < inst.minLot) {
    const requiredEquity = ((inst.minLot * lossPerLotUsd) / input.riskPct) * 100;
    return {
      ok: false,
      reason: `risk budget ${budget.toFixed(2)} USD is below the loss of the minimum lot (${(inst.minLot * lossPerLotUsd).toFixed(2)} USD at this stop); the trade is refused rather than oversized`,
      lossPerLotUsd,
      requiredEquity,
    };
  }
  const marginUsd = (lots * inst.contractSize * entryPrice) / inst.leverage;
  return {
    ok: true,
    lots,
    riskUsd: budget,
    lossAtStopUsd: lots * lossPerLotUsd,
    lossPerLotUsd,
    tickValuePerLot,
    ticksToStop,
    marginUsd,
  };
}
