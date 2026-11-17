#!/usr/bin/env node
/**
 * The agent SDK (agent-sdk/) end to end on a live chain, with the account from
 * scripts/chain-e2e.mjs. Software passkeys stand in for the owner's wallet, and a local
 * bundler (scripts/lib/dev-bundler.mjs) for a hosted one.
 *
 *   Payments
 *    1. Owner grants a payment budget (both passkeys)
 *    2. budget() reads it
 *    3. Pay within budget                          -> done, agent key only
 *    4. Pay again, filling the budget              -> done
 *    5. Pay past the budget                        -> needs approval, nothing sent
 *    6. Pay over the per-payment limit             -> needs approval (same nonce)
 *    7. Owner approves request 6 with both keys    -> waitForOperation sees it land
 *    8. Request 5, which used the same nonce       -> superseded
 *    9. Pay someone the owner didn't allow         -> refused (not-allowed)
 *   Trades (testnet demo router)
 *   10. Owner grants a trading budget and approves the router (both passkeys)
 *   11. Swap within budget                         -> done, tokens arrive
 *   12. Swap with no minimum out                   -> refused (invalid-argument)
 *   13. Swap over the per-trade limit              -> needs approval
 *   Owner controls
 *   14. Freeze (one passkey)                       -> refused (frozen); unfreeze (both)
 *   15. Revoke both agents (both passkeys)         -> refused (revoked)
 *
 *   npm run build:agent-sdk
 *   set -a; source networks/robinhood-testnet.env; set +a
 *   DEPLOYER_ACCOUNT=<keystore> node scripts/agent-sdk-e2e.mjs
 */
import {
  concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiParameters,
  toFunctionSelector,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  account, assert as passkeyAssert, buildOp, castSend, cfg, check, ethCall, expectSuccess, failed, need, passkeySig, payer,
  PASSKEYS, rpc, selfCall,
} from './lib/e2e-account.mjs';
import { startDevBundler } from './lib/dev-bundler.mjs';
import { createHaptixAgent, decodeRequest, ETH, HaptixAgentError } from '../agent-sdk/dist/index.js';

const payment = BigInt(need('AGENT_E2E_PAYMENT_WEI'));
const budget = BigInt(need('AGENT_E2E_BUDGET_WEI'));
const trade = BigInt(need('AGENT_TRADE_PAYMENT_WEI'));
const tradeBudget = BigInt(need('AGENT_TRADE_BUDGET_WEI'));
const minOut = BigInt(need('AGENT_TRADE_MIN_OUT_WEI'));
const gas = BigInt(need('AGENT_E2E_GRANT_CALL_GAS'));
const usd = getAddress(need('DEMO_USD_TOKEN'));
const stock = getAddress(need('DEMO_STOCK_TOKEN'));
const router = getAddress(need('SWAP_ROUTER'));
const fee = Number(need('SWAP_POOL_FEE'));
if (payment * 2n !== budget || trade * 2n !== tradeBudget) {
  console.error('Config error: each budget must be exactly two payments.');
  process.exit(2);
}

const abi = parseAbi([
  'struct SessionConfig { address agentKey; uint48 validAfter; uint48 validUntil; uint256 humanApprovalThreshold; uint256 perTxLimitEth; uint256 perTxLimitToken; uint256 windowDuration; address[] allowedProtocols; bytes4[] allowedSelectors; address[] allowedTokens; uint256[] tokenWindowCaps; }',
  'function grantAgentSession(SessionConfig config)',
  'function revokeAgentSession(address agentKey)',
  'function executeBatch(address[] dests, uint256[] values, bytes[] funcs)',
  'function freeze()',
  'function unfreeze()',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function mint(address to, uint256 amount)',
]);
const enc = (functionName, args = []) => encodeFunctionData({ abi, functionName, args });
const read = async (to, functionName, args) => decodeFunctionResult({ abi, functionName, data: await ethCall(to, enc(functionName, args)) });
const batch = (calls) => enc('executeBatch', [calls.map((c) => c[0]), calls.map(() => 0n), calls.map((c) => c[1])]);
const day = 86_400n;
const until = () => Number(BigInt(Math.floor(Date.now() / 1000)) + day);
const NO_SELECTOR = '0x00000000';
const SWAP_SELECTOR = toFunctionSelector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))');

