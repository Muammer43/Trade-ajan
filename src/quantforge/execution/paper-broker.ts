// Paper broker: simulated execution against real market data. It never sends an order anywhere.
//
// Market orders fill at the live ask (buy) or bid (sell) plus configured slippage; bid/ask are the provider's
// when published, otherwise modelled from the mid and the configured spread. Stops, targets and partials are
// checked on every closed monitoring bar (5m by default) with the same rules the backtester uses; break-even,
// trailing and time exits are applied at strategy-timeframe closes. Commission is charged per side; swap at
// each 17:00 New York rollover (Wednesday triple). Every fill, fee and P&L is a ledger transaction.

import type { QuantForgeConfig } from "../config/schema.js";
import type { SourceLogger } from "../core/logger.js";
import { minutesToClose, nextCloseIsWeekend, rolloversBetween } from "../core/time.js";
import { type Quote, type StoredCandle, TF_MS } from "../core/types.js";
import { floorToStep } from "../core/util.js";
import type { Database } from "../database/db.js";
import { type ExitEvent, type ExitKind, stepBar } from "../risk/position-rules.js";
import type { BrokerAdapter, BrokerPosition, OrderAck, OrderRequest } from "./broker.js";
import type { Ledger, PositionRow } from "./ledger.js";

export type CloseResult = {
  positionId: number;
  kind: ExitKind | "partial_skipped";
  lots: number;
  price: number;
  pnl: number;
  closed: boolean;
};

export class PaperBroker implements BrokerAdapter {
  readonly id = "paper";
  readonly mode = "paper" as const;
  readonly capabilities = {
    market: true,
    pending: true,
    partialClose: true,
    modify: true,
    serverSideStops: false,
  };

