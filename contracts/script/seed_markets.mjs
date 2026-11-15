// TEST TOOL. On the demo deployment, the server's keeper (server/keeper.py) is the only thing that
// opens markets (CHAIN_SERVER.md item 2), so this refuses to --send there without --force.
// Point it at a scratch deployment with --deployments path/to/deployments.json instead.
//
// Open the example markets from contracts/markets/examples.json on Monad.
// Each gets a quote signed with the pricer key (as the server's /api/quote would), and the
// vault seeds it. Dry run by default: prints what it would open and what it costs. Add --send.
//
//   node script/seed_markets.mjs                      # dry run, featured markets
//   node script/seed_markets.mjs --groups all --send  # open all of them
//   node script/seed_markets.mjs --groups live,collapse --send
//   node script/seed_markets.mjs --only live_singapore --send
//
// Groups: featured, all, weekly, collapse, vessel, route, trade, live.
// Ship-arrival markets aren't in examples.json: they're quoted live from a ship's position
// (contracts/pricing/quote.py, served as POST /api/quote).
// Needs DEPLOYER_PRIVATE_KEY (sends) and PRICER_PRIVATE_KEY (signs quotes), in the env or PRIVATE.md.
// Records what it opened in contracts/markets/created.json, and skips those on a rerun.
import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { encodeFunctionData, formatEther, parseEther, parseEventLogs, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, chain, publicClient, marketsAbi, signer, setting, readJson } from './env.mjs';
import { QUOTE_DOMAIN, QUOTE_TYPES } from '../../web/chain/abi.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const SEND = args.includes('--send');
const groups = opt('groups', 'featured').split(',');
const only = opt('only');
const FORCE = args.includes('--force');
const DEMO_DEPLOYMENTS = path.join(CONTRACTS, 'deployments.json'); // what the server and page use
const GAS_MARGIN = 112n; // percent: Monad charges the full gas limit, keep it tight
// Same policy as contracts/pricing/quote.py
const POLICY = {
  weekly: { maxCollateral: 20, creationFee: 0.01, graceH: 24 * 14 },
  trade: { maxCollateral: 20, creationFee: 0.01, graceH: 24 * 30 },
  live: { maxCollateral: 5, creationFee: 0, graceH: 2 },
};

const examples = readJson(path.join(CONTRACTS, 'markets', 'examples.json')).markets;
const createdPath = path.join(CONTRACTS, 'markets', 'created.json');
const created = existsSync(createdPath) ? readJson(createdPath) : {};
const deploymentsPath = path.resolve(opt('deployments', DEMO_DEPLOYMENTS));
const deployments = existsSync(deploymentsPath) ? readJson(deploymentsPath) : undefined;
const onDemo = deploymentsPath === DEMO_DEPLOYMENTS;

const now = Math.floor(Date.now() / 1000);
const closeOf = (m) => (m.close_minutes ? now + m.close_minutes * 60 : Math.floor(Date.parse(m.close_time) / 1000));

function quoteFor(m) {
  const kind = m.group === 'live' ? 'live' : m.group === 'trade' ? 'trade' : 'weekly';
  const pol = POLICY[kind];
  const close = closeOf(m);
  return {
    question: m.question,
    series: m.series,
    subject: keccak256(toHex(m.series.split(':').slice(0, 2).join(':'))), // one cap per strait/route/partner/gate
    threshold: BigInt(m.threshold),
    isAbove: m.is_above,
    closeTime: BigInt(close),
    resolveBy: BigInt(close + pol.graceH * 3600),
    feeBps: m.fee_bps,
    priorYesBps: m.prior_yes_bps,
    seed: parseEther(String(m.seed_mon)),
    maxCollateral: parseEther(String(pol.maxCollateral)),
    creationFee: parseEther(String(pol.creationFee)),
    expiry: BigInt(now + 600),
    quoteId: toHex(randomBytes(32)),
  };
}

const picked = examples.filter((m) => {
  if (only) return only.split(',').includes(m.id);
  return groups.includes('all') || groups.includes(m.group) || (groups.includes('featured') && m.featured);
});

const plan = [];
for (const m of picked) {
  const prev = created[m.id];
  if (prev && prev.closeTime > now) { console.log(`skip  ${m.id}: already open as #${prev.marketId}`); continue; }
  if (closeOf(m) <= now + 60) { console.log(`skip  ${m.id}: closes ${m.close_time}, too late to open`); continue; }
  plan.push(m);
}

