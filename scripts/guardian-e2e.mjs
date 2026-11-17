#!/usr/bin/env node
/**
 * Freeze, guardian and recovery end to end on a live chain, with the account from
 * scripts/chain-e2e.mjs. The deployer plays the guardian. The account ends where it
 * started: unfrozen, no guardian, no recovery pending, same keys.
 *
 *   1. Set a guardian with the contract's minimum wait (both passkeys)   -> success
 *   2. A guardian with zero wait                                         -> reverts InvalidTimelock
 *   3. Freeze with ONE passkey                                           -> success
 *   4. While frozen, a small send with one passkey                       -> rejected
 *   5. Unfreeze with one passkey                                         -> rejected
 *   6. Unfreeze with both passkeys                                       -> success
 *   7. Guardian starts a recovery to new keys                            -> success, executeAfter = now + wait
 *   8. Guardian starts it again                                          -> reverts RecoveryPending (clock can't restart)
 *   9. Anyone finishes it before the wait                                -> reverts TimelockNotExpired
 *  10. Owner cancels it with ONE passkey                                 -> success
 *  11. Remove the guardian (both passkeys)                               -> success
 *
 * Finishing a recovery after the wait isn't run live (it takes the full wait, at least
 * a day); the contract tests cover it.
 *
 * Env: a networks/*.env file, DEPLOYER_ACCOUNT [DEPLOYER_KEYSTORE_PASSWORD], and
 *   AGENT_E2E_GRANT_CALL_GAS   call gas for settings changes (reused from the agent test)
 *   E2E_SEND_UNDER_WEI         a send below the per-send limit
 */
import { webcrypto as wc } from 'node:crypto';
import { encodeFunctionData, decodeFunctionResult, parseAbi, zeroAddress } from 'viem';
import {
  account, buildOp, castSend, cfg, check, ethCall, expectRejected, expectRevert, expectSuccess, failed, link, need, passkeySig, payer,
  selfCall, sendCall,
} from './lib/e2e-account.mjs';

const settingsGas = BigInt(need('AGENT_E2E_GRANT_CALL_GAS'));
const under = BigInt(need('E2E_SEND_UNDER_WEI'));
const abi = parseAbi([
  'struct PublicKey { uint256 x; uint256 y; }',
  'function isFrozen() view returns (bool)',
  'function guardian() view returns (address)',
  'function MIN_RECOVERY_TIMELOCK() view returns (uint48)',
  'function pendingRecovery() view returns (uint48 executeAfter, bool active, bytes32 signersHash)',
  'function freeze()',
  'function unfreeze()',
  'function setGuardian(address newGuardian, uint48 timelock)',
  'function cancelRecovery()',
  'function initiateRecovery(PublicKey[] newSigners)',
  'function completeRecovery(PublicKey[] newSigners)',
  'error InvalidTimelock()',
  'error RecoveryPending()',
  'error TimelockNotExpired()',
]);
const enc = (functionName, args = []) => encodeFunctionData({ abi, functionName, args });
const read = async (functionName) => decodeFunctionResult({ abi, functionName, data: await ethCall(account, enc(functionName)) });

const min = Number(await read('MIN_RECOVERY_TIMELOCK'));
console.log(`Account  ${account}\nGuardian ${payer} (the deployer)\nMin wait ${min / 3600} hours, read from the contract\n`);

{ const b = await buildOp(selfCall(enc('setGuardian', [payer, min])), settingsGas); await expectSuccess('1. Set guardian (both passkeys)', b, await passkeySig(b.hash, [0, 1])); }
check('   guardian on chain', (await read('guardian')).toLowerCase() === payer.toLowerCase());
await expectRevert('2. Guardian with zero wait', account, enc('setGuardian', [payer, 0]), account, abi, /InvalidTimelock/);

{ const b = await buildOp(selfCall(enc('freeze'))); await expectSuccess('3. Freeze with one passkey', b, await passkeySig(b.hash, [0])); }
check('   frozen on chain', await read('isFrozen'));
{ const b = await buildOp(sendCall(payer, under), cfg.cgl, under); await expectRejected('4. While frozen, small send with one passkey', b, await passkeySig(b.hash, [0]), /AA24/); }
{ const b = await buildOp(selfCall(enc('unfreeze')), settingsGas); await expectRejected('5. Unfreeze with one passkey', b, await passkeySig(b.hash, [0]), /AA24/); }
{ const b = await buildOp(selfCall(enc('unfreeze')), settingsGas); await expectSuccess('6. Unfreeze with both passkeys', b, await passkeySig(b.hash, [0, 1])); }
check('   unfrozen on chain', !(await read('isFrozen')));

// New keys a recovering device would have made (fresh P-256 points).
const newKeys = await Promise.all([0, 1].map(async () => {
  const kp = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await wc.subtle.exportKey('jwk', kp.publicKey);
  return { x: BigInt('0x' + Buffer.from(jwk.x, 'base64url').toString('hex')), y: BigInt('0x' + Buffer.from(jwk.y, 'base64url').toString('hex')) };
}));
{
  const r = castSend(account, enc('initiateRecovery', [newKeys]));
  const [executeAfter, active] = await read('pendingRecovery');
  const block = await (await fetch(cfg.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByHash', params: [r.blockHash, false] }) })).json();
  const ts = Number(BigInt(block.result.timestamp));
  check(`7. Guardian starts recovery\n   ${link('tx', r.transactionHash)}`, r.status === '0x1' && active && Number(executeAfter) === ts + min, `executeAfter ${executeAfter} = block ${ts} + ${min}`);
}
await expectRevert('8. Guardian starts it again', account, enc('initiateRecovery', [newKeys]), payer, abi, /RecoveryPending/);
await expectRevert('9. Finish before the wait', account, enc('completeRecovery', [newKeys]), payer, abi, /TimelockNotExpired/);
{ const b = await buildOp(selfCall(enc('cancelRecovery'))); await expectSuccess('10. Owner cancels with one passkey', b, await passkeySig(b.hash, [0])); }
check('   no recovery pending', !(await read('pendingRecovery'))[1]);
{ const b = await buildOp(selfCall(enc('setGuardian', [zeroAddress, 0])), settingsGas); await expectSuccess('11. Remove guardian (both passkeys)', b, await passkeySig(b.hash, [0, 1])); }
check('   no guardian on chain', (await read('guardian')) === zeroAddress);

console.log(failed() ? `\n${failed()} check(s) failed` : '\nAll guardian checks passed.');
process.exit(failed() ? 1 : 0);
