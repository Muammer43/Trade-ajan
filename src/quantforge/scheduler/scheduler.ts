// Controlled scheduler. It wakes shortly after each minute, decides which jobs are due from the clock and
// the market calendar, and queues them on the application's serial job queue:
//   monitor   every closed monitor bar (5m) while the market is open      ~1 API credit
//   decision  every closed decision bar (15m) while the market is open    ~1 API credit
//   macro     hourly cross-asset bars                                       ~2 API credits
//   history   once at start-up when history is missing (low priority)
//   daily     backup, pruning and regime evaluation (backupHourUtc)
// No API call is made while the market is closed except an hourly check. No LLM runs on a tick.

import type { QuantForgeApp } from "../app.js";
import { floorTo, isMarketOpenAt } from "../core/time.js";
import { TF_MS } from "../core/types.js";
import { errorMessage } from "../core/util.js";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running: Promise<unknown> | null = null;
  private last = { monitor: 0, decision: 0, macro: 0, daily: "", closedCheck: 0 };
  private historyDone = false;
  private failures = 0;

  constructor(
    private readonly app: QuantForgeApp,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stopped = false;
    this.arm(1000);
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((error) => this.app.log.log("error", "scheduler", `tick failed: ${errorMessage(error)}`))
        .finally(() => {
          this.running = null;
          const t = this.now();
          // Next wake: 5 s past the next minute, plus a back-off after repeated failures (max 5 min).
          const backoff = Math.min(300_000, this.failures > 2 ? 2 ** (this.failures - 2) * 30_000 : 0);
          this.arm(60_000 - (t % 60_000) + 5_000 + backoff);
        });
    }, ms);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.running) await Promise.race([this.running, new Promise((r) => setTimeout(r, 10_000))]);
  }

  /** One scheduling pass; public for tests and the CLI. */
  async tick(): Promise<string[]> {
    const app = this.app;
    const cfg = app.config;
    const t = this.now();
    const lag = cfg.data.closeLagMs;
    const ran: string[] = [];
    const monitorLen = TF_MS[cfg.data.monitorTf];
    const marketActive = isMarketOpenAt(t) || isMarketOpenAt(t - monitorLen);
    const job = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await app.serial(name, fn);
        ran.push(name);
        this.failures = 0;
      } catch {
        this.failures++;
      }
    };

    if (!this.historyDone) {
      await job("history", () => app.ensureHistory((m) => app.log.log("info", "history", m)));
      this.historyDone = true;
    }
    if (!marketActive) {
      if (t - this.last.closedCheck >= 3_600_000) {
        this.last.closedCheck = t;
        ran.push("closed-idle");
      }
    } else {
      const mBoundary = floorTo(t - lag, cfg.data.monitorTf);
      if (mBoundary > this.last.monitor) {
        this.last.monitor = mBoundary;
        await job("monitor", () => app.monitorTick());
      }
      const dBoundary = floorTo(t - lag, cfg.data.decisionTf);
      if (dBoundary > this.last.decision) {
        this.last.decision = dBoundary;
        await job("decision", () => app.decisionTick());
      }
      const hBoundary = floorTo(t, "1h");
      if (hBoundary > this.last.macro && t - hBoundary >= 120_000 && cfg.data.macroSymbols.length) {
        this.last.macro = hBoundary;
        await job("macro", () => app.macroTick());
      }
    }
    const day = new Date(t).toISOString().slice(0, 10);
    if (
      cfg.scheduler.enabled &&
      new Date(t).getUTCHours() === cfg.scheduler.backupHourUtc &&
      this.last.daily !== day
    ) {
      this.last.daily = day;
      await job("daily", async () => {
        const file = await app.backup();
        app.log.log("info", "daily", `backup written: ${file}`);
        const keep = cfg.data.retentionDays;
        app.candles.prune("XAUUSD", "5m", t - keep["5m"] * 86_400_000);
        app.events.prune(t - 30 * 86_400_000);
        app.regimeEvaluation();
      });
    }
    return ran;
  }
}
