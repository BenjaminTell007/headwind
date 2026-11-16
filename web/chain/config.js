// Network and addresses. Monad testnet unless the page overrides it.
import { defineChain } from './lib.js';

export const SERVER = 'https://headway-production-83bb4bd7.up.railway.app';

export const RPC_HTTP = 'https://testnet-rpc.monad.xyz';
export const RPC_WS = 'wss://testnet-rpc.monad.xyz';
// Backups, tried in order when one answers 429 (rate limited) or fails. A room full of people on one
// wifi shares one IP, and the public endpoints limit per IP. All three checked on Nov 15 (chain 10143).
export const RPC_HTTP_LIST = [RPC_HTTP, 'https://rpc-testnet.monadinfra.com', 'https://rpc.ankr.com/monad_testnet'];
export const RPC_WS_LIST = [RPC_WS, 'wss://rpc-testnet.monadinfra.com'];
// Multicall3 at its usual address (code present on Monad testnet): many reads become one request.
export const EXPLORER = 'https://testnet.monadvision.com';

export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: RPC_HTTP_LIST, webSocket: RPC_WS_LIST } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  blockExplorers: { default: { name: 'MonadVision', url: EXPLORER } },
  testnet: true,
});

// Gas: Monad charges the full gas limit, not gas used. We estimate each call and add this margin.
export const GAS_MARGIN_BPS = 1_200; // +12%
// A burner below this asks the faucet for more gas. Testnet base fee was ~100 gwei on Nov 15,
// so one trade (~66k gas) costs ~0.007 MON; this keeps room for a few trades.
export const MIN_GAS_BALANCE = 3n * 10n ** 16n; // 0.03 MON

/** Contract addresses, from deployments.js (written by contracts/script/write_deployments.mjs). */
export async function loadDeployments() {
  const { DEPLOYMENTS } = await import('./deployments.js');
  if (!DEPLOYMENTS?.markets?.address) throw new Error('Contracts not deployed yet: run contracts/script/write_deployments.mjs');
  return DEPLOYMENTS;
}

export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (addr) => `${EXPLORER}/address/${addr}`;
