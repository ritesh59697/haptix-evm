// PasskeyAccount on chain: predict its address, read it, and send from it through an
// ERC-4337 v0.7 bundler. Mirrors scripts/chain-e2e.mjs, which passed live on Robinhood
// testnet, except that signatures come from real passkeys and a bundler submits the op.
import {
  concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi, parseAbiParameters,
  toHex, toPrefixedMessage, type Address, type Hex,
} from 'viem';
import { rpc } from './rpc';
import { sign, type Assertion, type StoredKey } from './passkey';

const net = __HAPTIX_NETWORK__;

const factoryAbi = parseAbi([
  'struct PublicKey { uint256 x; uint256 y; }',
  'function getAddress(PublicKey[] initialSigners, uint256 threshold, bytes32 salt) view returns (address)',
  'function createAccount(PublicKey[] initialSigners, uint256 threshold, bytes32 salt) returns (address)',
]);
const accountAbi = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function threshold() view returns (uint256)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function ERC1271_VERSION() view returns (uint256)',
]);
const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);
// abi.encode(uint256[] signerIds, WebAuthn.Signature[] sigs), as PasskeyAccount._validateSignature decodes it.
const SIG_PARAMS = parseAbiParameters(
  'uint256[] ids, (bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)[] sigs',
);

// isValidSignature's format since ERC1271_VERSION 2: signers, signatures, and the full
// personal_sign preimage when one key is claimed to be enough.
const SIG_V2_PARAMS = parseAbiParameters(
  'uint256[] ids, (bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)[] sigs, bytes personal',
);
// Accounts from the earlier factory: abi.encode(uint256 signerId, WebAuthn.Signature sig).
const SIG_V1_PARAMS = parseAbiParameters(
  'uint256 id, (bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s) sig',
);
// ERC-6492: a signature from an account that isn't deployed yet ends with this suffix.
const ERC6492_SUFFIX = '0x6492649264926492649264926492649264926492649264926492649264926492';
const ERC1271_MAGIC = '0x1626ba7e';

export interface Account {
  address: Address;
  salt: Hex;
  thresholdWei: string;
  keys: StoredKey[];
  createdAt: number;
  /** The factory that makes this account. Older records predate the field. */
  factory?: Address;
}

const ethCall = (to: Address, data: Hex) => rpc<Hex>(net.rpcUrl, 'eth_call', [{ to, data }, 'latest']);
const pubkeys = (keys: StoredKey[]) => keys.map((k) => ({ x: BigInt(k.x), y: BigInt(k.y) }));

export async function predictAddress(keys: StoredKey[], thresholdWei: bigint, salt: Hex): Promise<Address> {
  const data = encodeFunctionData({ abi: factoryAbi, functionName: 'getAddress', args: [pubkeys(keys), thresholdWei, salt] });
  return decodeFunctionResult({ abi: factoryAbi, functionName: 'getAddress', data: await ethCall(net.factory, data) });
}

export const newSalt = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

export async function getBalance(address: Address) {
  return BigInt(await rpc<Hex>(net.rpcUrl, 'eth_getBalance', [address, 'latest']));
}

export async function isDeployed(address: Address) {
  return (await rpc<Hex>(net.rpcUrl, 'eth_getCode', [address, 'latest'])).length > 2;
}

/** The per-send limit: on chain once deployed, otherwise what the account will be created with. */
export async function readThreshold(account: Account, deployed: boolean): Promise<bigint> {
  if (!deployed) return BigInt(account.thresholdWei);
  const data = encodeFunctionData({ abi: accountAbi, functionName: 'threshold' });
  return decodeFunctionResult({ abi: accountAbi, functionName: 'threshold', data: await ethCall(account.address, data) });
}

export class InsufficientFundsError extends Error {
  constructor(public needWei: bigint, public haveWei: bigint) {
    super('Not enough ETH to cover this send plus gas.');
    this.name = 'InsufficientFundsError';
  }
}

export type SendStep = { stage: 'preparing' } | { stage: 'signing'; key: StoredKey; index: number; of: number } | { stage: 'submitting' } | { stage: 'confirming'; userOpHash: Hex };

interface GasPrice { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

async function gasPrice(bundlerUrl: string): Promise<GasPrice> {
  try {
    // Pimlico's bundler quotes the fee it will accept.
    const p = await rpc<{ standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } }>(bundlerUrl, 'pimlico_getUserOperationGasPrice', []);
    return { maxFeePerGas: BigInt(p.standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.standard.maxPriorityFeePerGas) };
  } catch {
    const price = BigInt(await rpc<Hex>(net.rpcUrl, 'eth_gasPrice', []));
    return { maxFeePerGas: price * 2n, maxPriorityFeePerGas: price };
  }
}

