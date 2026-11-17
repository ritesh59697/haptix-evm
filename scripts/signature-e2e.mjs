#!/usr/bin/env node
/**
 * The account's signature rule on the live contract, with the account from
 * scripts/chain-e2e.mjs. Read-only: everything goes through isValidSignature.
 *
 *   personal_sign, one key, with preimage    -> accepted
 *   permit-shaped hash, one key              -> refused
 *   permit-shaped hash, both keys            -> accepted
 *   personal_sign preimage for another hash  -> refused
 *   typed-data preimage, one key             -> refused
 *
 * Env: a networks/*.env file and DEPLOYER_ACCOUNT [DEPLOYER_KEYSTORE_PASSWORD].
 */
import { concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, toHex, stringToHex, toPrefixedMessage } from 'viem';
import { PASSKEYS, account, assert, check, ethCall, failed } from './lib/e2e-account.mjs';

const abi = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)', 'function getMessageHash(bytes32) view returns (bytes32)']);
const PARAMS = parseAbiParameters(`uint256[] ids, ${PASSKEYS} sigs, bytes personal`);
const MAGIC = '0x1626ba7e';
const digest = async (hash) => decodeFunctionResult({ abi, functionName: 'getMessageHash', data: await ethCall(account, encodeFunctionData({ abi, functionName: 'getMessageHash', args: [hash] })) });
const valid = async (hash, ids, personal = '0x') => {
  const d = await digest(hash);
  const sig = encodeAbiParameters(PARAMS, [ids.map(BigInt), await Promise.all(ids.map((i) => assert(i, d))), personal]);
  const out = await ethCall(account, encodeFunctionData({ abi, functionName: 'isValidSignature', args: [hash, sig] }));
  return out.slice(0, 10) === MAGIC;
};

console.log(`Account ${account}\n`);
const preimage = toPrefixedMessage({ raw: stringToHex('Sign in to haptix.test') });
const personalHash = keccak256(preimage);
const typedPreimage = concatHex(['0x1901', keccak256(toHex('domain')), keccak256(toHex('Permit(owner,spender,value)'))]);
const permitHash = keccak256(typedPreimage);

check('personal_sign, one key, with preimage: accepted', await valid(personalHash, [0], preimage));
check('personal_sign, the other key alone: accepted', await valid(personalHash, [1], preimage));
check('permit-shaped hash, one key: refused', !(await valid(permitHash, [0])));
check('permit-shaped hash, both keys: accepted', await valid(permitHash, [0, 1]));
check('personal_sign preimage for another hash: refused', !(await valid(permitHash, [0], preimage)));
check('typed-data preimage, one key: refused', !(await valid(permitHash, [0], typedPreimage)));

console.log(failed() ? `\n${failed()} check(s) failed` : '\nAll signature checks passed.');
process.exit(failed() ? 1 : 0);
