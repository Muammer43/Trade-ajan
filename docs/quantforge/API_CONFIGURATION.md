# API and Configuration Guide

## Files

| Path (default `~/.quantforge`, override with `QF_HOME`) | Purpose                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                                           | Settings. Merged over defaults and strictly validated (unknown keys are refused). Template: `config/config.example.json`. |
| `credentials.env`                                       | API keys, `KEY=value` lines, **must be chmod 600**. Template: `config/credentials.env.example`.                           |
| `live-credentials.env`                                  | Reserved for a future verified live adapter. Separate from paper credentials.                                             |
| `dashboard-token`                                       | Dashboard access token (0600). Delete it and restart to rotate.                                                           |
| `quantforge.db`                                         | SQLite database (`QF_DATA_DIR` to relocate).                                                                              |
| `backups/`                                              | Backups (`QF_BACKUP_DIR` to relocate).                                                                                    |
| `logs/quantforge.log`                                   | JSON-lines log, rotated at 5 MB.                                                                                          |

Every configuration version is hashed and recorded in `config_versions`.

## Twelve Data (primary)

1. Create a key at <https://twelvedata.com/account/api-keys>.
2. Run `./install.sh` (the wizard stores it), or set `TWELVEDATA_API_KEY` in `credentials.env` or the environment.
3. Check it with `node dist/quantforge/cli/main.js doctor`.

Verified for this project (live tests): `/time_series` (1min…1day, `timezone=UTC`, `end_date` paging, at most
5000 bars per call), `/price`, `/api_usage`. On the basic plan **XAG/USD is not available**. QuantForge
detects this and skips the symbol for 7 days, so the Macro agent then uses EUR/USD alone. Twelve Data
publishes no bid/ask or volume for XAU/USD, so bid/ask are modelled from `costs.spread`. The dashboard labels
them "modelled".

WebSocket (`data.providers[0].websocket: true`): the adapter implements Twelve Data's price stream with
reconnects and REST fallback. Twelve Data includes WebSocket only on certain plans, and **it has not been
verified** in this project's test environment. Leave it off unless your plan includes it.

## Other providers

| id      | Basis                                  | Use                                                                                                 |
| ------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `yahoo` | `futures_proxy` (COMEX GC=F, not spot) | Disabled by default. Never feeds trading decisions (`useForTrading: false`).                        |
| `csv`   | spot                                   | `~/.quantforge/import/XAUUSD_15m.csv` (UTC). Or one-off: `quantforge import-csv file.csv --tf 15m`. |

Priority: a lower `priority` number is tried first. A provider that fails 3 times in a row is skipped for 2
minutes. A request-specific refusal (unsupported symbol or plan) does not count as a failure.

## Instrument and costs: match your broker

XAUUSD contracts differ between brokers. Set these from your broker's contract specification:

```json
"instrument": { "contractSize": 100, "tickSize": 0.01, "minLot": 0.01, "lotStep": 0.01, "maxLot": 5, "leverage": 100 },
"costs": { "spread": 0.35, "slippage": 0.05, "commissionPerLotRoundTrip": 7, "swapLongPerLotNight": -45, "swapShortPerLotNight": -10 }
```

Every backtest, validation and paper fill uses these numbers. Spread is widened ×1.3 in the Asian session
and ×2 in the last 30 minutes before a close.

## Risk (balanced profile defaults)

`riskPerTradePct 0.5` (hard range 0.25–1), `maxDailyLossPct 2`, `maxWeeklyLossPct 4`, `maxDrawdownPct 12` (kill
switch), `maxOpenPositions 2`, `maxCorrelatedRiskPct 1`, `maxConsecutiveLosses 4` (24 h cooldown, restarted only
by a further loss), `maxTradesPerDay 5`, `maxSpread 0.8`, `maxSlippage 0.5`, ATR percentile band 0.03–0.98,
`minRewardRisk 1.5`, no new trades within 30 minutes of a close, positions flattened before the weekend.
`profile: "conservative"` uses 0.25% per trade. Editing risk values from the dashboard sets `profile: "custom"`.

> With USD 1,000 and 0.5% risk the budget is USD 5 per trade (USD 10 at the 1% maximum). One 0.01 lot loses about USD 1 per USD 1 of
> stop distance (plus costs). A stop wider than roughly USD 9.4 therefore cannot be sized, and the trade is
> refused, never oversized.

## Optional LLM review (AI Judge)

```json
"agents": { "llm": { "enabled": true, "provider": "anthropic", "model": "claude-sonnet-5-5", "timeoutMs": 45000, "maxCallsPerDay": 40 } }
```

Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY`, or for `openai-compatible` set `baseURL` plus `QF_LLM_API_KEY`. The model receives
only agent evidence, must answer in JSON, may cite only existing evidence ids, and can only agree, caution
(−0.1 confidence) or veto. It runs only when a trade is proposed.

## Dashboard HTTP API

All endpoints except `/api/health` and `/api/login` need the session cookie. Every POST also needs the
header `X-QF-Request: 1`.

| Method | Path                                                                                                                                                                                                                                                                            | Purpose                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| POST   | `/api/login` `{token}` / `/api/logout`                                                                                                                                                                                                                                          | Session                                    |
| GET    | `/api/overview`, `/api/market?tf=5m\|15m\|1h\|4h`, `/api/agents`, `/api/decisions`, `/api/signals[?only=trades]`, `/api/backtests[/:id]`, `/api/paper`, `/api/trades`, `/api/positions`, `/api/risk`, `/api/performance`, `/api/providers`, `/api/logs?level=`, `/api/settings` | Page data                                  |
| GET    | `/api/stream`                                                                                                                                                                                                                                                                   | Server-Sent Events (`update`, `heartbeat`) |
| POST   | `/api/backtests/run {days}`, `/api/positions/:id/close`, `/api/positions/close-all`, `/api/risk/kill-switch {on, reason, flatten}`, `/api/settings`, `/api/regime/evaluate`, `/api/backup`, `/api/live/arm {phrase}`                                                            | Actions                                    |

## Strategy (`strategy` section)

```json
"strategy": {
  "minScore": 60, "minRewardRisk": 1.5, "targetR": 2.5, "minStopAtr": 0.4, "maxStopAtr": 2.5,
  "models": { "trend_pullback": true, "breakout_retest": true, "failed_breakout": true },
  "management": { "partialAtR": 1, "partialFraction": 0.5, "breakEvenAtR": 1, "trailAtr": 1.5, "maxBars": 32 }
}
```

`risk.riskPerTradePct` is hard-limited to 0.25–1 (default 0.5). A config.json from the earlier version is
migrated at start-up: the removed `discovery` section is dropped and a higher risk is clamped to 1.
Rules of each model: [STRATEJI_TR.md](STRATEJI_TR.md).
