/* What you paid for each position.

   The contract only stores how many shares a wallet holds, not what they cost, and public
   RPCs keep about 30 seconds of logs. So every trade made from these pages is written
   here (in this browser's localStorage, next to the burner wallet's key), and the
   dashboard works out profit and loss from it.

   A trade: { t, kind, id, side, q, mon, shares, tx, est }
     kind    'buy' | 'sell' | 'claim' | 'seen'
     id      onchain market id (number)
     side    'yes' | 'no' ('both' for a claim)
     mon     MON paid (buy) or received (sell, claim), as a number
     shares  shares bought or sold, as a number
     est     true when the dashboard had to estimate it (shares that showed up in the
             wallet without a recorded trade are booked at the price when first seen) */

const KEY = addr => 'headway.trades.v1.' + String(addr).toLowerCase();
let memory = null;   // set by useMemory(): keep everything in RAM (sample mode, blocked storage)

export const useMemory = () => { memory = {}; };

export function loadTrades(addr) {
  if (memory) return memory[KEY(addr)] || [];
  try { return JSON.parse(localStorage.getItem(KEY(addr)) || '[]'); } catch { return []; }
}

export function recordTrade(addr, trade) {
  const all = loadTrades(addr).concat([{ t: Date.now(), ...trade, id: Number(trade.id) }]).slice(-600);
  if (memory) { memory[KEY(addr)] = all; return all; }
  try { localStorage.setItem(KEY(addr), JSON.stringify(all)); } catch { /* storage blocked: this visit only */ memory = { [KEY(addr)]: all }; }
  return all;
}

/* Small JSON stores for the dashboard's price and profit history, per wallet. */
export function loadStore(name, addr) {
  const k = `headway.${name}.v1.${String(addr).toLowerCase()}`;
  if (memory) return memory[k] || null;
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
}
export function saveStore(name, addr, value) {
  const k = `headway.${name}.v1.${String(addr).toLowerCase()}`;
  if (memory) { memory[k] = value; return; }
  try { localStorage.setItem(k, JSON.stringify(value)); } catch { /* fine: history is a nicety */ }
}

/* Average-cost book. Returns a Map of "id:side" -> { shares, cost, realized, est }.
   A sell takes out its share of the cost and books the rest as realized profit or loss.
   A claim closes both sides of a market against the payout. */
export function book(trades) {
  const b = new Map();
  const at = (id, side) => { const k = id + ':' + side; if (!b.has(k)) b.set(k, { shares: 0, cost: 0, realized: 0, est: false }); return b.get(k); };
  for (const t of trades) {
    if (t.kind === 'buy' || t.kind === 'seen') {
      const p = at(t.id, t.side); p.shares += t.shares; p.cost += t.mon; if (t.est) p.est = true;
    } else if (t.kind === 'sell') {
      const p = at(t.id, t.side), frac = p.shares > 0 ? Math.min(1, t.shares / p.shares) : 1, out = p.cost * frac;
      p.realized += t.mon - out; p.cost -= out; p.shares = Math.max(0, p.shares - t.shares);
      if (p.shares < 1e-9) { p.shares = 0; p.cost = 0; }
    } else if (t.kind === 'claim') {
      const y = at(t.id, 'yes'), n = at(t.id, 'no');
      y.realized += t.mon - y.cost - n.cost;
      y.shares = y.cost = n.shares = n.cost = 0;
    }
  }
  return b;
}