/** A signature of the real shape and size, so the bundler's gas estimate covers the real one. */
function dummySignature(signerIds: bigint[]): Hex {
  const cd = JSON.stringify({ type: 'webauthn.get', challenge: 'A'.repeat(43), origin: location.origin, crossOrigin: false });
  const sig: Assertion = {
    authenticatorData: toHex(new Uint8Array(37).fill(5)),
    clientDataJSON: cd,
    challengeIndex: BigInt(cd.indexOf('"challenge":"')),
    typeIndex: BigInt(cd.indexOf('"type":"')),
    r: 1n,
    s: 1n,
  };
  return encodeAbiParameters(SIG_PARAMS, [signerIds, signerIds.map(() => sig)]);
}

const pack = (hi: bigint, lo: bigint) => concatHex([toHex(hi, { size: 16 }), toHex(lo, { size: 16 })]);

/**
 * How many keys the account contract will ask for (PasskeyAccount._requiredSignatures).
 * One only for a plain native send below the per-send limit; every contract call,
 * approval or token move gets both. Extra signatures are accepted, so when in doubt, two.
 */
export function signersNeeded(account: Account, valueWei: bigint, data: Hex, thresholdWei = BigInt(account.thresholdWei), frozen = false): number[] {
  return !frozen && data === '0x' && valueWei < thresholdWei ? [0] : [0, 1];
}

/**
 * Run one call from the account: execute(to, value, data). `signerIds` are indexes
 * into account.keys: [0] for one fingerprint, [0, 1] for both keys.
 */
