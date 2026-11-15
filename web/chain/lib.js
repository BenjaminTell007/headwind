// The one place viem is loaded from. Pinned version, ESM build from jsDelivr.
// Node scripts and tests swap this file for `export * from 'viem'; export * from 'viem/accounts'`.
export * from 'https://cdn.jsdelivr.net/npm/viem@2.21.0/+esm';
export { generatePrivateKey, privateKeyToAccount } from 'https://cdn.jsdelivr.net/npm/viem@2.21.0/accounts/+esm';
