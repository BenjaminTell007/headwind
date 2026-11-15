// Contract helpers the page calls. Reads go straight to the chain; writes go through a wallet
// from wallet.js. Amounts are bigint wei (1 MON = 10n ** 18n); use parseMon/formatMon at the edges.
//
// The hedge flow (a trade manager covering a shipment):
//   const q = await requestQuote({ ship: 'COSCO SAGITTARIUS', port: 'Rotterdam', deadline, cargoUsd: 500_000 });
//   q.model.p_yes, q.hedge.cover_mon                     // what the model says, before paying anything
//   const m = await markets();
//   const r = await m.create(wallet, q, { buyYes: true, stake: parseMon('0.2') });   // open + hedge, one tx
//
// Everyone else:
//   await m.list()                                        // every market with odds
//   await m.buy(wallet, id, true, parseMon('0.01'))       // trade
//   await m.vault.deposit(wallet, parseMon('5'))          // underwrite
import {
  parseAbi, encodeFunctionData, parseEventLogs, formatEther, parseEther,
  BaseError, ContractFunctionRevertedError,
} from './lib.js';
import { MARKETS_ABI, ERROR_TEXT, OUTCOME } from './abi.js';
import { loadDeployments, SERVER } from './config.js';
import { publicClient } from './wallet.js';

export { OUTCOME };
export const abi = parseAbi(MARKETS_ABI);
const WAD = 10n ** 18n;

export const parseMon = (s) => parseEther(String(s));
export const formatMon = (wei, digits = 4) => Number(formatEther(wei)).toFixed(digits);
/** priceYes (1e18 = 100%) as a number from 0 to 1. */
export const toProb = (p) => Number((p * 10_000n) / WAD) / 10_000;

/** What a market is about, from its series string. */
export function describeSeries(series) {
  const [kind, a, b, c] = series.split(':');
  if (kind === 'arrival') return { kind, ship: a, port: b };
  if (kind === 'gate') return { kind: 'live', gate: a, window: b };
  if (kind === 'portwatch') return { kind: 'strait', strait: a, measure: b };
  if (kind === 'route_efficiency') return { kind: 'route', corridor: a, measure: b };
  if (kind === 'comtrade') return { kind: 'trade', partner: c, measure: b };
  return { kind };
}

function shapeMarket(id, m) {
  const pool = m.yesReserve + m.noReserve;
  const priceYes = pool === 0n ? 0n : (m.noReserve * WAD) / pool;
  const now = Date.now() / 1000;
  return {
    id: BigInt(id),
    question: m.question,
    series: m.series,
    about: describeSeries(m.series),
    subject: m.subject,
    threshold: m.threshold, // for arrivals: the deadline, unix seconds
    isAbove: m.isAbove,
    closeTime: Number(m.closeTime),
    resolveBy: Number(m.resolveBy),
    feeBps: Number(m.feeBps),
    creator: m.creator,
    outcome: Number(m.outcome), // OUTCOME.OPEN / YES / NO / INVALID
    resolved: Number(m.outcome) !== OUTCOME.OPEN,
    value: m.value,
    yesReserve: m.yesReserve,
    noReserve: m.noReserve,
    lpSupply: m.lpSupply,
    collateral: m.collateral,
    maxCollateral: m.maxCollateral,
    vaultSeed: m.vaultSeed,
    vaultSettled: m.vaultSettled,
    priceYes,
    probYes: toProb(priceYes),
    open: Number(m.outcome) === OUTCOME.OPEN && now < Number(m.closeTime),
  };
}

/**
 * Find the onchain market for a page market. Use this instead of matching on `series` alone:
 * several markets share a series (Suez weekly total and Suez collapse are both
 * `portwatch:Suez Canal:weekly_transits`; every Singapore live window is `gate:singapore:30min`).
 *
 * Matches the question exactly first, then falls back to the series. Among several matches it
 * prefers an open market, then the newest (highest id), so a rolling live market finds this
 * window's market, not last window's.
 *
 *   const onchain = await m.list();
 *   for (const card of cards) { const c = findMarket(onchain, card); if (c) { card.chainId = c.id; card.probYes = c.probYes; } }
 */
