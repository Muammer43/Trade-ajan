#!/usr/bin/env node
// QuantForge AI Pro command line.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Lock } from "../../store/lock.js";
import { QuantForgeApp } from "../app.js";
import { loadConfig, type QfPaths, resolveQfPaths } from "../config/load.js";
import { isTimeframe, type Timeframe } from "../core/types.js";
import { flagStaleQuotes, normalizeBars } from "../data/normalize.js";
import { parseCsv } from "../data/providers/csv.js";
import { CANONICAL } from "../data/service.js";
import { listBackups, restoreBackup } from "../security/backup.js";
import { runDaemon } from "./daemon.js";
import { runSetup } from "./setup.js";

const HELP = `QuantForge AI Pro — XAUUSD multi-agent quantitative trading (PAPER mode by default)

Usage: quantforge <command> [options]

  setup [--yes]            first-run wizard (config, API key, dashboard token)
  run                      start the daemon in the foreground (scheduler + dashboard)
  status                   process, data, account and strategy status
  doctor                   check Node.js, node:sqlite, paths, permissions and connectivity
  backfill [--tf 15m] [--days N]   fetch history (all configured timeframes when --tf is omitted)
  discover [--quiet]       run strategy discovery and validation now
  regime-eval              evaluate the regime classifier on stored history
  import-csv <file> --tf 15m       import UTC OHLC history from CSV
  backup                   write a database backup
  restore <file>           restore a backup (stop QuantForge first)
  backups                  list backups
  health                   exit 0 when the daemon answers and data is fresh
  kill-switch on|off [reason]      engage/release the global kill switch
  close-all                close every paper position at the current price
  live-status              show every live-trading safety gate
  tick                     run one scheduler pass (diagnostics)
  research "<question>"    ask the original TradingAgents research engine (needs a model key)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function withApp<T>(paths: QfPaths, fn: (app: QuantForgeApp) => Promise<T>, quiet = false): Promise<T> {
  const app = await QuantForgeApp.create({ paths, logToStderr: !quiet });
  try {
    return await fn(app);
  } finally {
    app.close();
  }
}

function daemonPid(paths: QfPaths): number | null {
  if (!existsSync(paths.pidFile)) return null;
  const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  // A killed but unreaped (zombie) process is not running.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (/^\d+ \(.*\) Z/.test(stat)) return null;
  } catch {
    // No /proc (macOS): kill(0) is the answer.
  }
  return pid;
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...args] = argv;
  const paths = resolveQfPaths();
  const out = (s: string) => process.stdout.write(`${s}\n`);
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return 0;
    case "setup":
      return runSetup(paths, { yes: args.includes("--yes") });
    case "run":
      return runDaemon(paths, {
        noScheduler: args.includes("--no-scheduler"),
        noDashboard: args.includes("--no-dashboard"),
      });
    case "status":
      return withApp(
        paths,
        async (app) => {
          const o = app.overview();
          const pid = daemonPid(paths);
          out(`daemon: ${pid ? `running (PID ${pid})` : "not running"}`);
          out(`mode: ${o.mode.toUpperCase()} (requested ${o.requestedMode})`);
          out(`market: ${o.marketOpen ? `open, ${o.minutesToClose} min to close` : "closed"}`);
          out(
            `price: ${o.quote ? `${o.quote.price.toFixed(2)} ${o.quote.delayed ? "(last closed bar)" : ""}` : "no data yet"}`,
          );
          for (const tf of ["5m", "15m", "1h"] as Timeframe[]) {
            const first = app.candles.first(CANONICAL, tf);
            const last = app.candles.last(CANONICAL, tf);
            out(
              `data ${tf}: ${app.candles.count(CANONICAL, tf)} bars${first && last ? ` ${new Date(first.ts).toISOString()} → ${new Date(last.ts).toISOString()}` : ""}`,
            );
          }
          out(
            `account: balance ${o.account.balance.toFixed(2)} equity ${o.account.equity.toFixed(2)} USD, ${o.openPositions} open positions, ${o.stats.trades} closed trades`,
          );
          out(
            `strategies active: ${o.activeStrategies.length ? o.activeStrategies.map((s) => s.id).join(", ") : "none"}`,
          );
          out(
            `kill switch: ${o.risk.controls.killSwitch.on ? `ON (${o.risk.controls.killSwitch.reason})` : "off"}`,
          );
          out(`API credits today: ${o.apiBudget.usedToday}/${o.apiBudget.perDay}`);
          out(
            `last decision: ${o.lastDecision ? `${String(o.lastDecision.action)} @ ${new Date(Number(o.lastDecision.bar_ts)).toISOString()}` : "none"}`,
          );
          return 0;
        },
        true,
      );
    case "doctor":
      return doctor(paths);
    case "backfill":
      return withApp(paths, async (app) => {
        const tf = flag(args, "--tf");
        const days = flag(args, "--days");
        if (tf) {
          if (!isTimeframe(tf)) throw new Error(`unknown timeframe ${tf}`);
          const r = await app.data.backfill(tf, Number(days ?? 365), { onProgress: out });
          out(
            `done: ${r.pages} pages, +${r.inserted} bars, from ${r.from ? new Date(r.from).toISOString() : "—"}`,
          );
        } else {
          await app.ensureHistory(out);
          await app.macroTick();
          out("history complete");
        }
        return 0;
      });
    case "discover": {
      const quiet = args.includes("--quiet");
      const lock = await Lock.acquire(`${paths.home}/discovery.lock`);
      if (!(lock instanceof Lock)) {
        process.stderr.write("a discovery run is already in progress\n");
        return 2;
      }
      try {
        return await withApp(
          paths,
          async (app) => {
            const r = await app.discoverInline(quiet ? undefined : out);
            out(r.conclusion);
            out(
              `run ${r.runId}: ${r.validated} validated; activated: ${r.activated.join(", ") || "none"}; retired: ${r.retired.join(", ") || "none"}`,
            );
            return 0;
          },
          quiet,
        );
      } finally {
        await lock.release();
      }
    }
    case "regime-eval":
      return withApp(paths, async (app) => {
        const ev = app.regimeEvaluation();
        out(ev ? JSON.stringify(ev, null, 2) : "not enough history (need 1200 clean bars)");
        return ev ? 0 : 1;
      });
    case "import-csv": {
      const file = args[0];
      const tf = flag(args, "--tf");
      if (!file || !tf || !isTimeframe(tf)) {
        out("usage: quantforge import-csv <file> --tf <5m|15m|1h|...>");
        return 1;
      }
      return withApp(paths, async (app) => {
        const bars = parseCsv(readFileSync(file, "utf8"));
        const { candles, issues } = normalizeBars(bars, {
          symbol: CANONICAL,
          tf,
          provider: "csv",
          now: Date.now(),
        });
        const r = app.candles.upsert(flagStaleQuotes(candles));
        out(
          `${file}: ${bars.length} rows, ${candles.length} valid closed bars, +${r.inserted} new, ${r.updated} updated, ${issues.filter((i) => i.kind !== "unclosed").length} rejected`,
        );
        return 0;
      });
    }
    case "backup":
      return withApp(
        paths,
        async (app) => {
          out(await app.backup());
          return 0;
        },
        true,
      );
    case "backups":
      for (const b of listBackups(paths))
        out(
          `${new Date(b.mtime).toISOString()}  ${(b.bytes / 1024).toFixed(0)} KB  ${b.encrypted ? "enc " : ""}${b.file}`,
        );
      return 0;
    case "restore": {
      const file = args[0];
      if (!file) {
        out("usage: quantforge restore <backup file>");
        return 1;
      }
      if (daemonPid(paths)) {
        out("QuantForge is running; stop it first (./stop.sh).");
        return 2;
      }
      const r = restoreBackup(file, paths, process.env.QF_BACKUP_PASSPHRASE);
      out(`restored into ${r.restored}${r.previous ? `; previous database kept as ${r.previous}` : ""}`);
      return 0;
    }
    case "health": {
      const config = loadConfig(paths);
      const pid = daemonPid(paths);
      if (!pid) {
        out("unhealthy: daemon not running");
        return 1;
      }
      try {
        const res = await fetch(`http://${config.dashboard.host}:${config.dashboard.port}/api/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (error) {
        out(`unhealthy: dashboard not answering (${(error as Error).message})`);
        return 1;
      }
      return withApp(
        paths,
        async (app) => {
          const q = app.data.quality(app.config.data.decisionTf);
          const open = app.overview().marketOpen;
          if (open && !q.fresh) {
            out(`degraded: market open but data is ${q.ageBars.toFixed(1)} bars old`);
            return 3;
          }
          out(`healthy: PID ${pid}, data ${q.fresh ? "fresh" : "not fresh (market closed)"}`);
          return 0;
        },
        true,
      );
    }
    case "kill-switch":
      return withApp(
        paths,
        async (app) => {
          const on = args[0] === "on";
          if (args[0] !== "on" && args[0] !== "off") {
            out("usage: quantforge kill-switch on|off [reason]");
            return 1;
          }
          app.risk.setKillSwitch(on, args.slice(1).join(" ") || "cli");
          out(
            `kill switch ${on ? "ENGAGED" : "released"}${on ? " (the daemon flattens open positions on its next monitoring pass)" : ""}`,
          );
          return 0;
        },
        true,
      );
    case "close-all":
      return withApp(paths, async (app) => {
        const r = await app.closeAll("manual");
        out(`closed ${r.closed}${r.failed.length ? `; failed: ${r.failed.join("; ")}` : ""}`);
        return r.failed.length ? 1 : 0;
      });
    case "live-status":
      return withApp(
        paths,
        async (app) => {
          const s = app.liveGate.status();
          out(`effective mode: ${s.effectiveMode.toUpperCase()}`);
          for (const c of s.checks) out(`  [${c.passed ? "x" : " "}] ${c.name}: ${c.detail}`);
          return 0;
        },
        true,
      );
    case "tick":
      return withApp(paths, async (app) => {
        const { Scheduler } = await import("../scheduler/scheduler.js");
        out(`ran: ${(await new Scheduler(app).tick()).join(", ") || "nothing due"}`);
        return 0;
      });
    case "research": {
      // The original TradingAgents engine, preserved: one question, answered headless.
      const cli = fileURLToPath(new URL("../../cli/main.js", import.meta.url));
      const child = spawn(process.execPath, [cli, "-p", args.join(" ")], { stdio: "inherit" });
      return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
    }
    default:
      out(`unknown command: ${cmd}\n`);
      out(HELP);
      return 1;
  }
}