export async function sendCall(opts: {
  account: Account;
  to: Address;
  valueWei: bigint;
  data?: Hex;
  /** Replaces the execute(to, value, data) call, for a batch. */
  callData?: Hex;
  signerIds: number[];
  bundlerUrl: string;
  onStep: (s: SendStep) => void;
}): Promise<{ userOpHash: Hex; txHash: Hex; success: boolean }> {
  const { account, to, valueWei, bundlerUrl, onStep } = opts;
  const ids = opts.signerIds.map(BigInt);
  onStep({ stage: 'preparing' });

  const deployed = await isDeployed(account.address);
  const factoryData = deployed
    ? undefined
    : encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [pubkeys(account.keys), BigInt(account.thresholdWei), account.salt] });
  const factory = account.factory ?? net.factory;
  const nonceData = encodeFunctionData({ abi: entryPointAbi, functionName: 'getNonce', args: [account.address, 0n] });
  const nonce = decodeFunctionResult({ abi: entryPointAbi, functionName: 'getNonce', data: await ethCall(net.entryPoint, nonceData) });
  const callData = opts.callData ?? encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [to, valueWei, opts.data ?? '0x'] });
  const fees = await gasPrice(bundlerUrl);

  // Estimate with a placeholder signature. The temporary balance only lets the
  // simulation pay its prefund; the real balance is checked below.
  const est = await rpc<{ preVerificationGas: Hex; verificationGasLimit: Hex; callGasLimit: Hex }>(bundlerUrl, 'eth_estimateUserOperationGas', [
    {
      sender: account.address,
      nonce: toHex(nonce),
      ...(factoryData ? { factory, factoryData } : {}),
      callData,
      maxFeePerGas: toHex(fees.maxFeePerGas),
      maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
      signature: dummySignature(ids),
    },
    net.entryPoint,
    { [account.address]: { balance: toHex(10n ** 18n) } },
  ]);
  // The placeholder fails the passkey check early, so the real verification costs more.
  // Unused verification gas is not charged, so a wide margin only raises the prefund.
  const verificationGasLimit = BigInt(est.verificationGasLimit) * BigInt(2 + ids.length);
  const callGasLimit = (BigInt(est.callGasLimit) * 12n) / 10n;
  const preVerificationGas = (BigInt(est.preVerificationGas) * 11n) / 10n;

  const maxGasCost = (verificationGasLimit + callGasLimit + preVerificationGas) * fees.maxFeePerGas;
  const depositData = encodeFunctionData({ abi: entryPointAbi, functionName: 'balanceOf', args: [account.address] });
  const deposit = decodeFunctionResult({ abi: entryPointAbi, functionName: 'balanceOf', data: await ethCall(net.entryPoint, depositData) });
  const balance = await getBalance(account.address);
  const need = valueWei + (maxGasCost > deposit ? maxGasCost - deposit : 0n);
  if (balance < need) throw new InsufficientFundsError(need, balance);

  const initCode = factoryData ? concatHex([factory, factoryData]) : '0x';
  const packed = {
    sender: account.address,
    nonce,
    initCode,
    callData,
    accountGasLimits: pack(verificationGasLimit, callGasLimit),
    preVerificationGas,
    gasFees: pack(fees.maxPriorityFeePerGas, fees.maxFeePerGas),
    paymasterAndData: '0x' as Hex,
    signature: '0x' as Hex,
  };
  const hashData = encodeFunctionData({ abi: entryPointAbi, functionName: 'getUserOpHash', args: [packed] });
  const opHash = decodeFunctionResult({ abi: entryPointAbi, functionName: 'getUserOpHash', data: await ethCall(net.entryPoint, hashData) });

  const sigs: Assertion[] = [];
  for (const [i, id] of opts.signerIds.entries()) {
    onStep({ stage: 'signing', key: account.keys[id], index: i, of: opts.signerIds.length });
    sigs.push(await sign(account.keys[id], opHash));
  }

  onStep({ stage: 'submitting' });
  const userOpHash = await rpc<Hex>(bundlerUrl, 'eth_sendUserOperation', [
    {
      sender: account.address,
      nonce: toHex(nonce),
      ...(factoryData ? { factory, factoryData } : {}),
      callData,
      callGasLimit: toHex(callGasLimit),
      verificationGasLimit: toHex(verificationGasLimit),
      preVerificationGas: toHex(preVerificationGas),
      maxFeePerGas: toHex(fees.maxFeePerGas),
      maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
      signature: encodeAbiParameters(SIG_PARAMS, [ids, sigs]),
    },
    net.entryPoint,
  ]);

  onStep({ stage: 'confirming', userOpHash });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const receipt = await rpc<{ success: boolean; receipt: { transactionHash: Hex } } | null>(bundlerUrl, 'eth_getUserOperationReceipt', [userOpHash]);
    if (receipt) return { userOpHash, txHash: receipt.receipt.transactionHash, success: receipt.success };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Submitted, but no receipt after 2 minutes. Look up ${userOpHash} on the explorer.`);
}

/**
 * The digest the account's isValidSignature checks: the site's hash wrapped in the
 * account's own EIP-712 domain (PasskeyAccount.getMessageHash), so a signature for one
 * account or chain can't be replayed on another.
 */
export function accountMessageDigest(account: Account, hash: Hex): Hex {
  return hashTypedData({
    domain: { name: 'PasskeyAccount', version: '1', chainId: net.chainId, verifyingContract: account.address },
    types: { PasskeyAccountMessage: [{ name: 'messageHash', type: 'bytes32' }] },
    primaryType: 'PasskeyAccountMessage',
    message: { messageHash: hash },
  });
}

/** The account's signature format: 2 on current accounts, 1 on the earlier factory's. */
export async function signatureVersion(account: Account, deployed: boolean): Promise<number> {
  if (!deployed) return 2; // it will be created by the current factory
  const data = encodeFunctionData({ abi: accountAbi, functionName: 'ERC1271_VERSION' });
  try {
    return Number(decodeFunctionResult({ abi: accountAbi, functionName: 'ERC1271_VERSION', data: await ethCall(account.address, data) }));
  } catch {
    return 1;
  }
}

/**
 * Sign a site's message hash. One key is enough only for a personal_sign message (its
 * preimage goes in the signature as proof) and only while not frozen; anything else
 * needs both. Before the account is deployed the signature is wrapped in ERC-6492 so
 * verifiers can deploy it in a simulation first.
 */
export async function signHash(
  account: Account, hash: Hex, opts: { signerIds: number[]; personalMessage?: Hex; version: number },
): Promise<{ signature: Hex; deployed: boolean }> {
  const digest = accountMessageDigest(account, hash);
  const sigs: Assertion[] = [];
  for (const id of opts.signerIds) sigs.push(await sign(account.keys[id], digest));
  const inner = opts.version >= 2
    ? encodeAbiParameters(SIG_V2_PARAMS, [opts.signerIds.map(BigInt), sigs, opts.personalMessage ? toPrefixedMessage({ raw: opts.personalMessage }) : '0x'])
    : encodeAbiParameters(SIG_V1_PARAMS, [0n, sigs[0]]);
  const deployed = await isDeployed(account.address);
  if (deployed) return { signature: inner, deployed };
  const factoryData = encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [pubkeys(account.keys), BigInt(account.thresholdWei), account.salt] });
  const wrapped = encodeAbiParameters(parseAbiParameters('address, bytes, bytes'), [account.factory ?? net.factory, factoryData, inner]);
  return { signature: concatHex([wrapped, ERC6492_SUFFIX]), deployed };
}

/** Ask the deployed account whether it accepts the signature. */
export async function checkSignature(account: Account, hash: Hex, signature: Hex): Promise<boolean> {
  const data = encodeFunctionData({ abi: accountAbi, functionName: 'isValidSignature', args: [hash, signature] });
  const out = await ethCall(account.address, data);
  return out.slice(0, 10).toLowerCase() === ERC1271_MAGIC;
}

export const sendNative = (opts: Omit<Parameters<typeof sendCall>[0], 'data'>) => sendCall(opts);