  constructor(
    private readonly db: Database,
    private readonly ledger: Ledger,
    private readonly config: QuantForgeConfig,
    /** The latest real quote; throws when none can be obtained. */
    private readonly quote: () => Promise<Quote>,
    private readonly log: SourceLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async connect(): Promise<{ ok: boolean; detail: string }> {
    this.ledger.ensure();
    const v = this.ledger.verify();
    return v.ok
      ? { ok: true, detail: `paper account ${this.ledger.account}: balance ${v.balance.toFixed(2)} USD` }
      : { ok: false, detail: `ledger mismatch: balance ${v.balance} ≠ transactions ${v.sum}` };
  }

  async account() {
    let q: Quote | undefined;
    try {
      q = await this.quote();
    } catch {
      q = undefined;
    }
    const v = this.ledger.view(q);
    return { balance: v.balance, equity: v.equity, freeMargin: v.freeMargin, currency: "USD" };
  }

  async positions(): Promise<BrokerPosition[]> {
    return this.ledger.openPositions().map((p) => ({
      id: p.id,
      side: p.side,
      lots: p.lots_open,
      entry: p.entry_price,
      sl: p.sl,
      tp: p.tp,
      strategyId: p.strategy_id,
    }));
  }

  private halfCommission(lots: number): number {
    return (this.config.costs.commissionPerLotRoundTrip / 2) * lots;
  }

  /** Open a position at `fill` (already including spread and slippage). */
  private open(
    req: OrderRequest,
    fill: number,
    reference: number,
    spread: number,
    slippage: number,
    orderId: number | null,
  ): number {
    return this.db.tx(() => {
      const s = req.side === "long" ? 1 : -1;
      // Re-anchor the stop and target to the actual fill so the risk distance is the one that was sized.
      const stopDist = Math.abs(req.sl - reference) || Math.abs(req.sl - fill);
      const rewardDist = Math.abs(req.tp - reference) || Math.abs(req.tp - fill);
      const sl = fill - s * stopDist;
      const tp = fill + s * rewardDist;
      const id = this.ledger.insertPosition({
        account: this.ledger.account,
        order_id: orderId,
        broker: this.id,
        mode: "paper",
        strategy_id: req.strategyId,
        side: req.side,
        lots_initial: req.lots,
        lots_open: req.lots,
        entry_price: fill,
        sl,
        tp,
        initial_sl: sl,
        opened_at: this.now(),
        last_bar_ts: null,
        rules_json: JSON.stringify(req.meta.rules),
        atr_at_entry: req.meta.atr,
        regime: req.meta.regime,
      });
      const commission = this.halfCommission(req.lots);
      if (commission > 0) {
        this.ledger.post("commission", -commission, {
          positionId: id,
          orderId: orderId ?? undefined,
          note: "entry commission",
        });
        this.db.run("UPDATE positions SET commission=commission+? WHERE id=?", commission, id);
      }
      this.log.info(
        `paper fill: ${req.side} ${req.lots} lots @ ${fill.toFixed(2)} (reference ${reference.toFixed(2)}, spread ${spread.toFixed(2)}, slippage ${slippage.toFixed(2)})`,
        { positionId: id, clientOrderId: req.clientOrderId },
      );
      return id;
    });
  }

  async submit(req: OrderRequest, orderId: number | null = null): Promise<OrderAck> {
    if (!(req.lots > 0)) return { status: "rejected", reason: "lots must be positive" };
    if (req.type !== "market") {
      // Pending: kept on the order row by the order manager; triggered in processMonitorBar.
      return { status: "accepted", brokerOrderId: `paper-pending-${req.clientOrderId}` };
    }
    let q: Quote;
    try {
      q = await this.quote();
    } catch (error) {
      return { status: "rejected", reason: `no live price to fill against: ${(error as Error).message}` };
    }
    if (this.now() - q.ts > 5 * 60_000)
      return {
        status: "rejected",
        reason: `latest price is ${Math.round((this.now() - q.ts) / 60_000)} min old`,
      };
    const slip = this.config.costs.slippage;
    const fill = req.side === "long" ? q.ask + slip : q.bid - slip;
    const positionId = this.open(req, fill, q.price, q.spread, slip, orderId);
    return {
      status: "filled",
      brokerOrderId: `paper-${positionId}`,
      positionId,
      fillPrice: fill,
      referencePrice: q.price,
      slippage: slip,
      spread: q.spread,
    };
  }

  async modify(
    positionId: number,
    change: { sl?: number | undefined; tp?: number | undefined },
  ): Promise<{ ok: boolean; reason?: string }> {
    const p = this.ledger.position(positionId);
    if (p?.status !== "open") return { ok: false, reason: "no such open position" };
    const sl = change.sl ?? p.sl;
    const tp = change.tp ?? p.tp;
    const valid =
      p.side === "long"
        ? sl < p.entry_price || sl <= (tp ?? Number.POSITIVE_INFINITY)
        : sl > p.entry_price || sl >= (tp ?? 0);
    if (!valid) return { ok: false, reason: "invalid stop/target" };
    this.db.run("UPDATE positions SET sl=?, tp=? WHERE id=?", sl, tp, positionId);
    return { ok: true };
  }

  /** Close part or all of a position at the current live price (manual/emergency). */
  async close(
    positionId: number,
    fraction: number,
    reason: string,
  ): Promise<{ ok: boolean; price?: number; pnl?: number; reason?: string }> {
    const p = this.ledger.position(positionId);
    if (p?.status !== "open") return { ok: false, reason: "no such open position" };
    let q: Quote;
    try {
      q = await this.quote();
    } catch (error) {
      return { ok: false, reason: `no live price: ${(error as Error).message}` };
    }
    const slip = this.config.costs.slippage;
    const price = p.side === "long" ? q.bid - slip : q.ask + slip;
    const lots =
      fraction >= 1 ? p.lots_open : floorToStep(p.lots_open * fraction, this.config.instrument.lotStep);
    if (!(lots > 0)) return { ok: false, reason: "fraction too small for the lot step" };
    const r = this.closeLots(p, lots, price, reason === "emergency" ? "emergency" : "manual");
    return { ok: true, price, pnl: r.pnl };
  }

  /** Realize `lots` of a position at `price`; closes it when nothing remains. */
  private closeLots(p: PositionRow, lots: number, price: number, kind: ExitKind): CloseResult {
    return this.db.tx(() => {
      const cs = this.config.instrument.contractSize;
      const s = p.side === "long" ? 1 : -1;
      const closeLots = Math.min(lots, p.lots_open);
      const pnl = Math.round(s * (price - p.entry_price) * closeLots * cs * 100) / 100;
      const commission = this.halfCommission(closeLots);
      this.ledger.post("realized_pnl", pnl, {
        positionId: p.id,
        note: `${kind} ${closeLots} lots @ ${price.toFixed(2)}`,
      });
      if (commission > 0)
        this.ledger.post("commission", -commission, { positionId: p.id, note: "exit commission" });
      const remaining = Math.max(0, Math.round((p.lots_open - closeLots) * 1e6) / 1e6);
      const closed = remaining < this.config.instrument.minLot / 2;
      this.db.run(
        "UPDATE positions SET lots_open=?, realized_pnl=realized_pnl+?, commission=commission+? WHERE id=?",
        closed ? 0 : remaining,
        pnl,
        commission,
        p.id,
      );
      if (closed) {
        const row = this.ledger.position(p.id) as PositionRow;
        const net = row.realized_pnl - row.commission + row.swap;
        const risk = Math.abs(row.entry_price - row.initial_sl) * row.lots_initial * cs;
        this.db.run(
          "UPDATE positions SET status='closed', closed_at=?, exit_reason=?, exit_price=?, r_multiple=? WHERE id=?",
          this.now(),
          kind,
          price,
          risk > 0 ? Math.round((net / risk) * 1000) / 1000 : null,
          p.id,
        );
        this.log.info(
          `paper close: position ${p.id} ${kind} @ ${price.toFixed(2)}, net ${net.toFixed(2)} USD`,
        );
      }
      return { positionId: p.id, kind, lots: closeLots, price, pnl, closed };
    });
  }

  /** Charge swap for rollovers crossed since the last charge. */
  private accrueSwap(p: PositionRow, until: number): void {
    const nights = rolloversBetween(p.last_swap_ts ?? p.opened_at, until);
    if (nights <= 0) return;
    const perLot =
      p.side === "long" ? this.config.costs.swapLongPerLotNight : this.config.costs.swapShortPerLotNight;
    const amount = Math.round(perLot * p.lots_open * nights * 100) / 100;
    this.db.tx(() => {
      if (amount !== 0) this.ledger.post("swap", amount, { positionId: p.id, note: `${nights} rollover(s)` });
      this.db.run("UPDATE positions SET swap=swap+?, last_swap_ts=? WHERE id=?", amount, until, p.id);
    });
  }

  private apply(
    p: PositionRow,
    events: ExitEvent[],
    state: ReturnType<Ledger["managed"]>,
    barTs: number,
  ): CloseResult[] {
    const out: CloseResult[] = [];
    let row = p;
    for (const e of events) {
      const lotStep = this.config.instrument.lotStep;
      if (e.kind === "partial") {
        const lots = floorToStep(row.lots_initial * e.fraction, lotStep);
        const rest = Math.round((row.lots_open - lots) * 1e6) / 1e6;
        if (lots < this.config.instrument.minLot || rest < this.config.instrument.minLot) {
          // Too small to split at this broker's lot step: the partial is skipped, the break-even still applies.
          out.push({
            positionId: row.id,
            kind: "partial_skipped",
            lots: 0,
            price: e.price,
            pnl: 0,
            closed: false,
          });
          continue;
        }
        out.push(this.closeLots(row, lots, e.price, "partial"));
      } else {
        out.push(this.closeLots(row, row.lots_open, e.price, e.kind));
      }
      row = this.ledger.position(row.id) as PositionRow;
      if (row.status === "closed") return out;
    }
    if (row.status === "open") {
      this.db.run(
        "UPDATE positions SET sl=?, partial_done=?, be_done=?, bars_held=?, mfe=?, mae=?, last_bar_ts=? WHERE id=?",
        state.sl,
        state.partialDone ? 1 : 0,
        state.beDone ? 1 : 0,
        state.barsHeld,
        state.mfe,
        state.mae,
        barTs,
        row.id,
      );
    }
    return out;
  }

  /** Check stops, targets and partials on a closed monitoring bar; accrue swap; flatten before the weekend. */
  processMonitorBar(bar: StoredCandle, spread: number): CloseResult[] {
    const out: CloseResult[] = [];
    const barClose = bar.ts + TF_MS[bar.tf];
    for (const p of this.ledger.openPositions()) {
      // Only bars that began after the fill (allowing the processing delay of under a minute) can trigger
      // its exits, and each bar is applied once.
      if (bar.ts < p.opened_at - 60_000 || (p.last_bar_ts !== null && bar.ts <= p.last_bar_ts)) continue;
      this.accrueSwap(p, barClose);
      const fresh = this.ledger.position(p.id) as PositionRow;
      const m = this.ledger.managed(fresh);
      const toClose = minutesToClose(barClose);
      const force =
        this.config.risk.closeBeforeWeekend &&
        nextCloseIsWeekend(barClose) &&
        toClose > 0 &&
        toClose <= TF_MS[bar.tf] / 60_000
          ? "weekend"
          : undefined;
      const events = stepBar(m, bar, {
        spread,
        slippage: this.config.costs.slippage,
        atr: fresh.atr_at_entry,
        phase: "monitor",
        forceExit: undefined,
      });
      if (force && m.openFrac > 0 && !events.some((e) => e.kind !== "partial")) {
        const s = fresh.side === "long" ? 1 : -1;
        events.push({
          kind: "weekend",
          price: bar.close - (s * spread) / 2 - s * this.config.costs.slippage,
          fraction: m.openFrac,
        });
      }
      out.push(...this.apply(fresh, events, m, bar.ts));
    }
    this.processPending(bar, spread);
    return out;
  }

  /** Break-even, trailing, bar count and time exit at the close of a strategy-timeframe bar. */
  processDecisionBar(bar: StoredCandle, spread: number, atr: number): CloseResult[] {
    const out: CloseResult[] = [];
    for (const p of this.ledger.openPositions()) {
      if (bar.ts < p.opened_at) continue;
      const m = this.ledger.managed(p);
      const events = stepBar(m, bar, {
        spread,
        slippage: this.config.costs.slippage,
        atr: Number.isFinite(atr) ? atr : p.atr_at_entry,
        phase: "manage",
      });
      out.push(...this.apply(p, events, m, Math.max(p.last_bar_ts ?? 0, bar.ts)));
    }
    return out;
  }

  /** Trigger pending limit/stop orders on a monitoring bar. */
  private processPending(bar: StoredCandle, spread: number): void {
    const pending = this.db.all<{
      id: number;
      client_order_id: string;
      side: "long" | "short";
      type: string;
      lots: number;
      requested_price: number;
      sl: number;
      tp: number;
      strategy_id: string | null;
      decision_id: number | null;
      intent: string;
    }>("SELECT * FROM orders WHERE broker='paper' AND status='accepted' AND type IN ('limit','stop')");
    for (const o of pending) {
      const s = o.side === "long" ? 1 : -1;
      const askLow = bar.low + spread / 2;
      const askHigh = bar.high + spread / 2;
      const bidLow = bar.low - spread / 2;
      const bidHigh = bar.high - spread / 2;
      let fill: number | null = null;
      if (o.type === "limit") {
        if (s > 0 && askLow <= o.requested_price) fill = Math.min(o.requested_price, bar.open + spread / 2);
        if (s < 0 && bidHigh >= o.requested_price) fill = Math.max(o.requested_price, bar.open - spread / 2);
      } else {
        if (s > 0 && askHigh >= o.requested_price)
          fill = Math.max(o.requested_price, bar.open + spread / 2) + this.config.costs.slippage;
        if (s < 0 && bidLow <= o.requested_price)
          fill = Math.min(o.requested_price, bar.open - spread / 2) - this.config.costs.slippage;
      }
      if (fill === null) continue;
      const meta = this.db.get<{ detail: string }>(
        "SELECT detail FROM order_events WHERE order_id=? AND to_status='accepted' ORDER BY id DESC LIMIT 1",
        o.id,
      );
      const parsed = meta ? (JSON.parse(meta.detail) as { meta: OrderRequest["meta"] }) : undefined;
      if (!parsed) continue;
      const positionId = this.open(
        {
          clientOrderId: o.client_order_id,
          side: o.side,
          type: "market",
          lots: o.lots,
          sl: o.sl,
          tp: o.tp,
          strategyId: o.strategy_id,
          decisionId: o.decision_id,
          meta: parsed.meta,
        },
        fill,
        o.requested_price,
        spread,
        this.config.costs.slippage,
        o.id,
      );
      this.db.run(
        "UPDATE orders SET status='filled', fill_price=?, reference_price=?, position_id=?, updated_at=? WHERE id=?",
        fill,
        o.requested_price,
        positionId,
        this.now(),
        o.id,
      );
      this.db.run(
        "INSERT INTO order_events(order_id, ts, from_status, to_status, detail) VALUES (?,?,?,?,?)",
        o.id,
        this.now(),
        "accepted",
        "filled",
        JSON.stringify({ fill, positionId }),
      );
    }
  }
}
