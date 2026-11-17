// Freeze, guardian and recovery on PasskeyAccount.
//
// What the contract allows, and so what the wallet asks for:
//   freeze()                 one key (or the EntryPoint); while frozen every send needs both
//   unfreeze()               both keys
//   setGuardian(g, wait)     both keys; wait >= MIN_RECOVERY_TIMELOCK; cancels a pending recovery
//   cancelRecovery()         one key, or the guardian
//   initiateRecovery(keys)   the guardian only; refused while one is pending (the clock never restarts)
//   completeRecovery(keys)   anyone, after the wait, and not while frozen
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiParameters,
  zeroAddress, type Address, type Hex,
} from 'viem';
import { rpc } from './rpc';
import type { StoredKey } from './passkey';

const net = __HAPTIX_NETWORK__;

export const guardianAbi = parseAbi([
  'struct PublicKey { uint256 x; uint256 y; }',
  'function isFrozen() view returns (bool)',
  'function guardian() view returns (address)',
  'function recoveryTimelock() view returns (uint48)',
  'function MIN_RECOVERY_TIMELOCK() view returns (uint48)',
  'function pendingRecovery() view returns (uint48 executeAfter, bool active, bytes32 signersHash)',
  'function signerCount() view returns (uint256)',
  'function signers(uint256) view returns (uint256 x, uint256 y)',
  'function freeze()',
  'function unfreeze()',
  'function setGuardian(address newGuardian, uint48 timelock)',
  'function cancelRecovery()',
  'function initiateRecovery(PublicKey[] newSigners)',
  'function completeRecovery(PublicKey[] newSigners)',
]);

const call = async <T>(to: Address, functionName: string, args: unknown[] = []): Promise<T> => {
  const data = encodeFunctionData({ abi: guardianAbi, functionName: functionName as never, args: args as never });
  const out = await rpc<Hex>(net.rpcUrl, 'eth_call', [{ to, data }, 'latest']);
  return decodeFunctionResult({ abi: guardianAbi, functionName: functionName as never, data: out }) as T;
};

export interface SecurityState {
  frozen: boolean;
  guardian: Address | null;
  waitSeconds: number;
  minWaitSeconds: number;
  pending: { executeAfter: number; signersHash: Hex } | null;
}

const factoryAbi = parseAbi(['function accountImplementation() view returns (address)']);

/** The contract's minimum recovery wait, read from the factory's account implementation. */
async function minWaitFromImplementation(): Promise<number> {
  const out = await rpc<Hex>(net.rpcUrl, 'eth_call', [{ to: net.factory, data: encodeFunctionData({ abi: factoryAbi, functionName: 'accountImplementation' }) }, 'latest']);
  const impl = decodeFunctionResult({ abi: factoryAbi, functionName: 'accountImplementation', data: out });
  return Number(await call<number>(impl, 'MIN_RECOVERY_TIMELOCK'));
}

/** Freeze, guardian and recovery state. An account not on chain yet has none set. */
export async function readSecurity(account: Address, deployed: boolean): Promise<SecurityState> {
  if (!deployed) return { frozen: false, guardian: null, waitSeconds: 0, minWaitSeconds: await minWaitFromImplementation(), pending: null };
  const [frozen, guardian, wait, min, pending] = await Promise.all([
    call<boolean>(account, 'isFrozen'),
    call<Address>(account, 'guardian'),
    call<number>(account, 'recoveryTimelock'),
    call<number>(account, 'MIN_RECOVERY_TIMELOCK'),
    call<readonly [number, boolean, Hex]>(account, 'pendingRecovery'),
  ]);
  return {
    frozen,
    guardian: guardian === zeroAddress ? null : guardian,
    waitSeconds: Number(wait),
    minWaitSeconds: Number(min),
    pending: pending[1] ? { executeAfter: Number(pending[0]), signersHash: pending[2] } : null,
  };
}

/** The keys the account accepts right now, read from chain. */
export async function readSigners(account: Address): Promise<{ x: bigint; y: bigint }[]> {
  const n = Number(await call<bigint>(account, 'signerCount'));
  return Promise.all(Array.from({ length: n }, async (_, i) => {
    const [x, y] = await call<readonly [bigint, bigint]>(account, 'signers', [BigInt(i)]);
    return { x, y };
  }));
}

export const isDeployedAt = async (a: Address) => (await rpc<Hex>(net.rpcUrl, 'eth_getCode', [a, 'latest'])).length > 2;

const pubkeys = (keys: StoredKey[]) => keys.map((k) => ({ x: BigInt(k.x), y: BigInt(k.y) }));

/** keccak256(abi.encode(newSigners)), as the contract stores for a pending recovery. */
export const signersHash = (keys: StoredKey[]): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters('(uint256 x, uint256 y)[]'), [pubkeys(keys)]));

export const freezeCall = (): Hex => encodeFunctionData({ abi: guardianAbi, functionName: 'freeze' });
export const unfreezeCall = (): Hex => encodeFunctionData({ abi: guardianAbi, functionName: 'unfreeze' });
export const cancelRecoveryCall = (): Hex => encodeFunctionData({ abi: guardianAbi, functionName: 'cancelRecovery' });
export const setGuardianCall = (g: Address | null, waitSeconds: number): Hex =>
  encodeFunctionData({ abi: guardianAbi, functionName: 'setGuardian', args: [g ?? zeroAddress, waitSeconds] });

// --- Recovery request: what a new device hands the guardian ------------------

/** Everything the guardian page needs, so it works with any wallet and needs no config of its own. */
export interface RecoveryRequest {
  v: 1;
  chain: { id: number; name: string; rpcUrl: string; explorerUrl: string; nativeSymbol: string };
  account: Address;
  /** The new device's public keys, in the order they'll be installed. */
  keys: { x: Hex; y: Hex }[];
  /** keccak256(abi.encode(keys)): what the account stores while this recovery is pending. */
  signersHash: Hex;
  initiateData: Hex;
  completeData: Hex;
  cancelData: Hex;
  /** Calldata for the reads the page shows, so it needs no ABI library. */
  reads: { guardian: Hex; recoveryTimelock: Hex; pendingRecovery: Hex; isFrozen: Hex };
}

export function recoveryRequest(account: Address, keys: StoredKey[]): RecoveryRequest {
  const k = pubkeys(keys);
  return {
    v: 1,
    chain: { id: net.chainId, name: net.name, rpcUrl: net.rpcUrl, explorerUrl: net.explorerUrl, nativeSymbol: net.nativeSymbol },
    account: getAddress(account),
    keys: keys.map(({ x, y }) => ({ x, y })),
    signersHash: signersHash(keys),
    initiateData: encodeFunctionData({ abi: guardianAbi, functionName: 'initiateRecovery', args: [k] }),
    completeData: encodeFunctionData({ abi: guardianAbi, functionName: 'completeRecovery', args: [k] }),
    cancelData: cancelRecoveryCall(),
    reads: {
      guardian: encodeFunctionData({ abi: guardianAbi, functionName: 'guardian' }),
      recoveryTimelock: encodeFunctionData({ abi: guardianAbi, functionName: 'recoveryTimelock' }),
      pendingRecovery: encodeFunctionData({ abi: guardianAbi, functionName: 'pendingRecovery' }),
      isFrozen: encodeFunctionData({ abi: guardianAbi, functionName: 'isFrozen' }),
    },
  };
}

export const encodeRecoveryRequest = (r: RecoveryRequest) =>
  btoa(JSON.stringify(r)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
