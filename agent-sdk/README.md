# @haptix/agent

Let an AI agent spend from a user's Haptix account, within the budget the user granted it.

The user's account contract enforces the budget, not this library. The agent holds its own key. That key can only:

- pay addresses the user allowed;
- trade through the router and tokens the user allowed, with what it buys always returning to the account;
- spend up to a per-payment limit and a rolling 24-hour budget.

When the agent wants more, the SDK sends nothing. It returns a **request** that the user pastes into the Haptix wallet and approves with both passkeys.

> Status: tested on Robinhood Chain testnet (see [Tested](#tested)). Not published to npm; use it from this repository.

## Setup

The user creates the budget in the Haptix extension (Agents → New budget). The wallet shows the agent's private key once. Give that key to your agent the way you'd give it any secret, for example an environment variable.

```bash
cd agent-sdk && npm install && npm run build
```

```ts
import { createHaptixAgent } from './agent-sdk/dist/index.js';

const agent = createHaptixAgent({
  rpcUrl: process.env.RPC_URL!,          // a node for the account's chain
  bundlerUrl: process.env.BUNDLER_URL!,  // any ERC-4337 v0.7 bundler for that chain
  entryPoint: process.env.ENTRYPOINT_ADDRESS as `0x${string}`,
  account: process.env.HAPTIX_ACCOUNT as `0x${string}`,
  agentKey: process.env.HAPTIX_AGENT_KEY as `0x${string}`,
  chainId: Number(process.env.CHAIN_ID), // optional: refuse any other chain
  // optional: how messages name the native currency (default ETH, 18 decimals)
  nativeCurrency: { symbol: process.env.NATIVE_SYMBOL!, decimals: 18 },
});
```

The network files in [`../networks`](../networks) hold the RPC, EntryPoint and router for each chain.

## Use

```ts
import { parseEther, parseUnits } from 'viem';

// How much is left? Pass a token address for a token budget; ETH is the default.
const b = await agent.budget();
console.log(b.status, b.remaining, b.perPayment, b.resetsAt);

// Pay ETH to an address the user allowed.
const out = await agent.pay('0xRecipient…', parseEther('0.0001'));

// Or swap through an allowed SwapRouter02-compatible router.
const trade = await agent.swap({
  router: '0xRouter…', tokenIn: '0xUSD…', tokenOut: '0xStock…',
  amountIn: parseUnits('100', 18), minAmountOut: parseUnits('0.9', 18), fee: 3000,
});

if (out.status === 'done') {
  console.log('paid in', out.transactionHash);
} else {
  // Over the agent's limits. Nothing was sent. Show this to the user:
  console.log(out.message);
  console.log('Paste into Haptix → Agents → paste, and approve with both keys:', out.request);
  // Then learn when (and whether) they approved it. The default wait is two minutes;
  // a person may take longer, so give it as long as your agent can wait.
  const result = await agent.waitForOperation(out.userOpHash, {
    fromBlock: out.fromBlock, nonce: out.nonce, timeoutMs: 24 * 60 * 60 * 1000,
  });
}
```

`agent.check(action)` gives the same verdict as `pay` or `swap` without signing or sending anything.

## Outcomes

`pay`, `swap` and `run` resolve to one of two outcomes:

| `status` | Meaning |
|---|---|
| `done` | Sent with the agent's key alone and included on chain. Includes `transactionHash`. |
| `needs-approval` | Over the per-payment limit (`reason: 'per-payment-limit'`) or the rolling budget (`reason: 'budget'`). Includes `request` for the user. |

`message` says why in the asset's own units, read from the token: for example `100 dUSD is more than the 0 dUSD left of the 200 dUSD budget.`

Anything the user's approval wouldn't fix throws a `HaptixAgentError`. A failure talking to the node itself (a timeout, a bad URL) throws an `RpcError` instead. A `HaptixAgentError`'s `code` is one of:

| `code` | Why |
|---|---|
| `not-granted`, `revoked`, `expired`, `not-yet-valid` | The agent's session doesn't allow anything now. The user grants a new budget. |
| `frozen` | The user froze the account. No agent can spend until it's unfrozen. |
| `not-allowed` | The recipient, router or token isn't in the agent's grant. |
| `above-approval-ceiling` | Over the most the user may approve for this agent. |
| `invalid-argument` | A zero amount, or a swap with no minimum out (the SDK refuses those to protect against slippage). |
| `wrong-chain` | The node isn't on the configured `chainId`. |
| `insufficient-funds` | The account can't pay this operation's gas. |
| `bundler-rejected` | The bundler refused for another reason; the message says why. |
| `reverted` | Included, but the call reverted (for example, a swap below its minimum). |
| `superseded` | The account used this nonce for something else first. Try again. |
| `timeout` | Not on chain within `timeoutMs`. |

`waitForOperation` resolves to `{ status: 'included', success, transactionHash }` or `{ status: 'superseded' }`. A request is tied to the account's nonce, so it can never run once the account sends anything else.

## Approval requests

A request is base64url JSON, version 1, in the format the Haptix wallet reads:

- the account;
- the agent;
- the chain id;
- the full user operation;
- the agent's signature over its hash.

The wallet decodes the call from those bytes and shows the user what they're approving. It then adds both passkey signatures and submits that exact operation. `decodeRequest` and `encodeRequest` read and write the format.

`waitForOperation` reads the EntryPoint's `UserOperationEvent`s from the node, not from a bundler. So it sees the operation land whichever bundler the wallet used. Nodes limit how many blocks one log query may span (10,000,000 on Robinhood Chain's public RPCs, about 12 days on mainnet). When a node refuses a range, the SDK pages through it.

## Gas

The SDK estimates with the bundler's `eth_estimateUserOperationGas`. It signs with a placeholder of the approved shape (the agent plus two passkeys), so one estimate fits both outcomes. Fees come from the bundler when it prices them: Pimlico's `pimlico_getUserOperationGasPrice` or Alchemy's `rundler_maxPriorityFeePerGas`. Otherwise they come from the node.

The margins on those estimates are in `DEFAULT_GAS_MARGINS`, and you can override them with `gas` in the config. The account pays its own gas; there is no paymaster support yet.

## Tested

- **Unit tests** against a mocked node (`npm test`, no network): every refusal, both limit reasons, the request format as the wallet parses it, and a superseded request.
- **Live on Robinhood Chain testnet** (`scripts/agent-sdk-e2e.mjs`, 15 steps, 2026-11-17, rerun 2026-11-21), using a local test bundler (`scripts/lib/dev-bundler.mjs`):
  - pays within budget;
  - stops at the budget and at the per-payment limit;
  - the owner approves a request with both passkeys, and `waitForOperation` sees it land;
  - the other request on that nonce becomes superseded;
  - an unlisted payee is refused;
  - a swap through the demo router;
  - a swap with no minimum is refused, and an over-limit swap needs approval;
  - refused while frozen, and refused after revoke.
- **Through the real extension** (`tools/test-dapp/full-flow.mjs`, 33 checks, 2026-11-21): `agent-pay.mjs`, built on this SDK, trades within budget, then stops and prints a request. The Haptix extension reads that request, shows it, and approves it with both passkeys (virtual passkeys in a headless browser). After revoke, the SDK refuses with `revoked`.

- **With real passkeys and a hosted bundler** (2026-11-26, Pimlico): `agent-pay.mjs` traded twice within budget, stopped at the budget and printed a request that the owner approved in the extension with Touch ID and a phone passkey, then refused after revoke. Receipts are in the [main README](../README.md#receipts).

Not yet tested:
- Alchemy's bundler;
- Robinhood Chain mainnet;
- a wait of hours: paging through a long block range is covered by the unit tests only.

## Command line

[`scripts/agent-pay.mjs`](../scripts/agent-pay.mjs) wraps the SDK:

```bash
node scripts/agent-pay.mjs <to> <amount in ETH>
node scripts/agent-pay.mjs swap <tokenIn> <tokenOut> <amount> <minimum out>
```

It exits with 0 when done, 3 when it printed a request for the owner, and 1 when refused.
