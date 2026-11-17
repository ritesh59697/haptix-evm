#!/usr/bin/env node
/**
 * Pay or trade from a Haptix account as one of its agents.
 *
 * The agent key comes from the extension (Agents → New budget), which shows it once.
 * Within the agent's budget it goes through with the agent's signature alone.
 * When the contract stops it (over the 24h budget or the per-payment limit), this prints
 * a request: paste it into the extension (Agents → paste button) and approve it with
 * both of your keys. The request carries this exact operation and the agent's signature,
 * so the wallet only adds its own two signatures.
 *
 *   set -a; source networks/robinhood-testnet.env; set +a
 *   HAPTIX_AGENT_KEY=0x… HAPTIX_ACCOUNT=0x… BUNDLER_URL=https://… \
 *     node scripts/agent-pay.mjs <to> <amount in ETH>
 *
 *   # A trading agent (also needs SWAP_ROUTER, which the network file sets):
 *     node scripts/agent-pay.mjs swap <tokenIn> <tokenOut> <amount> <minimum out>
 */
import {
  concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, formatEther, getAddress,
  formatUnits, parseAbi, parseAbiParameters, parseEther, parseUnits, toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k}. See the comment at the top of this file.`);
    process.exit(2);
  }
  return v;
};
const args = process.argv.slice(2);
const isSwap = args[0] === 'swap';
if (isSwap ? args.length !== 5 : args.length !== 2) {
  console.error('Usage: node scripts/agent-pay.mjs <to> <amount in ETH>\n   or: node scripts/agent-pay.mjs swap <tokenIn> <tokenOut> <amount> <minimum out>');
  process.exit(2);
}
const RPC_URL = need('RPC_URL');
const CHAIN_ID = Number(need('CHAIN_ID'));
const ENTRYPOINT = getAddress(need('ENTRYPOINT_ADDRESS'));
const BUNDLER_URL = need('BUNDLER_URL');
const ACCOUNT = getAddress(need('HAPTIX_ACCOUNT'));
const agent = privateKeyToAccount(need('HAPTIX_AGENT_KEY'));

const accountAbi = parseAbi([
  'function executeByAgent(address agentKey, address dest, uint256 value, bytes func)',
  'function agentSessions(address) view returns (uint48 validAfter, uint48 validUntil, bool isRegistered, bool revoked, uint256 humanApprovalThreshold, uint256 perTxLimitEth, uint256 perTxLimitToken, uint256 windowSeconds)',
  'function agentWindow(address, address) view returns (uint96 spent, uint48 expiry)',
  'function agentWindowCap(address, address) view returns (uint256)',
]);
const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);
const swapAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);
const decimalsAbi = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const ETH = '0x0000000000000000000000000000000000000000';
const AGENT_SIG = parseAbiParameters('address agentKey, bytes agentSig');
const ESCALATED_SIG = parseAbiParameters(
  'address agentKey, bytes agentSig, uint256[] ids, (bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)[] sigs',
);

let id = 0;
async function rpc(url, method, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const body = await res.json();
  if (body.error) {
    const e = new Error(`${method}: ${body.error.message}`);
    e.rpc = body.error;
    throw e;
  }
  return body.result;
}
const read = async (abi, address, functionName, args) =>
  decodeFunctionResult({ abi, functionName, data: await rpc(RPC_URL, 'eth_call', [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, 'latest']) });

// --- What this call is -----------------------------------------------------
let to, value, func, asset, unit, symbol, spendAmount, describe;
if (isSwap) {
  const [, tokenInArg, tokenOutArg, amountArg, minOutArg] = args;
  const tokenIn = getAddress(tokenInArg);
  const tokenOut = getAddress(tokenOutArg);
  to = getAddress(need('SWAP_ROUTER'));
  value = 0n;
  asset = tokenIn;
  [unit, symbol] = await Promise.all([read(decimalsAbi, tokenIn, 'decimals', []), read(decimalsAbi, tokenIn, 'symbol', [])]);
  const [unitOut, symbolOut] = await Promise.all([read(decimalsAbi, tokenOut, 'decimals', []), read(decimalsAbi, tokenOut, 'symbol', [])]);
  spendAmount = parseUnits(amountArg, unit);
  const minOut = parseUnits(minOutArg, unitOut);
  // What it buys always comes back to the account; the contract refuses anything else.
  func = encodeFunctionData({ abi: swapAbi, functionName: 'exactInputSingle', args: [{ tokenIn, tokenOut, fee: 0, recipient: ACCOUNT, amountIn: spendAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
  describe = `swapping ${amountArg} ${symbol} for at least ${minOutArg} ${symbolOut}`;
} else {
  to = getAddress(args[0]);
  value = parseEther(args[1]);
  func = '0x';
  asset = ETH;
  unit = 18;
  symbol = 'ETH';
  spendAmount = value;
  describe = `paying ${args[1]} ETH to ${to}`;
}
const fmtUnits = (v) => formatUnits(v, unit);

// --- What the contract will allow ------------------------------------------
const [, validUntil, registered, revoked, , perTxLimitEth, perTxLimitToken] = await read(accountAbi, ACCOUNT, 'agentSessions', [agent.address]);
if (!registered) {
  console.error(`Agent ${agent.address} has no session on ${ACCOUNT}.`);
  process.exit(1);
}
if (revoked) {
  console.error('This agent was revoked. Ask the owner for a new budget.');
  process.exit(1);
}
const [spent, expiry] = await read(accountAbi, ACCOUNT, 'agentWindow', [agent.address, asset]);
const cap = await read(accountAbi, ACCOUNT, 'agentWindowCap', [agent.address, asset]);
const perTxLimit = isSwap ? perTxLimitToken : perTxLimitEth;
const now = Math.floor(Date.now() / 1000);
const spentNow = Number(expiry) > now ? spent : 0n;
console.log(`Agent ${agent.address} on ${ACCOUNT}`);
console.log(`  budget: ${fmtUnits(spentNow)} of ${fmtUnits(cap)} ${symbol} used in this window; up to ${fmtUnits(perTxLimit)} ${symbol} each`);
if (Number(validUntil) <= now) console.log('  the session has ended: this needs the owner');
const within = Number(validUntil) > now && spendAmount > 0n && spendAmount <= perTxLimit && (cap === 0n || spentNow + spendAmount <= cap);
console.log(`  ${describe}: ${within ? 'within budget' : 'needs the owner'}`);

// --- Build the operation ---------------------------------------------------
const nonce = await read(entryPointAbi, ENTRYPOINT, 'getNonce', [ACCOUNT, 0n]);
const callData = encodeFunctionData({ abi: accountAbi, functionName: 'executeByAgent', args: [agent.address, to, value, func] });
let fees;
try {
  const p = await rpc(BUNDLER_URL, 'pimlico_getUserOperationGasPrice', []);
  fees = { maxFeePerGas: BigInt(p.standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.standard.maxPriorityFeePerGas) };
} catch {
  const price = BigInt(await rpc(RPC_URL, 'eth_gasPrice', []));
  fees = { maxFeePerGas: price * 2n, maxPriorityFeePerGas: price };
}

// Estimate with a placeholder of the escalated shape (agent + two passkeys), the larger
// of the two, so the same operation works whether or not the owner has to approve it.
const dummyAgentSig = concatHex([toHex(1n, { size: 32 }), toHex(1n, { size: 32 }), '0x1b']);
const cd = JSON.stringify({ type: 'webauthn.get', challenge: 'A'.repeat(43), origin: `chrome-extension://${'a'.repeat(32)}`, crossOrigin: false });
const dummyPasskey = { authenticatorData: toHex(new Uint8Array(37).fill(5)), clientDataJSON: cd, challengeIndex: BigInt(cd.indexOf('"challenge"')), typeIndex: BigInt(cd.indexOf('"type"')), r: 1n, s: 1n };
const placeholder = concatHex(['0x02', encodeAbiParameters(ESCALATED_SIG, [agent.address, dummyAgentSig, [0n, 1n], [dummyPasskey, dummyPasskey]])]);
const draft = {
  sender: ACCOUNT, nonce: toHex(nonce), callData,
  maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
};
const est = await rpc(BUNDLER_URL, 'eth_estimateUserOperationGas', [{ ...draft, signature: placeholder }, ENTRYPOINT, { [ACCOUNT]: { balance: toHex(10n ** 18n) } }]);
// The placeholder fails its checks early, so real verification costs more. Unused
// verification gas isn't charged; a wide margin only raises the prefund.
const userOp = {
  ...draft,
  verificationGasLimit: toHex(BigInt(est.verificationGasLimit) * 4n),
  callGasLimit: toHex((BigInt(est.callGasLimit) * 12n) / 10n),
  preVerificationGas: toHex((BigInt(est.preVerificationGas) * 11n) / 10n),
};
const pack = (hi, lo) => concatHex([toHex(BigInt(hi), { size: 16 }), toHex(BigInt(lo), { size: 16 })]);
const userOpHash = await read(entryPointAbi, ENTRYPOINT, 'getUserOpHash', [{
  sender: ACCOUNT, nonce, initCode: '0x', callData,
  accountGasLimits: pack(userOp.verificationGasLimit, userOp.callGasLimit),
  preVerificationGas: BigInt(userOp.preVerificationGas),
  gasFees: pack(userOp.maxPriorityFeePerGas, userOp.maxFeePerGas),
  paymasterAndData: '0x', signature: '0x',
}]);
// The account checks ecrecover(userOpHash) directly: no message prefix.
const agentSig = await agent.sign({ hash: userOpHash });

