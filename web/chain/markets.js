// Contract helpers the page calls. Reads go straight to the chain; writes go through a wallet
// from wallet.js. Amounts are bigint wei (1 MON = 10n ** 18n); use parseMon/formatMon at the edges.
//
//   const m = await markets();                       // bound to the deployed address
//   const list = await m.list();                     // every market, with odds
//   const r = await m.buy(wallet, id, true, parseMon('0.01'));
//   r.trade.shares, r.trade.priceYes, r.receipt.hash
import {
  parseAbi, encodeFunctionData, parseEventLogs, formatEther, parseEther,
  BaseError, ContractFunctionRevertedError,
} from './lib.js';
import { MARKETS_ABI, ERROR_TEXT } from './abi.js';
import { loadDeployments } from './config.js';
import { publicClient } from './wallet.js';

export const abi = parseAbi(MARKETS_ABI);
const WAD = 10n ** 18n;

export const parseMon = (s) => parseEther(String(s));
export const formatMon = (wei, digits = 4) => Number(formatEther(wei)).toFixed(digits);
/** priceYes (1e18 = 100%) as a number from 0 to 1. */
export const toProb = (p) => Number((p * 10_000n) / WAD) / 10_000;

function shapeMarket(id, m) {
  const pool = m.yesReserve + m.noReserve;
  const priceYes = pool === 0n ? 0n : (m.noReserve * WAD) / pool;
  return {
    id: BigInt(id),
    question: m.question,
    series: m.series,
    threshold: m.threshold,
    isAbove: m.isAbove,
    closeTime: Number(m.closeTime), // unix seconds
    feeBps: Number(m.feeBps),
    creator: m.creator,
    resolved: m.resolved,
    outcomeYes: m.outcomeYes,
    value: m.value,
    yesReserve: m.yesReserve,
    noReserve: m.noReserve,
    lpSupply: m.lpSupply,
    priceYes,
    probYes: toProb(priceYes),
    open: !m.resolved && Date.now() / 1000 < Number(m.closeTime),
  };
}

/** Turn a revert into a short sentence for the page. */
export function explain(err) {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    const name = revert?.data?.errorName;
    if (name) return ERROR_TEXT[name] || name;
    if (/insufficient funds/i.test(err.message)) return 'Not enough MON in this wallet.';
    return err.shortMessage || err.message;
  }
  return String(err?.message || err);
}

export async function markets(address) {
  const addr = address ?? (await loadDeployments()).markets.address;
  const read = (functionName, args = []) => publicClient.readContract({ address: addr, abi, functionName, args });

  async function write(wallet, functionName, args, value = 0n) {
    // Simulate first so a revert comes back as a named error before any gas is spent.
    await publicClient.simulateContract({ address: addr, abi, functionName, args, value, account: wallet.address });
    const data = encodeFunctionData({ abi, functionName, args });
    const receipt = await wallet.send({ to: addr, data, value });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${receipt.hash})`);
    const events = parseEventLogs({ abi, logs: receipt.logs });
    return { receipt, events, trade: events.find((e) => e.eventName === 'Trade')?.args };
  }

  const api = {
    address: addr,

    // ---- reads
    count: async () => Number(await read('marketCount')),
    get: async (id) => shapeMarket(id, await read('getMarket', [BigInt(id)])),
    async list({ from = 0, batch = 25 } = {}) {
      const n = await api.count();
      const out = [];
      for (let i = from; i < n; i += batch) {
        const ids = Array.from({ length: Math.min(batch, n - i) }, (_, k) => i + k);
        out.push(...(await Promise.all(ids.map((id) => api.get(id)))));
      }
      return out;
    },
    priceYes: (id) => read('priceYes', [BigInt(id)]),
    quoteBuy: (id, yes, amount) => read('quoteBuy', [BigInt(id), yes, amount]),
    quoteSell: (id, yes, shares) => read('quoteSell', [BigInt(id), yes, shares]),
    costForShares: (id, yes, shares) => read('costForShares', [BigInt(id), yes, shares]),
    async position(id, who) {
      const [yes, no, lp, , feesOwed] = await read('accounts', [BigInt(id), who]);
      const fees = await read('pendingFees', [BigInt(id), who]);
      return { yes, no, lp, fees: fees > feesOwed ? fees : feesOwed };
    },

    // ---- writes (slippage in basis points of the quote)
    async buy(wallet, id, yes, amount, { slippageBps = 300 } = {}) {
      const quote = await api.quoteBuy(id, yes, amount);
      const minShares = (quote * BigInt(10_000 - slippageBps)) / 10_000n;
      return write(wallet, 'buy', [BigInt(id), yes, minShares], amount);
    },
    async sell(wallet, id, yes, shares, { slippageBps = 300 } = {}) {
      const quote = await api.quoteSell(id, yes, shares);
      const minOut = (quote * BigInt(10_000 - slippageBps)) / 10_000n;
      return write(wallet, 'sell', [BigInt(id), yes, shares, minOut]);
    },
    redeem: (wallet, id) => write(wallet, 'redeem', [BigInt(id)]),
    addLiquidity: (wallet, id, amount) => write(wallet, 'addLiquidity', [BigInt(id)], amount),
    removeLiquidity: (wallet, id, lp) => write(wallet, 'removeLiquidity', [BigInt(id), lp]),
    claimFees: (wallet, id) => write(wallet, 'claimFees', [BigInt(id)]),

    /** Open a market. `m` is an entry from contracts/markets/examples.json, or the same fields. */
    async create(wallet, m) {
      const closeTime = m.close_minutes
        ? Math.floor(Date.now() / 1000) + m.close_minutes * 60
        : Math.floor(new Date(m.close_time).getTime() / 1000);
      const r = await write(wallet, 'createMarket', [
        m.question, m.series, BigInt(m.threshold), m.is_above, BigInt(closeTime),
        m.fee_bps ?? 100, m.prior_yes_bps ?? 5_000,
      ], parseMon(m.seed_mon ?? 0.2));
      r.id = r.events.find((e) => e.eventName === 'MarketCreated').args.id;
      return r;
    },

    /**
     * Size a hedge. A delay of `delayDays` costs `costPerDayPct`% of cargo value per day
     * (Hummels & Schaur: 0.6 to 2.1). Cover that loss with YES shares, each paying 1 MON.
     * `usdPerMon` is the demo exchange rate.
     */
    async hedge(id, { cargoUsd, delayDays, costPerDayPct = 1.2, usdPerMon = 1000 }) {
      const lossUsd = cargoUsd * delayDays * (costPerDayPct / 100);
      const shares = parseMon((lossUsd / usdPerMon).toFixed(18));
      const cost = await api.costForShares(id, true, shares);
      const price = await api.priceYes(id);
      return {
        lossUsd,
        coverMon: shares,
        costMon: cost,
        premium: Number((cost * 10_000n) / shares) / 10_000, // cost per unit of cover
        probYes: toProb(price),
      };
    },
  };
  return api;
}
