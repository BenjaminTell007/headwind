// Shared setup for the Node scripts: settings from the environment or PRIVATE.md, viem clients.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MARKETS_ABI, FAUCET_ABI } from '../../web/chain/abi.js';

export const CONTRACTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(CONTRACTS, '..');

/** KEY=VALUE from the environment, else from PRIVATE.md in the repo root (never committed). */
export function setting(name, fallback) {
  if (process.env[name]) return process.env[name];
  const file = path.join(ROOT, 'PRIVATE.md');
  if (existsSync(file)) {
    const m = readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm'));
    if (m) return m[1];
  }
  return fallback;
}

export const RPC = setting('MONAD_RPC_URL', 'https://testnet-rpc.monad.xyz');
export const chain = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
export const marketsAbi = parseAbi(MARKETS_ABI);
export const faucetAbi = parseAbi(FAUCET_ABI);
export const publicClient = createPublicClient({ chain, transport: http(RPC) });

export function signer() {
  const key = setting('DEPLOYER_PRIVATE_KEY');
  if (!key) throw new Error('Set DEPLOYER_PRIVATE_KEY in your shell or in PRIVATE.md');
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  return { account, wallet: createWalletClient({ account, chain, transport: http(RPC) }) };
}

export function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
