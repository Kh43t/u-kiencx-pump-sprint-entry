// Wire shim for agent-fun/replay/v2 (pump.fun paper-trading replay), Node 22.
// Zero dependencies, erasable TypeScript: the grader runs `node /bot/main.ts`
// and Node strips the types. It speaks the protocol on stdin/stdout: one JSON
// line in per batch (hello, batch, done), one reply line out per batch. It keeps
// the bot's view of the world current — cash, positions, each curve's latest
// reserves, orders still in flight — and hands that view to onBatch.
//
// stdout carries replies only; diagnostics go to stderr. Determinism matters:
// the entry runs twice and the two action logs must match byte for byte, so a
// strategy must never read the clock, the environment or Math.random; the only
// randomness allowed is seeded from hello.seed.

export const PROTOCOL = 'agent-fun/replay/v2';
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS = 10_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_LINE = 1_048_576;
const MAX_REPLY = 65_536;

export type U64 = string;
export type Pubkey = string;

export interface Caps {
  max_open_positions: number;
  max_order_bps_of_real_reserve: number;
  max_orders_per_batch: number;
  shorts: false;
  leverage: false;
}

export interface Hello {
  type: 'hello';
  protocol: typeof PROTOCOL;
  seed: U64;
  universe: {
    program: string;
    quote: 'SOL';
    mayhem: 'excluded';
    exclude_cashback: true;
    sample: { hash: 'sha256'; modulus: number; residue: number };
  };
  capital: { lamports: U64 };
  caps: Caps;
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

export interface TradeEvent {
  event: 'TradeEvent';
  slot: number;
  block_time: number | null;
  mint: Pubkey;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  user: Pubkey;
  creator: Pubkey;
  virtual_quote_reserves: U64;
  virtual_token_reserves: U64;
  real_quote_reserves: U64;
  real_token_reserves: U64;
  fee_basis_points: U64;
  creator_fee_basis_points: U64;
}

export interface CreateEvent {
  event: 'CreateEvent';
  slot: number;
  block_time: number | null;
  mint: Pubkey;
  user: Pubkey;
  creator: Pubkey;
  virtual_quote_reserves: U64;
  virtual_token_reserves: U64;
  real_token_reserves: U64;
}

export interface CompleteEvent {
  event: 'CompleteEvent';
  slot: number;
  block_time: number | null;
  mint: Pubkey;
}

export type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

export interface Mark {
  mint: Pubkey;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

export interface Fill {
  client_id: string;
  mint: Pubkey;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

export interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: U64; positions: { mint: Pubkey; token_amount: U64; cost_lamports: U64 }[] };
}

export interface Done {
  type: 'done';
  seq: number;
  reason: 'end_of_data' | 'aborted';
  account: Batch['account'];
}

export type Amount = bigint | string | number;

export interface BuyInput {
  side: 'buy';
  mint: Pubkey;
  quote_lamports: Amount;
  max_slippage_bps: number;
  client_id?: string;
}

export interface SellInput {
  side: 'sell';
  mint: Pubkey;
  token_amount: Amount;
  max_slippage_bps: number;
  client_id?: string;
}

export type OrderInput = BuyInput | SellInput;

export interface BotState {
  hello: Hello;
  seq: number;
  slot: number;
  cash: bigint;
  positions: Map<Pubkey, { token_amount: bigint; cost_lamports: bigint }>;
  curves: Map<
    Pubkey,
    {
      mint: Pubkey;
      created_slot: number | null;
      virtual_token_reserves: bigint;
      virtual_quote_reserves: bigint;
      real_token_reserves: bigint;
      real_quote_reserves: bigint;
      reserves_slot: number;
      trades: number;
      complete: boolean;
    }
  >;
  pending: Map<string, { order: { side: 'buy' | 'sell'; client_id: string; mint: Pubkey; quote_lamports?: U64; token_amount?: U64; max_slippage_bps: number }; seq: number; decided_slot: number }>;
  txFeeLamports(): bigint;
  maxBuyLamports(mint: Pubkey): bigint;
  committedPositionCount(): number;
  freeCashLamports(): bigint;
  applyBatch(batch: Batch): void;
  applyDone(done: Done): void;
  toOrders(result: unknown): { side: 'buy' | 'sell'; client_id: string; mint: Pubkey; quote_lamports: U64; token_amount: U64; max_slippage_bps: number }[];
  recordOrders(orders: readonly { client_id: string }[]): void;
}

export interface Bot {
  onHello?(state: BotState): void | Promise<void>;
  onBatch(state: BotState, batch: Batch): readonly OrderInput[] | void | null | undefined | Promise<readonly OrderInput[] | void | null | undefined>;
  onDone?(state: BotState, done: Done): void | Promise<void>;
}

class BadWire extends Error {}
class BadOrder extends Error {}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

function asU64(v: unknown, what: string): U64 {
  let n: bigint | null = null;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === 'string' && U64_RE.test(v)) n = BigInt(v);
  if (n === null || n < 0n || n > U64_MAX) throw new BadOrder(`${what} must be a u64, got ${String(v)}`);
  return n.toString();
}

