#!/usr/bin/env node
/**
 * Haptix end-to-end on any EVM chain: create a passkey account, prove the
 * spend policy on-chain.
 *
 *   1. Send UNDER the limit with ONE passkey          -> must succeed
 *   2. Send OVER the limit with ONE passkey           -> must be rejected (AA24)
 *   3. Send OVER the limit with TWO passkeys (quorum) -> must succeed
 *
 * Signers are SOFTWARE P-256 keys producing real WebAuthn assertions
 * (authenticatorData + clientDataJSON, UV flag set, low-s). The contract runs
 * the exact verification path a Touch ID passkey goes through; the only
 * difference is where the private key lives. Keys are generated once per
 * chain+factory and kept in .haptix-e2e/ (gitignored, testnet only).
 *
 * We act as our own bundler (handleOps from the deployer EOA), the same path
 * a hosted bundler takes, so no bundler is needed on the chain.
 *
 * Env (load a networks/*.env file first):
 *   RPC_URL CHAIN_ID ENTRYPOINT_ADDRESS FACTORY_ADDRESS EXPLORER_URL
 *   E2E_THRESHOLD_WEI E2E_SEND_UNDER_WEI E2E_SEND_OVER_WEI
 *   E2E_VERIFICATION_GAS_LIMIT E2E_CALL_GAS_LIMIT E2E_PRE_VERIFICATION_GAS
 *   E2E_CLIENT_ORIGIN
 * Gas payer, one of:
 *   DEPLOYER_ACCOUNT=<foundry keystore name> [DEPLOYER_KEYSTORE_PASSWORD]
 *   DEPLOYER_UNLOCKED_FROM=<address>   (local anvil fork only: an unlocked dev account)
 * Optional:
 *   E2E_RECIPIENT  (defaults to the gas payer's address)
 */
import { webcrypto as wc, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  encodeFunctionData, decodeFunctionResult, encodeAbiParameters, parseAbiParameters,
  decodeEventLog, decodeErrorResult, parseAbi, concatHex, getAddress,
} from 'viem';

// ---------------------------------------------------------------- config
const need = (k) => {
  const v = process.env[k];
  if (v === undefined || v === '') { console.error(`Missing env ${k}. Load a networks/*.env file first.`); process.exit(2); }
  return v;
};
const cfg = {
  rpc: need('RPC_URL'),
  chainId: BigInt(need('CHAIN_ID')),
  entryPoint: getAddress(need('ENTRYPOINT_ADDRESS')),
  factory: getAddress(need('FACTORY_ADDRESS')),
  explorer: process.env.EXPLORER_URL || '',
  threshold: BigInt(need('E2E_THRESHOLD_WEI')),
  under: BigInt(need('E2E_SEND_UNDER_WEI')),
  over: BigInt(need('E2E_SEND_OVER_WEI')),
  vgl: BigInt(need('E2E_VERIFICATION_GAS_LIMIT')),
  cgl: BigInt(need('E2E_CALL_GAS_LIMIT')),
  pvg: BigInt(need('E2E_PRE_VERIFICATION_GAS')),
  origin: need('E2E_CLIENT_ORIGIN'),
};
if (!(cfg.under <= cfg.threshold && cfg.over > cfg.threshold)) {
  console.error('Config error: need E2E_SEND_UNDER_WEI <= E2E_THRESHOLD_WEI < E2E_SEND_OVER_WEI');
  process.exit(2);
}

const walletArgs = (() => {
  if (process.env.DEPLOYER_ACCOUNT) {
    return ['--account', process.env.DEPLOYER_ACCOUNT, '--password', process.env.DEPLOYER_KEYSTORE_PASSWORD ?? ''];
  }
  if (process.env.DEPLOYER_UNLOCKED_FROM) return ['--unlocked', '--from', process.env.DEPLOYER_UNLOCKED_FROM];
  console.error('Set DEPLOYER_ACCOUNT (foundry keystore) or DEPLOYER_UNLOCKED_FROM (local anvil only).');
  process.exit(2);
})();

