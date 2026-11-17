#!/usr/bin/env node
// Set or clear the chain-e2e account's guardian (both passkeys), for UI tests.
//   node scripts/lib/set-guardian.mjs <guardian address | none>
import { encodeFunctionData, decodeFunctionResult, parseAbi, getAddress, zeroAddress } from 'viem';
import { account, buildOp, ethCall, expectSuccess, failed, need, passkeySig, payer, selfCall } from './e2e-account.mjs';
const abi = parseAbi(['function setGuardian(address, uint48)', 'function MIN_RECOVERY_TIMELOCK() view returns (uint48)']);
const arg = process.argv[2] ?? payer;
const g = arg === 'none' ? zeroAddress : getAddress(arg);
const min = g === zeroAddress ? 0 : Number(decodeFunctionResult({ abi, functionName: 'MIN_RECOVERY_TIMELOCK', data: await ethCall(account, encodeFunctionData({ abi, functionName: 'MIN_RECOVERY_TIMELOCK' })) }));
const b = await buildOp(selfCall(encodeFunctionData({ abi, functionName: 'setGuardian', args: [g, min] })), BigInt(need('AGENT_E2E_GRANT_CALL_GAS')));
await expectSuccess(`Guardian of ${account} -> ${g === zeroAddress ? 'none' : g}`, b, await passkeySig(b.hash, [0, 1]));
process.exit(failed() ? 1 : 0);
