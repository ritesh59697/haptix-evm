// SAMPLE DATA for design work only: open the dev server with ?sample=1.
// The real wallet builds a WalletState from the chain in src/wallet.tsx.

export type Approver = 'agent' | 'you' | 'both';

export interface Asset {
  symbol: string;
  name: string;
  amount: number;
  /** Decimals to display. */
  decimals: number;
  /** ERC-20s only: the contract and its on-chain decimals. */
  address?: `0x${string}`;
  unitDecimals?: number;
}
export interface Agent {
  id: string;
  name: string;
  scope: string;
  token: string;
  spent24h: number;
  budget24h: number;
  endsInDays: number;
  resetsInHours: number;
  /** Real agents only: the agent key's address and whether the contract still lets it spend. */
  address?: string;
  status?: 'active' | 'revoked' | 'expired';
}
export interface KeyInfo { label: string; kind: 'touchid' | 'security-key' | 'phone'; synced: boolean }
export interface ActivityItem {
  id: string;
  title: string;
  detail: string;
  amount: string;
  approver: Approver;
  ts: number;
  txHash?: string;
  /** pending: submitted to the bundler, no receipt seen yet. */
  status?: 'pending' | 'ok' | 'failed';
}

export type Request =
  | { id: string; kind: 'send-both-keys'; to: string; amount: number; token: string; firstKeySigned: boolean }
  | { id: string; kind: 'agent-over-budget'; agentId: string; give: number; giveToken: string; getToken: string; contract: string }
  | { id: string; kind: 'dapp-approval'; site: string; token: string; spender: string; requested: 'unlimited' | number; balance: number };

export interface WalletState {
  account: string;
  assets: Asset[];
  /** Above perSend, a send needs both keys. daily is the optional rolling 24h cap. */
  limit: { token: string; perSend: number; daily: { spent: number; cap: number } | null };
  balanceHistory: number[];
  agents: Agent[];
  keys: KeyInfo[];
  guardian: string | null;
  recoveryWaitHours: number | null;
  /** Shortest recovery wait the contract accepts. */
  minRecoveryWaitHours: number;
  /** While frozen every send needs both keys and agents can't spend. */
  frozen: boolean;
  /** isValidSignature's format: 2 needs both keys for anything but personal_sign; 1 is the earlier factory's one-key rule. */
  signatureVersion: number;
  /** A recovery the guardian started. ours: it would install this device's keys. */
  pendingRecovery: { executeAfter: number; ours: boolean } | null;
  deployed: boolean;
  activity: ActivityItem[];
  requests: Request[];
}

export const sample: WalletState = {
  account: '0x3f2a8c41e09b7d5a6f13c2e8b4d90a7e5c1291c4',
  assets: [
    { symbol: 'ETH', name: 'Ether', amount: 0.421, decimals: 4 },
    { symbol: 'USDC', name: 'USD Coin', amount: 25, decimals: 2 },
  ],
  limit: { token: 'ETH', perSend: 0.5, daily: { spent: 0.12, cap: 0.5 } },
  deployed: true,
  balanceHistory: [0.31, 0.32, 0.30, 0.33, 0.33, 0.36, 0.35, 0.37, 0.36, 0.38, 0.37, 0.40, 0.38, 0.41, 0.40, 0.42, 0.41, 0.43, 0.421],
  agents: [
    { id: 'a1', name: 'Rebalancer', scope: 'Swaps only · 2 contracts', token: 'ETH', spent24h: 0.021, budget24h: 0.05, endsInDays: 6, resetsInHours: 14 },
    { id: 'a2', name: 'Bill payer', scope: 'Transfers · 1 recipient', token: 'USDC', spent24h: 10, budget24h: 10, endsInDays: 23, resetsInHours: 9 },
  ],
  keys: [
    { label: 'Touch ID', kind: 'touchid', synced: true },
    { label: 'Security key', kind: 'security-key', synced: false },
  ],
  guardian: '0x7c4d19b2f0e83a6c5d7e1f2a9b3c4d5e6f70a0e1',
  recoveryWaitHours: 48,
  minRecoveryWaitHours: 24,
  frozen: false,
  signatureVersion: 2,
  pendingRecovery: null,
  activity: [
    { id: 't1', title: 'Swap', detail: 'Rebalancer', amount: '−0.012 ETH', approver: 'agent', ts: Date.now() - 2 * 3600_000 },
    { id: 't2', title: 'Sent', detail: '0x8b1e…22af', amount: '−0.12 ETH', approver: 'you', ts: Date.now() - 5 * 3600_000 },
    { id: 't3', title: 'Paid bill', detail: 'Bill payer', amount: '−10.00 USDC', approver: 'agent', ts: Date.now() - 9 * 3600_000 },
    { id: 't4', title: 'Sent', detail: '0x51c0…7e3d', amount: '−0.80 ETH', approver: 'both', ts: Date.now() - 26 * 3600_000 },
    { id: 't5', title: 'Received', detail: '0x9a03…41bb', amount: '+1.00 ETH', approver: 'you', ts: Date.now() - 72 * 3600_000 },
  ],
  requests: [
    { id: 'r1', kind: 'send-both-keys', to: '0x8b1e5f02c4a9d7e36b1f0c8a2d4e6f8a0b2c22af', amount: 1.5, token: 'ETH', firstKeySigned: true },
    { id: 'r2', kind: 'agent-over-budget', agentId: 'a1', give: 0.08, giveToken: 'ETH', getToken: 'USDC', contract: '0x51c0a3e9b2d4f6a8c0e2b4d6f8a0c2e4b6d87e3d' },
    { id: 'r3', kind: 'dapp-approval', site: 'swap.example.xyz', token: 'USDC', spender: '0xa4f90c2e8b6d4f2a0c8e6b4d2f0a8c6e4b2d0b12', requested: 'unlimited', balance: 25 },
  ],
};