// ---------------------------------------------------------------- ABIs
const factoryAbi = parseAbi([
  'struct PublicKey { uint256 x; uint256 y; }',
  'function getAddress(PublicKey[] initialSigners, uint256 threshold, bytes32 salt) view returns (address)',
  'function createAccount(PublicKey[] initialSigners, uint256 threshold, bytes32 salt) returns (address)',
]);
const accountAbi = parseAbi(['function execute(address dest, uint256 value, bytes func)']);
const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
]);

// ---------------------------------------------------------------- rpc + cast
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(cfg.rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) { const e = new Error(`${method}: ${body.error.message}`); e.data = body.error.data; throw e; }
  return body.result;
}
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const cast = (args) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const castSend = (to, data, value) => {
  const args = ['send', to, ...(data && data !== '0x' ? [data] : []), '--rpc-url', cfg.rpc, '--json', ...walletArgs];
  if (value !== undefined) args.push('--value', value.toString());
  return JSON.parse(cast(args));
};
const link = (kind, id) => (cfg.explorer ? `${cfg.explorer}${kind}/${id}` : id);

// ---------------------------------------------------------------- software passkeys
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hex = (buf) => Buffer.from(buf).toString('hex');

async function newSigner() {
  const kp = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await wc.subtle.exportKey('jwk', kp.privateKey);
  return jwk;
}
async function loadSigner(jwk) {
  const key = await wc.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return {
    key,
    x: BigInt('0x' + hex(Buffer.from(jwk.x, 'base64url'))),
    y: BigInt('0x' + hex(Buffer.from(jwk.y, 'base64url'))),
  };
}
/** A WebAuthn assertion over `challengeHex`, in the struct layout WebAuthn.sol expects. */
async function assert(signer, challengeHex) {
  const authData = Buffer.alloc(37);
  createHash('sha256').update(new URL(cfg.origin).hostname).digest().copy(authData, 0); // rpIdHash
  authData[32] = 0x05; // UP | UV: a user was present and verified
  const challenge = Buffer.from(challengeHex.slice(2), 'hex');
  const cd = JSON.stringify({ type: 'webauthn.get', challenge: b64u(challenge), origin: cfg.origin, crossOrigin: false });
  const cdHash = createHash('sha256').update(cd).digest();
  const sig = Buffer.from(await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.key, Buffer.concat([authData, cdHash])));
  const r = BigInt('0x' + hex(sig.subarray(0, 32)));
  let s = BigInt('0x' + hex(sig.subarray(32, 64)));
  if (s > P256_N / 2n) s = P256_N - s; // contract enforces low-s
  return {
    authenticatorData: '0x' + hex(authData),
    clientDataJSON: cd,
    challengeIndex: BigInt(cd.indexOf('"challenge":"')),
    typeIndex: BigInt(cd.indexOf('"type":"')),
    r, s,
  };
}
const SIG_PARAMS = parseAbiParameters(
  'uint256[] ids, (bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)[] sigs'
);

