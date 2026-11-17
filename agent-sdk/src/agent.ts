import {
  concatHex, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeEventTopics, encodeFunctionData,
  getAddress, toHex, zeroAddress, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  accountAbi, AGENT_SIG, entryPointAbi, ESCALATED_SIG, SIG_TYPE_AGENT, SWAP_SELECTOR, swapAbi, userOperationEvent,
} from './abi.js';
import { encodeRequest, type ApprovalRequest, type RequestUserOp } from './request.js';
import { rpc, RpcError, type Fetch } from './rpc.js';

/** The account's key for native ETH in its per-asset budgets. */
export const ETH: Address = zeroAddress;

export interface GasMargins {
  /**
   * Verification gas is estimated with a placeholder signature that fails its checks
   * early, so the real check costs more. Unused verification gas isn't charged; the
   * margin only raises the amount the account must hold up front.
   */
  verificationPercent: number;
  callPercent: number;
  preVerificationPercent: number;
  /** maxFeePerGas = base fee × this / 100 + priority fee, when the bundler doesn't price it. */
  baseFeePercent: number;
}

/** Margins on the bundler's estimates. These worked on Robinhood Chain testnet; override per chain if needed. */
export const DEFAULT_GAS_MARGINS: GasMargins = {
  verificationPercent: 400,
  callPercent: 120,
  preVerificationPercent: 110,
  baseFeePercent: 200,
};

export interface HaptixAgentConfig {
  /** A node for the chain the account is on. */
  rpcUrl: string;
  /** An ERC-4337 v0.7 bundler for that chain. */
  bundlerUrl: string;
  entryPoint: Address;
  /** The owner's Haptix account. */
  account: Address;
  /** The agent's private key, shown once by the wallet when the owner granted the budget. */
  agentKey: Hex;
  /** If set, every call first checks the node reports this chain. */
  chainId?: number;
  gas?: Partial<GasMargins>;
  /** How often waitForOperation polls, and for how long. */
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetch?: Fetch;
}

export type SessionStatus = 'active' | 'not-granted' | 'revoked' | 'expired' | 'not-yet-valid' | 'frozen';

/** What the agent may spend of one asset, read from the account. */
export interface Budget {
  account: Address;
  agent: Address;
  status: SessionStatus;
  /** Unix seconds. */
  validAfter: number;
  validUntil: number;
  /** ETH (the zero address) or a token. */
  asset: Address;
  /** Whether this agent may spend the asset at all. */
  allowed: boolean;
  /** The most one operation may spend without the owner. */
  perPayment: bigint;
  /** The rolling budget, or 0n for none. */
  windowCap: bigint;
  windowSeconds: number;
  /** Spent in the current window. */
  spent: bigint;
  /** Left in the current window, or null when there's no rolling budget. */
  remaining: bigint | null;
  /** When the current window ends (unix seconds), or null when none is open. */
  resetsAt: number | null;
  /** Above this, not even the owner's approval lets the agent spend (0n: no ceiling). */
  approvalCeiling: bigint;
}

export interface PayAction {
  kind: 'pay';
  to: Address;
  /** In wei. */
  amount: bigint;
}

export interface SwapAction {
  kind: 'swap';
  /** A Uniswap SwapRouter02-compatible router the owner allowed. */
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** In tokenIn's base units. */
  amountIn: bigint;
  /** In tokenOut's base units. Must be above zero: the contract requires it of agents. */
  minAmountOut: bigint;
  /** The pool's fee tier, as the router expects it. */
  fee: number;
}

export type Action = PayAction | SwapAction;

export type LimitReason = 'per-payment-limit' | 'budget';

export type Decision =
  | { decision: 'within' }
  | { decision: 'needs-approval'; reason: LimitReason; message: string };

export type Outcome =
  | { status: 'done'; userOpHash: Hex; transactionHash: Hex }
  | {
      status: 'needs-approval';
      reason: LimitReason;
      message: string;
      /** Give this to the owner: they paste it into the wallet and approve with both keys. */
      request: string;
      /** Pass to waitForOperation to learn when the owner approved it. */
      userOpHash: Hex;
      /** Where to start looking, and the nonce it uses: pass both to waitForOperation. */
      fromBlock: bigint;
      nonce: bigint;
    };

