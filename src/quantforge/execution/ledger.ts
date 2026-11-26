// Account ledger: balances, positions, transactions and equity history. The balance only changes together
// with a transaction row in the same database transaction, so balance == sum(transactions) always holds and
// is verified at start-up.

import type { QuantForgeConfig } from "../config/schema.js";
import { utcDay, utcDayStart, utcWeekStart } from "../core/time.js";
import type { Quote, Side, TradingMode } from "../core/types.js";
import type { Database } from "../database/db.js";
import type { StateRepo } from "../database/repositories.js";
import type { AccountView } from "../risk/engine.js";
import type { ManagedPosition } from "../risk/position-rules.js";
import type { ExitRules } from "../strategy/spec.js";

export type PositionRow = {
  id: number;
  account: string;
  order_id: number | null;
  broker: string;
  mode: TradingMode;
  strategy_id: string | null;
  side: Side;
  lots_initial: number;
  lots_open: number;
  entry_price: number;
  sl: number;
  tp: number | null;
  initial_sl: number;
  opened_at: number;
  closed_at: number | null;
  status: "open" | "closed";
  exit_reason: string | null;
  exit_price: number | null;
  realized_pnl: number;
  commission: number;
  swap: number;
  r_multiple: number | null;
  mfe: number;
  mae: number;
  partial_done: number;
  be_done: number;
  bars_held: number;
  last_bar_ts: number | null;
  last_swap_ts: number | null;
  rules_json: string;
  atr_at_entry: number;
  regime: string | null;
};

export type TxType = "deposit" | "commission" | "realized_pnl" | "swap" | "adjustment";

export class Ledger {
  constructor(
    private readonly db: Database,
    private readonly state: StateRepo,
    private readonly config: QuantForgeConfig,
    readonly account: string,
    readonly mode: TradingMode,
    private readonly now: () => number = Date.now,
  ) {}

  /** Create the account with its initial deposit if it does not exist yet. */
  ensure(): void {
    const exists = this.db.get("SELECT name FROM accounts WHERE name=?", this.account);
    if (exists) return;
    this.db.tx(() => {
      const t = this.now();
      this.db.run(
        "INSERT INTO accounts(name, mode, currency, initial_balance, balance, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        this.account,
        this.mode,
        "USD",
        this.config.risk.initialBalance,
        0,
        t,
        t,
      );
      this.post("deposit", this.config.risk.initialBalance, { note: "initial paper capital" });
    });
  }

  balance(): number {
    return Number(
      this.db.get<{ balance: number }>("SELECT balance FROM accounts WHERE name=?", this.account)?.balance ??
        0,
    );
  }

  initialBalance(): number {
    return Number(
      this.db.get<{ b: number }>("SELECT initial_balance AS b FROM accounts WHERE name=?", this.account)?.b ??
        0,
    );
  }

  /** Post a transaction and move the balance with it (inside the caller's transaction when nested). */
  post(
    type: TxType,
    amount: number,
    ref: { positionId?: number | undefined; orderId?: number | undefined; note?: string | undefined } = {},
  ): number {
    return this.db.tx(() => {
      const rounded = Math.round(amount * 100) / 100;
      const after = Math.round((this.balance() + rounded) * 100) / 100;
      this.db.run(
        "UPDATE accounts SET balance=?, updated_at=? WHERE name=?",
        after,
        this.now(),
        this.account,
      );
      this.db.run(
        "INSERT INTO transactions(account, ts, type, amount, balance_after, position_id, order_id, note) VALUES (?,?,?,?,?,?,?,?)",
        this.account,
        this.now(),
        type,
        rounded,
        after,
        ref.positionId ?? null,
        ref.orderId ?? null,
        ref.note ?? null,
      );
      return after;
    });
  }

  /** Whether the balance equals the sum of all transactions (to the cent). */
  verify(): { ok: boolean; balance: number; sum: number } {
    const sum = Number(
      this.db.get<{ s: number | null }>(
        "SELECT SUM(amount) AS s FROM transactions WHERE account=?",
        this.account,
      )?.s ?? 0,
    );
    const balance = this.balance();
    return { ok: Math.abs(sum - balance) < 0.005, balance, sum: Math.round(sum * 100) / 100 };
  }

  openPositions(): PositionRow[] {
    return this.db.all<PositionRow>(
      "SELECT * FROM positions WHERE account=? AND status='open' ORDER BY id",
      this.account,
    );
  }

  position(id: number): PositionRow | undefined {
    return this.db.get<PositionRow>("SELECT * FROM positions WHERE id=? AND account=?", id, this.account);
  }

  closedPositions(limit = 500): PositionRow[] {
    return this.db.all<PositionRow>(
      "SELECT * FROM positions WHERE account=? AND status='closed' ORDER BY closed_at DESC LIMIT ?",
      this.account,
      limit,
    );
  }

