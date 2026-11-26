# Controlled Live Trading — Preparation Guide

**Live trading is disabled in this release and cannot be enabled by configuration alone.** No broker's
execution API has been verified for this project, so no live adapter ships. QuantForge will not pretend that
an order was executed.

## The gate (`src/quantforge/execution/live-guard.ts`)

Live execution requires **all** of the following. `quantforge live-status` and the Settings page show each
check:

1. `config.mode = "live"` and `config.live.enabled = true`
2. Environment `QF_LIVE_TRADING=I_UNDERSTAND_REAL_MONEY_RISK` for the running process
3. A separate `~/.quantforge/live-credentials.env`, mode 0600
4. A **registered, verified broker adapter** whose id equals `config.live.broker`. The `LIVE_ADAPTERS`
   registry is empty, so this check always fails today.
5. A successful connection check and position reconciliation in this process
6. A manual arm with the phrase `ARM LIVE TRADING WITH REAL MONEY`. This is held in memory only, expires
   after 8 hours, and is cleared on every restart. A restart never re-enables live trading, and nothing
   switches from paper to live automatically.

Even with a live adapter, the order manager re-checks the effective mode at submission, and the risk engine
applies the same limits plus `live.maxLots`.

## Adding a broker adapter (developer work)

1. Pick a broker with a documented, supported order API for XAUUSD (for example a FIX/REST bridge or an
   MT5 gateway that you operate). Verify the contract spec, symbol name, lot step, stop-level rules and
   whether stops sit on the server.
2. Implement `BrokerAdapter` (`execution/broker.ts`): `connect`, `account`, `positions`, `submit` (honour
   `clientOrderId` for idempotency), `modify`, `close`.
3. Make it pass the contract suite `brokerContract()` in `tests/unit/execution.test.ts` against the broker's
   **demo** environment, plus reconciliation tests for partial fills, rejects and disconnects.
4. Register it in `LIVE_ADAPTERS` and run it on a demo account in paper-like conditions for weeks. Compare
   fills against the paper broker's assumptions (spread, slippage, swap) and update `costs` accordingly.
5. Only then consider a tiny live allocation with `live.maxLots` at the broker minimum.

## Before real money

- The strategy must have stayed consistent with its validation on paper (the Strategy Research agent vetoes
  a strategy whose paper expectancy has broken from validation).
- Re-run discovery on the latest data. An edge that disappears should not be traded.
- Keep the phone on power, the battery unrestricted, and a watchdog (`healthcheck.sh --restart`) running.
  Prefer server-side stops at the broker, because a phone can lose connectivity.
