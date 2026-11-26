// Order lifecycle: prepare → validate → submit → confirm, with idempotency and reconciliation.
//
// The client order id is derived from (account, strategy, signal bar, side), and is UNIQUE in the database:
// the same signal can never produce two orders, even across crashes and restarts. Every status change is an
// order_events row. On start-up, orders left in a non-terminal state are reconciled against the broker.

import { createHash } from "node:crypto";
import type { SourceLogger } from "../core/logger.js";
import type { Side } from "../core/types.js";
import type { Database } from "../database/db.js";
import type { BrokerAdapter, OrderAck, OrderRequest, OrderType } from "./broker.js";

export type OrderStatus =
  | "new"
  | "validated"
  | "submitted"
  | "accepted"
  | "filled"
  | "rejected"
  | "cancelled";
const TERMINAL: readonly OrderStatus[] = ["filled", "rejected", "cancelled"];

export function clientOrderId(account: string, strategyId: string, signalBarTs: number, side: Side): string {
  return `qf-${createHash("sha256").update(`${account}|${strategyId}|${signalBarTs}|${side}`).digest("hex").slice(0, 24)}`;
}

export type SubmitResult =
  | {
      outcome: "filled";
      orderId: number;
      positionId: number;
      fillPrice: number;
      referencePrice: number;
      slippage: number;
    }
  | { outcome: "accepted"; orderId: number }
  | { outcome: "rejected"; orderId: number | null; reason: string }
  | { outcome: "duplicate"; orderId: number; reason: string };

export class OrderManager {
  constructor(
    private readonly db: Database,
    private readonly broker: BrokerAdapter & {
      submit(req: OrderRequest, orderId?: number | null): Promise<OrderAck>;
    },
    readonly account: string,
    private readonly log: SourceLogger,
    private readonly now: () => number = Date.now,
  ) {}

  private transition(
    orderId: number,
    from: OrderStatus | null,
    to: OrderStatus,
    detail?: unknown,
    fields: Record<string, number | string | null> = {},
  ): void {
    const sets = ["status=?", "updated_at=?", ...Object.keys(fields).map((k) => `${k}=?`)].join(", ");
    this.db.tx(() => {
      this.db.run(`UPDATE orders SET ${sets} WHERE id=?`, to, this.now(), ...Object.values(fields), orderId);
      this.db.run(
        "INSERT INTO order_events(order_id, ts, from_status, to_status, detail) VALUES (?,?,?,?,?)",
        orderId,
        this.now(),
        from,
        to,
        detail === undefined ? null : JSON.stringify(detail),
      );
    });
  }

  /**
   * Submit an order. `validate` is the final pre-submission gate (risk engine verdict and live-safety gate)
   * and is evaluated after the order row exists, so even a refused order leaves an audit trail.
   */
  async submit(
    req: OrderRequest & { type: OrderType },
    validate: () => { ok: boolean; reason?: string },
  ): Promise<SubmitResult> {
    const existing = this.db.get<{ id: number; status: string }>(
      "SELECT id, status FROM orders WHERE client_order_id=?",
      req.clientOrderId,
    );
    if (existing)
      return {
        outcome: "duplicate",
        orderId: existing.id,
        reason: `order ${req.clientOrderId} already exists (${existing.status}); not resubmitted`,
      };
    let orderId: number;
    try {
      orderId = this.db.run(
        `INSERT INTO orders(client_order_id, account, broker, mode, decision_id, strategy_id, side, type, lots, requested_price, sl, tp, status, intent, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'new','open',?,?)`,
        req.clientOrderId,
        this.account,
        this.broker.id,
        this.broker.mode,
        req.decisionId,
        req.strategyId,
        req.side,
        req.type,
        req.lots,
        req.price ?? null,
        req.sl,
        req.tp,
        this.now(),
        this.now(),
      ).lastId;
      this.db.run(
        "INSERT INTO order_events(order_id, ts, from_status, to_status, detail) VALUES (?,?,?,?,?)",
        orderId,
        this.now(),
        null,
        "new",
        JSON.stringify({ lots: req.lots, side: req.side }),
      );
    } catch (error) {
      if (/UNIQUE/i.test((error as Error).message)) {
        const row = this.db.get<{ id: number }>(
          "SELECT id FROM orders WHERE client_order_id=?",
          req.clientOrderId,
        );
        return { outcome: "duplicate", orderId: row?.id ?? -1, reason: "concurrent duplicate order refused" };
      }
      throw error;
    }
    const verdict = validate();
    if (!verdict.ok) {
      this.transition(
        orderId,
        "new",
        "rejected",
        { stage: "validation", reason: verdict.reason },
        { reject_reason: verdict.reason ?? "validation failed" },
      );
      return { outcome: "rejected", orderId, reason: verdict.reason ?? "validation failed" };
    }
    this.transition(orderId, "new", "validated");
    this.transition(orderId, "validated", "submitted", { broker: this.broker.id });
    let ack: OrderAck;
    try {
      ack = await this.broker.submit(req, orderId);
    } catch (error) {
      const reason = `broker error: ${(error as Error).message}`;
      this.transition(orderId, "submitted", "rejected", { reason }, { reject_reason: reason });
      return { outcome: "rejected", orderId, reason };
    }
    if (ack.status === "filled") {
      this.transition(orderId, "submitted", "filled", ack, {
        broker_order_id: ack.brokerOrderId,
        fill_price: ack.fillPrice,
        reference_price: ack.referencePrice,
        slippage: ack.slippage,
        position_id: ack.positionId,
      });
      return {
        outcome: "filled",
        orderId,
        positionId: ack.positionId,
        fillPrice: ack.fillPrice,
        referencePrice: ack.referencePrice,
        slippage: ack.slippage,
      };
    }
    if (ack.status === "accepted") {
      this.transition(
        orderId,
        "submitted",
        "accepted",
        { brokerOrderId: ack.brokerOrderId, meta: req.meta },
        { broker_order_id: ack.brokerOrderId },
      );
      return { outcome: "accepted", orderId };
    }
    this.transition(orderId, "submitted", "rejected", ack, { reject_reason: ack.reason });
    return { outcome: "rejected", orderId, reason: ack.reason };
  }

