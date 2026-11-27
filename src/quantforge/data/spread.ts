// Modelled XAUUSD spread, shared by paper execution and the backtest so both pay the same costs.

import type { QuantForgeConfig } from "../config/schema.js";
import { minutesToClose, sessionOf } from "../core/time.js";

/**
 * The configured typical spread, widened in the thin Asian session (×1.3) and in the 30 minutes before a
 * market close (×2), when dealer spreads on gold are known to widen.
 */
export function modelledSpread(config: QuantForgeConfig, ts: number): number {
  let s = config.costs.spread;
  if (sessionOf(ts) === "asia") s *= 1.3;
  const toClose = minutesToClose(ts);
  if (toClose > 0 && toClose <= 30) s *= 2;
  return Math.round(s * 100) / 100;
}