// ---------------------------------------------------------------- state
const stateDir = path.resolve('.haptix-e2e');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const statePath = path.join(stateDir, `${cfg.chainId}-${cfg.factory.toLowerCase()}.json`);
let state;
if (fs.existsSync(statePath)) {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
} else {
  state = {
    note: 'TESTNET ONLY software passkeys for scripts/chain-e2e.mjs. Never fund on mainnet.',
    signers: [await newSigner(), await newSigner()],
    salt: '0x' + hex(wc.getRandomValues(new Uint8Array(32))),
    threshold: cfg.threshold.toString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}
if (BigInt(state.threshold) !== cfg.threshold) {
  console.error(`E2E_THRESHOLD_WEI changed since ${statePath} was created; delete that file to start a fresh account.`);
  process.exit(2);
}
const signers = await Promise.all(state.signers.map(loadSigner));
const pubkeys = signers.map((s) => ({ x: s.x, y: s.y }));

// ---------------------------------------------------------------- userops
async function buildOp(sender, initCode, dest, value) {
  const nonce = decodeFunctionResult({
    abi: entryPointAbi, functionName: 'getNonce',
    data: await ethCall(cfg.entryPoint, encodeFunctionData({ abi: entryPointAbi, functionName: 'getNonce', args: [sender, 0n] })),
  });
  const gasPrice = BigInt(await rpc('eth_gasPrice', []));
  const maxFee = gasPrice * 2n;
  const pad = (v) => v.toString(16).padStart(32, '0');
  return {
    sender, nonce, initCode,
    callData: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [dest, value, '0x'] }),
    accountGasLimits: `0x${pad(cfg.vgl)}${pad(cfg.cgl)}`,
    preVerificationGas: cfg.pvg,
    gasFees: `0x${pad(gasPrice)}${pad(maxFee)}`, // priority = current price, max = 2x
    paymasterAndData: '0x',
    signature: '0x',
    // Most the EntryPoint can charge the account for this op at today's price.
    _maxGasCost: (cfg.vgl + cfg.cgl + cfg.pvg) * maxFee,
    _value: value,
  };
}
const stripLocal = ({ _hash, _maxGasCost, _value, ...op }) => op;
async function signOp(op, signerIds) {
  const hash = decodeFunctionResult({
    abi: entryPointAbi, functionName: 'getUserOpHash',
    data: await ethCall(cfg.entryPoint, encodeFunctionData({ abi: entryPointAbi, functionName: 'getUserOpHash', args: [stripLocal(op)] })),
  });
  const sigs = [];
  for (const id of signerIds) sigs.push(await assert(signers[id], hash));
  return { ...op, signature: encodeAbiParameters(SIG_PARAMS, [signerIds.map(BigInt), sigs]) , _hash: hash };
}
const handleOpsData = (op, beneficiary) => {
  return encodeFunctionData({ abi: entryPointAbi, functionName: 'handleOps', args: [[stripLocal(op)], beneficiary] });
};
function opEvent(receipt) {
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== cfg.entryPoint) continue;
    try {
      const ev = decodeEventLog({ abi: entryPointAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'UserOperationEvent') return ev.args;
    } catch { /* other EntryPoint events */ }
  }
  return null;
}
function revertReason(err) {
  const raw = err?.data?.data ?? err?.data;
  if (typeof raw !== 'string' || !raw.startsWith('0x')) return err.message;
  try {
    const d = decodeErrorResult({ abi: entryPointAbi, data: raw });
    return `${d.errorName}(${d.args.slice(0, 2).join(', ')})`;
  } catch { return raw; }
}

// ---------------------------------------------------------------- run
const chainId = BigInt(await rpc('eth_chainId', []));
if (chainId !== cfg.chainId) { console.error(`RPC chain ${chainId} != CHAIN_ID ${cfg.chainId}`); process.exit(1); }

const payer = getAddress(process.env.DEPLOYER_UNLOCKED_FROM || cast(['wallet', 'address', ...walletArgs]));
const recipient = getAddress(process.env.E2E_RECIPIENT || payer);

const account = decodeFunctionResult({
  abi: factoryAbi, functionName: 'getAddress',
  data: await ethCall(cfg.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'getAddress', args: [pubkeys, cfg.threshold, state.salt] })),
});
const deployed = (await rpc('eth_getCode', [account, 'latest'])).length > 2;
const initCode = deployed ? '0x' : concatHex([
  cfg.factory,
  encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [pubkeys, cfg.threshold, state.salt] }),
]);

console.log(`Network:   ${process.env.NETWORK_NAME || ''} (${chainId})`);
console.log(`Factory:   ${cfg.factory}`);
console.log(`Account:   ${account} ${deployed ? '(deployed)' : '(counterfactual; deploys in step 1)'}`);
console.log(`Gas payer: ${payer}`);
console.log(`Limit:     ${cfg.threshold} wei per op; above it a 2nd passkey is required\n`);

const receipts = { chainId: chainId.toString(), factory: cfg.factory, account, threshold: cfg.threshold.toString(), steps: [] };

/**
 * Top the account up to exactly what this op can cost: its value, plus max gas at the
 * current price minus whatever gas deposit the account already has in the EntryPoint
 * (v0.7 keeps unused prefund there, not in the account's own balance).
 */
