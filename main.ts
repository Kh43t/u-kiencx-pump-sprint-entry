// Pump Sprint: launch-sniper bot for the agent-fun/replay/v2 pump.fun replay.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// wire shim is vendored beside it (vendor/makefun-bot.ts, written for this entry).
// The bot trades 10 SOL of paper money: it buys a new curve only in its first
// slots and only when the launch looks organic (creator with real money in, a
// few other buyers, no bundle, no creator sell), sells into the spike at +50%,
// cuts at -6%, never holds past 50 slots. Deterministic: no clock, no
// randomness, no I/O.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
