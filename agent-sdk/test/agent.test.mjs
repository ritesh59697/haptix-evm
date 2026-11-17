// Unit tests against a mocked node and bundler: how the SDK classifies an action, and
// the approval request it hands the owner. No network. The live behaviour is checked by
// scripts/agent-sdk-e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, parseAbi, recoverAddress, toHex, zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createHaptixAgent, decodeRequest, encodeRequest, ETH, HaptixAgentError } from '../dist/index.js';

const abi = parseAbi([
  'function agentSessions(address) view returns (uint48 validAfter, uint48 validUntil, bool isRegistered, bool revoked, uint256 humanApprovalThreshold, uint256 perTxLimitEth, uint256 perTxLimitToken, uint256 windowSeconds)',
  'function agentWindow(address, address) view returns (uint96 spent, uint48 expiry)',
  'function agentWindowCap(address, address) view returns (uint256)',
  'function agentAllowedTokens(address, address) view returns (bool)',
  'function agentAllowedProtocols(address, address) view returns (bool)',
  'function agentAllowedSelectors(address, address, bytes4) view returns (bool)',
  'function isAllowedRecipient(address) view returns (bool)',
  'function isFrozen() view returns (bool)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
]);

const NOW = 1_800_000_000;
const DAY = 86_400;
const ACCOUNT = getAddress('0x' + '11'.repeat(20));
const ENTRYPOINT = getAddress('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
const PAYEE = getAddress('0x' + '22'.repeat(20));
const ROUTER = getAddress('0x' + '33'.repeat(20));
const TOKEN_IN = getAddress('0x' + '44'.repeat(20));
const TOKEN_OUT = getAddress('0x' + '55'.repeat(20));

/** A chain state the mock node answers from. Each test changes what it needs. */
function state(over = {}) {
  return {
    session: { validAfter: 0, validUntil: NOW + DAY, registered: true, revoked: false, ceiling: 0n, perTxEth: 100n, perTxToken: 100n, windowSeconds: DAY },
    frozen: false,
    allowedTokens: [ETH, TOKEN_IN, TOKEN_OUT],
    protocols: [PAYEE, ROUTER],
    recipients: [],
    caps: { [ETH]: 200n, [TOKEN_IN]: 200n },
    windows: {},
    nonce: 7n,
    sent: [],
    head: 1000,
    /** Operations on chain: { block, userOpHash, success }. */
    included: [],
    /** The most blocks one eth_getLogs may span, or null for no limit. */
    logLimit: null,
    logQueries: 0,
    ...over,
  };
}

function mockFetch(s) {
  const has = (list, a) => list.some((x) => getAddress(x) === getAddress(a));
  const answers = {
    agentSessions: () => [s.session.validAfter, s.session.validUntil, s.session.registered, s.session.revoked, s.session.ceiling, s.session.perTxEth, s.session.perTxToken, BigInt(s.session.windowSeconds)],
    isFrozen: () => s.frozen,
    agentAllowedTokens: ([, t]) => has(s.allowedTokens, t),
    agentAllowedProtocols: ([, p]) => has(s.protocols, p),
    agentAllowedSelectors: ([, p]) => has(s.protocols, p),
    isAllowedRecipient: ([r]) => has(s.recipients, r),
    agentWindowCap: ([, a]) => s.caps[getAddress(a)] ?? 0n,
    agentWindow: ([, a]) => s.windows[getAddress(a)] ?? [0n, 0],
    getNonce: () => s.nonce,
    getUserOpHash: ([op]) => keccak256(op.callData),
  };
  const methods = {
    eth_chainId: () => toHex(46630),
    eth_getBlockByNumber: () => ({ number: toHex(1000), timestamp: toHex(NOW), baseFeePerGas: toHex(10_000_000) }),
    eth_maxPriorityFeePerGas: () => toHex(1_000),
    eth_estimateUserOperationGas: () => ({ verificationGasLimit: toHex(100_000), callGasLimit: toHex(100_000), preVerificationGas: toHex(50_000) }),
    eth_sendUserOperation: ([op]) => { s.sent.push(op); return keccak256(op.callData); },
    eth_blockNumber: () => toHex(s.head),
    eth_getLogs: ([{ fromBlock, toBlock, topics }]) => {
      s.logQueries++;
      const from = Number(BigInt(fromBlock));
      const to = toBlock === 'latest' ? s.head : Number(BigInt(toBlock));
      if (s.logLimit !== null && to - from + 1 > s.logLimit) {
        throw Object.assign(new Error(`query spans ${to - from + 1} blocks, but only ${s.logLimit} are allowed; narrow the block range`), { rpc: -32602 });
      }
      return s.included
        .filter((o) => o.block >= from && o.block <= to && o.userOpHash === topics[1])
        .map((o) => ({
          transactionHash: keccak256(toHex(o.block)),
          topics: [topics[0], o.userOpHash, '0x' + '00'.repeat(12) + ACCOUNT.slice(2).toLowerCase(), '0x' + '00'.repeat(32)],
          data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [7n, o.success, 1n, 1n]),
        }));
    },
    eth_call: ([{ data }]) => {
      const { functionName, args } = decodeFunctionData({ abi, data });
      const result = answers[functionName](args);
      return encodeFunctionResult({ abi, functionName, result });
    },
  };
  return async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    const handler = methods[method];
    let body;
    try {
      body = handler
        ? { jsonrpc: '2.0', id, result: handler(params) }
        : { jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } };
    } catch (e) {
      body = { jsonrpc: '2.0', id, error: { code: e.rpc ?? -32000, message: e.message } };
    }
    return new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? toHex(v) : v)));
  };
}

