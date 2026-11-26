# QuantForge AI Pro — Architecture, Repository Audit and Compatibility Report

## 1. Audit of the original TradingAgents repository (Phase 1)

The upload was the TypeScript rewrite of TradingAgents (v1.0.1): about 34k lines in `src/`, no automated
tests. `tsc` and `biome` both passed cleanly before any change.

| Module                        | Contents                                                                                                  | Use in QuantForge                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/engine`                  | Session engine, delegation to specialist agents, memory, compaction, sync, calendar                       | Preserved unchanged. Reached through the original CLI and `quantforge research`.                                                                             |
| `src/agents` + `specs/agents` | Agent loop, catalog, budgets, prompts; Quant, Macro, Risk and Equity specs                                | Preserved. Their roles were adapted into the deterministic trading agents (Quant Research, Macro Intelligence, Risk Management).                             |
| `src/models`                  | Providers (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, OpenAI-compatible, ChatGPT), secret scrubbing | **Reused**: the AI Judge's optional LLM review builds its client with `providerOf()`.                                                                        |
| `src/compute`                 | Indicators (TA-Lib conventions), risk (VaR/ES/Sortino/Calmar), portfolio, optimization, correlation       | **Reused**: ATR/ADX in the feature engine via `indicatorsOf()`; `riskOf()` for daily paper-equity risk on the Performance page.                              |
| `src/tools`                   | Data/compute tools, evidence store and citations                                                          | Preserved. QuantForge agents follow the same evidence discipline: every claim carries an evidence id, and the LLM may cite only those ids.                   |
| `src/data`                    | Tauric, Yahoo and Polymarket providers with daily-bar routing                                             | Preserved. Yahoo is reused via `yahoo-finance2` as a futures-proxy adapter. The router is daily-equity oriented, so intraday XAUUSD needed a new data layer. |
| `src/store`                   | Process lock, private files (0600), JSONL log                                                             | **Reused**: `Lock` for the single-instance daemon and discovery; `readPrivate`/`writePrivate`/`writeAtomic` for credentials, tokens and config.              |
| `src/cli`                     | Ink terminal UI, setup, PDF reports                                                                       | Preserved as the `tradingagents` command.                                                                                                                    |

What was missing for trading: an intraday market-data layer, persistence (the original keeps sessions in
JSONL), backtesting, validation, risk, execution and scheduling. The original README says it plainly:
_"it does not place trades"_.

### Problems found

| Finding                                                                                                      | Severity              | Resolution                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript@7.0.2` (native Go compiler) has no Android binary                                                | High for Termux       | Releases ship a prebuilt `dist/`. `npm run build:portable` uses the pure-JS `typescript@5.9.3` (alias `typescript-js`), which was verified to compile the whole tree. |
| `bun` (dev only) and `@biomejs/biome` (dev only) have no Android binaries                                    | Low                   | Not needed at runtime: `install.sh` installs with `--omit=dev`.                                                                                                       |
| Release binaries are glibc-only (`linux-x64/arm64`)                                                          | High for Termux       | Not used: QuantForge runs from source under Termux Node.js.                                                                                                           |
| `store/lock.ts` treats a zombie holder as alive, blocking restart after `kill -9` until the zombie is reaped | Medium                | **Fixed** (one function): a zombie holder's lock is stale.                                                                                                            |
| Twelve Data sends weekend quotes for XAU/USD (flat bars Fri 22:00 → Sun 22:00 UTC)                           | High for data quality | Market calendar flags them `market_closed`, and they are excluded from analysis. Found by inspecting real data.                                                       |
| No tests                                                                                                     | —                     | 91 automated tests added, plus an opt-in live API test.                                                                                                               |

### Termux dependency compatibility

| Dependency                                                                       | Native code?                                           | Termux                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `node:sqlite` (built into Node ≥ 22.13)                                          | in Node                                                | ✔ no compilation (chosen over `better-sqlite3`, which needs a toolchain) |
| zod, yaml, ajv, semver, uuid, marked, chalk, ink, react, string-width, wrap-ansi | no                                                     | ✔                                                                        |
| ai-sdk packages, openapi-fetch, yahoo-finance2, pdfkit                           | no                                                     | ✔                                                                        |
| Dashboard                                                                        | no external assets (no CDN), vanilla JS, Canvas charts | ✔ works offline in Chrome                                                |
| WebSocket                                                                        | Node's global `WebSocket`                              | ✔ (optional)                                                             |