const seedTotal = plan.reduce((s, m) => s + parseEther(String(m.seed_mon)), 0n);
const feeTotal = plan.reduce((s, m) => s + quoteFor(m).creationFee, 0n);
const gasPrice = await publicClient.getGasPrice();
const gasEach = 550_000n; // createMarket measured at ~475k gas (forge --gas-report), with margin
console.log(`\n${plan.length} markets to open on chain ${chain.id}`);
for (const m of plan) {
  console.log(`  ${m.group.padEnd(8)} ${String(m.seed_mon).padStart(4)} MON  ${(m.prior_yes_bps / 100).toFixed(0).padStart(3)}%  ${m.question}`);
}
console.log(`Vault seeds ${formatEther(seedTotal)} MON (from the vault, not your wallet)`);
console.log(`Your wallet: creation fees ${formatEther(feeTotal)} MON + gas about ${formatEther(gasEach * gasPrice * BigInt(plan.length))} MON at ${Number(gasPrice) / 1e9} gwei`);

if (!SEND) { console.log('\nDry run. Add --send to open them.'); process.exit(0); }
if (!deployments) { console.error(`No deployments file at ${deploymentsPath}. Deploy, then run script/write_deployments.mjs`); process.exit(1); }
if (onDemo && !FORCE) {
  console.error(`Refusing: ${deployments.markets.address} is the demo deployment, where the server's keeper opens markets.
Opening them here too would make duplicates. Use --deployments <scratch deployments.json>, or add --force if you really mean it.`);
  process.exit(1);
}

const address = deployments.markets.address;
const pricerKey = setting('PRICER_PRIVATE_KEY');
if (!pricerKey) { console.error('Set PRICER_PRIVATE_KEY (the key whose address the contract has as pricer)'); process.exit(1); }
const pricer = privateKeyToAccount(pricerKey.startsWith('0x') ? pricerKey : `0x${pricerKey}`);
const onchainPricer = await publicClient.readContract({ address, abi: marketsAbi, functionName: 'pricer' });
if (onchainPricer.toLowerCase() !== pricer.address.toLowerCase()) {
  console.error(`PRICER_PRIVATE_KEY is ${pricer.address} but the contract's pricer is ${onchainPricer}`);
  process.exit(1);
}
const idle = await publicClient.readContract({ address, abi: marketsAbi, functionName: 'vaultIdle' });
if (idle < seedTotal) console.warn(`Vault has ${formatEther(idle)} MON free, seeds need ${formatEther(seedTotal)}: some will fail. Deposit more with deposit().`);

const { account, wallet } = signer();
let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
for (const m of plan) {
  const q = quoteFor(m);
  try {
    const sig = await pricer.signTypedData({
      domain: { ...QUOTE_DOMAIN, chainId: chain.id, verifyingContract: address },
      types: QUOTE_TYPES, primaryType: 'Quote', message: q,
    });
    const callArgs = [q, sig, true, 0n];
    const value = q.creationFee;
    await publicClient.simulateContract({ address, abi: marketsAbi, functionName: 'createMarket', args: callArgs, value, account });
    const data = encodeFunctionData({ abi: marketsAbi, functionName: 'createMarket', args: callArgs });
    const gas = ((await publicClient.estimateGas({ account, to: address, data, value })) * GAS_MARGIN) / 100n;
    const hash = await wallet.sendTransaction({ to: address, data, value, gas, nonce });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    nonce += 1;
    if (receipt.status !== 'success') throw new Error(`reverted ${hash}`);
    const ev = parseEventLogs({ abi: marketsAbi, logs: receipt.logs, eventName: 'MarketCreated' })[0];
    created[m.id] = { marketId: Number(ev.args.id), closeTime: Number(q.closeTime), tx: hash, gasUsed: Number(receipt.gasUsed), openedAt: new Date().toISOString() };
    writeFileSync(createdPath, JSON.stringify(created, null, 1) + '\n');
    console.log(`open  #${ev.args.id} ${m.id}  gas ${receipt.gasUsed}/${gas}`);
  } catch (e) {
    nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    console.error(`fail  ${m.id}: ${e.shortMessage || e.message}`);
  }
}