const key = generatePrivateKey();
const agentAddress = privateKeyToAccount(key).address;
const agent = (s) => createHaptixAgent({
  rpcUrl: 'http://node', bundlerUrl: 'http://bundler', entryPoint: ENTRYPOINT, account: ACCOUNT, agentKey: key,
  fetch: mockFetch(s), pollIntervalMs: 1, timeoutMs: 50,
});
const pay = (amount, to = PAYEE) => ({ kind: 'pay', to, amount });
const swap = (amountIn, minAmountOut = 1n) => ({ kind: 'swap', router: ROUTER, tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn, minAmountOut, fee: 3000 });
const refused = (code) => (e) => e instanceof HaptixAgentError && e.code === code;

test('budget reads the session and the open window', async () => {
  const s = state({ windows: { [ETH]: [150n, NOW + 60] } });
  const b = await agent(s).budget();
  assert.equal(b.status, 'active');
  assert.equal(b.agent, agentAddress);
  assert.equal(b.perPayment, 100n);
  assert.equal(b.spent, 150n);
  assert.equal(b.remaining, 50n);
  assert.equal(b.resetsAt, NOW + 60);
});

test('a closed window counts as nothing spent', async () => {
  const b = await agent(state({ windows: { [ETH]: [200n, NOW - 1] } })).budget();
  assert.equal(b.spent, 0n);
  assert.equal(b.remaining, 200n);
  assert.equal(b.resetsAt, null);
});

test('within budget', async () => {
  assert.deepEqual(await agent(state()).check(pay(100n)), { decision: 'within' });
  assert.deepEqual(await agent(state()).check(swap(100n)), { decision: 'within' });
});

test('over the per-payment limit needs the owner', async () => {
  const d = await agent(state()).check(pay(101n));
  assert.equal(d.decision, 'needs-approval');
  assert.equal(d.reason, 'per-payment-limit');
});

test('over the rolling budget needs the owner', async () => {
  const d = await agent(state({ windows: { [ETH]: [150n, NOW + 60] } })).check(pay(100n));
  assert.equal(d.decision, 'needs-approval');
  assert.equal(d.reason, 'budget');
});

for (const [name, over, code] of [
  ['no session', { session: { ...state().session, registered: false } }, 'not-granted'],
  ['revoked', { session: { ...state().session, revoked: true } }, 'revoked'],
  ['expired', { session: { ...state().session, validUntil: NOW } }, 'expired'],
  ['not started', { session: { ...state().session, validAfter: NOW + 1 } }, 'not-yet-valid'],
  ['frozen', { frozen: true }, 'frozen'],
]) {
  test(`refuses, even for the owner, when ${name}`, async () => {
    await assert.rejects(agent(state(over)).check(pay(1n)), refused(code));
  });
}

test('refuses a payee the owner didn\'t allow', async () => {
  await assert.rejects(agent(state()).check(pay(1n, getAddress('0x' + '99'.repeat(20)))), refused('not-allowed'));
});

test('an allowlisted recipient counts as allowed', async () => {
  const other = getAddress('0x' + '99'.repeat(20));
  assert.deepEqual(await agent(state({ recipients: [other] })).check(pay(1n, other)), { decision: 'within' });
});