async function doctor(paths: QfPaths): Promise<number> {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  let ok = true;
  const check = (name: string, passed: boolean, detail: string) => {
    out(`${passed ? "OK  " : "FAIL"}  ${name}: ${detail}`);
    if (!passed) ok = false;
  };
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  check(
    "node",
    major > 22 || (major === 22 && minor >= 13),
    `${process.version} on ${process.platform}/${process.arch} (need ≥ 22.13 for node:sqlite)`,
  );
  try {
    const { Database } = await import("../database/db.js");
    const db = new Database(":memory:");
    check(
      "node:sqlite",
      db.integrityCheck() === "ok",
      `SQLite ${String(db.get<{ v: string }>("SELECT sqlite_version() AS v")?.v)}`,
    );
    db.close();
  } catch (error) {
    check("node:sqlite", false, (error as Error).message);
  }
  check(
    "WebSocket client",
    typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function",
    "global WebSocket (optional; REST polling is the fallback)",
  );
  check("home", existsSync(paths.home), paths.home);
  check(
    "config",
    true,
    existsSync(paths.config) ? paths.config : "not created yet (defaults in use; run setup)",
  );
  try {
    const config = loadConfig(paths);
    check(
      "config valid",
      true,
      `mode ${config.mode}, dashboard ${config.dashboard.host}:${config.dashboard.port}`,
    );
  } catch (error) {
    check("config valid", false, (error as Error).message);
  }
  const termux = Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"));
  check(
    "platform",
    true,
    termux ? `Android Termux ${process.env.TERMUX_VERSION ?? ""}` : "not Termux (fine for development)",
  );
  try {
    const res = await fetch("https://api.twelvedata.com/price?symbol=XAU/USD", {
      signal: AbortSignal.timeout(10_000),
      headers: process.env.TWELVEDATA_API_KEY
        ? { authorization: `apikey ${process.env.TWELVEDATA_API_KEY}` }
        : {},
    });
    const body = (await res.json()) as { price?: string; message?: string };
    check(
      "twelvedata",
      Boolean(body.price),
      body.price ? `XAU/USD ${body.price}` : `${res.status} ${body.message ?? ""}`,
    );
  } catch (error) {
    check("twelvedata", false, (error as Error).message);
  }
  return ok ? 0 : 1;
}

// A reader that goes away (e.g. `quantforge status | head`) is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
