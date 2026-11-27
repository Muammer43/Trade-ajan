// QuantForge AI application: wires data, intelligence, decision, risk, execution and persistence, and
// runs the jobs the scheduler triggers. Jobs are serialized (one at a time) so a phone's CPU is never asked to
// run two heavy jobs at once, and every job is idempotent per candle.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { riskOf } from "../compute/risk.js";
import { type BacktestReport, runBacktest } from "./backtest/engine.js";
import { type ClosedTrade, equityStats, tradeStats } from "./backtest/metrics.js";
import { type Credentials, loadConfig, loadCredentials, type QfPaths } from "./config/load.js";
import type { QuantForgeConfig } from "./config/schema.js";
import { Logger, type SourceLogger } from "./core/logger.js";
import { isMarketOpenAt, minutesToClose, utcDay } from "./core/time.js";
import { type Quote, TF_MS, type Timeframe } from "./core/types.js";
import { errorMessage } from "./core/util.js";
import { ApiBudget } from "./data/budget.js";
import { CsvProvider } from "./data/providers/csv.js";
import { TwelveDataProvider } from "./data/providers/twelvedata.js";
import type { MarketDataProvider } from "./data/providers/types.js";
import { YahooProvider } from "./data/providers/yahoo.js";
import { ProviderRouter } from "./data/router.js";
import { CANONICAL, MarketDataService } from "./data/service.js";
import { Database } from "./database/db.js";
import {
  CandleRepo,
  ConfigVersionRepo,
  EventRepo,
  HealthRepo,
  ProcessedRepo,
  plain,
  StateRepo,
} from "./database/repositories.js";
import { type Decision, DecisionEngine, saveDecision } from "./decision/engine.js";
import { Ledger } from "./execution/ledger.js";
import { LiveGate } from "./execution/live-guard.js";
import { clientOrderId, OrderManager } from "./execution/order-manager.js";
import { PaperBroker } from "./execution/paper-broker.js";
import { LlmJudge } from "./intelligence/agents/llm.js";
import { computeFeatures } from "./intelligence/features.js";
import { evaluateRegimes } from "./intelligence/regime.js";
import { HealthMonitor } from "./monitoring/health.js";
import { RiskEngine } from "./risk/engine.js";
import { TradingFrame } from "./strategy/structure.js";
import { MODEL_LABELS, type ModelId } from "./strategy/types.js";

export type AppOptions = {
  paths: QfPaths;
  config?: QuantForgeConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Replace the configured providers (tests, replay). */
  providers?: { provider: MarketDataProvider; config: QuantForgeConfig["data"]["providers"][number] }[];
  logToStderr?: boolean;
  dbPath?: string;
  /** Replace the retry back-off sleep (tests with a simulated clock). */
  sleep?: (ms: number) => Promise<void>;
};

const PAPER_ACCOUNT = "paper";

export class QuantForgeApp {
  readonly log: Logger;
  readonly db: Database;
  readonly candles: CandleRepo;
  readonly state: StateRepo;
  readonly events: EventRepo;
  readonly health: HealthRepo;
  readonly configVersions: ConfigVersionRepo;
  readonly processed: ProcessedRepo;
  readonly budget: ApiBudget;
  readonly router: ProviderRouter;
  readonly data: MarketDataService;
  readonly ledger: Ledger;
  readonly paper: PaperBroker;
  readonly orders: OrderManager;
  readonly risk: RiskEngine;
  readonly decisions: DecisionEngine;
  readonly liveGate: LiveGate;
  readonly monitor = new HealthMonitor();
  readonly llm: LlmJudge;
  private readonly appLog: SourceLogger;
  private queue: Promise<unknown> = Promise.resolve();
  private backtestChild: ReturnType<typeof spawn> | null = null;
  readonly startedAt: number;
  private listeners = new Set<(event: string, payload: unknown) => void>();
  lastSuccessfulUpdate: number | null = null;
  lastError: string | null = null;
  readonly now: () => number;