  /** Cancel pending orders older than `maxAgeMs`. */
  expirePending(maxAgeMs: number): number {
    const stale = this.db.all<{ id: number }>(
      "SELECT id FROM orders WHERE account=? AND status='accepted' AND created_at<?",
      this.account,
      this.now() - maxAgeMs,
    );
    for (const o of stale) this.transition(o.id, "accepted", "cancelled", { reason: "expired" });
    return stale.length;
  }

  /**
   * Reconcile after a restart: an order left "new"/"validated" never reached the broker and is cancelled;
   * one left "submitted" is matched to a broker position by order id, else cancelled as unconfirmed.
   * Orders are never re-sent automatically.
   */
  async reconcile(): Promise<{
    checked: number;
    filled: number;
    cancelled: number;
    orphanPositions: number[];
  }> {
    const open = this.db.all<{ id: number; status: OrderStatus }>(
      `SELECT id, status FROM orders WHERE account=? AND status NOT IN (${TERMINAL.map(() => "?").join(",")}) AND status<>'accepted'`,
      this.account,
      ...TERMINAL,
    );
    let filled = 0;
    let cancelled = 0;
    const brokerPositions = await this.broker.positions();
    for (const o of open) {
      const pos = this.db.get<{ id: number; entry_price: number }>(
        "SELECT id, entry_price FROM positions WHERE order_id=?",
        o.id,
      );
      if (pos && o.status === "submitted") {
        this.transition(
          o.id,
          o.status,
          "filled",
          { reconciled: true },
          { position_id: pos.id, fill_price: pos.entry_price },
        );
        filled++;
      } else {
        this.transition(o.id, o.status, "cancelled", {
          reason: "interrupted before confirmation; not re-sent",
        });
        cancelled++;
      }
    }
    // Positions the broker holds that no order explains.
    const known = new Set(
      this.db
        .all<{ position_id: number }>("SELECT position_id FROM orders WHERE position_id IS NOT NULL")
        .map((r) => Number(r.position_id)),
    );
    const orphanPositions = brokerPositions
      .filter(
        (p) =>
          !known.has(p.id) &&
          this.db.get("SELECT id FROM positions WHERE id=? AND order_id IS NOT NULL", p.id) === undefined,
      )
      .map((p) => p.id);
    if (open.length || orphanPositions.length)
      this.log.warn("order reconciliation", { checked: open.length, filled, cancelled, orphanPositions });
    return { checked: open.length, filled, cancelled, orphanPositions };
  }

  recent(limit: number): Record<string, unknown>[] {
    return this.db.all("SELECT * FROM orders WHERE account=? ORDER BY id DESC LIMIT ?", this.account, limit);
  }
}
