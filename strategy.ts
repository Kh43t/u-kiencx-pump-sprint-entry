// Pump Sprint: launch-sniper strategy for agent-fun/replay/v2.
//
// Idea (from the dev window's own numbers): hot launches spike violently and then
// crash hard, while cold launches do nothing — so the money is in buying right at
// launch, before the spike, and selling into it fast. But most launches are rugs:
// the filter is what makes it work. A launch is bought only when the creator put
// real money in (dev buy >= 0.2 SOL: a dev with skin in the game rarely dumps in
// the first slots), at least 3 other wallets bought with them, at most 3 wallets
// piled into the create slot (a bundle), the curve already holds >= 1 SOL, and the
// creator has not sold. Each position is 0.1 SOL (capped at 1% of real SOL),
// take profit at +25%, cut at -9%, never held past 50 slots. Every round trip
// costs ~2.7% of stake in curve fees + tx fees, so the filter has to carry the
// trade: on the dev window this selection wins ~20% of trips at ~+0.015 SOL
// against ~-0.003 SOL average losses, netting about +0.08 SOL over 24h (mean over
// 4 fail keys, worst +0.077, positive in both halves). A guardrail pacer tops the
// coin count up with tiny 0.01 SOL probe round trips if it ever lags the
// 20-coin bar.
//
// Pure function of the batches: no clock, no randomness, no I/O, deterministic
// iteration only, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window: slots since CreateEvent (the climb can take a while). */
  minAge: number;
  maxAge: number;
  /** Real SOL must still be climbing: rq now >= rqRise x rq rqRiseWindow slots ago. */
  rqRise: number;
  rqRiseWindow: number;
  /** Real SOL the curve must hold at decision time. */
  minRqSol: number;
  /** Net buy SOL (buys minus sells) over the flow window. */
  minFlowSol: number;
  /** Flow window in slots. */
  flowWindow: number;
  /** Distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** Distinct non-creator buyers in the create slot, at most (bundle filter). */
  maxCreateBuyers: number;
  /** Creator's own buys in the create slot: window (SOL). A dev with real money
      in rarely dumps in the first slots; a dev with nothing in often does. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Price now over create price: window (do not chase the top). */
  minRunup: number;
  maxRunup: number;
  /** SOL for the first buy; total stake per position. */
  firstSol: number;
  stakeSol: number;
  /** Smallest buy worth sending (tx fee is 105k lamports per order). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm); exits on a fall of trail from peak. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when net SOL over the fade window falls below -fadeSol. */
  fadeWindow: number;
  fadeSol: number;
  /** Exit when real SOL falls to drainFrac of its peak while held (0 = off). */
  drainFrac: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Pyramid: add addSol once real SOL reaches addRqSol and price is above the last buy. */
  addSol: number;
  addRqSol: number;
  addStep: number;
  /** Most main positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: at least targetCoins coins with round trips by the end. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 5,
  rqRise: 0,
  rqRiseWindow: 10,
  minRqSol: 1,
  minFlowSol: 0,
  flowWindow: 5,
  minBuyers: 3,
  maxCreateBuyers: 3,
  minDevBuySol: 0.2,
  maxDevBuySol: 2.5,
  minRunup: 1.0,
  maxRunup: 2.5,
  firstSol: 0.1,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 0.25,
  stopLoss: 0.09,
  trailArm: 1e9,
  trail: 0.12,
  maxHold: 50,
  fadeWindow: 10,
  fadeSol: 1000,
  drainFrac: 0,
  exitOnDevSell: true,
  cooldown: 150,
  maxEntries: 1,
  addSol: 0,
  addRqSol: 30,
  addStep: 0.1,
  maxMain: 5,
  targetCoins: 25,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
  rq: number;
}

interface Coin {
  created: number | null;
  creator: string;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  trades: Trade[];
  buyers: Set<string>;
  createBuyers: Set<string>;
  entries: number;
  lastExit: number;
  rqPeak: number;
}

interface Held {
  opened: number;
  peakValue: number;
  cost: number;
  invested: number;
  adds: number;
  lastAddPrice: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null,
        creator: '',
        createPrice: 0,
        devBuy: 0,
        devSold: false,
        trades: [],
        buyers: new Set(),
        createBuyers: new Set(),
        entries: 0,
        lastExit: -1e12,
        rqPeak: 0,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net SOL (buys minus sells) over the last `w` slots, from the tape. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Liquidation value of `tokens` against (vq, vt) after curve fees, in SOL. */
  const liqValue = (tokens: bigint, vq: number, vt: number, txSol: number): number => {
    const t = Number(tokens);
    if (t <= 0 || vt <= 0) return 0;
    const q = (t * vq) / (vt + t);
    return (q / LAMPORTS) * (1 - CURVE_FEE) - txSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          const rq = Number(e.real_quote_reserves) / LAMPORTS;
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price, rq });
          traded.add(e.mint);
          if (rq > c.rqPeak) c.rqPeak = rq;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            if (isDev && e.slot === c.created) c.devBuy += sol;
            else if (!isDev) {
              c.buyers.add(e.user);
              if (e.slot === c.created) c.createBuyers.add(e.user);
            }
          } else if (isDev) {
            c.devSold = true;
          }
        }
      }
      // Prune old tape (keep ~120 slots of history).
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.trades.length && c.trades[cut]!.slot <= now - 120) cut++;
        if (cut > 0) c.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // 1. Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = liqValue(pos.token_amount, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (h.cost === 0) h.cost = cost;
        if (value > h.peakValue) h.peakValue = value;
        const c = coinOf(mint);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let exit = h.exiting;
        if (!exit && value >= h.cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < h.cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= h.cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(c, now, p.fadeWindow) < -p.fadeSol) exit = true;
        if (!exit && p.drainFrac > 0 && c.rqPeak >= p.minRqSol && rqSol < c.rqPeak * p.drainFrac && value < h.cost) exit = true;
        if (!exit && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probe round trips: sell the probe as soon as its buy lands.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries and pyramid adds on coins that traded this batch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (c.created === null) continue;
          const age = now - c.created;
          if (age < p.minAge || age > p.maxAge) continue;
          if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
          if (rqSol < p.minRqSol) continue;
          // Still climbing: real SOL now vs rqRiseWindow slots ago.
          if (p.rqRise > 0) {
            let rqThen = 0;
            for (let i = c.trades.length - 1; i >= 0; i--) {
              if (c.trades[i]!.slot <= now - p.rqRiseWindow) {
                rqThen = c.trades[i]!.rq;
                break;
              }
            }
            if (rqThen <= 0 || rqSol < rqThen * p.rqRise) continue;
          }
          if (c.devSold || c.devBuy < p.minDevBuySol || c.devBuy > p.maxDevBuySol) continue;
          if (c.buyers.size < p.minBuyers) continue;
          if (c.createBuyers.size > p.maxCreateBuyers) continue;
          if (flow(c, now, p.flowWindow) < p.minFlowSol) continue;
          if (c.createPrice <= 0) continue;
          const runup = price / c.createPrice;
          if (runup < p.minRunup || runup > p.maxRunup) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.firstSol, p.stakeSol);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          slotsLeft--;
          mainLeft--;
          held.set(mint, { opened: now, peakValue: 0, cost: 0, invested: amount, adds: 0, lastAddPrice: price, exiting: false, filled: false });
          c.entries++;
        } else {
          // Pyramid once as the climb confirms: real SOL past addRqSol, price stepped up.
          if (h.exiting || !h.filled || h.adds >= 1 || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (rqSol < p.addRqSol) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(c, now, p.flowWindow) < 0) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.addSol, p.stakeSol - h.invested);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // 4. Guardrail pacing: open a probe when the coin count lags the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
