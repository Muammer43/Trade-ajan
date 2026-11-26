// Persistence of discovery runs, strategy candidates, their validation and their activation state.

import type { Database } from "../database/db.js";
import type { DiscoveryReport } from "../discovery/engine.js";
import type { ActiveStrategy } from "../intelligence/agents/types.js";
import type { StrategySpec } from "./spec.js";

export type StrategyStatus = "validated" | "rejected" | "active" | "retired";

export type StrategyRow = {
  id: string;
  run_id: number | null;
  family: string;
  spec_json: string;
  status: StrategyStatus;
  score: number | null;
  metrics_json: string | null;
  validation_json: string | null;
  rejection_json: string | null;
  created_at: number;
  updated_at: number;
  activated_at: number | null;
  deactivated_at: number | null;
};

export class StrategyRegistry {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  startRun(tf: string): number {
    return this.db.run(
      "INSERT INTO discovery_runs(started_at, status, tf) VALUES (?, 'running', ?)",
      this.now(),
      tf,
    ).lastId;
  }

  failRun(runId: number, error: string): void {
    this.db.run(
      "UPDATE discovery_runs SET status='failed', finished_at=?, error=? WHERE id=?",
      this.now(),
      error,
      runId,
    );
  }

  /** Store a finished run: every candidate that passed the training screen, with its full validation record. */
  finishRun(runId: number, report: DiscoveryReport): void {
    this.db.tx(() => {
      const t = this.now();
      for (const r of report.reports) {
        const validation = JSON.stringify({
          gates: r.gates,
          validation: r.validation,
          combined: r.combined,
          test: r.test,
          walkForward: r.walkForward,
          stability: r.stability,
          costSensitivity: r.costSensitivity,
          monteCarlo: r.monteCarlo,
          expectancyCi: r.expectancyCi,
          dsr: r.dsr,
        });
        const existing = this.db.get<{ status: string }>(
          "SELECT status FROM strategies WHERE id=?",
          r.spec.id,
        );
        // An active strategy keeps its status until activation decides; its record is refreshed.
        const status = existing?.status === "active" ? "active" : r.status;
        this.db.run(
          `INSERT INTO strategies(id, run_id, family, spec_json, status, score, metrics_json, validation_json, rejection_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, status=?, score=excluded.score, metrics_json=excluded.metrics_json,
             validation_json=excluded.validation_json, rejection_json=excluded.rejection_json, updated_at=excluded.updated_at`,
          r.spec.id,
          runId,
          r.spec.family,
          JSON.stringify(r.spec),
          status,
          r.score,
          JSON.stringify(r.train),
          validation,
          JSON.stringify(r.rejection),
          t,
          t,
          status,
        );
        if (existing?.status === "active" && r.status === "rejected")
          this.db.run(
            "UPDATE strategies SET rejection_json=? WHERE id=?",
            JSON.stringify(r.rejection),
            r.spec.id,
          );
      }
      const { reports: _r, ...summary } = report;
      this.db.run(
        "UPDATE discovery_runs SET status='finished', finished_at=?, bars=?, data_from=?, data_to=?, candidates=?, validated=?, summary_json=? WHERE id=?",
        t,
        report.bars,
        report.dataFrom,
        report.dataTo,
        report.candidates,
        report.validated,
        JSON.stringify(summary),
        runId,
      );
    });
  }

  /**
   * Make the top `maxActive` validated strategies of a run active and retire active strategies that this run
   * did not validate. With no validated strategy, nothing is active and the system does not trade.
   */
  applyRun(runId: number, maxActive: number): { activated: string[]; retired: string[] } {
    return this.db.tx(() => {
      const t = this.now();
      const validated = this.db
        .all<{ id: string }>(
          "SELECT id FROM strategies WHERE run_id=? AND status IN ('validated','active') AND (rejection_json IS NULL OR rejection_json='[]') ORDER BY score DESC LIMIT ?",
          runId,
          maxActive,
        )
        .map((r) => r.id);
      const keep = new Set(validated);
      const retired: string[] = [];
      for (const a of this.db.all<{ id: string }>("SELECT id FROM strategies WHERE status='active'")) {
        if (!keep.has(a.id)) {
          this.db.run(
            "UPDATE strategies SET status='retired', deactivated_at=?, updated_at=? WHERE id=?",
            t,
            t,
            a.id,
          );
          retired.push(a.id);
        }
      }
      const activated: string[] = [];
      for (const id of validated) {
        const r = this.db.run(
          "UPDATE strategies SET status='active', activated_at=?, updated_at=? WHERE id=? AND status<>'active'",
          t,
          t,
          id,
        );
        if (r.changes) activated.push(id);
      }
      return { activated, retired };
    });
  }

