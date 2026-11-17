// Agent sessions on PasskeyAccount: grant, read, revoke, and approving an agent's
// over-budget request. Granting and revoking are calls to the account itself, which
// its policy always prices at both keys.
import {
  concatHex, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress,
  parseAbi, parseAbiParameters, recoverAddress, toFunctionSelector, toHex, zeroAddress, type Address, type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { rpc } from './rpc';
import { sign, type Assertion } from './passkey';
import type { Account } from './account';
import { tokenInfo } from './token';

const net = __HAPTIX_NETWORK__;

export const agentAbi = parseAbi([
  'struct SessionConfig { address agentKey; uint48 validAfter; uint48 validUntil; uint256 humanApprovalThreshold; uint256 perTxLimitEth; uint256 perTxLimitToken; uint256 windowDuration; address[] allowedProtocols; bytes4[] allowedSelectors; address[] allowedTokens; uint256[] tokenWindowCaps; }',
  'function grantAgentSession(SessionConfig config)',
  'function revokeAgentSession(address agentKey)',
  'function agentSessions(address) view returns (uint48 validAfter, uint48 validUntil, bool isRegistered, bool revoked, uint256 humanApprovalThreshold, uint256 perTxLimitEth, uint256 perTxLimitToken, uint256 windowSeconds)',
  'function agentWindow(address, address) view returns (uint96 spent, uint48 expiry)',
  'function executeByAgent(address agentKey, address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dests, uint256[] values, bytes[] funcs)',
]);
/** The swap call the account's policy can price: Uniswap SwapRouter02's exactInputSingle. */
export const swapAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);
const SWAP_SELECTOR = toFunctionSelector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))');
const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
]);
const PASSKEY_SIGS = '(bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)[]';
/** First byte of an agent op's signature: 0x01 agent alone, 0x02 agent plus both passkeys. */
const SIG_TYPE_ESCALATED = '0x02';
/** The account's key for native ETH in its per-asset maps. */
const ETH = zeroAddress;
/** A plain ETH payment to an allowed address is not a function call: no selector. */
const NO_SELECTOR: Hex = '0x00000000';

const ethCall = (to: Address, data: Hex) => rpc<Hex>(net.rpcUrl, 'eth_call', [{ to, data }, 'latest']);

/** What the wallet keeps about an agent. The chain has no names; the private key is never kept. */
export interface AgentRecord {
  address: Address;
  name: string;
  /** Addresses it may pay ('pay' agents). */
  recipients: Address[];
  /** A trading agent: spends `token` for `tokenOut` through `router`. Absent means it pays ETH. */
  swap?: { router: Address; token: AgentToken; tokenOut: AgentToken };
  budgetWei: string;
  perPaymentWei: string;
  windowSeconds: number;
  validUntil: number;
  grantedAt: number;
}

export interface AgentToken { address: Address; symbol: string; decimals: number }

export function newAgentKey() {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/** Calldata for the account to call grantAgentSession on itself (wrap in execute). */
export function grantCall(r: AgentRecord): Hex {
  const budget = BigInt(r.budgetWei);
  const perPayment = BigInt(r.perPaymentWei);
  return encodeFunctionData({
    abi: agentAbi,
    functionName: 'grantAgentSession',
    args: [{
      agentKey: r.address,
      validAfter: 0,
      validUntil: r.validUntil,
      // Escalated requests already need both of your keys, so they have no extra cap.
      humanApprovalThreshold: 0n,
      perTxLimitEth: r.swap ? 0n : perPayment,
      perTxLimitToken: r.swap ? perPayment : 0n,
      windowDuration: BigInt(r.windowSeconds),
      allowedProtocols: r.swap ? [r.swap.router] : r.recipients,
      allowedSelectors: r.swap ? [SWAP_SELECTOR] : r.recipients.map(() => NO_SELECTOR),
      // Only the spent token gets a window; tokenOut can't be spent without an approval.
      allowedTokens: r.swap ? [r.swap.token.address, r.swap.tokenOut.address] : [ETH],
      tokenWindowCaps: r.swap ? [budget, 0n] : [budget],
    }],
  });
}

const batch = (calls: { to: Address; data: Hex }[]): Hex => encodeFunctionData({
  abi: agentAbi, functionName: 'executeBatch',
  args: [calls.map((c) => c.to), calls.map(() => 0n), calls.map((c) => c.data)],
});

/**
 * A trading agent also needs the router approved to spend its token. Agents can never
 * approve, so the owner does it with the grant, in one operation, for no more than the
 * agent could spend over the whole session.
 */
export function grantSwapBatch(account: Address, r: AgentRecord): Hex {
  if (!r.swap) throw new Error('Not a trading agent.');
  const days = BigInt(Math.max(1, Math.ceil((r.validUntil - r.grantedAt / 1000) / r.windowSeconds)));
  return batch([
    { to: account, data: grantCall(r) },
    { to: r.swap.token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [r.swap.router, BigInt(r.budgetWei) * days] }) },
  ]);
}