export type OperationResult =
  | { status: 'included'; success: boolean; transactionHash: Hex; actualGasCost: bigint }
  /** The account sent something else first, so this operation can never run. */
  | { status: 'superseded' };

export type ErrorCode =
  | SessionStatus
  | 'not-allowed'
  | 'above-approval-ceiling'
  | 'invalid-argument'
  | 'wrong-chain'
  | 'insufficient-funds'
  | 'bundler-rejected'
  | 'reverted'
  | 'superseded'
  | 'timeout';

/** The agent can't do this, and the owner's approval wouldn't change that. */
export class HaptixAgentError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'HaptixAgentError';
  }
}

const STATUS_MESSAGE: Record<Exclude<SessionStatus, 'active'>, string> = {
  'not-granted': 'This agent has no budget on this account.',
  revoked: 'The owner revoked this agent.',
  expired: 'This agent\'s budget has ended. Ask the owner for a new one.',
  'not-yet-valid': 'This agent\'s budget hasn\'t started yet.',
  frozen: 'The owner froze the account. No agent can spend until it is unfrozen.',
};

interface Prepared {
  userOp: RequestUserOp;
  userOpHash: Hex;
  nonce: bigint;
  agentSig: Hex;
  fromBlock: bigint;
}

interface Block {
  number: Hex;
  timestamp: Hex;
  baseFeePerGas?: Hex;
}

export class HaptixAgent {
  readonly account: Address;
  readonly address: Address;
  readonly entryPoint: Address;
  private readonly signer: PrivateKeyAccount;
  private readonly fetchFn: Fetch;
  private readonly margins: GasMargins;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private chainChecked: number | null = null;

