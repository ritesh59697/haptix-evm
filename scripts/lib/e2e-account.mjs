// Shared by the live e2e scripts: the chain-e2e account (software passkeys kept in
// .haptix-e2e/), user operations self-bundled from the deployer, and pass/fail checks.
// Load a networks/*.env file and set DEPLOYER_ACCOUNT [DEPLOYER_KEYSTORE_PASSWORD] first.
import { webcrypto as wc, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  encodeFunctionData, decodeFunctionResult, encodeAbiParameters, parseAbiParameters, decodeEventLog,
  decodeErrorResult, parseAbi, getAddress,
} from 'viem';

export const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing env ${k}. See the comment at the top of the script.`); process.exit(2); }
  return v;
};

export const cfg = {
  rpc: need('RPC_URL'),
  chainId: BigInt(need('CHAIN_ID')),
  entryPoint: getAddress(need('ENTRYPOINT_ADDRESS')),
  factory: getAddress(need('FACTORY_ADDRESS')),
  explorer: process.env.EXPLORER_URL || '',
  vgl: BigInt(need('E2E_VERIFICATION_GAS_LIMIT')),
  cgl: BigInt(need('E2E_CALL_GAS_LIMIT')),
  pvg: BigInt(need('E2E_PRE_VERIFICATION_GAS')),
  origin: need('E2E_CLIENT_ORIGIN'),
};
const walletArgs = ['--account', need('DEPLOYER_ACCOUNT'), '--password', process.env.DEPLOYER_KEYSTORE_PASSWORD ?? ''];

export const PASSKEYS = '(bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)[]';
const SIG_PARAMS = parseAbiParameters(`uint256[] ids, ${PASSKEYS} sigs`);
const factoryAbi = parseAbi([
  'struct PublicKey { uint256 x; uint256 y; }',
  'function getAddress(PublicKey[] initialSigners, uint256 threshold, bytes32 salt) view returns (address)',
]);
const accountAbi = parseAbi(['function execute(address dest, uint256 value, bytes func)']);
export const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
]);

let rpcId = 0;
export async function rpc(method, params) {
  const res = await fetch(cfg.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await res.json();
  if (body.error) { const e = new Error(`${method}: ${body.error.message}`); e.data = body.error.data; throw e; }
  return body.result;
}
export const ethCall = (to, data, from) => rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const cast = (args) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const castSend = (to, data, value) => {
  const args = ['send', to, ...(data && data !== '0x' ? [data] : []), '--rpc-url', cfg.rpc, '--json', ...walletArgs];
  if (value !== undefined) args.push('--value', value.toString());
  return JSON.parse(cast(args));
};
export const link = (kind, id) => (cfg.explorer ? `${cfg.explorer}${kind}/${id}` : id);

// --- software passkeys from chain-e2e -----------------------------------------
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hex = (buf) => Buffer.from(buf).toString('hex');
const statePath = path.resolve('.haptix-e2e', `${cfg.chainId}-${cfg.factory.toLowerCase()}.json`);
if (!fs.existsSync(statePath)) { console.error(`No ${statePath}. Run scripts/chain-e2e.mjs first.`); process.exit(2); }
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const signers = await Promise.all(state.signers.map(async (jwk) => ({
  key: await wc.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']),
  x: BigInt('0x' + hex(Buffer.from(jwk.x, 'base64url'))),
  y: BigInt('0x' + hex(Buffer.from(jwk.y, 'base64url'))),
})));
export async function assert(i, challengeHex) {
  const authData = Buffer.alloc(37);
  createHash('sha256').update(new URL(cfg.origin).hostname).digest().copy(authData, 0);
  authData[32] = 0x05; // UP | UV
  const cd = JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(challengeHex.slice(2), 'hex').toString('base64url'), origin: cfg.origin, crossOrigin: false });
  const sig = Buffer.from(await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signers[i].key, Buffer.concat([authData, createHash('sha256').update(cd).digest()])));
  let s = BigInt('0x' + hex(sig.subarray(32, 64)));
  if (s > P256_N / 2n) s = P256_N - s;
  return { authenticatorData: '0x' + hex(authData), clientDataJSON: cd, challengeIndex: BigInt(cd.indexOf('"challenge":"')), typeIndex: BigInt(cd.indexOf('"type":"')), r: BigInt('0x' + hex(sig.subarray(0, 32))), s };
}
/** The account's passkey signature with the given key indexes. */
export const passkeySig = async (hash, ids) => encodeAbiParameters(SIG_PARAMS, [ids.map(BigInt), await Promise.all(ids.map((i) => assert(i, hash)))]);

// --- the account and its operations ---------------------------------------------
export const payer = getAddress(cast(['wallet', 'address', ...walletArgs]));
export const account = decodeFunctionResult({
  abi: factoryAbi, functionName: 'getAddress',
  data: await ethCall(cfg.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'getAddress', args: [signers.map(({ x, y }) => ({ x, y })), BigInt(state.threshold), state.salt] })),
});
if ((await rpc('eth_getCode', [account, 'latest'])).length <= 2) { console.error(`${account} isn't deployed. Run scripts/chain-e2e.mjs first.`); process.exit(2); }

