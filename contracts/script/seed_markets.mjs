// Open the example markets from contracts/markets/examples.json on Monad.
// Dry run by default: prints what it would open and what it costs. Add --send to do it.
//
//   node script/seed_markets.mjs                      # dry run, featured markets
//   node script/seed_markets.mjs --groups all --send  # open all 65
//   node script/seed_markets.mjs --groups live,collapse --send
//   node script/seed_markets.mjs --only live_singapore --send
//
// Groups: featured, all, weekly, collapse, vessel, route, trade, live.
// Records what it opened in contracts/markets/created.json (example id -> onchain market id),
// and skips markets already open there, so it is safe to rerun.
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { encodeFunctionData, parseEther, formatEther, parseEventLogs } from 'viem';
import { CONTRACTS, chain, publicClient, marketsAbi, signer, readJson } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const SEND = args.includes('--send');
const groups = opt('groups', 'featured').split(',');
const only = opt('only');
const GAS_MARGIN = 112n; // percent: Monad charges the full gas limit, keep it tight

const examples = readJson(path.join(CONTRACTS, 'markets', 'examples.json')).markets;
const createdPath = path.join(CONTRACTS, 'markets', 'created.json');
const created = existsSync(createdPath) ? readJson(createdPath) : {};
const deployments = existsSync(path.join(CONTRACTS, 'deployments.json'))
  ? readJson(path.join(CONTRACTS, 'deployments.json'))
  : undefined;

const now = Math.floor(Date.now() / 1000);
const closeOf = (m) => (m.close_minutes ? now + m.close_minutes * 60 : Math.floor(Date.parse(m.close_time) / 1000));

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
const gasPrice = await publicClient.getGasPrice();
const gasEach = 300_000n; // createMarket with two strings, upper estimate for the dry run
console.log(`\n${plan.length} markets to open on chain ${chain.id}`);
for (const m of plan) {
  console.log(`  ${m.group.padEnd(8)} ${String(m.seed_mon).padStart(4)} MON  ${(m.prior_yes_bps / 100).toFixed(0).padStart(3)}%  ${m.question}`);
}
console.log(`Seed ${formatEther(seedTotal)} MON + gas about ${formatEther(gasEach * gasPrice * BigInt(plan.length))} MON at ${Number(gasPrice) / 1e9} gwei`);

if (!SEND) { console.log('\nDry run. Add --send to open them.'); process.exit(0); }
if (!deployments) { console.error('No contracts/deployments.json. Deploy, then run script/write_deployments.mjs'); process.exit(1); }

const address = deployments.markets.address;
const { account, wallet } = signer();
const balance = await publicClient.getBalance({ address: account.address });
console.log(`\nSigner ${account.address}, balance ${formatEther(balance)} MON`);
if (balance < seedTotal) { console.error('Not enough MON for the seeds'); process.exit(1); }

let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
for (const m of plan) {
  const closeTime = closeOf(m);
  const callArgs = [m.question, m.series, BigInt(m.threshold), m.is_above, BigInt(closeTime), m.fee_bps, m.prior_yes_bps];
  const value = parseEther(String(m.seed_mon));
  try {
    await publicClient.simulateContract({ address, abi: marketsAbi, functionName: 'createMarket', args: callArgs, value, account });
    const data = encodeFunctionData({ abi: marketsAbi, functionName: 'createMarket', args: callArgs });
    const gas = ((await publicClient.estimateGas({ account, to: address, data, value })) * GAS_MARGIN) / 100n;
    const hash = await wallet.sendTransaction({ to: address, data, value, gas, nonce });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    nonce += 1;
    if (receipt.status !== 'success') throw new Error(`reverted ${hash}`);
    const ev = parseEventLogs({ abi: marketsAbi, logs: receipt.logs, eventName: 'MarketCreated' })[0];
    created[m.id] = { marketId: Number(ev.args.id), closeTime, tx: hash, gasUsed: Number(receipt.gasUsed), openedAt: new Date().toISOString() };
    writeFileSync(createdPath, JSON.stringify(created, null, 1) + '\n');
    console.log(`open  #${ev.args.id} ${m.id}  gas ${receipt.gasUsed}/${gas}`);
  } catch (e) {
    nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    console.error(`fail  ${m.id}: ${e.shortMessage || e.message}`);
  }
}
