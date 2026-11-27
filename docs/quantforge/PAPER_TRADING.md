# Paper Trading

Paper mode is the default and the only mode that can execute in this release. It trades a separate account
(`paper`, USD 1,000 by default, 0.5% risk per trade) against **real** Twelve Data prices and never contacts a broker.

## How a paper trade happens

1. A 15-minute candle closes. The scheduler fetches it about 20 s later (`closeLagMs`) and claims it once.
2. The regime picks which of the three trade models may run; their setups are evaluated and scored
   (STRATEJI_TR.md). No qualifying setup means NO_TRADE.
3. Five agents report and the AI Judge computes a confidence (signal score + agent consensus, scaled down for
   data quality). Any veto, a contradiction, or a confidence below `decision.minConfidence` means NO_TRADE.
4. The risk engine checks every limit and sizes the position. Any failure means NO_TRADE, with each reason
   stored.
5. The order manager creates an idempotent order and the paper broker fetches a fresh price (1 API credit).
   A buy fills at the ask plus slippage, a sell at the bid minus slippage. Half the round-trip commission is
   charged at entry.
6. Every 5-minute bar checks stops, targets and partials (the adverse extreme first, gaps fill at the open).
   Swap is charged at 17:00 New York (Wednesday ×3), and positions are flattened before the weekend close.
   Each 15-minute close applies break-even, trailing and the time exit, the same rules as the backtest.

Every fill, fee, swap and realized P&L is a row in `transactions`, and the account balance always equals
their sum. This is checked at every start (`ledgerCheck` on the Paper Trading page). A mismatch engages the
kill switch.

## Simulated versus actual market conditions

The Orders table stores, for each fill, the **reference price** (provider mid at submission), the **fill
price** and the **slippage** applied. The Market page shows the provider bars the stops were evaluated on.
Known differences from a real broker:

- Bid/ask are modelled from the configured spread (Twelve Data has none for XAU/USD).
- Stops are checked on closed 5-minute bars, not tick by tick. A bar touching both stop and target counts
  as a stop.
- Small accounts cannot take partial profits: 0.01 lot cannot be split at a 0.01 lot step, so the partial
  is skipped and break-even still applies.

## Controls

- Dashboard → Open Positions: close one or all. Risk Management: kill switch (optionally flatten).
- CLI: `quantforge kill-switch on "reason"`, `quantforge close-all`.
- The kill switch persists across restarts, and the daemon flattens positions while it is on.

## Resetting the paper account

Stop QuantForge, move `~/.quantforge/quantforge.db` aside, and start again. A new account is created with
`risk.initialBalance`. History, strategies and decisions start empty.
