#!/usr/bin/env node
/**
 * Haptix chain preflight: can this chain run a passkey account?
 *
 * Reads everything from env (load a file from networks/ first):
 *   RPC_URL, CHAIN_ID, ENTRYPOINT_ADDRESS        required
 *   FACTORY_ADDRESS                              optional: checks it is deployed
 *   DEPLOYER_ADDRESS                             optional: prints its balance
 *
 * Checks, all live against the RPC:
 *   1. The RPC's chain id equals CHAIN_ID.
 *   2. The P-256 precompile at 0x100 accepts a freshly generated valid signature
 *      and rejects the same signature with one byte flipped. A fresh key per run
 *      means no stored vector can mask a missing precompile.
 *   3. The EntryPoint has code.
 *   4. (optional) The factory has code and points at that EntryPoint.
 *
 * Exits non-zero if any required check fails.
 */
import { generateKeyPairSync, sign, createHash } from 'node:crypto';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing env ${k}. Load a networks/*.env file first.`); process.exit(2); }
  return v;
};
const RPC_URL = need('RPC_URL');
const CHAIN_ID = BigInt(need('CHAIN_ID'));
const ENTRYPOINT = need('ENTRYPOINT_ADDRESS');
const FACTORY = process.env.FACTORY_ADDRESS || '';
const DEPLOYER = process.env.DEPLOYER_ADDRESS || '';
// Protocol-defined address of the P-256 verifier (RIP-7212 / EIP-7951); the thing under test.
const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100';

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function freshP256Input() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const msg = Buffer.from(`haptix-preflight-${Date.now()}`);
  const hash = createHash('sha256').update(msg).digest();
  const sig = sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const good = Buffer.concat([hash, sig, x, y]);
  const bad = Buffer.from(good);
  bad[0] ^= 0xff; // tamper with the message hash
  return { good: '0x' + good.toString('hex'), bad: '0x' + bad.toString('hex') };
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

const chainId = BigInt(await rpc('eth_chainId', []));
check('Chain id matches CHAIN_ID', chainId === CHAIN_ID, `rpc=${chainId} expected=${CHAIN_ID}`);

const { good, bad } = freshP256Input();
const okRet = await rpc('eth_call', [{ to: P256_PRECOMPILE, data: good }, 'latest']);
const badRet = await rpc('eth_call', [{ to: P256_PRECOMPILE, data: bad }, 'latest']);
const accepts = BigInt(okRet === '0x' ? 0 : okRet) === 1n;
const rejects = badRet === '0x' || BigInt(badRet) === 0n;
check('P-256 precompile accepts a valid signature', accepts, `returned ${okRet}`);
check('P-256 precompile rejects a tampered signature', rejects, `returned ${badRet}`);

const epCode = await rpc('eth_getCode', [ENTRYPOINT, 'latest']);
check('EntryPoint deployed', epCode.length > 2, `${ENTRYPOINT} code bytes=${(epCode.length - 2) / 2}`);

if (FACTORY) {
  const fCode = await rpc('eth_getCode', [FACTORY, 'latest']);
  const deployed = fCode.length > 2;
  let ep = '';
  if (deployed) {
    const ret = await rpc('eth_call', [{ to: FACTORY, data: '0xb0d691fe' /* entryPoint() */ }, 'latest']);
    ep = '0x' + ret.slice(-40);
  }
  check('Factory deployed', deployed, `${FACTORY}`);
  if (deployed) check('Factory uses ENTRYPOINT_ADDRESS', ep.toLowerCase() === ENTRYPOINT.toLowerCase(), `factory.entryPoint()=${ep}`);
} else {
  console.log('(FACTORY_ADDRESS empty: factory not deployed on this chain yet)');
}

if (DEPLOYER) {
  const bal = BigInt(await rpc('eth_getBalance', [DEPLOYER, 'latest']));
  const gasPrice = BigInt(await rpc('eth_gasPrice', []));
  console.log(`Deployer ${DEPLOYER} balance: ${bal} wei (gas price ${gasPrice} wei)`);
}

console.log(`\nPreflight: ${process.env.NETWORK_NAME || 'chain'} (${chainId})`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.detail}]`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