async function ensureFunded(op) {
  const deposit = decodeFunctionResult({
    abi: entryPointAbi, functionName: 'balanceOf',
    data: await ethCall(cfg.entryPoint, encodeFunctionData({ abi: entryPointAbi, functionName: 'balanceOf', args: [account] })),
  });
  const gasShortfall = op._maxGasCost > deposit ? op._maxGasCost - deposit : 0n;
  const need = op._value + gasShortfall;
  const bal = BigInt(await rpc('eth_getBalance', [account, 'latest']));
  if (bal >= need) return;
  const top = need - bal;
  console.log(`   funding account with ${top} wei (value ${op._value} + gas shortfall ${gasShortfall} - balance ${bal}; EntryPoint deposit ${deposit})`);
  const r = castSend(account, '0x', top);
  if (r.status !== '0x1') throw new Error(`funding tx failed: ${r.transactionHash}`);
  receipts.steps.push({ step: 'fund', tx: r.transactionHash, wei: top.toString() });
}

// Step 1: under the limit, one passkey.
{
  const op = await signOp(await buildOp(account, initCode, recipient, cfg.under), [0]);
  await ensureFunded(op);
  const r = castSend(cfg.entryPoint, handleOpsData(op, payer));
  const ev = opEvent(r);
  const ok = r.status === '0x1' && ev?.success === true;
  receipts.steps.push({ step: 'under-limit, 1 passkey', expected: 'success', ok, tx: r.transactionHash, userOpHash: op._hash, gasUsed: ev?.actualGasUsed?.toString() });
  console.log(`1. Send ${cfg.under} wei with ONE passkey: ${ok ? 'SUCCESS' : 'UNEXPECTED FAILURE'}`);
  console.log(`   ${link('tx', r.transactionHash)}\n`);
  if (!ok) throw new Error('step 1 failed');
}

// Step 2: over the limit, one passkey. Must be rejected in validation.
{
  const op = await signOp(await buildOp(account, '0x', recipient, cfg.over), [0]);
  // Fund it fully, so the ONLY thing that can stop this op is the missing 2nd passkey.
  // (Underfunded, the EntryPoint fails it earlier with AA21 and proves nothing.)
  await ensureFunded(op);
  let rejected = false, reason = '';
  try {
    await rpc('eth_call', [{ from: payer, to: cfg.entryPoint, data: handleOpsData(op, payer) }, 'latest']);
  } catch (e) {
    rejected = true;
    reason = revertReason(e);
  }
  const ok = rejected && /AA24/.test(reason);
  receipts.steps.push({ step: 'over-limit, 1 passkey', expected: 'rejected (AA24)', ok, reason, userOpHash: op._hash, note: 'simulated with eth_call against live chain state; nothing broadcast' });
  console.log(`2. Send ${cfg.over} wei with ONE passkey: ${ok ? 'REJECTED as expected' : rejected ? 'rejected for the WRONG reason' : 'NOT REJECTED (policy bug!)'}`);
  console.log(`   EntryPoint revert: ${reason}\n`);
  if (!ok) throw new Error('step 2: over-limit single-signature op was not rejected');
}

// Step 3: over the limit, two passkeys (quorum).
{
  const op = await signOp(await buildOp(account, '0x', recipient, cfg.over), [0, 1]);
  await ensureFunded(op);
  const r = castSend(cfg.entryPoint, handleOpsData(op, payer));
  const ev = opEvent(r);
  const ok = r.status === '0x1' && ev?.success === true;
  receipts.steps.push({ step: 'over-limit, 2 passkeys', expected: 'success', ok, tx: r.transactionHash, userOpHash: op._hash, gasUsed: ev?.actualGasUsed?.toString() });
  console.log(`3. Send ${cfg.over} wei with TWO passkeys: ${ok ? 'SUCCESS' : 'UNEXPECTED FAILURE'}`);
  console.log(`   ${link('tx', r.transactionHash)}\n`);
  if (!ok) throw new Error('step 3 failed');
}

const outPath = path.join(stateDir, `${cfg.chainId}-receipts-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(receipts, null, 2));
console.log(`All 3 policy checks passed. Account: ${link('address', account)}`);
console.log(`Receipts written to ${outPath}`);