function checkOne(o: unknown, where: string): { side: 'buy' | 'sell'; client_id: string | undefined; mint: Pubkey; amount: U64; max_slippage_bps: number } {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new BadOrder(`${where}: expected an order object`);
  const r = o as Record<string, unknown>;
  if (r.side !== 'buy' && r.side !== 'sell') throw new BadOrder(`${where}: side must be buy or sell`);
  const allowed = r.side === 'buy'
    ? ['side', 'client_id', 'mint', 'quote_lamports', 'max_slippage_bps']
    : ['side', 'client_id', 'mint', 'token_amount', 'max_slippage_bps'];
  for (const k of Object.keys(r)) if (!allowed.includes(k)) throw new BadOrder(`${where}: unknown key "${k}"`);
  if (typeof r.mint !== 'string' || !ADDR_RE.test(r.mint)) throw new BadOrder(`${where}: mint must be a base58 address`);
  const key = r.side === 'buy' ? 'quote_lamports' : 'token_amount';
  const amount = asU64(r[key], `${where}: ${key}`);
  const bps = r.max_slippage_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new BadOrder(`${where}: max_slippage_bps must be an integer 0..10000`);
  let client_id: string | undefined;
  if (r.client_id !== undefined) {
    if (typeof r.client_id !== 'string' || !ID_RE.test(r.client_id)) throw new BadOrder(`${where}: client_id must be 1-64 of [A-Za-z0-9_-], not starting with _`);
    client_id = r.client_id;
  }
  return { side: r.side, client_id, mint: r.mint, amount, max_slippage_bps: bps };
}