export function findMarket(onchain, { question, series } = {}) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const best = (xs) => xs.sort((a, b) => (b.open - a.open) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0))[0];
  const byQuestion = question ? onchain.filter((x) => norm(x.question) === norm(question)) : [];
  if (byQuestion.length) return best(byQuestion);
  // Series alone is only safe when the question was not given or has no onchain match,
  // and then only among markets that are still open.
  const bySeries = series ? onchain.filter((x) => x.series === series && x.open) : [];
  return bySeries.length === 1 ? bySeries[0] : bySeries.length ? best(bySeries) : undefined;
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

/**
 * Ask the pricing server for a signed quote. Body for an arrival market:
 *   { ship: name|IMO|MMSI, port: name|LOCODE, deadline: ISO time, cargoUsd?: number }
 * Returns { quote, signature, model, hedge? } (see contracts/pricing/quote.py).
 */
export async function requestQuote(body) {
  const res = await fetch(`${SERVER}/api/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, deadline: body.deadline instanceof Date ? body.deadline.toISOString() : body.deadline }),
  });
  if (!res.ok) throw new Error(`quote failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Quote JSON (numbers as strings) -> the tuple createMarket takes. */
function quoteArgs(q) {
  return {
    question: q.question,
    series: q.series,
    subject: q.subject,
    threshold: BigInt(q.threshold),
    isAbove: q.isAbove === true || q.isAbove === 'true',
    closeTime: BigInt(q.closeTime),
    resolveBy: BigInt(q.resolveBy),
    feeBps: Number(q.feeBps),
    priorYesBps: Number(q.priorYesBps),
    seed: BigInt(q.seed),
    maxCollateral: BigInt(q.maxCollateral),
    creationFee: BigInt(q.creationFee),
    expiry: BigInt(q.expiry),
    quoteId: q.quoteId,
  };
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
      const [yes, no, lp] = await read('accounts', [BigInt(id), who]);
      const fees = await read('pendingFees', [BigInt(id), who]);
      return { yes, no, lp, fees };
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
    /** Anyone can call a market invalid once its resolveBy has passed without a settlement. */
    resolveInvalid: (wallet, id) => write(wallet, 'resolveInvalid', [BigInt(id)]),

    /**
     * Open a market from a signed quote. With `stake`, buy a side in the same transaction
     * (a hedger buys YES = late). The vault seeds the pool at the quoted price.
     */
    async create(wallet, signed, { buyYes = true, stake = 0n, minShares = 0n } = {}) {
      const q = quoteArgs(signed.quote);
      const r = await write(wallet, 'createMarket', [q, signed.signature, buyYes, minShares], q.creationFee + stake);
      r.id = r.events.find((e) => e.eventName === 'MarketCreated').args.id;
      return r;
    },

    /**
     * Size a hedge on an open market. A delay of `delayDays` costs `costPerDayPct`% of cargo value
     * per day (Hummels & Schaur: 0.6 to 2.1; the quote's model gives one from the Comtrade cargo mix).
     * Cover that loss with YES shares, each paying 1 MON. `usdPerMon` is the demo exchange rate.
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

    // ---- the underwriter vault
    vault: {
      async info(who) {
        const [value, idle, deployed, total, mine, cap] = await Promise.all([
          read('vaultValue'), read('vaultIdle'), read('vaultDeployed'), read('vaultTotalShares'),
          who ? read('vaultShares', [who]) : Promise.resolve(0n), read('subjectCap'),
        ]);
        return { value, idle, deployed, totalShares: total, myShares: mine,
                 myValue: total === 0n ? 0n : (mine * value) / total, subjectCap: cap };
      },
      deposit: (wallet, amount) => write(wallet, 'deposit', [], amount),
      withdraw: (wallet, shares) => write(wallet, 'withdraw', [shares]),
      /** After a market settles: move the vault's share back into the vault. Anyone can call. */
      settle: (wallet, id) => write(wallet, 'settleVault', [BigInt(id)]),
      exposure: (subject) => read('subjectExposure', [subject]),
    },
  };
  return api;
}