  private constructor(
    readonly paths: QfPaths,
    public config: QuantForgeConfig,
    readonly creds: Credentials,
    opts: AppOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.log = new Logger({ file: paths.logFile, stderr: opts.logToStderr ?? true });
    this.appLog = this.log.child("app");
    this.db = Database.open(opts.dbPath ?? paths.db);
    this.candles = new CandleRepo(this.db);
    this.state = new StateRepo(this.db);
    this.events = new EventRepo(this.db);
    this.health = new HealthRepo(this.db);
    this.configVersions = new ConfigVersionRepo(this.db);
    this.processed = new ProcessedRepo(this.db);
    this.log.addSink((e) => {
      if (e.level === "warn" || e.level === "error" || e.level === "critical") {
        try {
          this.events.system(e.level, e.source, e.message, e.detail);
        } catch {
          // The database may be closing.
        }
      }
    });
    const b = config.data.apiBudget;
    this.budget = new ApiBudget(b.perMinute, b.perDay, b.reserve, this.now);
    // Seed today's usage so a restart does not reset the daily budget.
    this.budget.seed(this.health.creditsSince("twelvedata", Date.parse(`${utcDay(this.now())}T00:00:00Z`)));
    const providers =
      opts.providers ??
      config.data.providers.map((p) => {
        const provider: MarketDataProvider =
          p.id === "twelvedata"
            ? new TwelveDataProvider({ apiKey: creds.twelveData, timeoutMs: config.data.requestTimeoutMs })
            : p.id === "yahoo"
              ? new YahooProvider()
              : new CsvProvider(
                  p.csvDir?.startsWith("/") ? p.csvDir : `${paths.home}/${p.csvDir ?? "import"}`,
                );
        return { provider, config: p };
      });
    this.router = new ProviderRouter(providers, this.budget, this.health, this.log.child("data"), {
      now: this.now,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    this.data = new MarketDataService(this.router, this.candles, config, this.log.child("data"), this.now);
    this.ledger = new Ledger(this.db, this.state, config, PAPER_ACCOUNT, "paper", this.now);
    this.ledger.ensure();
    this.paper = new PaperBroker(
      this.db,
      this.ledger,
      config,
      () => this.freshQuote(),
      this.log.child("paper"),
      this.now,
    );
    this.orders = new OrderManager(this.db, this.paper, PAPER_ACCOUNT, this.log.child("orders"), this.now);
    this.risk = new RiskEngine(config, this.state, this.events, this.now);
    this.llm = new LlmJudge(config, creds.llmApiKey, this.state, this.now);
    this.decisions = new DecisionEngine(config, this.risk, this.llm);
    this.liveGate = new LiveGate(config, paths, opts.env ?? process.env, this.now);
    this.configVersions.record(config, "startup");
  }

  static async create(opts: AppOptions): Promise<QuantForgeApp> {
    const config = opts.config ?? loadConfig(opts.paths);
    const creds = await loadCredentials(opts.paths, config, opts.env ?? process.env);
    return new QuantForgeApp(opts.paths, config, creds, opts);
  }

  on(listener: (event: string, payload: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: string, payload: unknown): void {
    for (const l of this.listeners) {
      try {
        l(event, payload);
      } catch {
        // A failing listener is ignored.
      }
    }
  }

  /** Run jobs one at a time. */
  serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const started = performance.now();
      try {
        const out = await fn();
        this.monitor.beat(name, true, "ok", performance.now() - started);
        return out;
      } catch (error) {
        const msg = errorMessage(error);
        this.lastError = `${name}: ${msg}`;
        this.monitor.beat(name, false, msg, performance.now() - started);
        this.appLog.error(`${name} failed: ${msg}`);
        throw error;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  effectiveMode(): "paper" | "live" {
    return this.liveGate.status().effectiveMode;
  }

  /** A fresh provider quote (one API credit); falls back to the last stored monitor bar only for display. */
  async freshQuote(): Promise<Quote> {
    return this.data.quote({ priority: "critical" });
  }

  displayQuote(): (Quote & { delayed: boolean }) | null {
    const q = this.data.latestQuote();
    const bar = this.candles.last(CANONICAL, this.config.data.monitorTf);
    const fromBar = bar ? this.data.quoteFromBar(bar) : null;
    if (q && (!fromBar || q.ts >= fromBar.ts)) return { ...q, delayed: false };
    return fromBar ? { ...fromBar, delayed: true } : null;
  }

  // ----------------------------------------------------------------------------------------- start-up

  /** Recovery and consistency checks after a (re)start. */
  async recover(): Promise<string[]> {
    const notes: string[] = [];
    const integrity = this.db.integrityCheck();
    if (integrity !== "ok") {
      notes.push(`database integrity check: ${integrity}`);
      this.risk.setKillSwitch(true, `database integrity check failed: ${integrity}`);
    }
    const v = this.ledger.verify();
    if (!v.ok) {
      notes.push(`ledger mismatch: balance ${v.balance} vs transactions ${v.sum}; trading halted`);
      this.risk.setKillSwitch(true, "ledger balance does not match its transactions");
    }
    const r = await this.orders.reconcile();
    if (r.checked)
      notes.push(`reconciled ${r.checked} interrupted orders (${r.filled} filled, ${r.cancelled} cancelled)`);
    // Live is never re-enabled by a restart: arming is in-memory only.
    this.liveGate.disarm();
    this.events.system("info", "app", "started", { notes, mode: this.effectiveMode() });
    return notes;
  }

  // ----------------------------------------------------------------------------------------- jobs

  /** Ensure enough history exists for indicators, regime percentiles and backtests. */
  async ensureHistory(onProgress?: (m: string) => void): Promise<void> {
    const tfs: [Timeframe, number][] = [
      [this.config.data.monitorTf, this.config.data.backfillDays["5m"]],
      [this.config.data.decisionTf, this.config.data.backfillDays["15m"]],
      ["1h", this.config.data.backfillDays["1h"]],
    ];
    for (const [tf, days] of tfs) {
      const first = this.candles.first(CANONICAL, tf);
      if (first && first.ts <= this.now() - days * 86_400_000 * 0.9) continue;
      const r = await this.data.backfill(tf, days, { ...(onProgress ? { onProgress } : {}) });
      this.appLog.info(`backfill ${tf}: ${r.pages} pages, +${r.inserted} bars`);
    }
  }

  /** Monitoring job: new closed monitor bars → position management. */
  async monitorTick(): Promise<{ bars: number; exits: number }> {
    const tf = this.config.data.monitorTf;
    const before = this.candles.last(CANONICAL, tf)?.ts ?? 0;
    await this.data.sync(tf, { priority: "critical" });
    this.lastSuccessfulUpdate = this.now();
    const fresh = this.candles.range(CANONICAL, tf, before + 1, Number.MAX_SAFE_INTEGER);
    let exits = 0;
    for (const bar of fresh) {
      if (!bar.marketOpen || bar.quality === "stale_quote") continue;
      if (!this.processed.claim("monitor", tf, bar.ts)) continue;
      const spread = this.data.modelledSpread(bar.ts + TF_MS[tf]);
      const results = this.paper.processMonitorBar(bar, spread);
      exits += results.filter((x) => x.kind !== "partial_skipped").length;
      for (const x of results) this.emit("position", x);
    }
    // Pending paper orders older than one decision bar are cancelled.
    this.orders.expirePending(TF_MS[this.config.data.decisionTf]);
    const quote = this.displayQuote();
    const view = this.ledger.view(quote ?? undefined);
    for (const n of this.risk.refresh(view)) this.appLog.warn(`risk protection engaged: ${n}`);
    if (
      this.risk.controls().killSwitch.on &&
      this.ledger.openPositions().length &&
      this.state.get<boolean>("risk.flattenOnKill") !== false
    ) {
      await this.closeAll("emergency");
    }
    if (view.openPositions.length || fresh.length) this.ledger.recordEquity(quote ?? undefined);
    this.emit("update", { kind: "monitor", bars: fresh.length });
    return { bars: fresh.length, exits };
  }

  /** The trading frame of the latest closed 15-minute candles (market-open, clean). */
  tradingFrame(limit = 1600): TradingFrame {
    const bars = this.candles
      .latest(CANONICAL, this.config.data.decisionTf, limit)
      .filter((c) => c.marketOpen && c.quality === "ok");
    return new TradingFrame(bars.map(plain));
  }

  /** Decision job: the latest closed 15-minute candle → strategy → agents → risk → paper order. */
  async decisionTick(): Promise<Decision | null> {
    const tf = this.config.data.decisionTf;
    await this.data.sync(tf, { priority: "high" });
    this.lastSuccessfulUpdate = this.now();
    const last = this.candles.last(CANONICAL, tf);
    if (!last?.marketOpen || last.quality !== "ok") return null;
    if (!this.processed.claim("decision", tf, last.ts)) return null; // never process a candle twice
    const frame = this.tradingFrame();
    if (frame.n < 400) {
      this.appLog.warn(`only ${frame.n} usable ${tf} candles; the strategy needs at least 400`);
      return null;
    }
    // Break-even, trailing and time exits for every 15-minute candle since the last run (including candles
    // that closed while the process was down), each applied once.
    const lastManaged = this.processed.last("manage", tf) ?? last.ts - TF_MS[tf];
    for (const bar of this.candles.range(CANONICAL, tf, lastManaged + 1, last.ts)) {
      if (!bar.marketOpen || bar.quality !== "ok" || !this.processed.claim("manage", tf, bar.ts)) continue;
      let k = frame.n - 1;
      while (k > 0 && frame.ts(k) > bar.ts) k--;
      for (const x of this.paper.processDecisionBar(
        bar,
        this.data.modelledSpread(bar.ts + TF_MS[tf]),
        frame.atr(k),
      ))
        this.emit("position", x);
    }
    const quote = this.displayQuote();
    const q = this.data.quality(tf);
    const view = this.ledger.view(quote ?? undefined);
    this.risk.refresh(view);
    const macro = {
      eurusd: this.candles.latest("EURUSD", "1h", 200).map(plain),
      xagusd: this.candles.latest("XAGUSD", "1h", 200).map(plain),
    };
    const healthy = this.router
      .healthReport()
      .some((p) => p.useForTrading && p.enabled && p.state !== "open");
    const decision = await this.decisions.decide({
      now: this.now(),
      frame,
      i: frame.n - 1,
      quote,
      quality: {
        fresh: q.fresh,
        missingBars: q.missingBars,
        staleQuoteBars: q.staleQuoteBars,
        ageBars: q.ageBars,
      },
      macro,
      account: view,
      controls: this.risk.controls(),
      providerHealthy: healthy,
      mode: this.effectiveMode(),
      modelPerformance: this.ledger.modelPerformance(),
    });
    const id = saveDecision(this.db, decision);
    decision.id = id;
    const spread = this.data.modelledSpread(last.ts + TF_MS[tf]);
    this.db.run(
      "INSERT INTO market_snapshots(ts, symbol, price, bid, ask, spread, spread_source, provider, regime, features_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      this.now(),
      CANONICAL,
      quote?.price ?? last.close,
      quote?.bid ?? last.close,
      quote?.ask ?? last.close,
      quote?.spread ?? spread,
      quote?.spreadSource ?? "modelled",
      quote?.provider ?? last.provider,
      decision.regime,
      JSON.stringify({
        model: decision.model,
        score: decision.score,
        allowed: decision.signal.allowedModels,
      }),
    );
    if (decision.action !== "NO_TRADE") await this.execute(decision);
    this.emit("decision", { id, action: decision.action });
    this.emit("update", { kind: "decision" });
    return decision;
  }

  private async execute(d: Decision): Promise<void> {
    if (!d.model || !d.exit || !d.lots || d.entry === null || d.sl === null || d.tp === null) return;
    const side = d.action === "BUY" ? "long" : "short";
    const result = await this.orders.submit(
      {
        // One order per candle: the id is derived from the candle, so a repeated run can never duplicate it.
        clientOrderId: clientOrderId(PAPER_ACCOUNT, "candle", d.barTs, side),
        side,
        type: "market",
        lots: d.lots,
        sl: d.sl,
        tp: d.tp,
        strategyId: d.model,
        decisionId: d.id ?? null,
        meta: { atr: d.atr ?? 0, rules: d.exit, regime: d.regime },
      },
      () => {
        // Final gate, re-evaluated at submission: the mode must be paper (no live adapter exists) and the
        // risk verdict must still hold.
        if (this.effectiveMode() !== "paper") return { ok: false, reason: "live execution is not available" };
        if (this.risk.controls().killSwitch.on) return { ok: false, reason: "kill switch engaged" };
        return d.risk?.allowed ? { ok: true } : { ok: false, reason: "risk verdict missing" };
      },
    );
    this.appLog.info(`order for decision ${d.id}: ${result.outcome}`, result);
    this.emit("order", result);
  }

  async macroTick(): Promise<void> {
    for (const sym of this.config.data.macroSymbols) {
      const canonical = sym.replace("/", "").toUpperCase();
      const skipKey = `macro.skip.${canonical}`;
      const skipUntil = this.state.get<number>(skipKey);
      if (skipUntil && skipUntil > this.now()) continue;
      try {
        await this.data.sync("1h", { priority: "low", symbol: canonical });
      } catch (error) {
        const msg = errorMessage(error);
        // A symbol the data plan does not include is skipped for a week instead of retried every hour.
        if (/plan|upgrade|not available/i.test(msg)) {
          this.state.set(skipKey, this.now() + 7 * 86_400_000);
          this.appLog.warn(`macro ${sym} is not available on the current data plan; skipped for 7 days`);
        } else this.appLog.warn(`macro ${sym}: ${msg}`);
      }
    }
  }

  async closeAll(reason: "manual" | "emergency"): Promise<{ closed: number; failed: string[] }> {
    let closed = 0;
    const failed: string[] = [];
    for (const p of this.ledger.openPositions()) {
      const r = await this.paper.close(p.id, 1, reason);
      if (r.ok) closed++;
      else failed.push(`${p.id}: ${r.reason}`);
    }
    if (closed || failed.length)
      this.events.risk("close_all", reason === "emergency" ? "critical" : "warn", { closed, failed });
    this.emit("update", { kind: "close_all" });
    return { closed, failed };
  }

  /** Backtest the live rules over stored history in this process (CLI) and store the report. */
  async backtestInline(
    days: number,
    onProgress?: (m: string) => void,
  ): Promise<{ id: number; report: BacktestReport }> {
    const to = this.now();
    const from = to - days * 86_400_000;
    const warm = from - 30 * 86_400_000;
    const c15 = this.candles
      .range(CANONICAL, "15m", warm, to)
      .filter((c) => c.marketOpen && c.quality === "ok")
      .map(plain);
    if (c15.length < 1500)
      throw new Error(
        `backtest needs at least 1500 clean 15m candles; ${c15.length} stored (run backfill first)`,
      );
    const c5 = this.candles
      .range(CANONICAL, "5m", from, to)
      .filter((c) => c.marketOpen && c.quality === "ok")
      .map(plain);
    const report = await runBacktest({
      candles15: c15,
      candles5: c5,
      config: this.config,
      from,
      to,
      onProgress: onProgress ? (d, t) => onProgress(`${Math.round((d / Math.max(1, t)) * 100)}%`) : undefined,
    });
    const { trades, equity, ...summary } = report;
    const id = this.db.run(
      "INSERT INTO backtests(strategy_id, run_id, segment, created_at, params_json, metrics_json, trades_json, equity_json) VALUES (?,?,?,?,?,?,?,?)",
      "strategy",
      null,
      `${days}d`,
      this.now(),
      JSON.stringify({
        days,
        risk: this.config.risk,
        strategy: this.config.strategy,
        costs: this.config.costs,
        instrument: this.config.instrument,
      }),
      JSON.stringify(summary),
      JSON.stringify(trades.slice(-2000)),
      JSON.stringify(equity),
    ).lastId;
    this.events.system(
      "info",
      "backtest",
      `backtest #${id}: ${report.stats.trades} trades, net ${report.netProfit.toFixed(2)} USD`,
      { id },
    );
    return { id, report };
  }

  /** Backtest in a child process so the daemon and dashboard stay responsive. */
  spawnBacktest(days: number): { started: boolean; reason?: string } {
    if (this.backtestChild) return { started: false, reason: "a backtest is already running" };
    const cli = fileURLToPath(new URL("./cli/main.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "backtest", "--days", String(days), "--quiet"], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.backtestChild = child;
    let err = "";
    child.stderr?.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    child.on("exit", (code) => {
      this.backtestChild = null;
      if (code === 0) this.appLog.info("backtest finished");
      else this.appLog.error(`backtest exited with ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`);
      this.emit("update", { kind: "backtest" });
    });
    return { started: true };
  }

  backtestRunning(): boolean {
    return this.backtestChild !== null;
  }

  private stopStream: (() => void) | null = null;

  /**
   * Optional real-time price over the Twelve Data WebSocket (data.providers[].websocket = true). Display and
   * fills use it while connected; decisions still use closed REST candles. On failure REST polling continues.
   */
  startStream(): void {
    const cfg = this.config.data.providers.find((p) => p.id === "twelvedata" && p.enabled && p.websocket);
    const td = this.router.provider("twelvedata");
    if (!cfg || !(td instanceof TwelveDataProvider)) return;
    let retries = 0;
    const connect = () => {
      this.stopStream = td.stream(
        cfg.symbol,
        (q) => {
          retries = 0;
          this.data.pushStreamQuote(q.price, q.ts, "twelvedata", q.bid, q.ask);
          this.emit("quote", { price: q.price });
        },
        (state, detail) => {
          if (state === "open") this.appLog.info("price stream connected");
          if (state === "error")
            this.appLog.warn(`price stream: ${detail ?? "error"}; REST polling continues`);
          if (state === "closed" && this.stopStream && retries < 5) {
            retries++;
            setTimeout(connect, Math.min(300_000, 5_000 * 2 ** retries)).unref();
          }
        },
      );
    };
    connect();
  }

  regimeEvaluation(): ReturnType<typeof evaluateRegimes> | null {
    const tf = this.config.data.decisionTf;
    const bars = this.candles.latest(CANONICAL, tf, 40_000).filter((c) => c.marketOpen && c.quality === "ok");
    if (bars.length < 1200) return null;
    const f = computeFeatures(bars.map(plain), tf);
    const ev = evaluateRegimes(f, 16);
    this.db.run(
      "INSERT INTO regime_evaluations(ts, tf, bars, metrics_json) VALUES (?,?,?,?)",
      this.now(),
      tf,
      f.n,
      JSON.stringify(ev),
    );
    return ev;
  }

  async backup(): Promise<string> {
    const { createBackup } = await import("./security/backup.js");
    return createBackup(this.db, this.paths, this.config.scheduler.keepBackups, this.creds.backupPassphrase);
  }

  // ----------------------------------------------------------------------------------------- views

  /** Closed paper trades in the shape the statistics take. */
  closedTrades(limit = 10_000): ClosedTrade[] {
    return this.ledger
      .closedPositions(limit)
      .reverse()
      .map((p) => ({
        side: p.side,
        model: p.strategy_id ?? "manual",
        regime: p.regime ?? "unknown",
        openedAt: p.opened_at,
        closedAt: p.closed_at ?? p.opened_at,
        pnl: Math.round((p.realized_pnl - p.commission + p.swap) * 100) / 100,
        r: p.r_multiple ?? 0,
        exitReason: p.exit_reason ?? "manual",
      }));
  }

  performance() {
    const trades = this.closedTrades();
    const stats = tradeStats(trades, this.ledger.initialBalance());
    const equity = this.ledger.equityHistory(20_000);
    const eq = equityStats(equity);
    // Daily closes of equity → the original TradingAgents risk calculator (needs ≥ 21 daily values).
    const daily = new Map<string, number>();
    for (const e of equity) daily.set(utcDay(e.ts), e.equity);
    const dailyRisk =
      daily.size >= 21
        ? riskOf({
            label: "paper equity",
            dates: [...daily.keys()],
            values: [...daily.values()],
            perYear: 252,
          })
        : { error: `needs at least 21 days of equity history (${daily.size} so far)` };
    return { stats, equityStats: eq, equity, dailyRisk };
  }

  overview() {
    const quote = this.displayQuote();
    const view = this.ledger.view(quote ?? undefined);
    const trades = this.closedTrades();
    const stats = tradeStats(trades);
    const eq = equityStats(this.ledger.equityHistory(20_000));
    const lastDecision = this.db.get<{
      id: number;
      ts: number;
      bar_ts: number;
      action: string;
      model: string | null;
      regime: string;
      score: number | null;
      confidence: number;
      reasons_json: string;
    }>(
      "SELECT id, ts, bar_ts, action, model, regime, score, confidence, reasons_json FROM decisions ORDER BY id DESC LIMIT 1",
    );
    const lastSignal = this.db.get<{ bar_ts: number; action: string; model: string | null }>(
      "SELECT bar_ts, action, model FROM decisions WHERE action<>'NO_TRADE' ORDER BY id DESC LIMIT 1",
    );
    const snapshot = this.db.get<{ regime: string; ts: number; features_json: string | null }>(
      "SELECT regime, ts, features_json FROM market_snapshots ORDER BY id DESC LIMIT 1",
    );
    const allowed = snapshot?.features_json
      ? ((JSON.parse(snapshot.features_json) as { allowed?: ModelId[] }).allowed ?? [])
      : [];
    const controls = this.risk.controls();
    const dayLossPct = view.dayStartEquity > 0 ? (1 - view.equity / view.dayStartEquity) * 100 : 0;
    const openRisk = view.openPositions.reduce((s, p) => s + p.riskUsd, 0);
    const jobs = this.monitor.report().jobs as Record<string, { ts: number; ok: boolean }>;
    const lastJob = Math.max(0, ...Object.values(jobs).map((j) => j.ts));
    return {
      symbol: CANONICAL,
      quote,
      marketOpen: isMarketOpenAt(this.now()),
      minutesToClose: minutesToClose(this.now()),
      regime: snapshot?.regime ?? null,
      regimeTs: snapshot?.ts ?? null,
      activeModel: lastDecision?.model
        ? { id: lastDecision.model, label: MODEL_LABELS[lastDecision.model as ModelId] ?? lastDecision.model }
        : null,
      allowedModels: allowed.map((m) => ({ id: m, label: MODEL_LABELS[m] })),
      lastDecision: lastDecision
        ? { ...lastDecision, reasons: JSON.parse(lastDecision.reasons_json) as string[] }
        : null,
      lastSignal: lastSignal ?? null,
      mode: this.effectiveMode(),
      requestedMode: this.config.mode,
      account: {
        initialBalance: this.ledger.initialBalance(),
        balance: view.balance,
        equity: view.equity,
        unrealized: view.unrealized,
        dailyPnl: view.equity - view.dayStartEquity,
        totalPnl: view.equity - this.ledger.initialBalance(),
        realizedPnl: stats.netProfit,
        freeMargin: view.freeMargin,
      },
      stats: {
        trades: stats.trades,
        winRate: stats.trades ? stats.winRate : null,
        profitFactor: stats.profitFactor,
        expectancyUsd: stats.expectancyUsd,
        expectancyR: stats.expectancyR,
        maxDrawdownPct: eq.maxDrawdownPct,
      },
      openPositions: view.openPositions.length,
      recentTrades: trades.slice(-5).reverse(),
      risk: {
        dayLossPct,
        maxDailyLossPct: this.config.risk.maxDailyLossPct,
        dailyRiskUsedPct: Math.max(0, (dayLossPct / this.config.risk.maxDailyLossPct) * 100),
        openRiskUsd: openRisk,
        riskPerTradePct: this.config.risk.riskPerTradePct,
        controls,
      },
      providers: this.router
        .healthReport()
        .map((p) => ({ id: p.id, state: p.state, lastOk: p.lastOk, lastError: p.lastError, basis: p.basis })),
      apiBudget: this.budget.status(),
      lastSuccessfulUpdate:
        this.lastSuccessfulUpdate ??
        (Math.max(0, ...this.health.summary(0).map((r) => Number(r.last_ok ?? 0))) || null),
      lastError: this.lastError,
      bot: {
        running: true,
        startedAt: this.startedAt,
        lastJobAt: lastJob || null,
        schedulerEnabled: this.config.scheduler.enabled,
        killSwitch: controls.killSwitch.on,
        backtestRunning: this.backtestRunning(),
      },
    };
  }

  close(): void {
    const stop = this.stopStream;
    this.stopStream = null;
    stop?.();
    this.backtestChild?.kill("SIGTERM");
    this.monitor.stop();
    this.db.close();
  }
}