/** Revoking a trading agent also takes back the router's approval. */
export function revokeSwapBatch(account: Address, r: AgentRecord): Hex {
  if (!r.swap) throw new Error('Not a trading agent.');
  return batch([
    { to: account, data: revokeCall(r.address) },
    { to: r.swap.token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [r.swap.router, 0n] }) },
  ]);
}

export const revokeCall = (agent: Address): Hex => encodeFunctionData({ abi: agentAbi, functionName: 'revokeAgentSession', args: [agent] });

export interface AgentOnChain { registered: boolean; revoked: boolean; validUntil: number; spentWei: bigint; resetsAt: number | null }

/** Session flags and what the agent has spent in its current window. */
export async function readAgent(account: Address, agent: Address, asset: Address = ETH): Promise<AgentOnChain> {
  const [s, w] = await Promise.all([
    ethCall(account, encodeFunctionData({ abi: agentAbi, functionName: 'agentSessions', args: [agent] })),
    ethCall(account, encodeFunctionData({ abi: agentAbi, functionName: 'agentWindow', args: [agent, asset] })),
  ]);
  const [, validUntil, registered, revoked] = decodeFunctionResult({ abi: agentAbi, functionName: 'agentSessions', data: s });
  const [spent, expiry] = decodeFunctionResult({ abi: agentAbi, functionName: 'agentWindow', data: w });
  const now = Math.floor(Date.now() / 1000);
  const open = Number(expiry) > now; // a closed window has nothing spent in it
  return { registered, revoked, validUntil: Number(validUntil), spentWei: open ? BigInt(spent) : 0n, resetsAt: open ? Number(expiry) : null };
}

// --- Over-budget requests --------------------------------------------------

/** What an agent hands the owner when the contract stops it (see scripts/agent-pay.mjs). */
export interface AgentRequestPayload {
  v: 1;
  chainId: number;
  account: Address;
  agent: Address;
  /** The full op as the bundler takes it; its signature field is a placeholder. */
  userOp: Record<string, Hex | Address | undefined>;
  agentSig: Hex;
}

export interface AgentRequest {
  payload: AgentRequestPayload;
  to: Address;
  valueWei: bigint;
  data: Hex;
  userOpHash: Hex;
  /** Set when the request is a swap, decoded from the bytes being signed. */
  swap: { tokenIn: AgentToken; tokenOut: AgentToken; amountIn: bigint; amountOutMinimum: bigint; recipient: Address } | null;
}

const pack = (hi: Hex, lo: Hex) => concatHex([toHex(BigInt(hi), { size: 16 }), toHex(BigInt(lo), { size: 16 })]);