export const selfCall = (func) => encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [account, 0n, func] });
export const sendCall = (to, value) => encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [to, value, '0x'] });

const pad = (v) => v.toString(16).padStart(32, '0');
export async function buildOp(callData, callGas = cfg.cgl, value = 0n) {
  const nonce = decodeFunctionResult({ abi: entryPointAbi, functionName: 'getNonce', data: await ethCall(cfg.entryPoint, encodeFunctionData({ abi: entryPointAbi, functionName: 'getNonce', args: [account, 0n] })) });
  const gasPrice = BigInt(await rpc('eth_gasPrice', []));
  const maxFee = gasPrice * 2n;
  const op = { sender: account, nonce, initCode: '0x', callData, accountGasLimits: `0x${pad(cfg.vgl)}${pad(callGas)}`, preVerificationGas: cfg.pvg, gasFees: `0x${pad(gasPrice)}${pad(maxFee)}`, paymasterAndData: '0x', signature: '0x' };
  const hash = decodeFunctionResult({ abi: entryPointAbi, functionName: 'getUserOpHash', data: await ethCall(cfg.entryPoint, encodeFunctionData({ abi: entryPointAbi, functionName: 'getUserOpHash', args: [op] })) });
  return { op, hash, maxCost: (cfg.vgl + callGas + cfg.pvg) * maxFee, value };
}
const handleOps = (op) => encodeFunctionData({ abi: entryPointAbi, functionName: 'handleOps', args: [[op], payer] });
function opEvent(receipt) {
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== cfg.entryPoint) continue;
    try { const ev = decodeEventLog({ abi: entryPointAbi, data: log.data, topics: log.topics }); if (ev.eventName === 'UserOperationEvent') return ev.args; } catch { /* other events */ }
  }
  return null;
}
export function revertReason(err, abi = entryPointAbi) {
  const raw = err?.data?.data ?? err?.data;
  if (typeof raw !== 'string' || !raw.startsWith('0x')) return err.message;
  try { const d = decodeErrorResult({ abi, data: raw }); return `${d.errorName}(${(d.args ?? []).slice(0, 2).join(', ')})`; } catch { return raw; }
}
async function ensureFunded(b) {
  const deposit = decodeFunctionResult({ abi: entryPointAbi, functionName: 'balanceOf', data: await ethCall(cfg.entryPoint, encodeFunctionData({ abi: entryPointAbi, functionName: 'balanceOf', args: [account] })) });
  const want = b.value + (b.maxCost > deposit ? b.maxCost - deposit : 0n);
  const bal = BigInt(await rpc('eth_getBalance', [account, 'latest']));
  if (bal >= want) return;
  const r = castSend(account, '0x', want - bal);
  if (r.status !== '0x1') throw new Error(`funding failed: ${r.transactionHash}`);
  console.log(`   funded account with ${want - bal} wei`);
}

let failures = 0;
export const failed = () => failures;
export function check(label, ok, detail) {
  console.log(`${label}: ${ok ? 'OK' : 'FAILED'}${detail ? `\n   ${detail}` : ''}`);
  if (!ok) failures++;
}
export async function expectSuccess(label, b, signature) {
  await ensureFunded(b);
  const r = castSend(cfg.entryPoint, handleOps({ ...b.op, signature }));
  const ev = opEvent(r);
  const ok = r.status === '0x1' && ev?.success === true;
  console.log(`${label}: ${ok ? 'SUCCESS' : 'UNEXPECTED FAILURE'}\n   ${link('tx', r.transactionHash)}`);
  if (!ok) failures++;
  return r;
}
export async function expectRejected(label, b, signature, pattern) {
  await ensureFunded(b); // fully funded, so only the policy can stop it
  let reason = null;
  try { await rpc('eth_call', [{ from: payer, to: cfg.entryPoint, data: handleOps({ ...b.op, signature }) }, 'latest']); } catch (e) { reason = revertReason(e); }
  const ok = reason !== null && pattern.test(reason);
  console.log(`${label}: ${ok ? 'REJECTED as expected' : reason ? 'rejected for the WRONG reason' : 'NOT REJECTED'}${reason ? `\n   ${reason}` : ''}`);
  if (!ok) failures++;
}
/** A direct call that must revert with the named error (simulated; nothing is sent). */
export async function expectRevert(label, to, data, from, abi, pattern) {
  let reason = null;
  try { await ethCall(to, data, from); } catch (e) { reason = revertReason(e, abi); }
  const ok = reason !== null && pattern.test(reason);
  console.log(`${label}: ${ok ? 'REVERTS as expected' : reason ? 'reverts for the WRONG reason' : 'DOES NOT REVERT'}${reason ? `\n   ${reason}` : ''}`);
  if (!ok) failures++;
}