  constructor(private readonly config: HaptixAgentConfig) {
    for (const k of ['rpcUrl', 'bundlerUrl', 'entryPoint', 'account', 'agentKey'] as const) {
      if (!config[k]) throw new HaptixAgentError('invalid-argument', `Missing ${k}.`);
    }
    this.signer = privateKeyToAccount(config.agentKey);
    this.address = this.signer.address;
    this.account = getAddress(config.account);
    this.entryPoint = getAddress(config.entryPoint);
    this.fetchFn = config.fetch ?? fetch;
    this.margins = { ...DEFAULT_GAS_MARGINS, ...config.gas };
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  // --- Reading ------------------------------------------------------------------------

  /** The agent's budget for one asset (ETH by default), as the contract sees it now. */
  async budget(asset: Address = ETH): Promise<Budget> {
    const a = getAddress(asset);
    const [session, frozen, allowed, cap, win, block] = await Promise.all([
      this.read(accountAbi, this.account, 'agentSessions', [this.address]),
      this.read(accountAbi, this.account, 'isFrozen', []),
      this.read(accountAbi, this.account, 'agentAllowedTokens', [this.address, a]),
      this.read(accountAbi, this.account, 'agentWindowCap', [this.address, a]),
      this.read(accountAbi, this.account, 'agentWindow', [this.address, a]),
      this.block(),
    ]);
    const [validAfter, validUntil, registered, revoked, ceiling, perTxEth, perTxToken, windowSeconds] = session;
    const now = Number(BigInt(block.timestamp));
    const [spentRaw, expiry] = win;
    const open = Number(expiry) > now;
    const spent = open ? BigInt(spentRaw) : 0n;
    let status: SessionStatus = 'active';
    if (!registered) status = 'not-granted';
    else if (revoked) status = 'revoked';
    else if (frozen) status = 'frozen';
    else if (now >= Number(validUntil)) status = 'expired';
    else if (now < Number(validAfter)) status = 'not-yet-valid';
    return {
      account: this.account,
      agent: this.address,
      status,
      validAfter: Number(validAfter),
      validUntil: Number(validUntil),
      asset: a,
      allowed,
      perPayment: a === ETH ? perTxEth : perTxToken,
      windowCap: cap,
      windowSeconds: Number(windowSeconds),
      spent,
      remaining: cap === 0n ? null : cap > spent ? cap - spent : 0n,
      resetsAt: open ? Number(expiry) : null,
      approvalCeiling: ceiling,
    };
  }

  /**
   * Whether the agent can do this on its own key, or needs the owner. Sends nothing.
   * Throws HaptixAgentError when it can't be done at all, not even with the owner's approval.
   */
  async check(action: Action): Promise<Decision> {
    validate(action);
    await this.ensureChain();
    const asset = action.kind === 'pay' ? ETH : getAddress(action.tokenIn);
    const amount = action.kind === 'pay' ? action.amount : action.amountIn;
    const b = await this.budget(asset);
    if (b.status !== 'active') throw new HaptixAgentError(b.status, STATUS_MESSAGE[b.status]);

    if (action.kind === 'pay') {
      const to = getAddress(action.to);
      const [protocol, recipient] = await Promise.all([
        this.read(accountAbi, this.account, 'agentAllowedProtocols', [this.address, to]),
        this.read(accountAbi, this.account, 'isAllowedRecipient', [to]),
      ]);
      if (!b.allowed) throw new HaptixAgentError('not-allowed', 'This agent may not spend ETH.');
      if (!protocol && !recipient) throw new HaptixAgentError('not-allowed', `This agent may not pay ${to}.`);
    } else {
      const router = getAddress(action.router);
      const [protocol, selector, outAllowed] = await Promise.all([
        this.read(accountAbi, this.account, 'agentAllowedProtocols', [this.address, router]),
        this.read(accountAbi, this.account, 'agentAllowedSelectors', [this.address, router, SWAP_SELECTOR]),
        this.read(accountAbi, this.account, 'agentAllowedTokens', [this.address, getAddress(action.tokenOut)]),
      ]);
      if (!protocol || !selector) throw new HaptixAgentError('not-allowed', `This agent may not trade through ${router}.`);
      if (!b.allowed) throw new HaptixAgentError('not-allowed', `This agent may not spend ${asset}.`);
      if (!outAllowed) throw new HaptixAgentError('not-allowed', `This agent may not buy ${getAddress(action.tokenOut)}.`);
    }

    let limit: { reason: LimitReason; message: string } | null = null;
    if (amount > b.perPayment) {
      limit = { reason: 'per-payment-limit', message: `${amount} is over the per-payment limit of ${b.perPayment}.` };
    } else if (b.windowCap !== 0n && b.spent + amount > b.windowCap) {
      limit = { reason: 'budget', message: `${amount} is more than the ${b.remaining} left of the budget of ${b.windowCap}.` };
    }
    if (!limit) return { decision: 'within' };
    if (b.approvalCeiling !== 0n && amount > b.approvalCeiling) {
      throw new HaptixAgentError('above-approval-ceiling', `${amount} is above ${b.approvalCeiling}, the most the owner can approve for this agent.`);
    }
    return { decision: 'needs-approval', ...limit };
  }

  // --- Acting -------------------------------------------------------------------------

  /** Pay ETH to an address the owner allowed. */
  pay(to: Address, amount: bigint): Promise<Outcome> {
    return this.run({ kind: 'pay', to, amount });
  }

  /** Swap through an allowed router. What it buys always comes back to the account. */
  swap(params: Omit<SwapAction, 'kind'>): Promise<Outcome> {
    return this.run({ kind: 'swap', ...params });
  }

  async run(action: Action): Promise<Outcome> {
    const decision = await this.check(action);
    const prepared = await this.prepare(action);
    if (decision.decision === 'needs-approval') return this.needsApproval(prepared, decision);

    let userOpHash: Hex;
    try {
      const signature = concatHex([SIG_TYPE_AGENT, encodeAbiParameters(AGENT_SIG, [this.address, prepared.agentSig])]);
      userOpHash = await rpc<Hex>(this.fetchFn, this.config.bundlerUrl, 'eth_sendUserOperation', [
        { ...prepared.userOp, signature }, this.entryPoint,
      ]);
    } catch (e) {
      // The budget can move between the check and the send (another operation, a window
      // closing). Look again: if the owner can still approve it, hand over the request.
      if (e instanceof RpcError && /AA2[2-4]/.test(e.message)) {
        const again = await this.check(action);
        if (again.decision === 'needs-approval') return this.needsApproval(prepared, again);
      }
      if (e instanceof RpcError && /AA21/.test(e.message)) {
        throw new HaptixAgentError('insufficient-funds', 'The account doesn\'t hold enough ETH to pay for this operation\'s gas.', e);
      }
      throw new HaptixAgentError('bundler-rejected', `The bundler refused the operation: ${(e as Error).message}`, e);
    }
    const result = await this.waitForOperation(userOpHash, { fromBlock: prepared.fromBlock, nonce: prepared.nonce });
    if (result.status === 'superseded') {
      throw new HaptixAgentError('superseded', 'The account sent another operation first; try again.');
    }
    if (!result.success) {
      throw new HaptixAgentError('reverted', `The operation was included but its call reverted (tx ${result.transactionHash}).`);
    }
    return { status: 'done', userOpHash, transactionHash: result.transactionHash };
  }

  /**
   * Wait until an operation is on chain, whoever submitted it: this agent, or the owner's
   * wallet after approving a request. Reads the EntryPoint's events, not a bundler.
   */
  async waitForOperation(
    userOpHash: Hex,
    opts: { fromBlock: bigint; nonce?: bigint; timeoutMs?: number },
  ): Promise<OperationResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? this.timeoutMs);
    const scan = { next: opts.fromBlock };
    for (;;) {
      const found = await this.findOperation(userOpHash, scan);
      if (found) return found;
      // Read the nonce, then look again: if the nonce moved past ours and the operation
      // still isn't there, something else used the nonce.
      if (opts.nonce !== undefined) {
        const current: bigint = await this.read(entryPointAbi, this.entryPoint, 'getNonce', [this.account, 0n]);
        if (current > opts.nonce) {
          return (await this.findOperation(userOpHash, scan)) ?? { status: 'superseded' };
        }
      }
      if (Date.now() > deadline) throw new HaptixAgentError('timeout', `Operation ${userOpHash} isn't on chain yet.`);
      await new Promise((ok) => setTimeout(ok, this.pollIntervalMs));
    }
  }

  // --- Internals ----------------------------------------------------------------------

  /**
   * Blocks per eth_getLogs query. Unlimited until a node refuses a range, then halved
   * until it accepts; kept for later queries.
   */
  private logSpan: bigint | null = null;

  /** Search the EntryPoint's events from scan.next to the latest block, moving scan.next on. */
  private async findOperation(userOpHash: Hex, scan: { next: bigint }): Promise<OperationResult | null> {
    const topics = encodeEventTopics({ abi: [userOperationEvent], eventName: 'UserOperationEvent', args: { userOpHash } });
    const latest = BigInt(await rpc<Hex>(this.fetchFn, this.config.rpcUrl, 'eth_blockNumber', []));
    while (scan.next <= latest) {
      const to = this.logSpan === null ? latest : min(latest, scan.next + this.logSpan - 1n);
      let logs: { data: Hex; topics: [Hex, ...Hex[]]; transactionHash: Hex }[];
      try {
        logs = await rpc(this.fetchFn, this.config.rpcUrl, 'eth_getLogs', [{ address: this.entryPoint, topics, fromBlock: toHex(scan.next), toBlock: toHex(to) }]);
      } catch (e) {
        const span = to - scan.next + 1n;
        if (e instanceof RpcError && span > 1n && /range|span|narrow|limit|too (many|large)/i.test(e.message)) {
          this.logSpan = span / 2n;
          continue;
        }
        throw e;
      }
      if (logs.length) {
        const ev = decodeEventLog({ abi: [userOperationEvent], data: logs[0].data, topics: logs[0].topics });
        return { status: 'included', success: ev.args.success, transactionHash: logs[0].transactionHash, actualGasCost: ev.args.actualGasCost };
      }
      scan.next = to + 1n;
    }
    return null;
  }

  private needsApproval(p: Prepared, d: Extract<Decision, { decision: 'needs-approval' }>): Outcome {
    const request: ApprovalRequest = {
      v: 1, chainId: this.chainChecked!, account: this.account, agent: this.address, userOp: p.userOp, agentSig: p.agentSig,
    };
    return {
      status: 'needs-approval', reason: d.reason, message: d.message,
      request: encodeRequest(request), userOpHash: p.userOpHash, fromBlock: p.fromBlock, nonce: p.nonce,
    };
  }

  private callFor(action: Action): { dest: Address; value: bigint; func: Hex } {
    if (action.kind === 'pay') return { dest: getAddress(action.to), value: action.amount, func: '0x' };
    return {
      dest: getAddress(action.router),
      value: 0n,
      func: encodeFunctionData({
        abi: swapAbi, functionName: 'exactInputSingle',
        args: [{
          tokenIn: getAddress(action.tokenIn), tokenOut: getAddress(action.tokenOut), fee: action.fee,
          // The contract refuses any other recipient.
          recipient: this.account,
          amountIn: action.amountIn, amountOutMinimum: action.minAmountOut, sqrtPriceLimitX96: 0n,
        }],
      }),
    };
  }

  /** Build the operation, estimate it, and sign it with the agent key. */
  private async prepare(action: Action): Promise<Prepared> {
    const { dest, value, func } = this.callFor(action);
    const callData = encodeFunctionData({ abi: accountAbi, functionName: 'executeByAgent', args: [this.address, dest, value, func] });
    const [nonce, block] = await Promise.all([
      this.read(entryPointAbi, this.entryPoint, 'getNonce', [this.account, 0n]),
      this.block(),
    ]);
    const fees = await this.fees(block);
    const draft = {
      sender: this.account, nonce: toHex(nonce), callData,
      maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
    };
    const est = await this.estimate({ ...draft, signature: this.placeholderSignature() });
    const pct = (v: Hex, p: number) => toHex((BigInt(v) * BigInt(p)) / 100n);
    const userOp: RequestUserOp = {
      ...draft,
      verificationGasLimit: pct(est.verificationGasLimit, this.margins.verificationPercent),
      callGasLimit: pct(est.callGasLimit, this.margins.callPercent),
      preVerificationGas: pct(est.preVerificationGas, this.margins.preVerificationPercent),
    };
    const pack = (hi: Hex, lo: Hex) => concatHex([toHex(BigInt(hi), { size: 16 }), toHex(BigInt(lo), { size: 16 })]);
    const userOpHash = await this.read(entryPointAbi, this.entryPoint, 'getUserOpHash', [{
      sender: this.account, nonce, initCode: '0x', callData,
      accountGasLimits: pack(userOp.verificationGasLimit, userOp.callGasLimit),
      preVerificationGas: BigInt(userOp.preVerificationGas),
      gasFees: pack(userOp.maxPriorityFeePerGas, userOp.maxFeePerGas),
      paymasterAndData: '0x', signature: '0x',
    }]);
    // The account checks ecrecover(userOpHash) directly: no message prefix.
    const agentSig = await this.signer.sign({ hash: userOpHash });
    return { userOp, userOpHash, nonce, agentSig, fromBlock: BigInt(block.number) };
  }

  /**
   * A signature of the larger, owner-approved shape (agent plus two passkeys), so the
   * same estimate holds whether or not the owner has to approve.
   */
  private placeholderSignature(): Hex {
    const agentSig = concatHex([toHex(1n, { size: 32 }), toHex(1n, { size: 32 }), '0x1b']);
    const cd = JSON.stringify({ type: 'webauthn.get', challenge: 'A'.repeat(43), origin: `chrome-extension://${'a'.repeat(32)}`, crossOrigin: false });
    const passkey = {
      authenticatorData: toHex(new Uint8Array(37).fill(5)), clientDataJSON: cd,
      challengeIndex: BigInt(cd.indexOf('"challenge"')), typeIndex: BigInt(cd.indexOf('"type"')), r: 1n, s: 1n,
    };
    return concatHex(['0x02', encodeAbiParameters(ESCALATED_SIG, [this.address, agentSig, [0n, 1n], [passkey, passkey]])]);
  }

  private async estimate(op: Record<string, Hex>) {
    type Est = { verificationGasLimit: Hex; callGasLimit: Hex; preVerificationGas: Hex };
    const url = this.config.bundlerUrl;
    // The balance override lets an account that holds just enough for the real operation
    // be estimated; bundlers that don't take overrides get the plain call.
    try {
      return await rpc<Est>(this.fetchFn, url, 'eth_estimateUserOperationGas', [op, this.entryPoint, { [this.account]: { balance: toHex(10n ** 18n) } }]);
    } catch (e) {
      if (e instanceof RpcError && /AA2[1-4]|AA[3-9]\d/.test(e.message)) throw e;
      return rpc<Est>(this.fetchFn, url, 'eth_estimateUserOperationGas', [op, this.entryPoint]);
    }
  }

  /** Fees from the bundler when it prices them (Pimlico, Alchemy), else from the node. */
  private async fees(block: Block): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const url = this.config.bundlerUrl;
    try {
      const p = await rpc<{ standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } }>(this.fetchFn, url, 'pimlico_getUserOperationGasPrice', []);
      return { maxFeePerGas: BigInt(p.standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.standard.maxPriorityFeePerGas) };
    } catch { /* not Pimlico */ }
    let priority: bigint;
    try {
      priority = BigInt(await rpc<Hex>(this.fetchFn, url, 'rundler_maxPriorityFeePerGas', []));
    } catch {
      try {
        priority = BigInt(await rpc<Hex>(this.fetchFn, this.config.rpcUrl, 'eth_maxPriorityFeePerGas', []));
      } catch {
        priority = 0n;
      }
    }
    const base = block.baseFeePerGas ? BigInt(block.baseFeePerGas) : BigInt(await rpc<Hex>(this.fetchFn, this.config.rpcUrl, 'eth_gasPrice', []));
    return { maxFeePerGas: (base * BigInt(this.margins.baseFeePercent)) / 100n + priority, maxPriorityFeePerGas: priority };
  }

  private block() {
    return rpc<Block>(this.fetchFn, this.config.rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
  }

  private async ensureChain() {
    if (this.chainChecked !== null) return;
    const id = Number(BigInt(await rpc<Hex>(this.fetchFn, this.config.rpcUrl, 'eth_chainId', [])));
    if (this.config.chainId !== undefined && id !== this.config.chainId) {
      throw new HaptixAgentError('wrong-chain', `The node is on chain ${id}, not ${this.config.chainId}.`);
    }
    this.chainChecked = id;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async read(abi: readonly unknown[], to: Address, functionName: string, args: readonly unknown[]): Promise<any> {
    // viem's generics don't follow a dynamic function name; the ABIs above are fixed.
    const encode = encodeFunctionData as (p: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Hex;
    const decode = decodeFunctionResult as (p: { abi: readonly unknown[]; functionName: string; data: Hex }) => unknown;
    const out = await rpc<Hex>(this.fetchFn, this.config.rpcUrl, 'eth_call', [{ to, data: encode({ abi, functionName, args }) }, 'latest']);
    return decode({ abi, functionName, data: out });
  }
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

function validate(action: Action) {
  const amount = action.kind === 'pay' ? action.amount : action.amountIn;
  if (typeof amount !== 'bigint' || amount <= 0n) throw new HaptixAgentError('invalid-argument', 'The amount must be a bigint above zero.');
  if (action.kind === 'swap') {
    if (typeof action.minAmountOut !== 'bigint' || action.minAmountOut <= 0n) {
      throw new HaptixAgentError('invalid-argument', 'Set minAmountOut above zero; a swap with no minimum can be drained by slippage.');
    }
    if (!Number.isInteger(action.fee) || action.fee < 0) throw new HaptixAgentError('invalid-argument', 'fee must be the pool fee tier, a whole number.');
  }
}

export function createHaptixAgent(config: HaptixAgentConfig) {
  return new HaptixAgent(config);
}
