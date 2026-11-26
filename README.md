# QuantForge AI Pro

An autonomous, multi-agent quantitative trading system for **XAUUSD (spot gold)**. It is built on the
TradingAgents research framework and runs natively on **Android Termux**. It ships in **PAPER mode**:
it trades a simulated USD 1,000 account against real Twelve Data prices and never sends an order to a
broker.

> QuantForge looks for statistical edges and refuses to trade without one. On the real XAU/USD history
> tested so far (1 year of 15-minute bars and 3 years of hourly bars), **no strategy passed validation**,
> so the system's decision is NO TRADE. That is the correct outcome, not a defect. See
> [docs/quantforge/VALIDATION_REPORT.md](docs/quantforge/VALIDATION_REPORT.md).

## What it does

| Layer        | What it does                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market data  | Twelve Data (primary), Yahoo futures proxy (display only), CSV import. Symbol mapping and capability checks, priority fallback with circuit breakers, an API credit budget, UTC normalization, closed-candle checks, duplicate/missing/stale-quote detection. Missing bars are never filled with invented values.                                       |
| Intelligence | 10 agents (Quant Research, Macro Intelligence, Market Regime, Strategy Research, Price Action, Volatility, Liquidity, Risk Management, Execution Intelligence, AI Judge). Each report carries evidence ids, a confidence and an optional veto. An optional LLM review goes through the original TradingAgents model providers and can only add caution. |
| Regime       | Slope t-statistic + efficiency ratio trend states, ATR-percentile volatility levels, vol expansion/contraction, breakouts and liquidity traps. Evaluated against forward behaviour.                                                                                                                                                                     |
| Discovery    | 7,200 candidates from 10 hypothesis families (displacement, sweeps, failed breakouts, squeezes, mean reversion, momentum persistence, session drives, streak asymmetry) × filters × exits.                                                                                                                                                              |
| Validation   | Chronological train/validation/holdout split with segment-contained trades, Benjamini–Hochberg FDR, deflated Sharpe, anchored walk-forward with in-sample re-optimization, parameter stability, cost sensitivity, Monte Carlo and a bootstrap CI.                                                                                                       |
| Decision     | Deterministic BUY / SELL / NO_TRADE with entry, stop, target, R:R, size, holding time, confidence, reasons and why each alternative was rejected.                                                                                                                                                                                                       |
| Risk         | Risk-based sizing from the broker's contract spec, daily/weekly loss limits, max drawdown kill switch, loss-streak cooldown, exposure, spread/slippage/volatility gates, session close and weekend handling. The risk engine has the final say.                                                                                                         |
| Execution    | Broker adapter contract, an idempotent order manager, reconciliation, a paper broker with modelled bid/ask, slippage, commission, swap, partials, break-even, trailing and time exits, and a transaction ledger. Live trading is gated and has no adapter.                                                                                              |
| Platform     | SQLite via `node:sqlite` (no native build), a mobile dashboard with 14 pages, SSE plus polling, token login, a scheduler, a watchdog, backups (optionally encrypted) and Termux scripts.                                                                                                                                                                |

## Quick start (Android Termux)

```bash
pkg install -y nodejs-lts unzip
unzip QUANTFORGE_AI_PRO_TERMUX.zip -d ~ && cd ~/QUANTFORGE_AI_PRO
./install.sh          # dependencies + setup wizard (asks for your Twelve Data key)
./start.sh            # starts the daemon; open http://127.0.0.1:8787/ in Chrome
./status.sh  ./stop.sh  ./restart.sh  ./healthcheck.sh  ./backup.sh  ./restore.sh <file>  ./update.sh
```

The full Turkish guide is [docs/quantforge/KURULUM_TR.md](docs/quantforge/KURULUM_TR.md).

## Documentation

- [Turkish installation guide (Kurulum)](docs/quantforge/KURULUM_TR.md)
- [Architecture, repository audit and compatibility report](docs/quantforge/ARCHITECTURE.md)
- [API and configuration guide](docs/quantforge/API_CONFIGURATION.md)
- [Paper trading](docs/quantforge/PAPER_TRADING.md)
- [Controlled live trading preparation](docs/quantforge/LIVE_TRADING_PREPARATION.md)
- [Troubleshooting](docs/quantforge/TROUBLESHOOTING.md)
- [Validation and test report](docs/quantforge/VALIDATION_REPORT.md)
- Original framework: [docs/TRADINGAGENTS_README.md](docs/TRADINGAGENTS_README.md). Its CLI is preserved as
  `tradingagents` and is also reachable through `quantforge research "<question>"`.

## Development

```bash
npm ci
npm run build          # tsc + dashboard assets → dist/
npm run build:portable # same with the pure-JS TypeScript 5.9 compiler (works on Android)
npm run typecheck && npm run lint
npm test               # unit + integration + e2e (91 tests)
QF_LIVE_TESTS=1 node --test build/test/tests/integration/twelvedata.live.test.js   # real API
```

## Disclaimer

This is research and paper-trading software. Past and simulated performance does not predict future
results. Nothing here is investment advice.

Apache-2.0. See [LICENSE](LICENSE).
