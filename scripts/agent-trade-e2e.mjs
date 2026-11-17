#!/usr/bin/env node
/**
 * An agent trading within its budget, on a live chain, with the account from
 * scripts/chain-e2e.mjs. The router and tokens are the testnet demo DEX.
 *
 *   1. Grant a token budget and approve the router in one op (both passkeys) -> success
 *   2. Agent swaps within budget, agent key only                             -> success
 *   3. Agent swaps more than its per-trade limit                             -> rejected
 *   4. Agent sends what it buys to someone else                              -> rejected
 *   5. Agent swaps again, filling the budget                                 -> success
 *   6. Agent swaps past the budget                                           -> rejected
 *   7. The same swap with the agent key + both passkeys                      -> success
 *   8. Revoke and take back the approval, in one op (both passkeys)          -> success
 *   9. Agent swaps after revoke                                              -> rejected
 *
 * Env: a networks/*.env file and DEPLOYER_ACCOUNT [DEPLOYER_KEYSTORE_PASSWORD].
 */
import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, parseAbiParameters, parseAbi, concatHex, toFunctionSelector, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PASSKEYS, account, assert, buildOp, castSend, check, ethCall, expectRejected, expectSuccess, failed, need, passkeySig, payer } from './lib/e2e-account.mjs';

const budget = BigInt(need('AGENT_TRADE_BUDGET_WEI'));
const trade = BigInt(need('AGENT_TRADE_PAYMENT_WEI'));
const minOut = BigInt(need('AGENT_TRADE_MIN_OUT_WEI'));
const gas = BigInt(need('AGENT_E2E_GRANT_CALL_GAS'));
const usd = getAddress(need('DEMO_USD_TOKEN'));
const stock = getAddress(need('DEMO_STOCK_TOKEN'));
const router = getAddress(need('SWAP_ROUTER'));
if (trade * 2n !== budget) { console.error('Config error: the budget must be exactly two trades.'); process.exit(2); }

const abi = parseAbi([
  'struct SessionConfig { address agentKey; uint48 validAfter; uint48 validUntil; uint256 humanApprovalThreshold; uint256 perTxLimitEth; uint256 perTxLimitToken; uint256 windowDuration; address[] allowedProtocols; bytes4[] allowedSelectors; address[] allowedTokens; uint256[] tokenWindowCaps; }',
  'function grantAgentSession(SessionConfig config)',
  'function revokeAgentSession(address agentKey)',
  'function executeByAgent(address agentKey, address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dests, uint256[] values, bytes[] funcs)',
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function mint(address to, uint256 amount)',
]);
const enc = (functionName, args = []) => encodeFunctionData({ abi, functionName, args });
const read = async (to, functionName, args) => decodeFunctionResult({ abi, functionName, data: await ethCall(to, enc(functionName, args)) });

const agent = privateKeyToAccount(generatePrivateKey());
const AGENT_SIG = parseAbiParameters('address agentKey, bytes agentSig');
const ESCALATED_SIG = parseAbiParameters(`address agentKey, bytes agentSig, uint256[] ids, ${PASSKEYS} sigs`);
const agentSig = async (hash) => concatHex(['0x01', encodeAbiParameters(AGENT_SIG, [agent.address, await agent.sign({ hash })])]);
const swap = (amountIn, recipient = account) => enc('executeByAgent', [agent.address, router, 0n, enc('exactInputSingle', [{ tokenIn: usd, tokenOut: stock, fee: 0, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }])]);
const batch = (calls) => enc('executeBatch', [calls.map((c) => c[0]), calls.map(() => 0n), calls.map((c) => c[1])]);

console.log(`Account ${account}\nAgent   ${agent.address}\nRouter  ${router}\nBudget  ${budget} dUSD units per 24h, ${trade} per trade\n`);

const held = await read(usd, 'balanceOf', [account]);
if (held < budget * 2n) {
  const r = castSend(usd, enc('mint', [account, budget * 2n]));
  if (r.status !== '0x1') throw new Error('minting demo tokens failed');
  console.log(`   minted ${budget * 2n} demo dUSD to the account`);
}

const day = 86_400n;
const grant = enc('grantAgentSession', [{
  agentKey: agent.address, validAfter: 0, validUntil: Number(BigInt(Math.floor(Date.now() / 1000)) + day), humanApprovalThreshold: 0n,
  perTxLimitEth: 0n, perTxLimitToken: trade, windowDuration: day,
  allowedProtocols: [router], allowedSelectors: [toFunctionSelector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))')],
  allowedTokens: [usd, stock], tokenWindowCaps: [budget, 0n],
}]);
{ const b = await buildOp(batch([[account, grant], [usd, enc('approve', [router, budget * 2n])]]), gas); await expectSuccess('1. Grant budget + approve router (both passkeys)', b, await passkeySig(b.hash, [0, 1])); }
check('   router approved', (await read(usd, 'allowance', [account, router])) === budget * 2n);

const before = await read(stock, 'balanceOf', [account]);
{ const b = await buildOp(swap(trade), gas); await expectSuccess('2. Agent swaps within budget', b, await agentSig(b.hash)); }
check('   account received what it bought', (await read(stock, 'balanceOf', [account])) === before + minOut);
{ const b = await buildOp(swap(trade + 1n), gas); await expectRejected('3. Agent swaps over its per-trade limit', b, await agentSig(b.hash), /AA24/); }
{ const b = await buildOp(swap(trade, payer), gas); await expectRejected('4. Agent sends the proceeds to someone else', b, await agentSig(b.hash), /AA24/); }
{ const b = await buildOp(swap(trade), gas); await expectSuccess('5. Agent swaps again, budget now full', b, await agentSig(b.hash)); }
{
  const b = await buildOp(swap(trade), gas);
  await expectRejected('6. Agent swaps past the budget', b, await agentSig(b.hash), /AA22|AA24/);
  const escalated = concatHex(['0x02', encodeAbiParameters(ESCALATED_SIG, [agent.address, await agent.sign({ hash: b.hash }), [0n, 1n], await Promise.all([0, 1].map((i) => assert(i, b.hash)))])]);
  await expectSuccess('7. Same swap with agent key + both passkeys', b, escalated);
}
{ const b = await buildOp(batch([[account, enc('revokeAgentSession', [agent.address])], [usd, enc('approve', [router, 0n])]]), gas); await expectSuccess('8. Revoke + take back approval (both passkeys)', b, await passkeySig(b.hash, [0, 1])); }
check('   router no longer approved', (await read(usd, 'allowance', [account, router])) === 0n);
{ const b = await buildOp(swap(trade), gas); await expectRejected('9. Agent swaps after revoke', b, await agentSig(b.hash), /AA24/); }

console.log(failed() ? `\n${failed()} check(s) failed` : '\nAll agent trading checks passed.');
process.exit(failed() ? 1 : 0);
