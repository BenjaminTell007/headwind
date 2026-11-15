// Network and addresses. Monad testnet unless the page overrides it.
import { defineChain } from './lib.js';

export const SERVER = 'https://headway-production-83bb4bd7.up.railway.app';

export const RPC_HTTP = 'https://testnet-rpc.monad.xyz';
export const RPC_WS = 'wss://testnet-rpc.monad.xyz';
export const EXPLORER = 'https://testnet.monadvision.com';

export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_HTTP], webSocket: [RPC_WS] } },
  blockExplorers: { default: { name: 'MonadVision', url: EXPLORER } },
  testnet: true,
});

// Gas: Monad charges the full gas limit, not gas used. We estimate each call and add this margin.
export const GAS_MARGIN_BPS = 1_200; // +12%
// A burner below this asks the faucet for more gas. Testnet base fee was ~100 gwei on Nov 15,
// so one trade costs ~0.012 MON in gas; this is about two trades' worth.
export const MIN_GAS_BALANCE = 3n * 10n ** 16n; // 0.03 MON

let deployments;
/** Addresses from contracts/deployments.json (written after `forge script ... --broadcast`). */
export async function loadDeployments() {
  if (deployments) return deployments;
  const url = new URL('../../contracts/deployments.json', import.meta.url);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('contracts/deployments.json not found: deploy the contracts first');
  deployments = await res.json();
  return deployments;
}

export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (addr) => `${EXPLORER}/address/${addr}`;
