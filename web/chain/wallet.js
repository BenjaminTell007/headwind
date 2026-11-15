// Wallets: a burner key kept in this browser (default, no extension needed),
// or an injected wallet like MetaMask for anyone with real testnet MON.
//
//   const w = await getWallet();           // burner, funded from the faucet if empty
//   const w = await getWallet({ prefer: 'injected' });
//   w.address, await w.balance(), await w.send({ to, data, value })
import {
  createPublicClient, createWalletClient, custom, http, fallback, keccak256,
  generatePrivateKey, privateKeyToAccount,
} from './lib.js';
import { monadTestnet, RPC_HTTP_LIST, SERVER, GAS_MARGIN_BPS, MIN_GAS_BALANCE } from './config.js';

const STORAGE_KEY = 'headway.burner.v1';

// Reads go out as few requests as possible: contract reads issued together are bundled into one
// Multicall3 call, and plain RPC calls into one JSON-RPC batch. If an endpoint rate-limits (429) or
// fails, the next one in RPC_HTTP_LIST takes over, with a retry and backoff on each.
export const publicClient = createPublicClient({
  chain: monadTestnet,
  batch: { multicall: { wait: 16 } },
  transport: fallback(
    RPC_HTTP_LIST.map((url) => http(url, { batch: { wait: 16 }, retryCount: 0, timeout: 8_000 })),
    { rank: false, retryCount: 2, retryDelay: 300 },
  ),
});

// ------------------------------------------------------------------ storage

let memoryKey; // used when localStorage is blocked (private window, previews)
function loadKey() {
  try {
    const k = localStorage.getItem(STORAGE_KEY);
    if (k) return k;
  } catch {}
  return memoryKey;
}
function saveKey(k) {
  memoryKey = k;
  try { localStorage.setItem(STORAGE_KEY, k); } catch {}
}
export function forgetBurner() {
  memoryKey = undefined;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// ------------------------------------------------------------------ helpers

async function gasFor(from, tx) {
  // Monad bills the whole gas limit, so keep it tight: estimate, plus a small margin.
  const est = await publicClient.estimateGas({ account: from, ...tx });
  return (est * BigInt(10_000 + GAS_MARGIN_BPS)) / 10_000n;
}

function normalizeReceipt(r) {
  const ok = r.status === 'success' || r.status === '0x1' || r.status === 1;
  return {
    hash: r.transactionHash,
    status: ok ? 'success' : 'reverted',
    blockNumber: typeof r.blockNumber === 'bigint' ? r.blockNumber : BigInt(r.blockNumber),
    gasUsed: typeof r.gasUsed === 'bigint' ? r.gasUsed : BigInt(r.gasUsed),
    logs: r.logs,
  };
}

// Errors that mean the transaction itself is bad, so retrying another way won't help.
const FATAL = /nonce|insufficient|underpriced|intrinsic gas|exceeds|revert/i;

let syncSupported = true;
async function sendRaw(raw) {
  const hash = keccak256(raw);
  // eth_sendRawTransactionSync returns the receipt in the same round trip on Monad.
  if (syncSupported) {
    try {
      const r = await publicClient.request({ method: 'eth_sendRawTransactionSync', params: [raw] });
      if (r && r.transactionHash) return normalizeReceipt(r);
    } catch (e) {
      const msg = String(e?.details || e?.message || e);
      if (FATAL.test(msg)) throw e;
      if (/not (found|supported|available)|does not exist|unknown method/i.test(msg)) syncSupported = false;
      // Anything else (timeouts, "screening unavailable"): fall through to the async path.
    }
  }
  try {
    await publicClient.sendRawTransaction({ serializedTransaction: raw });
  } catch (e) {
    // The sync call may already have delivered it; then we just wait for the receipt.
    if (!/already known|known transaction|already imported/i.test(String(e?.details || e?.message || e))) throw e;
  }
  return normalizeReceipt(await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 }));
}

// ------------------------------------------------------------------ burner

export function burnerWallet() {
  let key = loadKey();
  if (!key) { key = generatePrivateKey(); saveKey(key); }
  const account = privateKeyToAccount(key);

  // One transaction at a time with a locally tracked nonce. Monad has no global mempool and
  // validates asynchronously, so a nonce gap can be accepted and then fail; a queue avoids that.
  let nonce;
  let queue = Promise.resolve();

  async function sendNow({ to, data, value = 0n, gas }) {
    if (nonce === undefined) nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const [fees, limit] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      gas ? Promise.resolve(gas) : gasFor(account.address, { to, data, value }),
    ]);
    const raw = await account.signTransaction({
      chainId: monadTestnet.id, type: 'eip1559', to, data, value, nonce,
      gas: limit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    try {
      const receipt = await sendRaw(raw);
      nonce += 1;
      return receipt;
    } catch (e) {
      nonce = undefined; // resync from the chain next time
      throw e;
    }
  }

  return {
    kind: 'burner',
    address: account.address,
    balance: () => publicClient.getBalance({ address: account.address }),
    send(tx) {
      const run = queue.then(() => sendNow(tx));
      queue = run.catch(() => {});
      return run;
    },
    /** The private key, for showing an "export wallet" option. Treat it like a password. */
    exportKey: () => key,
  };
}

// ------------------------------------------------------------------ injected (MetaMask etc.)

export const hasInjected = () => typeof window !== 'undefined' && !!window.ethereum;

export async function injectedWallet() {
  if (!hasInjected()) throw new Error('No browser wallet found');
  const client = createWalletClient({ chain: monadTestnet, transport: custom(window.ethereum) });
  const [address] = await client.requestAddresses();
  try {
    await client.switchChain({ id: monadTestnet.id });
  } catch {
    await client.addChain({ chain: monadTestnet });
    await client.switchChain({ id: monadTestnet.id });
  }
  return {
    kind: 'injected',
    address,
    balance: () => publicClient.getBalance({ address }),
    async send({ to, data, value = 0n, gas }) {
      const limit = gas ?? (await gasFor(address, { to, data, value }));
      const hash = await client.sendTransaction({ account: address, chain: monadTestnet, to, data, value, gas: limit });
      return normalizeReceipt(await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 }));
    },
  };
}

// ------------------------------------------------------------------ gas from the faucet

/** Ask the server's faucet relayer for gas if the wallet is nearly empty. Returns true if funded. */
export async function ensureGas(wallet) {
  if ((await wallet.balance()) >= MIN_GAS_BALANCE) return true;
  try {
    const res = await fetch(`${SERVER}/api/faucet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: wallet.address }),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  for (let i = 0; i < 20; i++) { // drip lands within a few blocks
    if ((await wallet.balance()) > 0n) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** The default wallet: burner unless asked for the injected one. Tops up gas for burners. */
export async function getWallet({ prefer = 'burner', fund = true } = {}) {
  const w = prefer === 'injected' && hasInjected() ? await injectedWallet() : burnerWallet();
  if (fund && w.kind === 'burner') await ensureGas(w);
  return w;
}