test('refuses tokens and routers the owner didn\'t allow', async () => {
  await assert.rejects(agent(state({ allowedTokens: [ETH, TOKEN_IN] })).check(swap(1n)), refused('not-allowed'));
  await assert.rejects(agent(state({ protocols: [PAYEE] })).check(swap(1n)), refused('not-allowed'));
});

test('refuses over the approval ceiling, but not within budget', async () => {
  const s = state({ session: { ...state().session, ceiling: 150n } });
  await assert.rejects(agent(s).check(pay(151n)), refused('above-approval-ceiling'));
  assert.equal((await agent(s).check(pay(120n))).decision, 'needs-approval');
});

test('refuses bad arguments before reading the chain', async () => {
  await assert.rejects(agent(state()).check(pay(0n)), refused('invalid-argument'));
  await assert.rejects(agent(state()).check(swap(1n, 0n)), refused('invalid-argument'));
});

test('checks the chain id when one is configured', async () => {
  const a = createHaptixAgent({ rpcUrl: 'http://node', bundlerUrl: 'http://b', entryPoint: ENTRYPOINT, account: ACCOUNT, agentKey: key, chainId: 4663, fetch: mockFetch(state()) });
  await assert.rejects(a.check(pay(1n)), refused('wrong-chain'));
});

test('over the limit, nothing is sent and the owner gets a request the wallet can read', async () => {
  const s = state();
  const out = await agent(s).pay(PAYEE, 150n);
  assert.equal(out.status, 'needs-approval');
  assert.equal(s.sent.length, 0);
  assert.equal(out.nonce, 7n);
  // Decoded the way the wallet does it (extension-app/src/chain/agents.ts).
  const payload = JSON.parse(atob(out.request.replace(/-/g, '+').replace(/_/g, '/')));
  assert.deepEqual(Object.keys(payload), ['v', 'chainId', 'account', 'agent', 'userOp', 'agentSig']);
  assert.deepEqual(Object.keys(payload.userOp), ['sender', 'nonce', 'callData', 'maxFeePerGas', 'maxPriorityFeePerGas', 'verificationGasLimit', 'callGasLimit', 'preVerificationGas']);
  assert.equal(payload.v, 1);
  assert.equal(payload.chainId, 46630);
  assert.equal(payload.agent, agentAddress);
  assert.equal(payload.userOp.sender, ACCOUNT);
  assert.equal(payload.userOp.nonce, '0x7');
  assert.equal(await recoverAddress({ hash: out.userOpHash, signature: payload.agentSig }), agentAddress);
  assert.deepEqual(decodeRequest(out.request), payload);
});

test('within budget it sends with the agent key alone', async () => {
  const s = state();
  const a = agent(s);
  await assert.rejects(a.pay(PAYEE, 50n), refused('timeout')); // the mock never includes it
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].signature.slice(0, 4), '0x01');
});

test('a request whose nonce was used by something else is superseded', async () => {
  const s = state();
  const a = agent(s);
  const out = await a.pay(PAYEE, 150n);
  s.nonce = 8n;
  assert.deepEqual(await a.waitForOperation(out.userOpHash, { fromBlock: out.fromBlock, nonce: out.nonce }), { status: 'superseded' });
});

test('waiting finds an approval far back, paging when the node limits the range', async () => {
  const s = state({ head: 1_000_000, logLimit: 10_000 });
  const a = agent(s);
  const hash = keccak256('0x01');
  s.included.push({ block: 990_000, userOpHash: hash, success: true });
  const r = await a.waitForOperation(hash, { fromBlock: 0n, nonce: 7n });
  assert.equal(r.status, 'included');
  assert.equal(r.success, true);
  // Halved until accepted, then reused: far fewer than one query per refused size.
  const queries = s.logQueries;
  const again = await a.waitForOperation(hash, { fromBlock: 0n });
  assert.equal(again.status, 'included');
  assert.ok(s.logQueries - queries <= Math.ceil(1_000_000 / 5_000) + 1, `${s.logQueries - queries} queries`);
});

test('request text round-trips', () => {
  const r = { v: 1, chainId: 1, account: ACCOUNT, agent: zeroAddress, userOp: { sender: ACCOUNT, nonce: '0x1', callData: '0x', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', verificationGasLimit: '0x1', callGasLimit: '0x1', preVerificationGas: '0x1' }, agentSig: '0x' };
  assert.deepEqual(decodeRequest(encodeRequest(r)), r);
  assert.deepEqual(decodeRequest(JSON.stringify(r)), r);
  assert.throws(() => decodeRequest('not a request!'));
});
