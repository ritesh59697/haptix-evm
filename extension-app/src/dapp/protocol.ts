// Shared between the background worker and the wallet pages: what a site asked for,
// where it's queued, and how the answer gets back to the page.
import type { Address, Hex } from 'viem';

/** EIP-1193 provider error codes. */
export const ProviderError = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupported: 4200,
  unrecognizedChain: 4902,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface RpcErrorShape { code: number; message: string }

interface Base {
  id: string;
  /** From chrome's MessageSender, never from page data. */
  origin: string;
  tabId: number;
  windowId: number;
  createdAt: number;
}
export type DappRequest =
  | (Base & { kind: 'dapp-connect' })
  | (Base & { kind: 'dapp-tx'; tx: { to: Address; value: string; data: Hex } })
  /** personal_sign carries the raw message bytes; typed carries the EIP-712 JSON. */
  | (Base & { kind: 'dapp-sign'; method: 'personal_sign'; message: Hex })
  | (Base & { kind: 'dapp-sign'; method: 'eth_signTypedData_v4'; typedData: string });

/** Read-only calls a site may make; the background forwards them to the chain RPC unchanged. */
export const READ_METHODS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice', 'eth_getBalance',
  'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_getStorageAt',
  'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas',
  'net_version',
]);

/** Message the wallet page sends to the asking tab once the user decides. */
export const RESULT_MESSAGE = 'haptix:result';
/** Message the background sends to a tab when what it may see changes. */
export const EVENT_MESSAGE = 'haptix:event';