function printRequest(reason) {
  const payload = { v: 1, chainId: CHAIN_ID, account: ACCOUNT, agent: agent.address, userOp, agentSig };
  console.log(`\nThe contract stopped this payment (${reason}).`);
  console.log('Paste this into Haptix → Agents → paste button, and approve it with both keys:\n');
  console.log(Buffer.from(JSON.stringify(payload)).toString('base64url'));
  console.log('\nIt expires if the account sends anything else first (the nonce changes).');
}

if (!within) {
  printRequest('over the agent\'s limits');
  process.exit(3);
}

try {
  const opHash = await rpc(BUNDLER_URL, 'eth_sendUserOperation', [{ ...userOp, signature: concatHex(['0x01', encodeAbiParameters(AGENT_SIG, [agent.address, agentSig])]) }, ENTRYPOINT]);
  console.log(`  submitted ${opHash}`);
  for (let i = 0; i < 60; i++) {
    const r = await rpc(BUNDLER_URL, 'eth_getUserOperationReceipt', [opHash]);
    if (r) {
      console.log(`  ${r.success ? 'paid' : 'reverted'}: tx ${r.receipt.transactionHash}`);
      process.exit(r.success ? 0 : 1);
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  console.error('  no receipt after 2 minutes');
  process.exit(1);
} catch (e) {
  // AA22 (not valid yet: the window is full) or AA24 (outside the session's rules).
  if (/AA2[2-4]/.test(e.message)) {
    printRequest(e.message.match(/AA2\d[^"]*/)?.[0] ?? 'refused');
    process.exit(3);
  }
  throw e;
}