/** Decode and check a pasted request: right chain, right account, signed by that agent. */
export async function parseAgentRequest(text: string, account: Account): Promise<AgentRequest> {
  let payload: AgentRequestPayload;
  try {
    const json = text.trim().startsWith('{') ? text.trim() : atob(text.trim().replace(/-/g, '+').replace(/_/g, '/'));
    payload = JSON.parse(json);
  } catch {
    throw new Error('That isn\'t an agent request. Paste the whole text the agent printed.');
  }
  if (payload.v !== 1) throw new Error('This request comes from a newer agent tool.');
  if (payload.chainId !== net.chainId) throw new Error(`The request is for chain ${payload.chainId}, not ${net.name}.`);
  const op = payload.userOp;
  if (!op.sender || getAddress(op.sender) !== getAddress(account.address)) throw new Error('The request is for a different account.');
  const call = decodeFunctionData({ abi: agentAbi, data: op.callData as Hex });
  if (call.functionName !== 'executeByAgent') throw new Error('The request isn\'t an agent payment.');
  const [agent, to, value, data] = call.args as [Address, Address, bigint, Hex];
  if (getAddress(agent) !== getAddress(payload.agent)) throw new Error('The request names a different agent than the one that signed it.');

  const packed = {
    sender: op.sender as Address,
    nonce: BigInt(op.nonce!),
    initCode: op.factory ? concatHex([op.factory as Hex, op.factoryData as Hex]) : '0x' as Hex,
    callData: op.callData as Hex,
    accountGasLimits: pack(op.verificationGasLimit as Hex, op.callGasLimit as Hex),
    preVerificationGas: BigInt(op.preVerificationGas!),
    gasFees: pack(op.maxPriorityFeePerGas as Hex, op.maxFeePerGas as Hex),
    paymasterAndData: '0x' as Hex,
    signature: '0x' as Hex,
  };
  const userOpHash = decodeFunctionResult({
    abi: entryPointAbi, functionName: 'getUserOpHash',
    data: await ethCall(net.entryPoint, encodeFunctionData({ abi: entryPointAbi, functionName: 'getUserOpHash', args: [packed] })),
  });
  const signer = await recoverAddress({ hash: userOpHash, signature: payload.agentSig });
  if (getAddress(signer) !== getAddress(agent)) throw new Error('The agent\'s signature doesn\'t match this request.');
  let swap: AgentRequest['swap'] = null;
  if (data !== '0x') {
    let params;
    try {
      params = decodeFunctionData({ abi: swapAbi, data }).args[0];
    } catch {
      throw new Error('The request calls something this wallet can\'t read, so it won\'t sign it.');
    }
    const token = async (a: Address): Promise<AgentToken> => {
      const info = await tokenInfo(a);
      if (!info) throw new Error(`${a} doesn't answer like a token, so this wallet won't sign the request.`);
      return { address: getAddress(a), ...info };
    };
    const [tokenIn, tokenOut] = await Promise.all([token(params.tokenIn), token(params.tokenOut)]);
    swap = { tokenIn, tokenOut, amountIn: params.amountIn, amountOutMinimum: params.amountOutMinimum, recipient: getAddress(params.recipient) };
  }
  return { payload, to: getAddress(to), valueWei: value, data, userOpHash, swap };
}

/** Add both passkeys to the agent's signature and submit. Returns the user op hash. onSigning gets 0, 1, then 2 once both are signed. */
export async function approveAgentRequest(
  req: AgentRequest, account: Account, bundlerUrl: string, onSigning: (index: number) => void,
): Promise<Hex> {
  const sigs: Assertion[] = [];
  for (const id of [0, 1]) {
    onSigning(id);
    sigs.push(await sign(account.keys[id], req.userOpHash));
  }
  const body = encodeAbiParameters(parseAbiParameters(`address agentKey, bytes agentSig, uint256[] ids, ${PASSKEY_SIGS} sigs`), [
    req.payload.agent, req.payload.agentSig, [0n, 1n], sigs,
  ]);
  const signature = concatHex([SIG_TYPE_ESCALATED, body]);
  onSigning(2); // both signed: submitting
  return rpc<Hex>(bundlerUrl, 'eth_sendUserOperation', [{ ...req.payload.userOp, signature }, net.entryPoint]);
}