  setStatus(id: string, active: boolean): { ok: boolean; reason?: string } {
    const row = this.get(id);
    if (!row) return { ok: false, reason: "unknown strategy" };
    const t = this.now();
    if (active) {
      const rejection = JSON.parse(row.rejection_json ?? "[]") as string[];
      if (row.status !== "validated" && row.status !== "retired")
        return { ok: false, reason: `a ${row.status} strategy cannot be activated` };
      if (rejection.length)
        return {
          ok: false,
          reason: `strategy failed validation (${rejection.join(", ")}) and cannot be activated`,
        };
      this.db.run("UPDATE strategies SET status='active', activated_at=?, updated_at=? WHERE id=?", t, t, id);
    } else {
      if (row.status !== "active") return { ok: false, reason: "strategy is not active" };
      this.db.run(
        "UPDATE strategies SET status='retired', deactivated_at=?, updated_at=? WHERE id=?",
        t,
        t,
        id,
      );
    }
    return { ok: true };
  }

  get(id: string): StrategyRow | undefined {
    return this.db.get<StrategyRow>("SELECT * FROM strategies WHERE id=?", id);
  }

  list(opts: { status?: string; limit?: number } = {}): StrategyRow[] {
    return opts.status
      ? this.db.all<StrategyRow>(
          "SELECT * FROM strategies WHERE status=? ORDER BY score DESC LIMIT ?",
          opts.status,
          opts.limit ?? 200,
        )
      : this.db.all<StrategyRow>(
          "SELECT * FROM strategies ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'validated' THEN 1 WHEN 'retired' THEN 2 ELSE 3 END, score DESC LIMIT ?",
          opts.limit ?? 200,
        );
  }

  activeSpecs(): { spec: StrategySpec; row: StrategyRow }[] {
    return this.list({ status: "active", limit: 20 }).map((row) => ({
      spec: JSON.parse(row.spec_json) as StrategySpec,
      row,
    }));
  }

  /** Active strategies with validation figures and their paper outcomes, for agents and the judge. */
  activeSummaries(account: string): ActiveStrategy[] {
    return this.activeSpecs().map(({ spec, row }) => {
      const v = JSON.parse(row.validation_json ?? "{}") as {
        combined?: { expectancyR?: number; trades?: number };
        expectancyCi?: { low?: number };
        dsr?: { dsr?: number };
        test?: { profitFactor?: number };
      };
      const live = this.db.get<{ n: number; e: number | null }>(
        "SELECT COUNT(*) AS n, AVG(r_multiple) AS e FROM positions WHERE account=? AND strategy_id=? AND status='closed'",
        account,
        spec.id,
      );
      return {
        id: spec.id,
        family: spec.family,
        score: row.score ?? 0,
        validation: {
          expectancyR: v.combined?.expectancyR ?? 0,
          ciLow: v.expectancyCi?.low ?? null,
          trades: v.combined?.trades ?? 0,
          dsr: v.dsr?.dsr ?? null,
          testProfitFactor: v.test?.profitFactor ?? null,
        },
        live: { trades: Number(live?.n ?? 0), expectancyR: live?.e ?? null },
      };
    });
  }

  runs(limit = 20): Record<string, unknown>[] {
    return this.db.all("SELECT * FROM discovery_runs ORDER BY id DESC LIMIT ?", limit);
  }

  lastFinishedRun(): { id: number; finished_at: number } | undefined {
    return this.db.get<{ id: number; finished_at: number }>(
      "SELECT id, finished_at FROM discovery_runs WHERE status='finished' ORDER BY id DESC LIMIT 1",
    );
  }

  saveBacktest(b: {
    strategyId: string | null;
    runId: number | null;
    segment: string;
    params: unknown;
    metrics: unknown;
    trades?: unknown;
    equity?: unknown;
  }): number {
    return this.db.run(
      "INSERT INTO backtests(strategy_id, run_id, segment, created_at, params_json, metrics_json, trades_json, equity_json) VALUES (?,?,?,?,?,?,?,?)",
      b.strategyId,
      b.runId,
      b.segment,
      this.now(),
      JSON.stringify(b.params),
      JSON.stringify(b.metrics),
      b.trades === undefined ? null : JSON.stringify(b.trades),
      b.equity === undefined ? null : JSON.stringify(b.equity),
    ).lastId;
  }

  backtests(limit = 50): Record<string, unknown>[] {
    return this.db.all(
      "SELECT id, strategy_id, run_id, segment, created_at, params_json, metrics_json FROM backtests ORDER BY id DESC LIMIT ?",
      limit,
    );
  }
}
