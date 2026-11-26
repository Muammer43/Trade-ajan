// Broker adapter contract. Signal generation, order preparation and validation happen upstream (decision
// engine, risk engine, order manager); an adapter only submits, confirms, modifies and closes. An adapter
// must be independently testable against tests/unit/broker-contract.test.ts.

import type { Side, TradingMode } from "../core/types.js";
import type { ExitRules } from "../strategy/spec.js";

export type OrderType = "market" | "limit" | "stop";

export type OrderRequest = {
  clientOrderId: string;
  side: Side;
  type: OrderType;
  lots: number;
  /** Limit/stop trigger price for pending orders. */
  price?: number | undefined;
  sl: number;
  tp: number;
  strategyId: string | null;
  decisionId: number | null;
  /** Management context the paper broker needs to manage the position like the backtest did. */
  meta: { atr: number; rules: ExitRules; regime: string | null; expiresAt?: number | undefined };
};

export type OrderAck =
  | {
      status: "filled";
      brokerOrderId: string;
      positionId: number;
      fillPrice: number;
      referencePrice: number;
      slippage: number;
      spread: number;
    }
  | { status: "accepted"; brokerOrderId: string }
  | { status: "rejected"; reason: string };

export type BrokerPosition = {
  id: number;
  side: Side;
  lots: number;
  entry: number;
  sl: number;
  tp: number | null;
  strategyId: string | null;
};

export type BrokerCapabilities = {
  market: boolean;
  pending: boolean;
  partialClose: boolean;
  modify: boolean;
  /** Whether stops live on the broker's server (survive this process being down). */
  serverSideStops: boolean;
};

export interface BrokerAdapter {
  readonly id: string;
  readonly mode: TradingMode;
  readonly capabilities: BrokerCapabilities;
  connect(): Promise<{ ok: boolean; detail: string }>;
  account(): Promise<{ balance: number; equity: number; freeMargin: number; currency: string }>;
  positions(): Promise<BrokerPosition[]>;
  submit(req: OrderRequest): Promise<OrderAck>;
  modify(
    positionId: number,
    change: { sl?: number | undefined; tp?: number | undefined },
  ): Promise<{ ok: boolean; reason?: string }>;
  close(
    positionId: number,
    fraction: number,
    reason: string,
  ): Promise<{ ok: boolean; price?: number; pnl?: number; reason?: string }>;
}
