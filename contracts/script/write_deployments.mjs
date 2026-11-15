// After `forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast`, write the
// addresses (and ABIs, if forge built them) to contracts/deployments.json for the page and server.
//
//   node script/write_deployments.mjs
//   node script/write_deployments.mjs --markets 0x... --faucet 0x...   (if deployed another way)
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CONTRACTS, chain, publicClient, readJson } from './env.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

let markets = arg('markets');
let faucet = arg('faucet');
let deployer;

const run = path.join(CONTRACTS, 'broadcast', 'Deploy.s.sol', String(chain.id), 'run-latest.json');
if ((!markets || !faucet) && existsSync(run)) {
  const r = readJson(run);
  for (const tx of r.transactions) {
    if (tx.transactionType !== 'CREATE') continue;
    if (tx.contractName === 'Markets') markets ??= tx.contractAddress;
    if (tx.contractName === 'Faucet') faucet ??= tx.contractAddress;
    deployer ??= tx.transaction?.from;
  }
}
if (!markets || !faucet) {
  console.error(`No addresses: deploy first, or pass --markets and --faucet. Looked in ${run}`);
  process.exit(1);
}

for (const [name, addr] of [['Markets', markets], ['Faucet', faucet]]) {
  const code = await publicClient.getCode({ address: addr });
  if (!code || code === '0x') {
    console.error(`${name} at ${addr} has no code on chain ${chain.id}`);
    process.exit(1);
  }
}

const abiOf = (name) => {
  const p = path.join(CONTRACTS, 'out', `${name}.sol`, `${name}.json`);
  return existsSync(p) ? readJson(p).abi : undefined;
};

const doc = {
  chainId: chain.id,
  network: 'monad-testnet',
  rpc: 'https://testnet-rpc.monad.xyz',
  explorer: 'https://testnet.monadvision.com',
  deployedAt: new Date().toISOString(),
  deployer,
  markets: { address: markets, abi: abiOf('Markets') },
  faucet: { address: faucet, abi: abiOf('Faucet') },
};
writeFileSync(path.join(CONTRACTS, 'deployments.json'), JSON.stringify(doc, null, 1) + '\n');
console.log(`Wrote contracts/deployments.json  Markets ${markets}  Faucet ${faucet}`);
