// Stillwater — a capital-preservation cbBTC bot for the bars-replay/v1 protocol.
//
// Strategy in one paragraph: in a 24-hour race ranked by net PnL, most bots
// lose money to fees and noise, so the default state of this bot is FLAT.
// It speaks the protocol directly (hello, then one reply per batch carrying
// orders, until done) and it trades only after a capitulation: a bar whose
// low wicks at least 1.4% below the close 20 bars earlier, followed by a
// later bar that holds that low and closes back above the panic bar's close
// (a higher low with a reclaim). Positions are small (25% of cash), exits
// are mechanical (take-profit, stop-loss, a trailing lock, a time stop),
// and a kill-switch parks the bot for the rest of the window once equity
// is 0.8% under its start or its peak. At most 3 entries per window, and
// none in the final 75 batches: a position opened there cannot be held
// long enough to justify its round-trip cost before the harness flattens
// it at the last close.
//
// Everything is a deterministic function of the hello and the batches:
// no wall clock, no randomness, no files, no network. Prices are kept as
// the raw integers the harness sends (USDC per cbBTC at the symbol's
// price_scale); money is BigInt quote units.

import { createInterface } from "node:readline";

// ---- Tunables (fractions are unitless ratios of raw prices) ----
const WICK_WINDOW = 20; // bars of history behind the capitulation wick
const WICK_DROP = 0.014; // wick low at least 1.4% under the reference close
const RECOVER_RESET = 0.004; // episode ends once price is within 0.4% of reference
const SIZE_QUARTER = 4n; // buy notional = cash / 4  (25% of cash)
const TAKE_PROFIT = 0.012; // exit at +1.2% over the entry fill price
const STOP_LOSS = 0.011; // exit at -1.1% under the entry fill price
const TRAIL_ARM = 0.006; // trailing lock arms at +0.6%
const TRAIL_GIVE = 0.004; // ...and exits 0.4% under the peak close
const MAX_HOLD_BARS = 150; // time stop: never hold longer than 150 bars
const COOLDOWN_BARS = 60; // quiet bars required after an exit fill
const REJECT_COOLDOWN_BARS = 30; // quiet bars after a rejected buy
const MAX_ENTRIES = 3; // filled entries per window
const NO_ENTRY_AFTER_BATCH = 1365; // windows run 1,440 batches: no late entries
const KILL_NUM = 992n; // kill-switch: equity <= 99.2% of start or of peak
const KILL_DEN = 1000n;
const BUY_SLIPPAGE_BPS = 50; // do not chase a bounce that already ran
const SELL_SLIPPAGE_BPS = 300; // exits are protective: give them room