QuantForge adds **no new runtime dependency**. The only addition is the dev alias `typescript-js`.

## 2. Module map (`src/quantforge`)

```
core/          types, market calendar (DST-aware New York sessions), statistics, logger with redaction
config/        zod schema + defaults + risk profiles; paths, credentials (env → 0600 file)
database/      node:sqlite wrapper (WAL, savepoints, migrations, VACUUM INTO backups), repositories
data/          normalize (UTC, OHLC checks, dedupe, closed bars, stale quotes, gaps), resample,
               budget (per-minute/day credits with priorities), router (priority + fallback + circuit
               breakers + health), service (sync, paged backfill, modelled bid/ask, quality)
  providers/   twelvedata (REST + WebSocket), yahoo (futures proxy), csv
intelligence/  features (causal), regime (classifier + forward evaluation)
  agents/      10 agents, runner (time budgets, isolation), AI judge, optional LLM review
strategy/      spec (shared by backtest/lab/live), signal families, registry (runs, activation)
discovery/     generator (experiment grid), engine (gates A–I)
backtest/      engine (next-open fills, costs, swap, weekend flattening), metrics
validation/    Monte Carlo, bootstrap CI, splits, walk-forward folds
risk/          sizing, risk engine (final authority), position rules (shared with the paper broker)
decision/      deterministic decision engine + persistence
execution/     broker contract, paper broker, ledger, order manager, live gate
scheduler/     clock/calendar-driven job scheduler
monitoring/    process health (memory, event-loop lag, job heartbeats)
security/      dashboard auth (token → HttpOnly session, rate limits), backups (AES-256-GCM)
dashboard/     HTTP server (JSON API, SSE, CSP), public/ single-page app (14 pages)
cli/           main (commands), daemon (lock, PID, signals), setup wizard
app.ts         wiring and jobs
```

## 3. Data flow on each closed candle

```
           every 5m close + lag                        every 15m close + lag
Twelve Data ──► sync 5m ──► paper broker: stops, targets, partials, swap, weekend flatten
           └──► sync 15m ──► features (causal) ──► regime ──► active strategy signals
                                   │                                 │
                                   ▼                                 ▼
                            9 specialist agents ──► AI judge (+optional LLM: caution/veto only)
                                                          │
                                                          ▼
                              risk engine (final authority, sizing) ──► decision (stored)
                                                          │ BUY/SELL only
                                                          ▼
                    order manager (idempotent id, audit trail) ──► paper broker ──► ledger
```

Duplicate processing is impossible by construction: `processed_candles(job, tf, ts)` is claimed in the
database before a candle is acted on, decisions are unique per (tf, bar), and order ids are a hash of
(account, strategy, signal bar, side) with a UNIQUE constraint.

## 4. Resource use (measured in the development container, x86-64; a phone will be slower)

| Operation                                                   | Measured                        |
| ----------------------------------------------------------- | ------------------------------- |
| Discovery: 7,200 candidates on 24,559 clean 15m bars        | 8.3–9.4 s (child process)       |
| Decision job (sync, features, 10 agents, risk, persistence) | 180 ms incl. one API round trip |
| Monitor job (5m sync, position management)                  | 451 ms incl. one API round trip |
| Daemon memory                                               | RSS 90 MB, heap 26 MB           |

API budget (Twelve Data basic: 8/min, 800/day): monitoring ≈ 288/day, decisions ≈ 96/day, EUR/USD ≈ 24/day,
paper fills 1 each. That is about 410/day, well inside the plan. The budget keeps 60 credits back from
non-critical work. No LLM call is ever made on a tick: the LLM runs only for a trade proposal, within a
daily call cap.

## 5. Security model

- Credentials come from the environment or `~/.quantforge/credentials.env`, which must be owner-only
  (0600) and is refused otherwise. Live credentials sit in a separate file.
- The Twelve Data key travels in the `Authorization` header, never in a URL. Every registered secret and
  any `apikey=`/`token=` pattern is redacted from logs.
- The dashboard binds to 127.0.0.1. Non-loopback requires `allowRemote: true`. Login token comparison is
  constant-time. Sessions use HttpOnly SameSite=Strict cookies. A CSRF header is required for writes.
  Rate limits apply. A strict CSP is set, with no inline scripts. All request bodies are validated with zod.
- Backups are 0600 with a SHA-256 checksum and optional AES-256-GCM encryption (scrypt-derived key).