  insertPosition(
    p: Omit<
      PositionRow,
      | "id"
      | "closed_at"
      | "status"
      | "exit_reason"
      | "exit_price"
      | "realized_pnl"
      | "commission"
      | "swap"
      | "r_multiple"
      | "mfe"
      | "mae"
      | "partial_done"
      | "be_done"
      | "bars_held"
      | "last_swap_ts"
    >,
  ): number {
    return this.db.run(
      `INSERT INTO positions(account, order_id, broker, mode, strategy_id, side, lots_initial, lots_open, entry_price, sl, tp, initial_sl,
        opened_at, status, last_bar_ts, last_swap_ts, rules_json, atr_at_entry, regime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?)`,
      p.account,
      p.order_id,
      p.broker,
      p.mode,
      p.strategy_id,
      p.side,
      p.lots_initial,
      p.lots_open,
      p.entry_price,
      p.sl,
      p.tp,
      p.initial_sl,
      p.opened_at,
      p.last_bar_ts,
      p.opened_at,
      p.rules_json,
      p.atr_at_entry,
      p.regime,
    ).lastId;
  }

  /** The managed-position view of a stored row (for the shared bar rules). */
  managed(row: PositionRow): ManagedPosition {
    return {
      side: row.side,
      entry: row.entry_price,
      sl: row.sl,
      tp: row.tp,
      stopDist: Math.abs(row.entry_price - row.initial_sl),
      openFrac: row.lots_initial > 0 ? row.lots_open / row.lots_initial : 0,
      partialDone: row.partial_done === 1,
      beDone: row.be_done === 1,
      barsHeld: row.bars_held,
      rules: JSON.parse(row.rules_json) as ExitRules,
      mfe: row.mfe,
      mae: row.mae,
    };
  }

  unrealized(row: PositionRow, quote: Quote): number {
    const s = row.side === "long" ? 1 : -1;
    const exitPx = row.side === "long" ? quote.bid : quote.ask;
    return s * (exitPx - row.entry_price) * row.lots_open * this.config.instrument.contractSize;
  }

  /** Equity marks for day/week/peak, created the first time each period is seen. */
  marks(equity: number): { dayStart: number; weekStart: number; peak: number } {
    const t = this.now();
    const dayKey = `equity.${this.account}.day.${utcDay(t)}`;
    const weekKey = `equity.${this.account}.week.${utcWeekStart(t)}`;
    const peakKey = `equity.${this.account}.peak`;
    let dayStart = this.state.get<number>(dayKey);
    if (dayStart === undefined) {
      dayStart = equity;
      this.state.set(dayKey, equity);
    }
    let weekStart = this.state.get<number>(weekKey);
    if (weekStart === undefined) {
      weekStart = equity;
      this.state.set(weekKey, equity);
    }
    const peak = Math.max(this.state.get<number>(peakKey) ?? equity, equity, this.initialBalance());
    this.state.set(peakKey, peak);
    return { dayStart, weekStart, peak };
  }

  view(quote: Quote | undefined): AccountView & { unrealized: number } {
    const balance = this.balance();
    const open = this.openPositions();
    const unrealized = quote ? open.reduce((s, p) => s + this.unrealized(p, quote), 0) : 0;
    const equity = balance + unrealized;
    const marks = this.marks(equity);
    const cs = this.config.instrument.contractSize;
    const margin = quote
      ? open.reduce((s, p) => s + (p.lots_open * cs * quote.price) / this.config.instrument.leverage, 0)
      : 0;
    const today = utcDayStart(this.now());
    const tradesToday = Number(
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM positions WHERE account=? AND opened_at>=?",
        this.account,
        today,
      )?.n ?? 0,
    );
    let consecutiveLosses = 0;
    for (const p of this.db.all<{ net: number }>(
      "SELECT realized_pnl - commission + swap AS net FROM positions WHERE account=? AND status='closed' ORDER BY closed_at DESC LIMIT 50",
      this.account,
    )) {
      if (p.net < 0) consecutiveLosses++;
      else break;
    }
    return {
      balance,
      equity,
      unrealized,
      dayStartEquity: marks.dayStart,
      weekStartEquity: marks.weekStart,
      peakEquity: marks.peak,
      openPositions: open.map((p) => ({
        side: p.side,
        lots: p.lots_open,
        // Remaining risk: distance to the current stop (zero or negative once the stop is past entry).
        riskUsd: Math.max(
          0,
          (p.side === "long" ? p.entry_price - p.sl : p.sl - p.entry_price) * p.lots_open * cs,
        ),
      })),
      tradesToday,
      consecutiveLosses,
      freeMargin: equity - margin,
    };
  }

  recordEquity(quote: Quote | undefined): void {
    const v = this.view(quote);
    const t = Math.floor(this.now() / 60_000) * 60_000;
    this.db.run(
      "INSERT OR REPLACE INTO equity_history(account, ts, balance, equity, unrealized, open_positions) VALUES (?,?,?,?,?,?)",
      this.account,
      t,
      v.balance,
      Math.round(v.equity * 100) / 100,
      Math.round(v.unrealized * 100) / 100,
      v.openPositions.length,
    );
  }

  equityHistory(limit = 2000): { ts: number; balance: number; equity: number }[] {
    return this.db
      .all<{ ts: number; balance: number; equity: number }>(
        "SELECT ts, balance, equity FROM equity_history WHERE account=? ORDER BY ts DESC LIMIT ?",
        this.account,
        limit,
      )
      .reverse();
  }

  transactions(limit = 200): Record<string, unknown>[] {
    return this.db.all(
      "SELECT * FROM transactions WHERE account=? ORDER BY id DESC LIMIT ?",
      this.account,
      limit,
    );
  }
}
