# Validation and Test Report

Generated on 2026-11-26 from runs actually executed in the development container (Linux x86-64,
Node.js v22.23.5, SQLite 3.54.1). Nothing below was run on an Android device. See "Not verified".

## 1. Strategy discovery on real XAU/USD data (Twelve Data)

### 15-minute bars, 1 year

- Data: 35,500 bars stored, 24,559 clean (market-open, non-stale) 15m bars, 2025-11-13 → 2026-11-26.
- Chronological segments: train 2025-11-17 → 2026-07-01, validation → 2026-09-14, holdout test → 2026-11-26.
- Candidates: 7,200 (200 signal configurations × 36 exit templates), all net of spread 0.35, slippage
  0.05/side, commission USD 7/lot round trip and swap.

| Stage                                                                          | Result                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| A — training screen (n ≥ 30, E > 0.05R, PF ≥ 1.15, no single-trade dependence) | 618 passed                                                                          |
| B — out-of-sample validation + Benjamini–Hochberg (q = 0.10)                   | **0 passed** (610 not significant after FDR, 428 negative expectancy out of sample) |
| C–I                                                                            | not reached                                                                         |

**Conclusion: no strategy demonstrated a statistically robust edge after costs. The system does not trade.**

### 1-hour bars, 3 years (2023-03 → 2026-11, 25,499 bars)

306 of 7,200 passed training; **0** survived validation with FDR control. Same conclusion.

These results were not tuned. Thresholds were fixed before the real-data runs and were not changed to get a
different outcome.

## 2. Positive and negative controls for the discovery pipeline

To show the pipeline can find an edge when one exists, and rejects noise when none does:

| Synthetic market                                        | Result                                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 120 days, planted continuation edge (p = 0.8)           | Validated `disp_cont` strategies that passed **all** gates, including the untouched holdout (test `finds and validates a planted continuation edge`) |
| 120 days, pure random walk with volatility clustering   | 0 validated (test `rejects everything on a market without an edge`)                                                                                  |
| 200 days, planted edge, full 7,200-candidate grid (e2e) | Validated, activated, and traded on paper                                                                                                            |

Note on the deflated Sharpe gate: the first implementation used the dispersion of Sharpe ratios across all
candidates. With a real edge present, that dispersion grows and the edge hides itself (the planted edge
failed DSR). The gate now uses the null sampling variance 1/(n−1), which is the quantity the
false-strategy theorem calls for. Under that gate the planted edge passes, and noise still fails at stage B.

## 3. Regime classifier evaluation (real 15m data, 24,557 bars, horizon 16 bars)

| Metric                                                           | Value                              |
| ---------------------------------------------------------------- | ---------------------------------- |
| Trend label accuracy vs forward trend class                      | 40.4%                              |
| Baseline: always the majority class                              | 55.1%                              |
| Baseline: persistence of the previous realized class             | 43.4%                              |
| Volatility level → mean forward \|return\| (low / normal / high) | 41.0 / 46.5 / 62.2 bps (monotonic) |
| Spearman(ATR percentile, forward \|return\|)                     | 0.097                              |

Interpretation: the **trend** labels describe the past window well but **do not forecast** the next 4 hours
better than naive baselines. Strategies therefore use them only as filters, and discovery decides whether a
filter helps. **Volatility** regimes do carry forward information (volatility clustering): higher predicted
volatility means larger moves. This is used for risk gating.

## 4. Automated tests executed

| Command                                                           | Result                                        |
| ----------------------------------------------------------------- | --------------------------------------------- |
| `npm run typecheck` (src, tests, original scripts)                | pass                                          |
| `npm run lint` (`biome check .`, 294 files)                       | pass                                          |
| `npm run build` and `build:portable` (TypeScript 5.9 JS compiler) | pass                                          |
| `npm test` — 91 tests in 30 suites (unit, integration, e2e)       | 91 pass, 0 fail (three consecutive full runs) |
| `QF_LIVE_TESTS=1` live Twelve Data test (3 tests)                 | 3 pass                                        |

One intermittent failure was observed during development in the shell-script e2e test: a timing race
after `kill -9` before the killed process left the process table. It was fixed by polling for process exit,
and the next three full runs were green.

Coverage by area: calendar and DST, statistics (t, normal, BH, DSR, bootstrap), configuration validation,
secret redaction, API budget, normalization (UTC, invalid OHLC, duplicates, forming bars, weekend quotes,
stale quotes, gaps), resampling, Twelve Data adapter (mocked HTTP, error mapping, key never in URL),
provider fallback and circuit breaker, feature **causality** (no look-ahead), regime, position rules (stop
before target, gaps, partial, break-even, trailing, time), backtester (next-open fills, costs, segment
containment, weekend flattening), validation helpers, discovery controls, sizing, every risk rule, kill
switch persistence, automatic breakers, ledger integrity, paper fills, SL/TP/partial/swap/time exits,
idempotency, reconciliation, the broker contract, the live gate, agents (isolation, timeouts, vetoes), the
LLM judge (cannot raise confidence, invented citations discarded), auth, encrypted backup and restore with
tamper detection, migrations, crash durability (WAL), data-service outage and catch-up, the dashboard API
(auth, CSRF, CSP, traversal, every page endpoint, lab, SSE), full e2e paper trading with a restart and a
network outage, and the Termux scripts (install check, start, status, health, `kill -9`, watchdog restart,
backup, stop, restore).

Bugs these tests found and that were fixed: a one-bar trade leak across segment boundaries in the
backtester; provider health degraded by plan-restricted symbols; float rounding of timestamps in API
output; zombie lock holders blocking restart (original `store/lock.ts`); and the deflated Sharpe hurdle
described above.

## 5. Live smoke test (real API, development container)

The daemon ran against Twelve Data with the dashboard. All 14 pages were opened in headless Chromium
emulating a Pixel 7, with no page errors (the only console 401 is the pre-login probe). Graceful SIGTERM
shutdown released the PID file and the lock.

## 6. Not verified

- **Running on a physical Android device under Termux.** The code avoids every known incompatibility
  (no native add-ons, no glibc binaries, no systemd or Docker, `node:sqlite` built in, pure-JS build path),
  but it has not been executed on a phone. `install.sh` was exercised here in `--check` mode and through the
  script tests.
- The Twelve Data WebSocket stream (plan-dependent; this environment could not authenticate it).
- The Yahoo futures-proxy adapter against the real Yahoo API (rate-limited here). It is disabled by default.
- The optional LLM review against a real model. It was tested with a scripted model client only.
- Any live broker. None is implemented, by design.
