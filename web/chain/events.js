// Live feed over websocket: every Markets event and every new block, as Monad produces them
// (a block about every 300 ms). Public RPCs only serve ~100 blocks of eth_getLogs history, so
// the page reads current state with markets.js and uses this feed for what happens next.
//
//   const stop = await watch({
//     onTrade:   (t) => {...},   // { id, who, yes, isBuy, amount, shares, priceYes, probYes, txHash, commitState }
//     onCreated: (m) => {...},
//     onResolved:(r) => {...},   // { id, value, outcome: OUTCOME.YES | NO | INVALID }
//     onBlock:   (b) => {...},   // { number, hash, timestamp, txCount, commitState }
//   });
//
// commitState comes from Monad's monadLogs / monadNewHeads subscriptions: 'Proposed', then
// 'Voted' and 'Finalized' as the block settles. The same trade arrives once per state, so a
// position can land faint (Proposed) and turn solid (Finalized). Plain newHeads/logs are the
// fallback if the node doesn't offer the Monad variants; then commitState is 'Proposed' only.
import { parseAbi, decodeEventLog } from './lib.js';
import { MARKETS_ABI } from './abi.js';
import { RPC_WS, loadDeployments } from './config.js';
import { toProb } from './markets.js';

const abi = parseAbi(MARKETS_ABI);

/**
 * Live odds, the simple way: calls onOdds({ id, probYes, priceYes, yes, isBuy, amount, who, txHash })
 * once per trade, as soon as its block is proposed (~300 ms on Monad). Also fires when a market
 * opens (with its starting odds) and when one settles ({ id, resolved: true, outcome }).
 * Returns a stop function.
 *
 *   const stop = await watchOdds(({ id, probYes }) => {
 *     const card = cards.find(c => c.chainId === id);
 *     if (card) { card.probYes = probYes; renderMarkets(); }
 *   });
 */
export async function watchOdds(onOdds, opts = {}) {
  return watch({
    onTrade: (t) => {
      if (t.commitState !== 'Proposed') return; // the same trade comes again as Voted/Finalized
      onOdds({ id: t.id, probYes: t.probYes, priceYes: t.priceYes, yes: t.yes, isBuy: t.isBuy,
               amount: t.amount, who: t.who, txHash: t.txHash });
    },
    onCreated: (c) => {
      if (c.commitState === 'Proposed') onOdds({ id: c.id, probYes: c.probYes, priceYes: c.priceYes, created: true });
    },
    onResolved: (r) => {
      if (r.commitState === 'Proposed') onOdds({ id: r.id, resolved: true, outcome: Number(r.outcome), value: r.value });
    },
  }, opts);
}

export async function watch(handlers = {}, { address } = {}) {
  const addr = (address ?? (await loadDeployments()).markets.address).toLowerCase();
  let ws;
  let stopped = false;
  let retry = 500;
  let nextId = 1;
  const pending = new Map(); // request id -> what it subscribed to
  const subs = new Map(); // subscription id -> kind

  function subscribe(kind, params) {
    const id = nextId++;
    pending.set(id, { kind, params });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params }));
  }

  function onLog(log, commitState) {
    if ((log.address || '').toLowerCase() !== addr) return;
    let ev;
    try { ev = decodeEventLog({ abi, data: log.data, topics: log.topics }); } catch { return; }
    const base = { txHash: log.transactionHash, blockNumber: BigInt(log.blockNumber), logIndex: Number(log.logIndex), commitState };
    const a = ev.args;
    if (ev.eventName === 'Trade') handlers.onTrade?.({ ...base, ...a, probYes: toProb(a.priceYes) });
    else if (ev.eventName === 'MarketCreated') handlers.onCreated?.({ ...base, ...a, probYes: toProb(a.priceYes) });
    else if (ev.eventName === 'MarketResolved') handlers.onResolved?.({ ...base, ...a });
    handlers.onEvent?.({ ...base, name: ev.eventName, args: a });
  }

  function onHead(h, commitState) {
    handlers.onBlock?.({
      number: BigInt(h.number),
      hash: h.hash,
      timestamp: Number(BigInt(h.timestamp)),
      txCount: h.transactionCount ?? (Array.isArray(h.transactions) ? h.transactions.length : undefined),
      commitState,
    });
  }

  function connect() {
    ws = new WebSocket(RPC_WS);
    ws.onopen = () => {
      retry = 500;
      subscribe('logs', ['monadLogs', { address: addr }]);
      if (handlers.onBlock) subscribe('heads', ['monadNewHeads']);
    };
    ws.onmessage = (msg) => {
      const m = JSON.parse(msg.data);
      if (m.id && pending.has(m.id)) {
        const req = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) {
          // No Monad variant on this node: fall back to the standard subscription.
          if (req.params[0] === 'monadLogs') subscribe('logs', ['logs', { address: addr }]);
          else if (req.params[0] === 'monadNewHeads') subscribe('heads', ['newHeads']);
          return;
        }
        subs.set(m.result, req.kind);
        return;
      }
      if (m.method !== 'eth_subscription') return;
      const kind = subs.get(m.params.subscription);
      const r = m.params.result;
      const state = r.commitState || 'Proposed';
      if (kind === 'logs') onLog(r, state);
      else if (kind === 'heads') onHead(r, state);
    };
    ws.onclose = () => {
      subs.clear();
      pending.clear();
      if (!stopped) setTimeout(connect, (retry = Math.min(retry * 2, 8_000)));
    };
    ws.onerror = () => ws.close();
  }

  connect();
  return () => { stopped = true; ws?.close(); };
}
