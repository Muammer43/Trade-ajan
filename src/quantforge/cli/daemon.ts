// The long-running process: single-instance lock, PID file, application, scheduler and dashboard, with
// graceful shutdown on SIGTERM/SIGINT and crash-safe restart (all state is in SQLite; jobs are idempotent).

import { rmSync, writeFileSync } from "node:fs";
import { Lock } from "../../store/lock.js";
import { QuantForgeApp } from "../app.js";
import type { QfPaths } from "../config/load.js";
import { DashboardServer } from "../dashboard/server.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { loadOrCreateToken } from "../security/auth.js";

export async function runDaemon(
  paths: QfPaths,
  opts: { noScheduler?: boolean; noDashboard?: boolean } = {},
): Promise<number> {
  const lock = await Lock.acquire(paths.lockFile);
  if (!(lock instanceof Lock)) {
    const who = lock.heldBy ? `PID ${lock.heldBy.pid} on ${lock.heldBy.host}` : "another process";
    process.stderr.write(
      `QuantForge is already running (${who}).${lock.stuck ? ` If no QuantForge process exists, delete ${lock.stuck}.` : ""}\n`,
    );
    return 2;
  }
  writeFileSync(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });
  let app: QuantForgeApp | undefined;
  let scheduler: Scheduler | undefined;
  let dashboard: DashboardServer | undefined;
  let stopping = false;
  const shutdown = async (signal: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    app?.log.log("info", "daemon", `shutting down (${signal})`);
    const force = setTimeout(() => process.exit(code || 1), 20_000);
    force.unref();
    try {
      await scheduler?.stop();
      await dashboard?.close();
      app?.events.system("info", "daemon", `stopped (${signal})`);
      app?.close();
    } finally {
      rmSync(paths.pidFile, { force: true });
      await lock.release();
      clearTimeout(force);
      process.exit(code);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("uncaughtException", (error) => {
    app?.log.log("critical", "daemon", `uncaught exception: ${error.message}`, { stack: error.stack });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    app?.log.log("error", "daemon", `unhandled rejection: ${String((reason as Error)?.message ?? reason)}`);
  });

  try {
    // Under nohup the log file is the record; stderr is only echoed when attached to a terminal.
    app = await QuantForgeApp.create({ paths, logToStderr: process.stderr.isTTY === true });
    const notes = await app.recover();
    for (const n of notes) app.log.log("warn", "recovery", n);
    const live = app.liveGate.status();
    app.log.log(
      "info",
      "daemon",
      `QuantForge AI Pro started — effective mode ${live.effectiveMode.toUpperCase()} (requested ${app.config.mode})`,
    );
    if (!opts.noDashboard) {
      const { token, created } = await loadOrCreateToken(paths.dashboardToken);
      dashboard = new DashboardServer({
        app,
        token,
        host: app.config.dashboard.host,
        port: app.config.dashboard.port,
      });
      const addr = await dashboard.listen();
      app.log.log(
        "info",
        "daemon",
        `dashboard on http://${addr.host}:${addr.port}/${created ? ` (new access token written to ${paths.dashboardToken})` : ""}`,
      );
    }
    app.startStream();
    if (!opts.noScheduler && app.config.scheduler.enabled) {
      scheduler = new Scheduler(app);
      scheduler.start();
    }
  } catch (error) {
    process.stderr.write(`QuantForge failed to start: ${(error as Error).message}\n`);
    await shutdown("startup-failure", 1);
    return 1;
  }
  return await new Promise<number>(() => {});
}
