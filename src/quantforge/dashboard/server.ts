// Dashboard HTTP server: static single-page app, a JSON API and a Server-Sent Events stream (with polling
// fallback in the client). Bound to 127.0.0.1 by default; every route except /api/health and the login
// requires a session. Mutating requests require the X-QF-Request header (CSRF defence with SameSite=Strict).

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { QuantForgeApp } from "../app.js";
import { jsonSafe } from "../backtest/metrics.js";
import { saveConfig } from "../config/load.js";
import { buildConfig } from "../config/schema.js";
import { isTimeframe } from "../core/types.js";
import { CANONICAL } from "../data/service.js";
import { ARM_PHRASE } from "../execution/live-guard.js";
import { agentCatalogue } from "../intelligence/agents/runner.js";
import { parseCookies, RateLimiter, SessionStore, tokensEqual } from "../security/auth.js";
import { listBackups } from "../security/backup.js";
import { MODEL_LABELS } from "../strategy/types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const COOKIE = "qf_session";

function findPublicDir(): string {
  const here = fileURLToPath(new URL("./public/", import.meta.url));
  if (existsSync(join(here, "index.html"))) return here;
  // Running from a test build: fall back to the source tree.
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (let k = 0; k < 6; k++) {
    const candidate = join(dir, "src", "quantforge", "dashboard", "public");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    dir = join(dir, "..");
  }
  return here;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage, limit = 64_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function parseJsonCol<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export type DashboardOptions = {
  app: QuantForgeApp;
  token: string;
  host: string;
  port: number;
  publicDir?: string;
};

export class DashboardServer {
  private server: Server | null = null;
  private readonly sessions: SessionStore;
  private readonly apiLimiter = new RateLimiter(240, 60_000);
  private readonly loginLimiter = new RateLimiter(8, 15 * 60_000);
  private readonly clients = new Set<ServerResponse>();
  private readonly publicDir: string;
  private unsubscribe: (() => void) | null = null;
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: DashboardOptions) {
    this.sessions = new SessionStore(opts.app.config.dashboard.sessionHours * 3_600_000);
    this.publicDir = opts.publicDir ?? findPublicDir();
  }

  async listen(): Promise<{ host: string; port: number }> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        const invalid = error instanceof z.ZodError;
        const status = error instanceof HttpError ? error.status : invalid ? 400 : 500;
        if (invalid)
          error = new Error(
            `invalid request: ${(error as z.ZodError).issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
          );
        if (status === 500)
          this.opts.app.log.log("error", "dashboard", `request failed: ${(error as Error).message}`);
        if (!res.headersSent)
          this.json(res, status, { error: status === 500 ? "internal error" : (error as Error).message });
        else res.end();
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.opts.port, this.opts.host, () => resolve());
    });
    this.unsubscribe = this.opts.app.on((event) => this.broadcast(event));
    this.pushTimer = setInterval(() => this.broadcast("heartbeat"), 25_000);
    const addr = this.server.address();
    return { host: this.opts.host, port: typeof addr === "object" && addr ? addr.port : this.opts.port };
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    if (this.pushTimer) clearInterval(this.pushTimer);
    for (const c of this.clients) c.end();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private broadcast(event: string): void {
    const payload = `event: ${event === "heartbeat" ? "heartbeat" : "update"}\ndata: ${JSON.stringify({ event, ts: Date.now() })}\n\n`;
    for (const c of this.clients) c.write(payload);
  }

  private headers(res: ServerResponse): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    res.setHeader("Cache-Control", "no-store");
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    this.headers(res);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(jsonSafe(body)));
  }

  private authed(req: IncomingMessage): boolean {
    return this.sessions.valid(parseCookies(req.headers.cookie)[COOKIE]);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const client = req.socket.remoteAddress ?? "unknown";
    const method = req.method ?? "GET";

    if (path === "/api/health") return this.json(res, 200, { ok: true, ts: Date.now() });
    if (!path.startsWith("/api/")) return this.serveStatic(path, res);
    if (!this.apiLimiter.allow(client)) throw new HttpError(429, "too many requests");
    if (method !== "GET" && req.headers["x-qf-request"] !== "1")
      throw new HttpError(403, "missing X-QF-Request header");

    if (path === "/api/login" && method === "POST") {
      if (!this.loginLimiter.allow(client))
        throw new HttpError(429, "too many login attempts; wait 15 minutes");
      const body = z.object({ token: z.string().min(1).max(200) }).safeParse(await readJson(req));
      if (!body.success || !tokensEqual(body.data.token, this.opts.token))
        throw new HttpError(401, "invalid access token");
      const id = this.sessions.create();
      res.setHeader(
        "Set-Cookie",
        `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(this.opts.app.config.dashboard.sessionHours * 3600)}`,
      );
      return this.json(res, 200, { ok: true });
    }
    if (path === "/api/logout" && method === "POST") {
      this.sessions.revoke(parseCookies(req.headers.cookie)[COOKIE]);
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return this.json(res, 200, { ok: true });
    }
    if (!this.authed(req)) throw new HttpError(401, "login required");

    if (path === "/api/stream") return this.stream(req, res);
    const app = this.opts.app;
    const route = `${method} ${path}`;
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));

    switch (route) {
      case "GET /api/overview":
        return this.json(res, 200, app.overview());
      case "GET /api/market": {
        const tfParam = url.searchParams.get("tf") ?? app.config.data.decisionTf;
        if (!isTimeframe(tfParam)) throw new HttpError(400, "invalid timeframe");
        const native = tfParam === "5m" || tfParam === "15m" || tfParam === "1h";
        const bars = native
          ? app.candles.latest(CANONICAL, tfParam, Math.min(limit, 500))
          : app.data.derived(app.config.data.decisionTf, tfParam, Math.min(limit, 500));
        return this.json(res, 200, {
          tf: tfParam,
          quote: app.displayQuote(),
          quality: app.data.quality(app.config.data.decisionTf),
          bars: bars.map((b) => ({
            ts: b.ts,
            o: b.open,
            h: b.high,
            l: b.low,
            c: b.close,
            open: b.marketOpen,
            q: b.quality,
          })),
        });
      }
      case "GET /api/agents": {
        const last = app.db.get<{ id: number }>("SELECT id FROM decisions ORDER BY id DESC LIMIT 1");
        const reports = last
          ? app.db
              .all("SELECT * FROM agent_reports WHERE decision_id=? ORDER BY id", last.id)
              .map((r) => ({ ...r, evidence: parseJsonCol(r.evidence_json, []) }))
          : [];
        return this.json(res, 200, {
          catalogue: agentCatalogue(),
          decisionId: last?.id ?? null,
          reports,
          llm: {
            enabled: app.config.agents.llm.enabled,
            provider: app.config.agents.llm.provider,
            model: app.config.agents.llm.model,
          },
        });
      }
      case "GET /api/decisions":
      case "GET /api/signals": {
        const only = url.searchParams.get("only");
        const rows =
          only === "trades"
            ? app.db.all(
                "SELECT * FROM decisions WHERE action<>'NO_TRADE' OR (model IS NOT NULL AND score > 0) ORDER BY id DESC LIMIT ?",
                limit,
              )
            : app.db.all("SELECT * FROM decisions ORDER BY id DESC LIMIT ?", limit);
        return this.json(
          res,
          200,
          rows.map((d) => ({
            ...d,
            modelLabel:
              typeof d.model === "string"
                ? ((MODEL_LABELS as Record<string, string>)[d.model] ?? d.model)
                : null,
            reasons: parseJsonCol(d.reasons_json, []),
            rejected: parseJsonCol(d.rejected_json, []),
            risk: parseJsonCol(d.risk_json, null),
            evaluations: parseJsonCol(d.components_json, []),
          })),
        );
      }
      case "GET /api/backtests":
        return this.json(res, 200, {
          running: app.backtestRunning(),
          runs: app.db
            .all(
              "SELECT id, segment, created_at, params_json, metrics_json FROM backtests WHERE strategy_id='strategy' ORDER BY id DESC LIMIT ?",
              limit,
            )
            .map((b) => ({
              id: b.id,
              segment: b.segment,
              created_at: b.created_at,
              params: parseJsonCol(b.params_json, {}),
              report: parseJsonCol(b.metrics_json, {}),
            })),
        });
      case "POST /api/backtests/run": {
        const body = z.object({ days: z.number().int().min(7).max(3000) }).parse(await readJson(req));
        return this.json(res, 200, app.spawnBacktest(body.days));
      }
      case "GET /api/paper":
        return this.json(res, 200, {
          account: app.overview().account,
          transactions: app.ledger.transactions(limit),
          orders: app.orders.recent(limit),
          ledgerCheck: app.ledger.verify(),
        });
      case "GET /api/trades":
        return this.json(res, 200, app.ledger.closedPositions(limit));
      case "GET /api/positions": {
        const q = app.displayQuote();
        return this.json(
          res,
          200,
          app.ledger
            .openPositions()
            .map((p) => ({ ...p, unrealized: q ? app.ledger.unrealized(p, q) : null })),
        );
      }
      case "POST /api/positions/close-all":
        return this.json(res, 200, await app.serial("close-all", () => app.closeAll("manual")));
      case "GET /api/risk":
        return this.json(res, 200, {
          config: app.config.risk,
          controls: app.risk.controls(),
          events: app.events.recentRisk(limit),
          account: app.ledger.view(app.displayQuote() ?? undefined),
          instrument: app.config.instrument,
          costs: app.config.costs,
        });
      case "POST /api/risk/kill-switch": {
        const body = z
          .object({
            on: z.boolean(),
            reason: z.string().max(200).optional(),
            flatten: z.boolean().optional(),
          })
          .parse(await readJson(req));
        const c = app.risk.setKillSwitch(body.on, body.reason ?? "dashboard");
        const closed =
          body.on && body.flatten ? await app.serial("kill-flatten", () => app.closeAll("emergency")) : null;
        return this.json(res, 200, { controls: c, closed });
      }
      case "GET /api/performance":
        return this.json(res, 200, app.performance());
      case "GET /api/providers":
        return this.json(res, 200, {
          providers: app.router.healthReport(),
          budget: app.budget.status(),
          calls24h: app.health.summary(Date.now() - 86_400_000),
          quality: app.data.quality(app.config.data.decisionTf),
        });
      case "GET /api/logs": {
        const level = url.searchParams.get("level") ?? undefined;
        return this.json(res, 200, {
          system: app.events.recentSystem(
            limit,
            level && ["info", "warn", "error", "critical"].includes(level) ? level : undefined,
          ),
          health: app.monitor.report(),
        });
      }
      case "GET /api/settings":
        return this.json(res, 200, {
          config: app.config,
          versions: app.configVersions.list(20),
          live: app.liveGate.status(),
          armPhrase: ARM_PHRASE,
          backups: listBackups(app.paths),
          paths: { home: app.paths.home, db: app.paths.db },
        });
      case "POST /api/settings":
        return this.json(res, 200, await this.updateSettings(await readJson(req)));
      case "POST /api/regime/evaluate":
        return this.json(res, 200, {
          evaluation: await app.serial("regime-eval", async () => app.regimeEvaluation()),
        });
      case "POST /api/live/arm": {
        const body = z.object({ phrase: z.string().max(100) }).parse(await readJson(req));
        return this.json(res, 200, app.liveGate.arm(body.phrase));
      }
      case "POST /api/backup":
        return this.json(res, 200, { file: await app.backup() });
      default: {
        const bt = /^\/api\/backtests\/(\d+)$/.exec(path);
        if (bt && method === "GET") {
          const row = app.db.get<Record<string, unknown>>(
            "SELECT * FROM backtests WHERE id=?",
            Number(bt[1]),
          );
          if (!row) throw new HttpError(404, "unknown backtest");
          return this.json(res, 200, {
            id: row.id,
            created_at: row.created_at,
            params: parseJsonCol(row.params_json, {}),
            report: parseJsonCol(row.metrics_json, {}),
            trades: parseJsonCol(row.trades_json, []),
            equity: parseJsonCol(row.equity_json, []),
          });
        }
        const m = /^\/api\/positions\/(\d+)\/close$/.exec(path);
        if (m && method === "POST") {
          const id = Number(m[1]);
          return this.json(
            res,
            200,
            await app.serial("close-position", () => app.paper.close(id, 1, "manual")),
          );
        }
        throw new HttpError(404, "not found");
      }
    }
  }

  private async updateSettings(raw: unknown) {
    const app = this.opts.app;
    const patch = z
      .object({
        risk: z.record(z.string(), z.unknown()).optional(),
        decision: z.record(z.string(), z.unknown()).optional(),
        costs: z.record(z.string(), z.unknown()).optional(),
        instrument: z.record(z.string(), z.unknown()).optional(),
        strategy: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .parse(raw);
    const built = buildConfig({
      ...app.config,
      risk: { ...app.config.risk, ...(patch.risk ?? {}), ...(patch.risk ? { profile: "custom" } : {}) },
      decision: { ...app.config.decision, ...(patch.decision ?? {}) },
      costs: { ...app.config.costs, ...(patch.costs ?? {}) },
      instrument: { ...app.config.instrument, ...(patch.instrument ?? {}) },
      strategy: { ...app.config.strategy, ...(patch.strategy ?? {}) },
    });
    if ("error" in built) throw new HttpError(400, built.error);
    await saveConfig(app.paths, built.config);
    const hash = app.configVersions.record(built.config, "dashboard");
    return {
      saved: true,
      hash,
      restartRequired: true,
      note: "config.json kaydedildi. Uygulamak için ./restart.sh çalıştırın; o zamana kadar mevcut limitler geçerli.",
    };
  }

  private stream(req: IncomingMessage, res: ServerResponse): void {
    this.headers(res);
    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.write("retry: 5000\n\n");
    if (this.clients.size >= 10) {
      res.end();
      return;
    }
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private serveStatic(path: string, res: ServerResponse): void {
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const file = normalize(join(this.publicDir, rel));
    if (!file.startsWith(normalize(this.publicDir)) || !existsSync(file)) {
      // Single-page app: unknown paths get the shell.
      const index = join(this.publicDir, "index.html");
      if (!existsSync(index)) {
        res.writeHead(404);
        res.end("dashboard assets missing");
        return;
      }
      this.headers(res);
      res.writeHead(200, { "Content-Type": MIME[".html"] as string });
      res.end(readFileSync(index));
      return;
    }
    this.headers(res);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }
}