/** Build the per-run view the strategy sees. Plain object + closures. */
function makeState(hello: Hello): BotState {
  const used = new Set<string>();
  let next = 1;
  const freshId = (taken: Set<string> | null): string => {
    for (;;) {
      const id = `o${next++}`;
      if (!used.has(id) && (taken === null || !taken.has(id))) return id;
    }
  };
  const state: BotState = {
    hello,
    seq: -1,
    slot: -1,
    cash: BigInt(hello.capital.lamports),
    positions: new Map(),
    curves: new Map(),
    pending: new Map(),
    txFeeLamports(): bigint {
      return BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
    },
    maxBuyLamports(mint: Pubkey): bigint {
      const c = state.curves.get(mint);
      if (c === undefined || c.complete) return 0n;
      return (c.real_quote_reserves * BigInt(hello.caps.max_order_bps_of_real_reserve)) / BPS;
    },
    committedPositionCount(): number {
      const mints = new Set<Pubkey>(state.positions.keys());
      for (const p of state.pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
      return mints.size;
    },
    freeCashLamports(): bigint {
      const tx = state.txFeeLamports();
      let free = state.cash;
      for (const p of state.pending.values()) {
        free -= tx;
        if (p.order.side === 'buy') free -= BigInt(p.order.quote_lamports ?? '0');
      }
      return free;
    },
    applyBatch(batch: Batch): void {
      state.seq = batch.seq;
      state.slot = batch.slot;
      for (const f of batch.fills) state.pending.delete(f.client_id);
      state.cash = BigInt(batch.account.cash_lamports);
      state.positions.clear();
      for (const p of batch.account.positions) {
        const tokens = BigInt(p.token_amount);
        if (tokens > 0n) state.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
      }
      const upsert = (mint: Pubkey, slot: number) => {
        let c = state.curves.get(mint);
        if (c === undefined) {
          c = { mint, created_slot: null, virtual_token_reserves: 0n, virtual_quote_reserves: 0n, real_token_reserves: 0n, real_quote_reserves: 0n, reserves_slot: slot, trades: 0, complete: false };
          state.curves.set(mint, c);
        }
        return c;
      };
      for (const m of batch.marks) {
        const c = state.curves.get(m.mint);
        if (c !== undefined && m.slot < c.reserves_slot) continue;
        const curve = upsert(m.mint, m.slot);
        curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(m.real_token_reserves);
        curve.real_quote_reserves = BigInt(m.real_quote_reserves);
        curve.reserves_slot = m.slot;
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const curve = upsert(e.mint, e.slot);
          curve.created_slot = e.slot;
          curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
          curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
          curve.real_token_reserves = BigInt(e.real_token_reserves);
          curve.real_quote_reserves = 0n;
          curve.reserves_slot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const curve = upsert(e.mint, e.slot);
          curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
          curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
          curve.real_token_reserves = BigInt(e.real_token_reserves);
          curve.real_quote_reserves = BigInt(e.real_quote_reserves);
          curve.reserves_slot = e.slot;
          curve.trades += 1;
        } else {
          upsert(e.mint, e.slot).complete = true;
        }
      }
    },
    applyDone(done: Done): void {
      state.seq = done.seq;
      state.cash = BigInt(done.account.cash_lamports);
      state.positions.clear();
      for (const p of done.account.positions) {
        const tokens = BigInt(p.token_amount);
        if (tokens > 0n) state.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
      }
    },
    toOrders(result: unknown) {
      if (result === undefined || result === null) return [];
      if (!Array.isArray(result)) throw new BadOrder(`batch ${state.seq}: onBatch must return an array of orders`);
      if (result.length > hello.caps.max_orders_per_batch) throw new BadOrder(`batch ${state.seq}: ${result.length} orders over the ${hello.caps.max_orders_per_batch} cap`);
      const checked = result.map((o, i) => checkOne(o, `batch ${state.seq} order ${i}`));
      const taken = new Set<string>();
      for (const o of checked) if (o.client_id !== undefined) taken.add(o.client_id);
      return checked.map((o) => {
        const client_id = o.client_id ?? freshId(taken);
        taken.add(client_id);
        return o.side === 'buy'
          ? { side: 'buy' as const, client_id, mint: o.mint, quote_lamports: o.amount, token_amount: '0', max_slippage_bps: o.max_slippage_bps }
          : { side: 'sell' as const, client_id, mint: o.mint, quote_lamports: '0', token_amount: o.amount, max_slippage_bps: o.max_slippage_bps };
      });
    },
    recordOrders(orders: readonly { client_id: string }[]): void {
      for (const order of orders) {
        used.add(order.client_id);
        const full = order as { side: 'buy' | 'sell'; client_id: string; mint: Pubkey; quote_lamports: U64; token_amount: U64; max_slippage_bps: number };
        state.pending.set(order.client_id, { order: full, seq: state.seq, decided_slot: state.slot });
      }
    },
  };
  return state;
}