// ---- Protocol shapes (only the fields this bot reads) ----
interface HelloSymbol {
  symbol: string;
  price_scale: number;
  qty_scale: number;
}
interface Hello {
  type: "hello";
  symbols: HelloSymbol[];
  capital: { quote_scale: number; quote_units: string };
}
interface Bar {
  symbol: string;
  o: string;
  h: string;
  l: string;
  c: string;
}
interface Fill {
  client_id: string;
  side: string;
  status: string;
  price: string;
  qty: string;
}
interface Position {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}
interface Account {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
}
interface Batch {
  type: "batch";
  seq: number;
  bars: Bar[];
  fills: Fill[];
  account: Account;
}
type Order =
  | { side: "buy"; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: "sell"; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

// ---- Bot state ----
let symbol = "";
let priceScale = 0;
let qtyScale = 0;
let quoteScale = 6;
let startCapital = 0n;
let peakEquity = 0n;
let killed = false;

const closes: number[] = []; // raw closes, oldest first, trimmed
let batchCount = 0; // batches seen, the bot's only clock
let panicLow = -1; // raw low of the capitulation wick (-1: no episode)
let panicClose = 0; // raw close of the wick bar
let panicSeq = -1; // seq of the wick bar

type Phase = "flat" | "buy_pending" | "in_position" | "sell_pending";
let phase: Phase = "flat";
let pendingId = "";
let pendingSeq = -1;
let sellDecisionSeq = -1;
let entryPrice = 0; // raw fill price of the open position
let entrySeq = -1; // seq of the batch that reported the buy fill
let peakClose = 0; // highest raw close since entry
let entriesFilled = 0;
let cooldownUntilSeq = -1;
let orderCounter = 0;

function nextClientId(kind: string): string {
  orderCounter += 1;
  return `sw-${kind}${orderCounter}`;
}

function onHello(msg: Hello): void {
  const s = msg.symbols[0];
  symbol = s.symbol;
  priceScale = s.price_scale;
  qtyScale = s.qty_scale;
  quoteScale = msg.capital.quote_scale;
  startCapital = BigInt(msg.capital.quote_units);
  peakEquity = startCapital;
}

// Average entry price (raw price units) implied by a position's cost basis.
function priceFromCost(pos: Position): number {
  const cost = BigInt(pos.cost_quote_units);
  const qty = BigInt(pos.qty);
  if (qty <= 0n) return 0;
  const exp = BigInt(priceScale + qtyScale - quoteScale);
  const scaled = exp >= 0n ? cost * 10n ** exp : cost / 10n ** -exp;
  return Number(scaled / qty);
}

function processFills(batch: Batch, barClose: number): void {
  for (const fill of batch.fills) {
    if (fill.client_id.startsWith("_flatten_")) {
      if (phase === "in_position" || phase === "sell_pending") {
        phase = "flat";
        pendingId = "";
        cooldownUntilSeq = batch.seq + COOLDOWN_BARS;
      }
      continue;
    }
    if (pendingId === "" || fill.client_id !== pendingId) continue;
    if (phase === "buy_pending") {
      if (fill.status === "filled") {
        phase = "in_position";
        entryPrice = Number(fill.price);
        entrySeq = batch.seq;
        peakClose = barClose > 0 ? barClose : entryPrice;
        entriesFilled += 1;
      } else {
        phase = "flat";
        cooldownUntilSeq = batch.seq + REJECT_COOLDOWN_BARS;
      }
      pendingId = "";
    } else if (phase === "sell_pending") {
      if (fill.status === "filled") {
        phase = "flat";
        cooldownUntilSeq = sellDecisionSeq + COOLDOWN_BARS;
        entryPrice = 0;
        entrySeq = -1;
      } else {
        phase = "in_position"; // exit refused: try again on the next batch
      }
      pendingId = "";
    }
  }
  // A pending order that no fill ever answered (defensive; the harness
  // reports every order on the next batch) clears after a few bars.
  if ((phase === "buy_pending" || phase === "sell_pending") && batch.seq - pendingSeq > 3) {
    phase = phase === "buy_pending" ? "flat" : "in_position";
    pendingId = "";
  }
}

// Reconcile the phase with the account the harness reports: the account is
// the ground truth about whether a position exists.
function reconcile(batch: Batch, barClose: number): void {
  const pos = batch.account.positions.find((p) => p.symbol === symbol && BigInt(p.qty) > 0n);
  if (pos && phase === "flat") {
    phase = "in_position";
    entryPrice = priceFromCost(pos);
    entrySeq = batch.seq;
    peakClose = barClose > 0 ? barClose : entryPrice;
  } else if (!pos && phase === "in_position") {
    phase = "flat";
    cooldownUntilSeq = batch.seq + COOLDOWN_BARS;
    entryPrice = 0;
    entrySeq = -1;
  }
}

function updateKillSwitch(batch: Batch): void {
  const equity = BigInt(batch.account.equity_quote_units);
  if (equity > peakEquity) peakEquity = equity;
  if (startCapital > 0n) {
    if (equity * KILL_DEN <= startCapital * KILL_NUM) killed = true;
    if (equity * KILL_DEN <= peakEquity * KILL_NUM) killed = true;
  }
}

function sellOrder(batch: Batch): Order | null {
  const pos = batch.account.positions.find((p) => p.symbol === symbol && BigInt(p.qty) > 0n);
  if (!pos) return null;
  const id = nextClientId("s");
  pendingId = id;
  pendingSeq = batch.seq;
  sellDecisionSeq = batch.seq;
  phase = "sell_pending";
  return { side: "sell", client_id: id, symbol, qty: pos.qty, max_slippage_bps: SELL_SLIPPAGE_BPS };
}

function exitOrder(batch: Batch, bar: Bar): Order | null {
  const close = Number(bar.c);
  if (close > peakClose) peakClose = close;
  let exit = false;
  if (killed) exit = true;
  else if (close <= entryPrice * (1 - STOP_LOSS)) exit = true;
  else if (close >= entryPrice * (1 + TAKE_PROFIT)) exit = true;
  else if (peakClose >= entryPrice * (1 + TRAIL_ARM) && close <= peakClose * (1 - TRAIL_GIVE)) exit = true;
  else if (batch.seq - entrySeq >= MAX_HOLD_BARS) exit = true;
  return exit ? sellOrder(batch) : null;
}

function entryOrder(batch: Batch, bar: Bar): Order | null {
  if (batchCount >= NO_ENTRY_AFTER_BATCH) return null;
  const close = Number(bar.c);
  const open = Number(bar.o);
  const low = Number(bar.l);
  if (closes.length < WICK_WINDOW + 1) return null;
  const refClose = closes[closes.length - 1 - WICK_WINDOW];

  // Maintain the capitulation episode: track the deepest wick.
  if (low <= refClose * (1 - WICK_DROP) && (panicSeq < 0 || low < panicLow)) {
    panicLow = low;
    panicClose = close;
    panicSeq = batch.seq;
  }
  if (panicSeq < 0) return null;

  // The episode ends untraded once price recovers near the reference.
  if (batch.seq > panicSeq && close >= refClose * (1 - RECOVER_RESET)) {
    panicSeq = -1;
    panicLow = -1;
    return null;
  }
  // Trigger: a later bar holds the panic low and closes back above the
  // panic bar's close with a green body — a higher low with a reclaim.
  const confirmed =
    batch.seq > panicSeq && low >= panicLow && close > panicClose && close > open;
  if (!confirmed) return null;
  if (killed || entriesFilled >= MAX_ENTRIES || batch.seq < cooldownUntilSeq) return null;

  const cash = BigInt(batch.account.cash_quote_units);
  const notional = cash / SIZE_QUARTER;
  if (notional < 1000000n) return null; // below the 1 USDC minimum order
  const id = nextClientId("b");
  pendingId = id;
  pendingSeq = batch.seq;
  phase = "buy_pending";
  panicSeq = -1;
  panicLow = -1;
  return {
    side: "buy",
    client_id: id,
    symbol,
    notional_quote_units: notional.toString(),
    max_slippage_bps: BUY_SLIPPAGE_BPS,
  };
}

function onBatch(batch: Batch): Order[] {
  batchCount += 1;
  const bar = batch.bars.find((b) => b.symbol === symbol);
  const barClose = bar ? Number(bar.c) : 0;
  if (bar) {
    closes.push(barClose);
    if (closes.length > 64) closes.shift();
  }
  processFills(batch, barClose);
  reconcile(batch, barClose);
  updateKillSwitch(batch);
  if (!bar) return [];
  if (phase === "in_position") {
    const order = exitOrder(batch, bar);
    return order ? [order] : [];
  }
  if (phase === "flat") {
    const order = entryOrder(batch, bar);
    return order ? [order] : [];
  }
  return [];
}

// ---- NDJSON loop: one reply per batch, echoing its seq ----
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let msg: { type?: string };
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    onHello(msg as Hello);
  } else if (msg.type === "batch") {
    const batch = msg as Batch;
    const orders = onBatch(batch);
    process.stdout.write(JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n");
  } else if (msg.type === "done") {
    process.exit(0);
  }
});
