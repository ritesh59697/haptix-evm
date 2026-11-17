#!/usr/bin/env node
/**
 * Agent budgets end to end on a live chain, with the account from scripts/chain-e2e.mjs
 * (run that first; it keeps its software passkeys in .haptix-e2e/).
 *
 *   1. Grant an agent a budget (both passkeys)               -> must succeed
 *   2. Agent pays within budget, agent key only              -> must succeed
 *   3. Agent pays again, filling the budget                  -> must succeed
 *   4. Agent pays past the budget, agent key only            -> must be rejected
 *   5. The same payment with the agent key + both passkeys   -> must succeed
 *   6. Revoke the agent (both passkeys)                      -> must succeed
 *   7. Agent pays after revoke                               -> must be rejected
 *
 * The session is encoded like the extension's grant (extension-app/src/chain/agents.ts)
 * and the agent signatures like scripts/agent-pay.mjs.
 *
 * Env: a networks/*.env file, DEPLOYER_ACCOUNT [DEPLOYER_KEYSTORE_PASSWORD], and
 *   AGENT_E2E_BUDGET_WEI     the agent's 24h budget
 *   AGENT_E2E_PAYMENT_WEI    one payment (the budget must fit exactly two)
 *   AGENT_E2E_GRANT_CALL_GAS call gas for grant/revoke (they write several storage slots)
 */
import { encodeFunctionData, encodeAbiParameters, parseAbiParameters, parseAbi, concatHex, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PASSKEYS, account, assert, buildOp, cfg, expectRejected, expectSuccess, failed, need, passkeySig, payer, selfCall } from './lib/e2e-account.mjs';

const budget = BigInt(need('AGENT_E2E_BUDGET_WEI'));
const payment = BigInt(need('AGENT_E2E_PAYMENT_WEI'));
const grantGas = BigInt(need('AGENT_E2E_GRANT_CALL_GAS'));
if (payment * 2n !== budget) { console.error('Config error: AGENT_E2E_BUDGET_WEI must be exactly two payments.'); process.exit(2); }

const abi = parseAbi([
  'struct SessionConfig { address agentKey; uint48 validAfter; uint48 validUntil; uint256 humanApprovalThreshold; uint256 perTxLimitEth; uint256 perTxLimitToken; uint256 windowDuration; address[] allowedProtocols; bytes4[] allowedSelectors; address[] allowedTokens; uint256[] tokenWindowCaps; }',
  'function grantAgentSession(SessionConfig config)',
  'function revokeAgentSession(address agentKey)',
  'function executeByAgent(address agentKey, address dest, uint256 value, bytes func)',
]);
const AGENT_SIG = parseAbiParameters('address agentKey, bytes agentSig');
const ESCALATED_SIG = parseAbiParameters(`address agentKey, bytes agentSig, uint256[] ids, ${PASSKEYS} sigs`);

const agent = privateKeyToAccount(generatePrivateKey());
const agentSig = async (hash) => concatHex(['0x01', encodeAbiParameters(AGENT_SIG, [agent.address, await agent.sign({ hash })])]);
const agentPay = (value) => encodeFunctionData({ abi, functionName: 'executeByAgent', args: [agent.address, payer, value, '0x'] });

console.log(`Account ${account}\nAgent   ${agent.address}\nPays    ${payer}\nBudget  ${budget} wei per 24h, ${payment} wei per payment\n`);

const day = 86_400n;
const grant = encodeFunctionData({
  abi, functionName: 'grantAgentSession',
  args: [{
    agentKey: agent.address, validAfter: 0, validUntil: Number(BigInt(Math.floor(Date.now() / 1000)) + day), humanApprovalThreshold: 0n,
    perTxLimitEth: payment, perTxLimitToken: 0n, windowDuration: day,
    allowedProtocols: [payer], allowedSelectors: ['0x00000000'], allowedTokens: [zeroAddress], tokenWindowCaps: [budget],
  }],
});
{ const b = await buildOp(selfCall(grant), grantGas); await expectSuccess('1. Grant budget with both passkeys', b, await passkeySig(b.hash, [0, 1])); }
{ const b = await buildOp(agentPay(payment), cfg.cgl, payment); await expectSuccess('2. Agent pays within budget', b, await agentSig(b.hash)); }
{ const b = await buildOp(agentPay(payment), cfg.cgl, payment); await expectSuccess('3. Agent pays again, budget now full', b, await agentSig(b.hash)); }
{
  const b = await buildOp(agentPay(payment), cfg.cgl, payment);
  await expectRejected('4. Agent pays past budget with its key alone', b, await agentSig(b.hash), /AA22|AA24/);
  const escalated = concatHex(['0x02', encodeAbiParameters(ESCALATED_SIG, [agent.address, await agent.sign({ hash: b.hash }), [0n, 1n], await Promise.all([0, 1].map((i) => assert(i, b.hash)))])]);
  await expectSuccess('5. Same payment with agent key + both passkeys', b, escalated);
}
{ const b = await buildOp(selfCall(encodeFunctionData({ abi, functionName: 'revokeAgentSession', args: [agent.address] })), grantGas); await expectSuccess('6. Revoke with both passkeys', b, await passkeySig(b.hash, [0, 1])); }
{ const b = await buildOp(agentPay(payment), cfg.cgl, payment); await expectRejected('7. Agent pays after revoke', b, await agentSig(b.hash), /AA24/); }

console.log(failed() ? `\n${failed()} step(s) failed` : '\nAll 7 agent checks passed.');
process.exit(failed() ? 1 : 0);
