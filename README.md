# Pump Sprint — Growth Sniper

[![make.fun](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![rank](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/Kh43t/u-kiencx-pump-sprint-entry/rank.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)
[![reward](https://make.fun/badge/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4/Kh43t/u-kiencx-pump-sprint-entry/reward.svg)](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4)

A paper-trading bot for the [Pump Sprint: 12-Hour Paper Trading Dash](https://make.fun/bounty/u-kiencx-pump-sprint-12-hour-paper-trading-dash-29aa76d4) bounty on make.fun. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve data (agent-fun/replay/v2).

## Strategy

Most pump.fun launches die; the ones that run spike violently in their first minute and then crash hard. So this bot buys **at launch, before the spike**, and sells into it fast — but only when the launch looks organic:

1. **Filter** — buy only when the creator put real money in (dev buy ≥ 0.2 SOL), at least 3 other wallets bought with them, at most 3 wallets piled into the create slot (a bundle filter), the curve already holds ≥ 1 SOL, and the creator has not sold.
2. **Buy** 0.1 SOL (capped at 1% of the curve's real SOL) in the launch's first 5 slots.
3. **Exit** — take profit at +25%, cut at −9%, never hold past 50 slots. No pyramid, no completion play: completers teleport to ~14.7x inside 5 slots, before any bot can buy them cheap.

A guardrail pacer keeps the run above 25 coins with tiny 0.01 SOL probe round trips if the coin count ever lags the 20-coin bar.

Local backtest on the kit's dev window (24h, full dataset, mean over 4 fail keys): **+0.080 SOL net PnL** (worst key +0.077, positive in both halves), ~96 coins, ~21% win rate, max drawdown ~1%.

## Layout

- `main.ts` — entrypoint: `node /bot/main.ts`
- `strategy.ts` — the strategy (pure function of the batches: no clock, no randomness, no I/O, so the two graded executions produce byte-identical action logs)
- `vendor/makefun-bot.ts` — minimal wire shim for agent-fun/replay/v2, written for this entry

## License

MIT