/** Split stdin into lines without loading a whole line longer than MAX_LINE. */
async function* lines(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: true });
  let buf = new Uint8Array(0);
  const push = (chunk: Uint8Array): void => {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0);
    merged.set(chunk, buf.length);
    buf = merged;
  };
  for await (const chunk of input) {
    push(typeof chunk === 'string' ? enc.encode(chunk) : chunk);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;
      if (nl > MAX_LINE) throw new BadWire(`input line over ${MAX_LINE} bytes`);
      let line = buf.subarray(0, nl);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      buf = buf.subarray(nl + 1);
      yield dec.decode(line);
    }
    if (buf.length > MAX_LINE) throw new BadWire(`input line over ${MAX_LINE} bytes`);
  }
  if (buf.length > 0) yield dec.decode(buf);
}

export async function runBot(bot: Bot, io: { input?: AsyncIterable<Uint8Array | string>; output?: { write(c: string): unknown; once?(e: 'drain', f: () => void): unknown } } = {}): Promise<{ state: BotState; done: Done; batches: number }> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const enc = new TextEncoder();
  let state: BotState | null = null;
  let batches = 0;
  let lineNo = 0;
  for await (const line of lines(input)) {
    lineNo++;
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new BadWire(`input line ${lineNo} is not JSON`);
    }
    const type = typeof msg === 'object' && msg !== null && !Array.isArray(msg) ? (msg as { type?: unknown }).type : undefined;
    if (type === 'hello') {
      const hello = msg as Hello;
      if (state !== null) throw new BadWire(`input line ${lineNo}: a second hello`);
      if (hello.protocol !== PROTOCOL) throw new BadWire(`the harness speaks ${String((hello as { protocol?: unknown }).protocol)}; this shim speaks ${PROTOCOL}`);
      state = makeState(hello);
      await bot.onHello?.(state);
    } else if (type === 'batch') {
      const batch = msg as Batch;
      if (state === null) throw new BadWire(`input line ${lineNo}: a batch before hello`);
      const ok =
        Number.isSafeInteger(batch.seq) &&
        Number.isSafeInteger(batch.slot) &&
        Array.isArray(batch.events) &&
        Array.isArray(batch.marks) &&
        Array.isArray(batch.fills) &&
        typeof batch.account === 'object' &&
        batch.account !== null &&
        Array.isArray(batch.account.positions);
      if (!ok) throw new BadWire(`input line ${lineNo}: malformed batch`);
      state.applyBatch(batch);
      const orders = state.toOrders(await bot.onBatch(state, batch));
      const text = JSON.stringify({ type: 'reply', seq: batch.seq, orders: orders.map((o) => (o.side === 'buy' ? { side: 'buy', client_id: o.client_id, mint: o.mint, quote_lamports: o.quote_lamports, max_slippage_bps: o.max_slippage_bps } : { side: 'sell', client_id: o.client_id, mint: o.mint, token_amount: o.token_amount, max_slippage_bps: o.max_slippage_bps })) });
      if (enc.encode(text).byteLength > MAX_REPLY) throw new BadOrder(`batch ${batch.seq}: the reply is over ${MAX_REPLY} bytes`);
      state.recordOrders(orders);
      const flushed = output.write(`${text}\n`);
      if (flushed === false && typeof output.once === 'function') await new Promise<void>((resolve) => (output.once as (e: 'drain', f: () => void) => unknown)('drain', resolve));
      batches++;
    } else if (type === 'done') {
      const done = msg as Done;
      if (state === null) throw new BadWire(`input line ${lineNo}: done before hello`);
      state.applyDone(done);
      await bot.onDone?.(state, done);
      return { state, done, batches };
    } else {
      throw new BadWire(`input line ${lineNo}: unknown message type ${String(type)}`);
    }
  }
  throw new BadWire(state === null ? 'input ended before hello' : `input ended before done (after ${batches} batches)`);
}