const bundler = await startDevBundler();
const sdk = (key) => createHaptixAgent({
  rpcUrl: cfg.rpc, bundlerUrl: bundler.url, entryPoint: cfg.entryPoint, account, agentKey: key, chainId: Number(cfg.chainId),
});
const payKey = generatePrivateKey();
const tradeKey = generatePrivateKey();
const payer1 = sdk(payKey);
const trader = sdk(tradeKey);

const refusal = async (label, promise, code) => {
  try {
    await promise;
    check(label, false, 'it went through');
  } catch (e) {
    check(label, e instanceof HaptixAgentError && e.code === code, e instanceof HaptixAgentError ? e.code : e.message);
  }
};
const nonce = async () => BigInt(await ethCall(cfg.entryPoint, encodeFunctionData({
  abi: parseAbi(['function getNonce(address, uint192) view returns (uint256)']), functionName: 'getNonce', args: [account, 0n],
})));

/** What the wallet does on Approve: add both passkeys to the agent's signature, then submit. */
async function ownerApproves(requestText) {
  const r = decodeRequest(requestText);
  const hash = await opHashOf(r.userOp);
  const sigs = await Promise.all([0, 1].map((i) => passkeyAssert(i, hash)));
  const body = encodeAbiParameters(parseAbiParameters(`address agentKey, bytes agentSig, uint256[] ids, ${PASSKEYS} sigs`), [r.agent, r.agentSig, [0n, 1n], sigs]);
  return rpcBundler('eth_sendUserOperation', [{ ...r.userOp, signature: concatHex(['0x02', body]) }, cfg.entryPoint]);
}
async function opHashOf(op) {
  const ep = parseAbi([
    'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
    'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  ]);
  const pack = (hi, lo) => concatHex([`0x${BigInt(hi).toString(16).padStart(32, '0')}`, `0x${BigInt(lo).toString(16).padStart(32, '0')}`]);
  const data = encodeFunctionData({ abi: ep, functionName: 'getUserOpHash', args: [{
    sender: op.sender, nonce: BigInt(op.nonce), initCode: '0x', callData: op.callData,
    accountGasLimits: pack(op.verificationGasLimit, op.callGasLimit), preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: pack(op.maxPriorityFeePerGas, op.maxFeePerGas), paymasterAndData: '0x', signature: '0x',
  }] });
  return decodeFunctionResult({ abi: ep, functionName: 'getUserOpHash', data: await ethCall(cfg.entryPoint, data) });
}
let bid = 0;
async function rpcBundler(method, params) {
  const res = await fetch(bundler.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++bid, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

console.log(`Account ${account}\nPayer   ${payer}\nAgents  ${payer1.address} (pay), ${trader.address} (trade)\n`);

try {
  // Enough ETH for the payments plus each operation's gas prefund.
  const balance = BigInt(await rpc('eth_getBalance', [account, 'latest']));
  const want = budget * 4n;
  if (balance < want) {
    castSend(account, '0x', want - balance);
    console.log(`   funded the account with ${want - balance} wei`);
  }

  // --- Payments ---------------------------------------------------------------------
  const grantPay = enc('grantAgentSession', [{
    agentKey: payer1.address, validAfter: 0, validUntil: until(), humanApprovalThreshold: 0n,
    perTxLimitEth: payment, perTxLimitToken: 0n, windowDuration: day,
    allowedProtocols: [payer], allowedSelectors: [NO_SELECTOR], allowedTokens: [ETH], tokenWindowCaps: [budget],
  }]);
  { const b = await buildOp(selfCall(grantPay), gas); await expectSuccess('1. Owner grants a payment budget (both passkeys)', b, await passkeySig(b.hash, [0, 1])); }

  const b0 = await payer1.budget();
  check('2. budget() reads it', b0.status === 'active' && b0.perPayment === payment && b0.windowCap === budget && b0.spent === 0n && b0.allowed, { status: b0.status, perPayment: `${b0.perPayment}`, cap: `${b0.windowCap}` });

  const p1 = await payer1.pay(payer, payment);
  check('3. Pay within budget: done with the agent key alone', p1.status === 'done', p1.transactionHash ?? p1.status);
  if (p1.transactionHash) console.log(`   ${cfg.explorer}tx/${p1.transactionHash}`);
  const p2 = await payer1.pay(payer, payment);
  const b2 = await payer1.budget();
  check('4. Pay again, filling the budget', p2.status === 'done' && b2.remaining === 0n, { status: p2.status, remaining: `${b2.remaining}` });

  const before = await nonce();
  const overBudget = await payer1.pay(payer, payment);
  check('5. Pay past the budget: needs approval, nothing sent', overBudget.status === 'needs-approval' && overBudget.reason === 'budget' && (await nonce()) === before, overBudget.reason);
  const overLimit = await payer1.pay(payer, payment + 1n);
  check('6. Pay over the per-payment limit: needs approval, same nonce', overLimit.status === 'needs-approval' && overLimit.reason === 'per-payment-limit' && overLimit.nonce === overBudget.nonce, overLimit.reason);

  await ownerApproves(overLimit.request);
  const landed = await payer1.waitForOperation(overLimit.userOpHash, { fromBlock: overLimit.fromBlock, nonce: overLimit.nonce });
  check('7. Owner approves with both keys; waitForOperation sees it land', landed.status === 'included' && landed.success, landed);
  if (landed.transactionHash) console.log(`   ${cfg.explorer}tx/${landed.transactionHash}`);
  const stale = await payer1.waitForOperation(overBudget.userOpHash, { fromBlock: overBudget.fromBlock, nonce: overBudget.nonce, timeoutMs: 20_000 });
  check('8. The other request on that nonce is superseded', stale.status === 'superseded', stale);

  await refusal('9. Pay someone the owner didn\'t allow: refused', payer1.pay(privateKeyToAccount(generatePrivateKey()).address, 1n), 'not-allowed');

  // --- Trades -----------------------------------------------------------------------
  if ((await read(usd, 'balanceOf', [account])) < tradeBudget * 2n) {
    castSend(usd, enc('mint', [account, tradeBudget * 2n]));
    console.log(`   minted ${tradeBudget * 2n} demo dUSD to the account`);
  }
  const grantTrade = enc('grantAgentSession', [{
    agentKey: trader.address, validAfter: 0, validUntil: until(), humanApprovalThreshold: 0n,
    perTxLimitEth: 0n, perTxLimitToken: trade, windowDuration: day,
    allowedProtocols: [router], allowedSelectors: [SWAP_SELECTOR], allowedTokens: [usd, stock], tokenWindowCaps: [tradeBudget, 0n],
  }]);
  { const b = await buildOp(batch([[account, grantTrade], [usd, enc('approve', [router, tradeBudget])]]), gas); await expectSuccess('10. Owner grants a trading budget and approves the router', b, await passkeySig(b.hash, [0, 1])); }

  const held = await read(stock, 'balanceOf', [account]);
  const s1 = await trader.swap({ router, tokenIn: usd, tokenOut: stock, amountIn: trade, minAmountOut: minOut, fee });
  check('11. Swap within budget: done, tokens arrive', s1.status === 'done' && (await read(stock, 'balanceOf', [account])) >= held + minOut, s1.transactionHash ?? s1.status);
  if (s1.transactionHash) console.log(`   ${cfg.explorer}tx/${s1.transactionHash}`);
  await refusal('12. Swap with no minimum out: refused', trader.swap({ router, tokenIn: usd, tokenOut: stock, amountIn: trade, minAmountOut: 0n, fee }), 'invalid-argument');
  const s2 = await trader.swap({ router, tokenIn: usd, tokenOut: stock, amountIn: trade + 1n, minAmountOut: minOut, fee });
  check('13. Swap over the per-trade limit: needs approval', s2.status === 'needs-approval' && s2.reason === 'per-payment-limit', s2.reason);

  // --- Owner controls ---------------------------------------------------------------
  { const b = await buildOp(selfCall(enc('freeze')), gas); await expectSuccess('14a. Freeze (one passkey)', b, await passkeySig(b.hash, [0])); }
  await refusal('14b. Agent while frozen: refused', payer1.check({ kind: 'pay', to: payer, amount: 1n }), 'frozen');
  { const b = await buildOp(selfCall(enc('unfreeze')), gas); await expectSuccess('14c. Unfreeze (both passkeys)', b, await passkeySig(b.hash, [0, 1])); }

  { const b = await buildOp(batch([[account, enc('revokeAgentSession', [payer1.address])], [account, enc('revokeAgentSession', [trader.address])], [usd, enc('approve', [router, 0n])]]), gas); await expectSuccess('15a. Revoke both agents (both passkeys)', b, await passkeySig(b.hash, [0, 1])); }
  await refusal('15b. Agent after revoke: refused', trader.check({ kind: 'swap', router, tokenIn: usd, tokenOut: stock, amountIn: 1n, minAmountOut: 1n, fee }), 'revoked');
} finally {
  bundler.close();
}
console.log(failed() ? `\n${failed()} check(s) failed` : '\nall checks passed');
process.exit(failed() ? 1 : 0);
